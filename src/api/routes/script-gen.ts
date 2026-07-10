/**
 * Script Generation API Routes
 *
 * POST   /api/scripts/generate          — Generate test scripts for a URL
 * GET    /api/scripts/history            — Paginated script history (project-filtered)
 * GET    /api/scripts/recent             — List recent generations (project-filtered)
 * GET    /api/scripts/:id/download       — Download script content as file
 * GET    /api/scripts/:id                — Get specific generated script (project-filtered)
 * DELETE /api/scripts/:id                — Soft-delete a script (project-filtered)
 * POST   /api/scripts/:id/review         — Trigger AI review on existing generation
 * POST   /api/scripts/:id/export         — Export as project directory
 * POST   /api/scripts/:id/push           — Push to GitHub repository
 */

import { Router, type Request, type Response } from 'express';
import {
  logGeneratedScript,
  getGeneratedScript,
  getRecentScripts,
  getScriptHistory,
  softDeleteScript,
  updateScriptReview,
  logDomSnapshot,
  logSelectorScores,
  logWorkflowMaps,
  logProjectExport,
  getKnowledgeItem,
  autoLinkScriptTraceability,
  getTestCaseById,
  getTestCasesForRequirement,
  getTestCaseTokenAttribution,
  getAttributedTokensForScripts,
  getLinkedDatasets,
  getTestDataRecords,
  resolveTestData,
  listTestDataSets,
  getRequirement,
  getProfileByUrl,
  markTestCaseAutomated,
  getRequirementAutomationCoverage,
  updateScriptContent,
  saveScriptVersion,
} from '../../db/postgres';
import { syncScript } from '../../services/script-sync';
import { learnFromSyncChanges } from '../../services/maintenance-pattern-service';
import {
  extractPreservedContent,
  mergeRegenerated,
  type MergeOptions,
} from '../../services/smart-regeneration';
import { resolveBaseUrl } from '../../services/url-resolver';
import { parseScriptContent } from '../../services/script-file-parser';
import { LocatorResolver, type CrawlDataLike, type LocatorReport } from '../../services/locator-resolver';
import { FolderStructureAnalyzer } from '../../services/folder-analyzer';
import { ScriptGenEngine, DeterministicGenerationEmptyError, type GenerationConfig, type GenerationResult, type GeneratedFile } from '../../script-gen/script-gen-engine';
import { deriveTestCaseTargetUrls, profileCoversTargets } from '../../script-gen/test-case-coverage';
import { getRepositoryContext } from '../../db/postgres';
import { KnowledgeOptimizer, type KnowledgeItem } from '../../ai/knowledge-optimizer';
import { AIReviewEngine } from '../../script-gen/ai-review-engine';
import { ValidationRunner, computeReliabilityBreakdown, toPublicReliability } from '../../script-gen/validation-runner';
import { ProjectExportEngine } from '../../script-gen/project-export-engine';
import {
  createBranch,
  commitAll,
  pushBranch,
  createPR,
  parseRepoUrl,
} from '../../github/pr-creator';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import JSZip from 'jszip';
import { CrawlOrchestrator } from '../../intelligence/crawl-orchestrator';
import { PatternMatcher } from '../../intelligence/pattern-matcher';
import { IntelligenceFusionService } from '../../services/intelligence-fusion-service';
import { getContextFromRequest } from '../middleware/context';
import { extractElementDescriptions } from '../../utils/element-descriptions';

/**
 * Reconstruct `GeneratedFile[]` from a stored script blob.
 *
 * The blob is a single `script_content` column delimited by `// === <path> ===`
 * headers. We delegate parsing to the shared `parseScriptContent` utility
 * (src/services/script-file-parser.ts) which correctly strips the delimiters —
 * including the very first header that has no leading newline — instead of the
 * previous manual `split('\n// === ')` + `replace(' ===', '')` logic that left
 * a `// ` prefix and a trailing ` ===` on the first file's path (the root cause
 * of the "Invalid file path" error during PR creation).
 *
 * File `type` is sourced from `parseScriptContent` (which itself prefers the
 * separately-stored `files_generated` metadata), keeping the AI-review, export
 * and push flows consistent.
 */
function reconstructGeneratedFiles(
  scriptContent: string | null | undefined,
  filesGenerated?: unknown,
): GeneratedFile[] {
  return parseScriptContent(scriptContent, filesGenerated).map((f) => ({
    path: f.path,
    content: f.content,
    type: f.type as GeneratedFile['type'],
  }));
}

// `extractElementDescriptions` now lives in a shared util so the Test-Case-Lab
// engine (TestToScriptEngine) grounds locators identically. See
// src/utils/element-descriptions.ts.

export function createScriptGenRouter(): Router {
  const router = Router();
  const crawlOrchestrator = new CrawlOrchestrator();
  const patternMatcher = new PatternMatcher();
  const fusionService = new IntelligenceFusionService();

  /* ── Generate Test Scripts ──────────────────────────────── */
  router.post('/generate', async (req: Request, res: Response) => {
    const startTime = Date.now();
    try {
      const {
        url: bodyUrl,
        instructions,
        testTypes,
        credentials,
        includeNegativeTests,
        followLinks,
        maxPages,
        repoId,
        knowledgeItemIds,
        authConfig: rawAuthConfig,
        additionalUrls,
        forceFreshCrawl,
        // Opt-in: persist a NEW application profile from this generation's crawl.
        // Default false — generation will refresh an EXISTING profile but never
        // silently create a brand-new one, so profile creation stays predictable
        // (one explicit "Create Profile" action = one profile).
        persistProfile,
        testCaseId,
        // ── Sprint 4: Enterprise Script Generation Enhancement ──
        requirementId,
        // Inline structured test cases from a CSV/Excel upload (no DB row). When
        // provided WITHOUT a testCaseId/requirementId these are normalized and
        // run through the SAME deterministic, grounded batch engine as
        // requirement-linked test cases — instead of the ungrounded LLM
        // discovery fallback that flattened scenario strings used to trigger.
        testCases: inlineTestCasesRaw,
        generationSource: rawGenerationSource,
        locatorStrategy,
        folderStrategy,
        // Opt-in to project scaffold files (playwright.config, README, .env.example,
        // CI workflow, utils). Suppressed by default — only test artifacts are
        // generated unless this is explicitly true.
        includeScaffold,
      } = req.body;

      // ── Sprint 4B: auto-populate the target URL from the environment ──────
      // An explicit, caller-supplied URL always wins. Only when it is blank
      // (e.g. requirement / test-case driven generation) do we resolve it from
      // the active environment → default environment → project context app_url.
      // Best-effort and non-blocking — never throws.
      let url: string = typeof bodyUrl === 'string' ? bodyUrl.trim() : '';
      if (!url) {
        try {
          const { environmentId: envIdForUrl } = getContextFromRequest(req);
          const resolved = await resolveBaseUrl({
            projectId: (req as any).projectId ?? null,
            environmentId: envIdForUrl ?? null,
            companyId: (req as any).companyId ?? null,
          });
          if (resolved.url) {
            url = resolved.url;
            console.log(`[ScriptGen] Auto-populated url from ${resolved.source}${resolved.label ? ` ("${resolved.label}")` : ''}: ${url}`);
          }
        } catch (urlErr: any) {
          console.warn(`[ScriptGen] Could not auto-populate url (non-blocking): ${urlErr?.message}`);
        }
      }

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, error: 'url is required' });
      }

      console.log(`[ScriptGen] Starting generation for: ${url}`);

      // ── Sanitize & validate auth config (NEVER log credentials) ──
      let sanitizedAuthConfig: import('../../script-gen/auth-engine').AuthConfig | undefined;
      if (rawAuthConfig && typeof rawAuthConfig === 'object') {
        const { loginUrl, username, password } = rawAuthConfig;
        if (!username || !password) {
          return res.status(400).json({
            success: false,
            error: 'authConfig requires both username and password',
          });
        }
        sanitizedAuthConfig = {
          loginUrl: typeof loginUrl === 'string' ? loginUrl : undefined,
          credentials: {
            username: String(username),
            password: String(password),
          },
        };
        // Log that auth is enabled but NEVER log credential values
        console.log(`[ScriptGen] Authentication enabled — loginUrl: ${sanitizedAuthConfig.loginUrl ?? '(auto-detect)'}`);
      }
      const companyId = (req as any).companyId as number | undefined;

      // ── Sprint 4: Load the structured test case (steps + requirement) ──
      // When a testCaseId is supplied, fetch the full test case so its steps
      // can drive the prompt + locator resolution. Best-effort: a missing test
      // case never blocks generation (preserves the url-based flow).
      let testCase: any = null;
      if (testCaseId != null && companyId != null) {
        try {
          testCase = await getTestCaseById(Number(testCaseId), companyId);
          if (testCase) {
            console.log(`[ScriptGen] 📋 Test case loaded — id=${testCase.id}, steps=${Array.isArray(testCase.steps) ? testCase.steps.length : 'n/a'}, requirement=${testCase.requirement_id ?? testCase.requirement?.id ?? 'none'}`);
          } else {
            console.log(`[ScriptGen] ⚠️ Test case ${testCaseId} not found for company ${companyId} (continuing url-based)`);
          }
        } catch (tcErr: any) {
          console.warn(`[ScriptGen] Could not load test case (non-blocking): ${tcErr?.message}`);
        }
      }

      // ── Requirement-based generation: load ALL test cases for the requirement ──
      // When a requirementId is supplied WITHOUT a specific testCaseId, fetch
      // every test case linked to that requirement so the engine can produce one
      // grounded, deterministic spec per case (no LLM, no project-context
      // credential contamination). This is the REQ-001 (10 test cases) flow.
      let requirementTestCases: any[] = [];
      if (!testCase && requirementId != null && companyId != null) {
        try {
          requirementTestCases = await getTestCasesForRequirement(String(requirementId), companyId);
          console.log(`[ScriptGen] 📋 Requirement ${requirementId} → ${requirementTestCases.length} test case(s) loaded for deterministic batch generation`);
          if (requirementTestCases.length === 0) {
            // Honesty signal: a "requirement based" generation with NO linked
            // test cases will silently fall through to generic flow templates
            // (smoke/search/navigation/form) — that is why users see "many
            // scenarios, few/generic scripts". Make it loud so it is diagnosable
            // instead of a mystery.
            console.warn(
              `[ScriptGen] ⚠️ Requirement ${requirementId} has 0 LINKED test cases — deterministic per-test-case generation is NOT possible. ` +
                `Generation will fall back to generic flow templates. Link the requirement's test cases (generated_test_cases.requirement_id) to generate one grounded script per scenario.`,
            );
          }
        } catch (reqErr: any) {
          console.warn(`[ScriptGen] Could not load requirement test cases (non-blocking): ${reqErr?.message}`);
        }
      }

      // ── Inline uploaded test cases (CSV/Excel upload) ────────────────────
      // When the caller supplies structured test cases inline (no DB row) and we
      // did NOT resolve a single testCase or requirement-linked batch, normalize
      // them into the engine's snake_case shape and treat them exactly like a
      // requirement batch. This routes an "Upload Test Cases" generation through
      // the deterministic, grounded engine (real locators, page-consolidated)
      // instead of the LLM discovery fallback (0% grounded) it used to hit.
      if (
        !testCase &&
        requirementTestCases.length === 0 &&
        Array.isArray(inlineTestCasesRaw) &&
        inlineTestCasesRaw.length > 0
      ) {
        requirementTestCases = inlineTestCasesRaw
          .filter((tc: any) => tc && typeof tc === 'object')
          .map((tc: any, i: number) => {
            // Accept both camelCase (from the upload parser) and snake_case.
            const expected = tc.expected_result ?? tc.expectedResult ?? '';
            const title =
              (typeof tc.title === 'string' && tc.title.trim())
                ? tc.title.trim()
                : (typeof tc.scenario === 'string' && tc.scenario.trim())
                  ? tc.scenario.trim()
                  : `Test case ${i + 1}`;
            return {
              // Stable numeric-ish id for downstream keying; keep original too.
              id: tc.id ?? `upload-${i + 1}`,
              title,
              // Engine's parseTestCaseSteps handles a newline string OR an array.
              steps: tc.steps ?? tc.scenario ?? '',
              expected_result: expected,
              preconditions: tc.preconditions ?? '',
              priority: tc.priority ?? '',
              module: tc.module ?? '',
              scenario: tc.scenario ?? title,
              requirement_id: tc.requirement_id ?? null,
              test_data: tc.test_data ?? tc.testData ?? null,
              // Mark provenance so downstream logging is honest.
              source: 'uploaded',
            };
          });
        console.log(`[ScriptGen] 📥 ${requirementTestCases.length} inline uploaded test case(s) normalized → deterministic batch generation`);
      }

      // ── Honesty guard: requirement intent with NO resolvable cases ───────
      // Requirement intent is asserted by EITHER a supplied requirementId OR an
      // explicit generationSource === 'requirement_based'. Either way, when the
      // user asked to generate FROM A REQUIREMENT, there is exactly ONE correct
      // source of truth — its linked test cases. If none resolve (after FK →
      // traceability → legacy-numeric-bridge in getTestCasesForRequirement) the
      // system must NOT quietly switch to the generic URL-discovery generator
      // and dress it up with a 100% score. That second generation path is the
      // root of the "many scenarios → 4 unrelated smoke/search/nav/form scripts,
      // 0% grounded" class of bugs. Fail loud + actionable so the user is routed
      // to create/link test cases first. URL / plain-English generation (no
      // requirement intent) is unaffected and still uses the LLM path as designed.
      const requirementIntent =
        requirementId != null || rawGenerationSource === 'requirement_based';
      if (
        requirementIntent &&
        !testCase &&
        requirementTestCases.length === 0 &&
        !(Array.isArray(inlineTestCasesRaw) && inlineTestCasesRaw.length > 0)
      ) {
        console.warn(
          `[ScriptGen] ❌ Requirement ${requirementId ?? '(unspecified id)'} resolved 0 test cases ` +
            `(FK + traceability + legacy-numeric bridge all empty). Refusing to emit generic ungrounded scripts.`,
        );
        return res.status(422).json({
          success: false,
          error:
            'This requirement has no linked test cases, so grounded per-test-case scripts cannot be generated. ' +
            'Generate the requirement’s test cases first (Test Case Lab), or generate from a URL / uploaded CSV instead.',
          code: 'REQUIREMENT_HAS_NO_TEST_CASES',
          requirementId: requirementId != null ? String(requirementId) : null,
          resolvedTestCaseCount: 0,
          // Explicit next step so the dashboard can deep-link the user forward
          // instead of leaving them staring at a failed generation.
          nextAction: 'GENERATE_TEST_CASES',
        });
      }

      // ── Test-case page coverage ──────────────────────────────────────────
      // A test case grounds its selectors against the crawled DOM of the page
      // it operates on. If the crawl only captured the entry page, a login test
      // case that navigates to /login grounds 0 selectors ("14 not found in
      // crawl") even though the profile says "cached real DOM". Derive the pages
      // the in-scope test cases actually visit so we can (a) crawl them and
      // (b) reject a cache that doesn't cover them.
      const coverageCases: any[] = [
        ...(testCase ? [testCase] : []),
        ...requirementTestCases,
      ];
      const testCaseTargetUrls = coverageCases.length > 0
        ? deriveTestCaseTargetUrls(coverageCases, url)
        : [];
      if (testCaseTargetUrls.length > 0) {
        console.log(`[ScriptGen] 🎯 Test cases navigate to ${testCaseTargetUrls.length} page(s) beyond the entry URL: ${testCaseTargetUrls.join(', ')}`);
      }
      // Merge request-provided additionalUrls with the test-case target pages
      // (deduped) — this is what the crawl will actually cover.
      const requestAdditionalUrls = Array.isArray(additionalUrls)
        ? additionalUrls.filter((u: any) => typeof u === 'string')
        : [];
      const effectiveAdditionalUrls = Array.from(
        new Set<string>([...requestAdditionalUrls, ...testCaseTargetUrls]),
      ).slice(0, 10);

      // ── Test Data → Script traceability: load REAL dataset records ──
      // For each test case in scope, load the datasets explicitly linked to it
      // and resolve their records (values, secrets hydrated). These are passed
      // to the engine so generated specs reference real data via getUser('<key>')
      // instead of empty/hardcoded credentials. Best-effort and non-blocking.
      let resolvedTestData: Array<{ name: string; environment?: string; records: Array<{ key: string; value: any }> }> = [];
      if (companyId != null) {
        try {
          const scopedCaseIds = [
            ...(testCase?.id != null ? [Number(testCase.id)] : []),
            ...requirementTestCases.map((t: any) => Number(t.id)).filter((n: number) => !Number.isNaN(n)),
          ];
          const projectIdForData = (req as any).projectId as number | undefined;
          const seenDatasets = new Set<string>(); // dedupe by name+environment
          for (const cid of scopedCaseIds) {
            const linked = await getLinkedDatasets(cid).catch(() => []);
            for (const ds of linked) {
              const dedupeKey = `${ds.name}::${ds.environment}`;
              if (seenDatasets.has(dedupeKey)) continue;
              seenDatasets.add(dedupeKey);
              // Prefer resolveTestData (hydrates secret refs); fall back to raw
              // records if resolution returns nothing.
              let records: Array<{ key: string; value: any }> = [];
              try {
                const resolved = await resolveTestData(ds.name, companyId as number, projectIdForData, ds.environment);
                if (Array.isArray(resolved) && resolved.length > 0) {
                  records = resolved.map((r: any) => ({ key: String(r.key), value: r.value }));
                }
              } catch { /* fall through to raw records */ }
              if (records.length === 0) {
                const raw = await getTestDataRecords(ds.id).catch(() => []);
                records = raw.map((r: any) => ({ key: String(r.key), value: r.value_jsonb }));
              }
              if (records.length > 0) {
                resolvedTestData.push({ name: ds.name, environment: ds.environment, records });
              }
            }
          }

          // ── Fallback: resolve datasets REFERENCED BY NAME in a case's
          // `test_data` text but never formally linked. Authors frequently type
          // a free-text reference (e.g. test_data: "locked_user") without
          // creating the dataset↔case association, which previously left the
          // generator with no record to bind — emitting bogus literals scraped
          // from the step prose. We match those references against the company's
          // Test Data Store by name (tolerant of singular/plural & punctuation)
          // so the real record (e.g. locked_users → locked_out_user) resolves.
          try {
            const scopedCases = [
              ...(testCase ? [testCase] : []),
              ...requirementTestCases,
            ];
            const refTexts = scopedCases
              .map((c: any) => `${c?.test_data ?? ''} ${c?.title ?? ''}`.toLowerCase())
              .filter(Boolean);
            if (refTexts.length > 0) {
              const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
              const allSets = await listTestDataSets(companyId as number, projectIdForData).catch(() => []);
              for (const ds of allSets) {
                const dedupeKey = `${ds.name}::${ds.environment}`;
                if (seenDatasets.has(dedupeKey)) continue;
                const dsNorm = norm(ds.name);
                if (!dsNorm) continue;
                // A reference matches when the (normalized) dataset name appears
                // as a token in a case's test_data/title, or vice-versa — covers
                // "locked_user" ↔ "locked_users" and "valid_users" ↔ "valid user".
                const referenced = refTexts.some((txt) => {
                  const tokens = txt.split(/[^a-z0-9]+/).filter(Boolean).map((t) => t.replace(/s$/, ''));
                  return tokens.includes(dsNorm) || tokens.some((t) => t && (t.includes(dsNorm) || dsNorm.includes(t)) && Math.min(t.length, dsNorm.length) >= 4);
                });
                if (!referenced) continue;
                seenDatasets.add(dedupeKey);
                let records: Array<{ key: string; value: any }> = [];
                try {
                  const resolved = await resolveTestData(ds.name, companyId as number, projectIdForData, ds.environment);
                  if (Array.isArray(resolved) && resolved.length > 0) {
                    records = resolved.map((r: any) => ({ key: String(r.key), value: r.value }));
                  }
                } catch { /* fall through to raw records */ }
                if (records.length === 0) {
                  const raw = await getTestDataRecords(ds.id).catch(() => []);
                  records = raw.map((r: any) => ({ key: String(r.key), value: r.value_jsonb }));
                }
                if (records.length > 0) {
                  resolvedTestData.push({ name: ds.name, environment: ds.environment, records });
                  console.log(`[ScriptGen] 🔗 Resolved by-name reference → dataset "${ds.name}" (${records.length} record(s))`);
                }
              }
            }
          } catch (nameErr: any) {
            console.warn(`[ScriptGen] By-name test-data resolution skipped (non-blocking): ${nameErr?.message}`);
          }

          if (resolvedTestData.length > 0) {
            const totalRecords = resolvedTestData.reduce((n, d) => n + d.records.length, 0);
            console.log(`[ScriptGen] 🔗 Test data resolved — ${resolvedTestData.length} dataset(s), ${totalRecords} record(s) for ${scopedCaseIds.length} case(s)`);
          }
        } catch (tdErr: any) {
          console.warn(`[ScriptGen] Could not resolve linked test data (non-blocking): ${tdErr?.message}`);
        }
      }

      // Resolve the generation provenance. Explicit value wins; otherwise infer
      // from what the caller supplied (test case / requirement / url).
      const generationSource: string =
        (typeof rawGenerationSource === 'string' && rawGenerationSource) ||
        (testCase ? 'test_case_based' : requirementId ? 'requirement_based' : 'url_based');

      // Auto-load repository intelligence if repoId provided
      let repoIntelligence: string | undefined;
      let repoProfile: import('../../context/types').RepositoryProfile | undefined;
      if (repoId) {
        console.log(`[ScriptGen] 🔍 Loading repository intelligence for repoId=${repoId}...`);
        // Strict project scoping: never surface another project's repo profile.
        const reqProjectId = (req as any).projectId as number | undefined;
        const profile = await getRepositoryContext(repoId, companyId, reqProjectId);
        if (profile) {
          const { buildAIPromptContext } = await import('../../context/prompt-builder');
          repoIntelligence = buildAIPromptContext(profile);
          repoProfile = profile; // pass structured profile for adaptive code generation
          console.log(`[ScriptGen] ✅ Repo intelligence loaded — framework=${profile.framework}, lang=${profile.language}, pattern=${profile.testPattern}, helpers=${profile.helperFunctions?.length ?? 0}, pageObjects=${profile.pageObjects?.length ?? 0}, fixtures=${profile.fixtures?.length ?? 0}`);
        } else {
          console.log(`[ScriptGen] ⚠️ No repository context found for repoId=${repoId} (company=${companyId ?? 'none'})`);
        }
      } else {
        console.log(`[ScriptGen] ℹ️ No repoId provided — skipping repository intelligence`);
      }

      // Load and optimize App Knowledge if knowledgeItemIds provided
      let knowledgeContext: string | undefined;
      let knowledgeItemsUsed: any[] = [];
      if (Array.isArray(knowledgeItemIds) && knowledgeItemIds.length > 0) {
        try {
          const items = await Promise.all(
            knowledgeItemIds.slice(0, 20).map((id: number) => getKnowledgeItem(id, companyId))
          );
          const validItems: KnowledgeItem[] = items
            .filter(Boolean)
            .map((ki: any) => ({
              id: ki.id,
              category: ki.category,
              title: ki.title,
              description: ki.description,
              tags: ki.tags || [],
              related_modules: ki.related_modules || [],
              priority: ki.priority,
              metadata: ki.metadata,
            }));

          if (validItems.length > 0) {
            const optimizer = new KnowledgeOptimizer();
            const optimized = optimizer.selectRelevantKnowledge(validItems, {
              testDescription: instructions,
              url,
              testTypes,
            }, {
              maxTokens: 1500,
              maxItems: 7,
              format: 'script-gen',
            });

            knowledgeContext = optimized.formattedContext || undefined;
            knowledgeItemsUsed = optimized.selectedItems;
            console.log(`[ScriptGen] Knowledge optimized: ${optimized.stats.selectedCount}/${validItems.length} items, ~${optimized.stats.estimatedTokens} tokens`);
          }
        } catch (kiErr: any) {
          console.warn(`[ScriptGen] Could not load knowledge items (non-blocking): ${kiErr.message}`);
        }
      }

      // ── Application Intelligence: check cache before crawling ──
      const projectId = (req as any).projectId as number | undefined;
      // Write-path attribution — environment / sprint selected in the dashboard
      // (forwarded as x-environment-id / x-sprint-id headers, resolved by
      // contextMiddleware). Undefined values let the DB triggers stamp defaults.
      const { environmentId, sprintId } = getContextFromRequest(req);
      const crawlDecision = await crawlOrchestrator.decideCrawlStrategy(url, companyId, {
        forceFreshCrawl: forceFreshCrawl ?? false,
        authConfig: sanitizedAuthConfig,
      }, projectId);

      console.log(`[ScriptGen] Crawl decision: usedCache=${crawlDecision.usedCache}, reason="${crawlDecision.reason}" (${crawlDecision.decisionTimeMs}ms)`);

      // ── Empty-DOM cache guard ──
      // A cached App Profile is only useful for locator grounding if it actually
      // carries DOM elements. We have seen profiles persisted with an empty
      // `elements` array (e.g. saved from a path that never captured the DOM, or
      // a crawl that yielded nothing). Serving that as the "Fast Path" produces a
      // dishonest result: the UI claims "cached real DOM" while every selector
      // silently falls back → "REAL LOCATORS 0/N". Detect this and fall through
      // to a fresh crawl, which also self-heals the stale profile (the fresh
      // crawl is saved back, refreshing the existing profile row below).
      const cachedElementCount = (() => {
        const cd: any = crawlDecision.crawlData;
        if (!cd) return 0;
        if (Array.isArray(cd.elements)) return cd.elements.length;
        // Some profiles store per-page crawls — sum their element arrays.
        if (Array.isArray(cd.pages)) {
          return cd.pages.reduce(
            (n: number, p: any) => n + (Array.isArray(p?.elements) ? p.elements.length : 0),
            0,
          );
        }
        return 0;
      })();
      if (crawlDecision.usedCache && cachedElementCount === 0) {
        console.warn(
          `[ScriptGen] ⚠️ Cached profile has no DOM elements (id=${crawlDecision.profile?.id ?? 'n/a'}) — ignoring cache and performing a fresh crawl so locators can ground against the real DOM.`,
        );
        crawlDecision.usedCache = false;
        crawlDecision.crawlData = null;
        crawlDecision.reason = `${crawlDecision.reason}; overridden — cached DOM was empty, re-crawling for real grounding`;
      }

      // ── Page-coverage cache guard ──
      // A cached profile can be non-empty yet still miss the pages the in-scope
      // test cases actually operate on (e.g. it captured only the home page but
      // the login test cases navigate to /login). Grounding those selectors then
      // fails silently → "REAL LOCATORS 0/N · not found in crawl" under a
      // "cached real DOM" banner. If the cache doesn't cover every target page,
      // re-crawl (the fresh crawl now seeds those pages via additionalUrls) so
      // grounding has the real DOM for them.
      if (crawlDecision.usedCache && crawlDecision.crawlData && testCaseTargetUrls.length > 0) {
        const { missing } = profileCoversTargets(crawlDecision.crawlData, testCaseTargetUrls);
        if (missing.length > 0) {
          console.warn(
            `[ScriptGen] ⚠️ Cached profile does not cover ${missing.length} test-case page(s) [${missing.join(', ')}] — ignoring cache and performing a fresh crawl that visits them so their locators can ground.`,
          );
          crawlDecision.usedCache = false;
          crawlDecision.crawlData = null;
          crawlDecision.reason = `${crawlDecision.reason}; overridden — cached DOM missing test-case pages (${missing.join(', ')}), re-crawling for real grounding`;
        }
      }

      // ── Multi-Intelligence Fusion: gather ALL intelligence sources + compute confidence ──
      let fusion: import('../../services/intelligence-fusion-service').FusedIntelligence | undefined;
      let fusionContext: string | undefined;
      if (companyId !== undefined && companyId !== null) {
        try {
          fusion = await fusionService.fuseIntelligenceForScriptGen({
            companyId: companyId as number,
            projectId,
            repositoryId: repoId,
            targetUrl: url,
            testScenario: instructions || undefined,
            preloadedRepoProfile: repoProfile,
            knowledgeItemsCount: knowledgeItemsUsed.length,
            // Sprint 4 — fuse structured test-case data as a first-class source.
            ...(testCase ? { testCase } : {}),
          });
          fusionContext = fusionService.buildFusionContext(fusion) || undefined;
          console.log(`[ScriptGen] 🔮 Fusion confidence=${fusion.confidenceScore}/100, sources=[${fusion.fusionMetadata.sourcesUsed.join(', ')}]`);
        } catch (fusionErr: any) {
          console.warn(`[ScriptGen] Fusion non-blocking error: ${fusionErr.message}`);
        }
      }

      // ── Sprint 2D: load the Scenario Graph for requirement-based generation ──
      // When generating from a requirement that has a persisted/buildable Scenario
      // Graph, load it once and match each test case to its canonical node (by
      // scenarioId) so Script Gen can consume the graph's semantics + resolvedDataset
      // instead of re-inferring them. Best-effort — if graph load fails or a case
      // has no matching node, generation falls back to legacy inference for that case.
      let scenarioGraphNodes: Map<string, any> | undefined;
      if (requirementId != null && (testCase || requirementTestCases.length > 0)) {
        try {
          const { getOrBuildScenarioGraph } = await import('../../graph/scenario-graph-service');
          const reqIdNum = typeof requirementId === 'string' ? parseInt(requirementId, 10) : requirementId;
          const graphResult = await getOrBuildScenarioGraph(
            { title: '', description: '' }, // Minimal input; graph is loaded by fingerprint
            [], // Coverage types not needed for load
            undefined, // Knowledge
            { requirementId: reqIdNum, companyId, projectId },
          );
          if (graphResult.graph && graphResult.graph.nodes.length > 0) {
            // Project nodes to {semantics, execution} only — Script Gen reads ONLY
            // these two fields from the node, never the full graph structure.
            // Keyed by node.id (scenarioId) for stable identity-based resolution.
            scenarioGraphNodes = new Map(
              graphResult.graph.nodes.map((n: any) => [
                n.id,
                {
                  ...(n.semantics ? { semantics: n.semantics } : {}),
                  ...(n.execution ? { execution: n.execution } : {}),
                },
              ]),
            );
            console.log(
              `[ScriptGen] 📊 Scenario Graph ${graphResult.origin} for requirement ${requirementId} — ${scenarioGraphNodes.size} node(s) threaded`,
            );
          }
        } catch (graphErr: any) {
          console.warn(
            `[ScriptGen] Could not load Scenario Graph (non-blocking, falling back to legacy inference): ${graphErr?.message}`,
          );
        }
      }

      const config: GenerationConfig = {
        url,
        instructions: instructions || undefined,
        testTypes: testTypes || ['smoke', 'functional'],
        credentials: credentials || undefined,
        includeNegativeTests: includeNegativeTests ?? true,
        followLinks: followLinks ?? false,
        maxPages: maxPages ?? 3,
        repoIntelligence,
        knowledgeContext,
        ...(typeof includeScaffold === 'boolean' ? { includeScaffold } : {}),
        ...(fusionContext ? { fusionContext } : {}),
        ...(repoProfile ? { repoProfile } : {}),
        ...(sanitizedAuthConfig ? { authConfig: sanitizedAuthConfig } : {}),
        ...(effectiveAdditionalUrls.length > 0
          ? { additionalUrls: effectiveAdditionalUrls }
          : {}),
        // Pass cached crawl data to engine if available
        ...(crawlDecision.usedCache && crawlDecision.crawlData
          ? { cachedCrawlData: crawlDecision.crawlData }
          : {}),
        // Anchor generation to the structured test case (steps + expected
        // result) when generating from a Test Case Lab case.
        ...(testCase ? { testCase } : {}),
        // Requirement-based batch: one deterministic spec per linked test case.
        ...(requirementTestCases.length > 0 ? { testCases: requirementTestCases } : {}),
        // Resolved dataset records → enables getUser('<key>') traceability.
        ...(resolvedTestData.length > 0 ? { resolvedTestData } : {}),
        // Sprint 2D: Scenario Graph nodes keyed by title for semantics consumption.
        ...(scenarioGraphNodes ? { scenarioGraphNodes } : {}),
        ...(companyId != null ? { companyId } : {}),
        ...(projectId != null ? { projectId } : {}),
      };

      // Log which generation path will run (no credentials ever logged).
      const usedInlineUploaded =
        !testCase && requirementTestCases.length > 0 && !requirementId &&
        Array.isArray(inlineTestCasesRaw) && inlineTestCasesRaw.length > 0;
      console.log('[ScriptGen] Generation mode:', JSON.stringify({
        requirementId: requirementId ?? null,
        testCaseId: testCaseId ?? null,
        requirementTestCaseCount: requirementTestCases.length,
        inlineUploadedTestCases: usedInlineUploaded ? requirementTestCases.length : 0,
        path: requirementTestCases.length > 0
          ? (usedInlineUploaded ? 'uploaded-batch-deterministic' : 'requirement-batch-deterministic')
          : testCase
            ? 'testcase-deterministic'
            : 'llm-fallback',
      }));

      const engine = new ScriptGenEngine();
      const result: GenerationResult = await engine.generate(config);

      // Save crawl data to profile if a fresh crawl was performed.
      //
      // IMPORTANT — predictable profile creation: by default we only REFRESH an
      // existing profile here. We do NOT silently create a brand-new profile for
      // the generated URL, because users found it confusing that generating a
      // script auto-spawned extra App Profiles they never explicitly created.
      // A new profile is created only when the caller explicitly opts in via
      // `persistProfile: true` (e.g. a future "save as profile" toggle in the UI).
      // An existing profile already present for this URL is detected by
      // decideCrawlStrategy and is always refreshed.
      if (!crawlDecision.usedCache && result.rawCrawlData) {
        try {
          const allowCreate = persistProfile === true || !!crawlDecision.profile;
          const saved = await crawlOrchestrator.saveCrawlResult(
            url,
            result.rawCrawlData,
            companyId,
            { authConfig: sanitizedAuthConfig },
            projectId,
            { allowCreate, source: 'auto' },
          );
          // Learn patterns from the crawl (project-scoped) regardless — pattern
          // learning is independent of whether a profile row was persisted.
          await patternMatcher.learnPatterns(result.rawCrawlData, companyId, projectId);
          console.log(
            `[ScriptGen] Patterns learned for ${url}; profile ${saved ? `saved (id=${saved.id})` : 'not created (predictable mode — no existing profile, persistProfile not set)'}`,
          );
        } catch (profileErr: any) {
          console.warn(`[ScriptGen] Could not save profile (non-blocking): ${profileErr.message}`);
        }
      }

      const generationTimeMs = Date.now() - startTime;

      // Run validation
      const validator = new ValidationRunner();
      const validationReport = validator.validate(result.generatedFiles, result.testPlan);

      // Determine validation status. Provisionally set from code quality here;
      // downgraded below to reflect the honest execution-readiness score once
      // grounding + business coverage are known (so a 0%-grounded generic script
      // is never marked "passed" on the strength of clean syntax alone).
      let validationStatus = validationReport.overallScore >= 80 ? 'passed' : 'needs_review';

      // ── Sprint 4: Locator Resolution Report ──
      // Resolve a locator for each interactive element implied by the test case
      // steps, walking the priority cascade (App Profile DOM → Knowledge → Repo
      // patterns → smart fallbacks) and validating against the cached DOM. The
      // resulting report is persisted for locator-quality tracking. Best-effort.
      let locatorReport: LocatorReport | null = null;
      try {
        const crawlData: CrawlDataLike | null =
          (crawlDecision.usedCache && crawlDecision.crawlData)
            ? (crawlDecision.crawlData as CrawlDataLike)
            : (result.rawCrawlData as CrawlDataLike) ?? null;

        // Element descriptions come from the test case steps (preferred) or the
        // free-text instructions. Only run when we have something to resolve.
        const elementDescriptions = extractElementDescriptions(testCase, instructions);
        if (elementDescriptions.length > 0) {
          const minConfidence =
            locatorStrategy && typeof locatorStrategy.minConfidence === 'number'
              ? locatorStrategy.minConfidence
              : 50;
          const resolver = new LocatorResolver({
            crawlData,
            knowledgeItems: knowledgeItemsUsed as any[],
            repoProfile: repoProfile ?? null,
            minConfidence,
          });
          const { report } = resolver.resolveAll(elementDescriptions);
          locatorReport = report;
          console.log(`[ScriptGen] 🎯 Locator report — ${report.totalLocators} locators, validated=${report.validatedCount}, avgConfidence=${report.avgConfidence}, todo=${report.todoCount}`);
        }
      } catch (locErr: any) {
        console.warn(`[ScriptGen] Locator resolution non-blocking error: ${locErr?.message}`);
      }

      // ── Tier B: real locator grounding from the deterministic engine ──
      // The deterministic requirement/test-case paths ground every selector
      // against the cached App Profile DOM and emit a per-element grounding
      // report. When present, it is the source of truth for the "REAL LOCATORS
      // x/y" metric (it reflects selectors actually written into the generated
      // files), so it overrides the heuristic LocatorResolver report above.
      const engineGrounding = result.locatorGrounding;
      if (engineGrounding && engineGrounding.entries.length > 0) {
        // Honest "REAL LOCATORS x/y" headline (review fix #3): count every REAL,
        // non-hallucinated selector — both DOM-verified AND curated known-good
        // fallbacks (e.g. SauceDemo's documented `[data-test="error"]` that the
        // login-page crawl couldn't confirm). The previous metric only counted
        // DOM-verified locators, under-selling the curated real selectors as
        // "todo" and reporting a misleading ~50%. `validatedCount` now reflects
        // real locators; per-locator `validated` still distinguishes DOM-verified
        // (grounded) from known-good for full transparency.
        const realCount = engineGrounding.realCount ?? engineGrounding.groundedCount;
        // App-Profile-grounding KPI (customer proof point). Surfaced per spec so
        // the UI can show e.g. "22 locators · 20 from App Profile · 2 healed by
        // AI · 91% Repository Grounded · 9% AI". North-star: grow App-Profile %,
        // shrink AI % as the App Profile improves.
        const appProfileCount = engineGrounding.fromAppProfile ?? engineGrounding.groundedCount;
        const fallbackCount = engineGrounding.fromFallback ?? Math.max(0, realCount - appProfileCount);
        const aiCount = engineGrounding.fromAI ?? 0;
        const appProfilePct = engineGrounding.appProfilePct ?? (engineGrounding.total ? Math.round((appProfileCount / engineGrounding.total) * 100) : 0);
        const aiPct = engineGrounding.aiPct ?? (engineGrounding.total ? Math.round((aiCount / engineGrounding.total) * 100) : 0);
        locatorReport = {
          totalLocators: engineGrounding.total,
          validatedCount: realCount,
          avgConfidence: engineGrounding.avgConfidence,
          todoCount: Math.max(0, engineGrounding.total - realCount),
          // Provenance KPI buckets (App Profile vs curated fallback vs AI).
          appProfileCount,
          fallbackCount,
          aiCount,
          appProfilePct,
          aiPct,
          groundedPct: engineGrounding.groundedPct,
          provenanceSummary: `${engineGrounding.total} locators · ${appProfileCount} from App Profile · ${aiCount} healed by AI · ${appProfilePct}% Repository Grounded · ${aiPct}% AI`,
          locators: engineGrounding.entries.map((e) => ({
            element: e.name,
            selector: e.selector,
            confidence: e.confidence,
            source: e.source,
            // DOM-verified locators are validated; curated known-good fallbacks
            // are real but flagged "known" so the UI can show ✓ vs ◐.
            validated: e.grounded,
            status: e.grounded ? 'validated' : (e.knownGood ? 'known' : 'todo'),
          })),
        } as unknown as LocatorReport;
        console.log(`[ScriptGen] 🎯 Locator grounding — ${realCount}/${engineGrounding.total} real (${engineGrounding.realPct ?? 0}%), DOM-verified ${engineGrounding.groundedCount}/${engineGrounding.total} (${engineGrounding.groundedPct}%), avgConfidence=${engineGrounding.avgConfidence}`);
      }

      // ── Sprint 4: Folder Placement Decision ──
      // Decide where the primary generated test file should live, honouring the
      // repo's existing conventions and never overwriting existing files.
      let folderDecision: { testRoot?: string; targetDirectory?: string; fileName?: string; namingConvention?: string; reason?: string } | undefined;
      try {
        if (repoProfile) {
          const analyzer = new FolderStructureAnalyzer(repoProfile);
          const featureName = testCase?.title || instructions || 'generated test';
          const existingFiles = (repoProfile as any)?.testSuites?.map((s: any) => s.filePath).filter(Boolean) ?? [];
          const placement = analyzer.decidePlacement('test', String(featureName), existingFiles);
          folderDecision = {
            testRoot: analyzer.analyze().testRoot,
            targetDirectory: placement.directory,
            fileName: placement.fileName,
            namingConvention: placement.namingConvention,
            reason: placement.reason,
          };
          console.log(`[ScriptGen] 📁 Folder decision — ${placement.targetPath} (${placement.reason})`);
        }
      } catch (folderErr: any) {
        console.warn(`[ScriptGen] Folder analysis non-blocking error: ${folderErr?.message}`);
      }

      // ── Sprint 4: capture RTM coverage BEFORE linking (for the rtmUpdate delta) ──
      const coverageRequirementId: string | null =
        (testCase?.requirement_id as string) ||
        (testCase?.requirement?.id as string) ||
        (typeof requirementId === 'string' ? requirementId : null);
      let coverageBefore: { coverage_percentage?: number; status?: string } | null = null;
      // Sprint 4B — also snapshot the requirement's automation coverage BEFORE,
      // so the response can surface the automation delta once this test case is
      // marked automated.
      let automationCoverageBefore: { totalTestCases: number; automatedCount: number; automationPercentage: number } | null = null;
      if (coverageRequirementId && companyId != null) {
        try {
          const reqRow = await getRequirement(coverageRequirementId, companyId);
          if (reqRow) coverageBefore = { coverage_percentage: reqRow.coverage_percentage, status: reqRow.status };
        } catch { /* non-fatal */ }
        try {
          automationCoverageBefore = await getRequirementAutomationCoverage(coverageRequirementId, companyId);
        } catch { /* non-fatal */ }
      }

      // ── Honest reliability breakdown ─────────────────────────────────────
      // validationReport.overallScore is CODE QUALITY only (syntax/structure).
      // On its own it produced the misleading "100% reliable" headline on a
      // script whose locators were 0% grounded and whose files didn't match the
      // requirement. Decompose reliability into code quality, grounding quality
      // and business coverage, and combine them weakest-link so a zeroed
      // dimension collapses the headline execution-readiness score.
      const intendedTestCaseCount =
        (testCase ? 1 : 0) + requirementTestCases.length;
      // The deterministic engine stamps a real model name; the generic fallback
      // path reports a "fallback"/"rule-based" model. If we intended to generate
      // from real cases but the fallback ran, business coverage is 0.
      const ranGenericFallback = /fallback|rule[-_ ]?based/i.test(String(result.stats?.model ?? ''));
      const usedRealTestCases = intendedTestCaseCount > 0 && !ranGenericFallback;
      const grounding =
        locatorReport && (locatorReport as any).totalLocators > 0
          ? {
              grounded: (locatorReport as any).validatedCount ?? 0,
              total: (locatorReport as any).totalLocators ?? 0,
            }
          : null;
      const reliabilityBreakdown = computeReliabilityBreakdown({
        codeQuality: validationReport.overallScore,
        grounding,
        intendedTestCaseCount,
        usedRealTestCases,
      });
      console.log(`[ScriptGen] 📐 Reliability — ${reliabilityBreakdown.headline}`);
      // Honest status gate: a script is only "passed" when it is genuinely
      // execution-ready (code AND grounding AND coverage), not merely syntactic.
      validationStatus = reliabilityBreakdown.executionReadiness >= 80 ? 'passed' : 'needs_review';

      // ── Token attribution for deterministic (0-LLM-token) generations ──
      // The deterministic translator spends 0 LLM tokens turning a structured
      // test case into code — but that test case DID cost real tokens to
      // generate. Rather than show a misleading "0 tokens", attribute this
      // script's fair share of its source requirement's generation cost so
      // History shows an honest, non-zero figure. LLM (url/plain-English)
      // generations keep their real measured token count. Fail-open.
      let effectiveTokens = result.stats.tokensUsed ?? 0;
      let tokenSource: 'llm' | 'test-case-attributed' = effectiveTokens > 0 ? 'llm' : 'test-case-attributed';
      let tokenAttribution:
        | { perCaseTokens: number; totalTokens: number; testCaseCount: number }
        | undefined;
      if (effectiveTokens <= 0) {
        const srcReqId = Number(
          testCase?.scenario?.requirement_id ??
          requirementTestCases?.[0]?.scenario?.requirement_id ??
          NaN,
        );
        if (!Number.isNaN(srcReqId)) {
          const attr = await getTestCaseTokenAttribution(srcReqId, companyId ?? undefined);
          if (attr && attr.perCaseTokens > 0) {
            tokenAttribution = attr;
            // Requirement batch (N cases → one script row) attributes the sum of
            // the batch's cases; a single test case attributes its per-case share.
            const casesInThisScript = requirementTestCases.length > 0 ? requirementTestCases.length : 1;
            effectiveTokens = attr.perCaseTokens * casesInThisScript;
            console.log(`[ScriptGen] 🎟️ Attributed ${effectiveTokens} tokens from requirement ${srcReqId} (${attr.perCaseTokens}/case × ${casesInThisScript}, req total ${attr.totalTokens}/${attr.testCaseCount} cases)`);
          } else {
            tokenSource = 'llm'; // nothing to attribute — leave as measured (0)
          }
        } else {
          tokenSource = 'llm';
        }
      }

      // Build intelligence metadata — tracks every intelligence source used
      const intelligenceMetadata = {
        repoIntelligenceUsed: !!repoIntelligence,
        repoId: repoId ?? undefined,
        repoFramework: repoProfile?.framework,
        repoTestPattern: repoProfile?.testPattern,
        repoHelperCount: repoProfile?.helperFunctions?.length ?? 0,
        repoPageObjectCount: repoProfile?.pageObjects?.length ?? 0,
        adaptiveCodegenUsed: !!repoProfile,
        adaptiveMode: repoProfile ? (repoProfile.pageObjects?.length ? 'pom' : 'flat') : undefined,
        knowledgeItemsUsed: knowledgeItemsUsed.length,
        knowledgeItemIds: knowledgeItemsUsed.map((ki: any) => ki.id),
        profileCacheUsed: crawlDecision.usedCache,
        crawlDecisionReason: crawlDecision.reason,
        profileId: crawlDecision.profile?.id ?? undefined,
        // Multi-intelligence fusion
        fusionConfidenceScore: fusion?.confidenceScore,
        fusionSourcesUsed: fusion?.fusionMetadata.sourcesUsed ?? [],
        fusionMissingCritical: fusion?.fusionMetadata.missingCritical ?? [],
        fusionWarnings: fusion?.fusionMetadata.warnings ?? [],
        // ── Sprint 4: Enterprise Script Generation Enhancement ──
        intelligenceSources: fusion?.fusionMetadata.sourceBreakdown ?? [],
        testCaseDataUsed: !!(fusion?.testCaseData && fusion.testCaseData.stepCount > 0),
        testCaseId: testCaseId != null ? Number(testCaseId) : undefined,
        generationSource,
        locatorStrategy: typeof locatorStrategy === 'object' ? JSON.stringify(locatorStrategy) : (locatorStrategy ?? undefined),
        folderStrategy: typeof folderStrategy === 'object' ? JSON.stringify(folderStrategy) : (folderStrategy ?? undefined),
        ...(locatorReport ? { locatorConfidence: locatorReport.avgConfidence, locatorTodoCount: locatorReport.todoCount } : {}),
        ...(folderDecision ? { folderDecision } : {}),
        // Honest, decomposed reliability (code / grounding / business coverage /
        // execution readiness) so History never shows a misleading single 100%.
        reliabilityBreakdown,
        // Token provenance so the UI can label the number honestly: 'llm' = real
        // measured tokens from the model; 'test-case-attributed' = this script's
        // share of its source requirement's generation cost (deterministic path).
        tokenSource,
        ...(tokenAttribution ? { tokenAttribution } : {}),
      };

      console.log(`[ScriptGen] 📊 Intelligence summary: repoIntel=${intelligenceMetadata.repoIntelligenceUsed} (${intelligenceMetadata.repoFramework ?? 'n/a'}), knowledge=${intelligenceMetadata.knowledgeItemsUsed} items, cache=${intelligenceMetadata.profileCacheUsed}, adaptive=${intelligenceMetadata.adaptiveCodegenUsed} (${intelligenceMetadata.adaptiveMode ?? 'n/a'})`);

      // Persist to DB (now includes intelligence_metadata)
      const scriptId = await logGeneratedScript({
        url: config.url,
        test_case_id: testCaseId != null ? Number(testCaseId) : null,
        page_type: result.testPlan?.pageType || 'unknown',
        workflow_graph: null,
        instructions: config.instructions,
        script_content: result.generatedFiles.map((f: GeneratedFile) => `// === ${f.path} ===\n${f.content}`).join('\n\n'),
        test_plan: {
          ...result.testPlan,
          knowledgeItemIds: knowledgeItemsUsed.map((ki: any) => ki.id),
          knowledgeItemTitles: knowledgeItemsUsed.map((ki: any) => ki.title),
        },
        validation_status: validationStatus,
        // HONEST headline score: execution readiness (weakest-link of code
        // quality × grounding × business coverage), NOT the code-only score.
        // A syntactically perfect but 0%-grounded generic script now persists a
        // low reliability score instead of a misleading 100%.
        reliability_score: reliabilityBreakdown.executionReadiness,
        // effectiveTokens = real measured LLM tokens, OR (for deterministic
        // test-case generation) this script's attributed share of the source
        // requirement's generation cost. Never a misleading bare 0.
        tokens_used: effectiveTokens,
        model: result.stats.model,
        generation_time_ms: generationTimeMs,
        files_generated: result.generatedFiles.map((f: GeneratedFile) => ({ path: f.path, size: f.content.length, type: f.type })),
        negative_tests_included: config.includeNegativeTests,
        intelligence_metadata: intelligenceMetadata,
        environment_id: environmentId ?? null,
        sprint_id: sprintId ?? null,
        // ── Sprint 4: RTM requirement link, provenance, locator report ──
        requirement_id: coverageRequirementId ?? null,
        generation_source: generationSource,
        locator_report: locatorReport ?? {},
      }, companyId, projectId);

      console.log(`[ScriptGen] ✅ Generation complete — ID ${scriptId}, ${result.generatedFiles.length} files, ${generationTimeMs}ms, project=${projectId || 'none'}`);

      // RTM: auto-link the script to its test case (and the resolved requirement).
      // Best-effort — never let traceability failures break script generation.
      // Sprint 4 — capture the links created + the coverage delta for `rtmUpdate`.
      let rtmUpdate: {
        requirementId: string | null;
        linksCreated: string[];
        coverageBefore: number | null;
        coverageAfter: number | null;
        statusBefore: string | null;
        statusAfter: string | null;
      } | undefined;
      // Sprint 4B — automation marking + the requirement's automation-coverage delta.
      let automationUpdate: {
        testCaseId: number;
        isAutomated: boolean;
        scriptId: number;
        coverageBefore: { totalTestCases: number; automatedCount: number; automationPercentage: number } | null;
        coverageAfter: { totalTestCases: number; automatedCount: number; automationPercentage: number } | null;
      } | undefined;
      if (testCaseId != null && companyId != null) {
        try {
          const linkResult = await autoLinkScriptTraceability({
            scriptId,
            testCaseId: Number(testCaseId),
            companyId,
            projectId: projectId ?? null,
            userId: (req as any).userId ?? null,
            // Sprint 4 — pass an explicit requirement so the link is established
            // even if the test case wasn't previously linked to one.
            requirementId: coverageRequirementId ?? null,
          });

          // Re-read coverage AFTER the DB triggers fired to surface the delta.
          const resolvedReqId = linkResult.requirementId ?? coverageRequirementId;
          let coverageAfter: { coverage_percentage?: number; status?: string } | null = null;
          if (resolvedReqId) {
            try {
              const reqRow = await getRequirement(resolvedReqId, companyId);
              if (reqRow) coverageAfter = { coverage_percentage: reqRow.coverage_percentage, status: reqRow.status };
            } catch { /* non-fatal */ }
          }

          rtmUpdate = {
            requirementId: resolvedReqId ?? null,
            linksCreated: linkResult.linksCreated,
            coverageBefore: coverageBefore?.coverage_percentage ?? null,
            coverageAfter: coverageAfter?.coverage_percentage ?? coverageBefore?.coverage_percentage ?? null,
            statusBefore: coverageBefore?.status ?? null,
            statusAfter: coverageAfter?.status ?? coverageBefore?.status ?? null,
          };
          console.log(`[ScriptGen] 🔗 RTM update — requirement=${rtmUpdate.requirementId ?? 'none'}, links=[${rtmUpdate.linksCreated.join(', ')}], coverage ${rtmUpdate.coverageBefore ?? '-'}%→${rtmUpdate.coverageAfter ?? '-'}%`);

          // Sprint 4B — mark the test case as automated now that a script exists.
          // Flips is_automated=true and records last_automated_script_id/_at.
          // Best-effort: never let automation tracking break script generation.
          let isAutomated = false;
          try {
            isAutomated = await markTestCaseAutomated(Number(testCaseId), scriptId, companyId);
            console.log(`[ScriptGen] ✅ Marked test case #${testCaseId} as automated (script #${scriptId})`);
          } catch (markErr: any) {
            console.warn(`[ScriptGen] ⚠️ Could not mark test case automated (non-fatal): ${markErr?.message}`);
          }

          // Re-read the requirement's automation coverage AFTER marking.
          let automationCoverageAfter: { totalTestCases: number; automatedCount: number; automationPercentage: number } | null = null;
          if (resolvedReqId) {
            try {
              automationCoverageAfter = await getRequirementAutomationCoverage(resolvedReqId, companyId);
            } catch { /* non-fatal */ }
          }

          automationUpdate = {
            testCaseId: Number(testCaseId),
            isAutomated,
            scriptId,
            coverageBefore: automationCoverageBefore,
            coverageAfter: automationCoverageAfter ?? automationCoverageBefore,
          };
          console.log(`[ScriptGen] 📈 Automation coverage ${automationUpdate.coverageBefore?.automationPercentage ?? '-'}%→${automationUpdate.coverageAfter?.automationPercentage ?? '-'}%`);
        } catch (linkErr: any) {
          console.warn(`[ScriptGen] ⚠️ Traceability auto-link failed (non-fatal): ${linkErr?.message}`);

          // Even if RTM linking failed, still try to mark the test case automated.
          try {
            const isAutomated = await markTestCaseAutomated(Number(testCaseId), scriptId, companyId);
            automationUpdate = {
              testCaseId: Number(testCaseId),
              isAutomated,
              scriptId,
              coverageBefore: automationCoverageBefore,
              coverageAfter: automationCoverageBefore,
            };
            console.log(`[ScriptGen] ✅ Marked test case #${testCaseId} as automated (script #${scriptId}) [post-link-failure]`);
          } catch (markErr: any) {
            console.warn(`[ScriptGen] ⚠️ Could not mark test case automated (non-fatal): ${markErr?.message}`);
          }
        }
      }

      res.json({
        success: true,
        data: {
          id: scriptId,
          url: config.url,
          filesGenerated: result.generatedFiles.length,
          files: result.generatedFiles.map((f: GeneratedFile) => ({ path: f.path, size: f.content.length, type: f.type })),
          testPlan: result.testPlan,
          validationReport,
          // Honest, TRIMMED reliability — only the four headline numbers the UI
          // needs: executionReadiness (weakest-link) + its code/grounding/
          // coverage components. The dashboard must headline
          // `reliability.executionReadiness`, NOT validationReport.overallScore
          // (code-only). The detailed weighting/dimensions/copy stay internal
          // (persisted in intelligence_metadata) so scoring can evolve without a
          // frozen public contract.
          reliability: toPublicReliability(reliabilityBreakdown),
          stats: result.stats,
          generationTimeMs,
          errors: result.errors,
          // Auth metadata — never includes credential values
          ...(result.authResult ? {
            authentication: {
              attempted: true,
              success: result.authResult.success,
              strategy: result.authResult.strategy,
              message: result.authResult.message,
              captchaDetected: result.authResult.captchaDetected,
              rateLimited: result.authResult.rateLimited,
              cookieCount: result.authResult.cookieNames?.length ?? 0,
            },
          } : {}),
          // Full intelligence metadata — what sources powered this generation
          intelligence: {
            profileCacheUsed: crawlDecision.usedCache,
            crawlDecisionReason: crawlDecision.reason,
            crawlDecisionTimeMs: crawlDecision.decisionTimeMs,
            profileId: crawlDecision.profile?.id ?? null,
            // Truthful crawl grounding signal for the UI. The dashboard derives
            // its "App Profile Used" vs "AI only" label from this. A cached App
            // Profile DOM is the fast path; a fresh crawl is the slow path.
            crawlStrategy: crawlDecision.usedCache ? 'FAST_PATH' : 'SLOW_PATH',
            crawlTimeMs: result.stats?.crawlTimeMs ?? 0,
            // Repository intelligence details
            repoIntelligenceUsed: !!repoIntelligence,
            repoId: repoId ?? null,
            repoFramework: repoProfile?.framework ?? null,
            repoTestPattern: repoProfile?.testPattern ?? null,
            repoHelperCount: repoProfile?.helperFunctions?.length ?? 0,
            repoPageObjectCount: repoProfile?.pageObjects?.length ?? 0,
            // Adaptive codegen details
            adaptiveCodegenUsed: !!repoProfile,
            adaptiveMode: repoProfile ? (repoProfile.pageObjects?.length ? 'pom' : 'flat') : null,
            // Knowledge items used
            knowledgeItemsUsed: knowledgeItemsUsed.length,
            knowledgeItemIds: knowledgeItemsUsed.map((ki: any) => ki.id),
            // Multi-intelligence fusion — overall confidence + per-source breakdown
            confidenceScore: fusion?.confidenceScore ?? null,
            sourcesUsed: fusion?.fusionMetadata.sourcesUsed ?? [],
            missingCritical: fusion?.fusionMetadata.missingCritical ?? [],
            warnings: fusion?.fusionMetadata.warnings ?? [],
            recommendation: fusion ? IntelligenceFusionService.recommendationFor(fusion.confidenceScore) : null,
            // Sprint 4: test-case-driven generation source + folder decision
            generationSource,
            testCaseId: testCase?.id ?? null,
            testCaseDataUsed: !!testCase,
            ...(folderDecision ? { folderDecision } : {}),
          },
          // Sprint 4: locator resolution report (element → locator + confidence)
          ...(locatorReport ? { locatorReport } : {}),
          // Sprint 4: RTM auto-update result (requirement link + coverage delta)
          ...(rtmUpdate ? { rtmUpdate } : {}),
          // Sprint 4B: automation marking + automation-coverage delta (before/after)
          ...(automationUpdate ? { automationUpdate } : {}),
          // Pipeline funnel + per-case trace, ALSO on success — so a PARTIAL
          // generation (e.g. 8/12 cases emitted) surfaces WHICH cases dropped and
          // why, directly in the UI diagnostics panel (not only on total failure).
          ...(result.pipeline
            ? { pipeline: { ...result.pipeline, cases: result.pipeline.cases.slice(0, 25) } }
            : {}),
          // Non-fatal warnings the deterministic engine collected (test-data
          // normalization reshapes, unmapped steps under warn policy). Surfaced so
          // the UI can show them even when generation otherwise succeeded.
          ...(result.testDataWarnings && result.testDataWarnings.length > 0
            ? { testDataWarnings: result.testDataWarnings.slice(0, 25) }
            : {}),
          ...(result.unmappedSteps && result.unmappedSteps.length > 0
            ? { unmappedSteps: result.unmappedSteps.slice(0, 25) }
            : {}),
        },
      });
    } catch (err: any) {
      // Honest failure for test-case / requirement intent. The engine now
      // REFUSES to fall back to the generic workflow generator when real cases
      // were supplied but produced nothing — it throws this typed error instead
      // of emitting 4 ungrounded specs dressed up as a 100% success. Surface it
      // as an actionable 422 so the dashboard routes the user to review /
      // regenerate the test cases rather than shipping fake scripts.
      if (err instanceof DeterministicGenerationEmptyError) {
        console.warn(
          `[ScriptGen] ❌ Deterministic generation from ${err.intendedCaseCount} case(s) produced nothing — refusing generic fallback`,
        );
        return res.status(422).json({
          success: false,
          error:
            'These test cases could not be turned into grounded scripts (no automatable steps resolved against the app). ' +
            'Review or regenerate the test cases in Test Case Lab, then try again. ' +
            'Generation will not silently emit generic, ungrounded scripts.',
          code: 'DETERMINISTIC_GENERATION_EMPTY',
          intendedTestCaseCount: err.intendedCaseCount,
          resolvedTestCaseCount: err.pipeline?.generatedScripts ?? 0,
          caseErrors: err.caseErrors.slice(0, 10),
          // Pipeline observability (user request) — the funnel + per-case trace
          // that pinpoints WHERE the count dropped to zero (canonicalization /
          // parsing / grounding / emit), so "nothing generated" is localizable
          // in one screen without SQL or logs.
          pipeline: err.pipeline
            ? { ...err.pipeline, cases: err.pipeline.cases.slice(0, 25) }
            : undefined,
          nextAction: 'REVIEW_TEST_CASES',
        });
      }
      console.error('[ScriptGen] Generation error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Paginated Script History (project-filtered) ──────── */
  router.get('/history', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;
      const sortBy = (req.query.sortBy as string) || 'created_at';
      const sortOrder = (req.query.sortOrder as string) || 'DESC';

      const { records, total } = await getScriptHistory(companyId, { projectId, limit, offset, sortBy, sortOrder });

      // Read-time token backfill for LEGACY rows: scripts generated before the
      // write-path attribution landed persisted tokens_used = 0. For any such
      // row that is linked to a test case, attribute its fair share of the
      // source requirement's generation cost so History shows an honest,
      // non-zero token figure. One batched query (no N+1). Fail-open.
      let attributionMap = new Map<number, { perCaseTokens: number; totalTokens: number; testCaseCount: number }>();
      try {
        const legacyIds = records
          .filter((r: any) => (!r.tokens_used || Number(r.tokens_used) <= 0) && r.test_case_id != null)
          .map((r: any) => Number(r.id));
        if (legacyIds.length > 0) {
          attributionMap = await getAttributedTokensForScripts(legacyIds);
        }
      } catch (attrErr: any) {
        console.warn('[ScriptGen] token attribution backfill skipped:', attrErr?.message);
      }

      // Sprint 4B — enrich each record with a structured per-file breakdown
      // parsed from the stored `script_content` blob. `script_content` is kept
      // for backward compatibility; the new `files` array powers the redesigned
      // file-wise history view (filename, content, language, framework, …).
      const data = records.map((rec: any) => {
        const attr = attributionMap.get(Number(rec.id));
        // Only override a falsy/zero token count; never clobber a real measured one.
        const tokensUsed = (!rec.tokens_used || Number(rec.tokens_used) <= 0) && attr
          ? attr.perCaseTokens
          : rec.tokens_used;
        // Merge a tokenSource marker into intelligence_metadata for the UI label.
        let intel = rec.intelligence_metadata;
        if (attr) {
          let parsed: any = {};
          if (typeof intel === 'string') {
            try { parsed = JSON.parse(intel) || {}; } catch { parsed = {}; }
          } else {
            parsed = intel || {};
          }
          intel = { ...parsed, tokenSource: 'test-case-attributed', tokenAttribution: attr };
        }
        return {
          ...rec,
          tokens_used: tokensUsed,
          intelligence_metadata: intel,
          files: parseScriptContent(rec.script_content, rec.files_generated),
        };
      });

      res.json({
        success: true,
        data,
        pagination: { total, limit, offset, hasMore: offset + limit < total },
      });
    } catch (err: any) {
      console.error('[ScriptGen] history error:', err);
      res.status(500).json({ success: false, error: 'Failed to fetch script history', details: err.message });
    }
  });

  /* ── Recent Generations (project-filtered) ───────────────── */
  router.get('/recent', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const pid = (req as any).projectId as number | undefined;
      const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
      const scripts = await getRecentScripts(limit, cid, pid);
      res.json({ success: true, data: scripts, count: scripts.length });
    } catch (err: any) {
      console.error('[ScriptGen] recent error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Download Script Content ─────────────────────────────── */
  router.get('/:id/download', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script ID' });
      }
      const script = await getGeneratedScript(id, companyId, projectId);
      if (!script) {
        return res.status(404).json({ success: false, error: 'Script not found' });
      }
      const code = script.script_content || '';
      if (!code) {
        return res.status(404).json({ success: false, error: 'Script content not found' });
      }

      const safeName = (script.url || 'test').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
      const dateStr = new Date().toISOString().split('T')[0];

      // Reconstruct the individual generated files (tests/, pages/, fixtures/, …)
      // from the stored blob. A generation almost always produces MULTIPLE files,
      // so the correct download artifact is a zip archive that preserves the repo
      // folder structure — not a single concatenated `.spec.ts` (Bug #2).
      const files = parseScriptContent(script.script_content, script.files_generated);

      // Fallback: if for some reason the blob couldn't be split into discrete
      // files, serve the raw content as a single .ts file (previous behaviour).
      if (files.length <= 1) {
        const single = files[0];
        const body = single ? single.content : code;
        const filename = single?.filename || `${safeName}_${dateStr}.spec.ts`;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        return res.send(body);
      }

      // Build a zip archive preserving each file's repo-relative path so the user
      // gets a ready-to-use folder tree (tests/…, pages/…, fixtures/…).
      const zip = new JSZip();
      for (const f of files) {
        // Guard against absolute/escaping paths; keep them repo-relative.
        const safePath = f.path.replace(/^[/\\]+/, '').replace(/\.\.[/\\]/g, '');
        zip.file(safePath || f.filename, f.content);
      }

      const zipBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      const zipName = `${safeName}_${dateStr}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);
      res.setHeader('Content-Length', String(zipBuffer.length));
      console.log(`[ScriptGen] 📦 Zipped ${files.length} file(s) for download → ${zipName}`);
      return res.send(zipBuffer);
    } catch (err: any) {
      console.error('[ScriptGen] download error:', err);
      res.status(500).json({ success: false, error: 'Failed to download script', details: err.message });
    }
  });

  /* ── Get Specific Script (project-filtered) ──────────────── */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const pid = (req as any).projectId as number | undefined;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script ID' });
      }
      const script = await getGeneratedScript(id, cid, pid);
      if (!script) {
        return res.status(404).json({ success: false, error: 'Script not found' });
      }
      res.json({ success: true, data: script });
    } catch (err: any) {
      console.error('[ScriptGen] get error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Soft Delete Script (project-filtered) ───────────────── */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const projectId = (req as any).projectId as number | undefined;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script ID' });
      }
      const deleted = await softDeleteScript(id, companyId, projectId);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Script not found or already deleted' });
      }
      res.json({ success: true, message: 'Script deleted successfully' });
    } catch (err: any) {
      console.error('[ScriptGen] delete error:', err);
      res.status(500).json({ success: false, error: 'Failed to delete script', details: err.message });
    }
  });

  /* ── AI Review ──────────────────────────────────────────── */
  router.post('/:id/review', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script ID' });
      }

      const script = await getGeneratedScript(id);
      if (!script) {
        return res.status(404).json({ success: false, error: 'Script not found' });
      }

      if (!script.files_generated) {
        return res.status(400).json({ success: false, error: 'No files to review' });
      }

      console.log(`[ScriptGen] Running AI review on script #${id}`);

      // Reconstruct GeneratedFile[] from stored data
      const generatedFiles: GeneratedFile[] = reconstructGeneratedFiles(
        script.script_content,
        script.files_generated,
      );

      const reviewer = new AIReviewEngine();
      const reviewResult = await reviewer.review(generatedFiles, script.test_plan || undefined);

      // Persist review results
      await updateScriptReview(id, reviewResult.score, reviewResult.issues);

      res.json({
        success: true,
        data: {
          scriptId: id,
          score: reviewResult.score,
          criticalCount: reviewResult.criticalCount,
          warningCount: reviewResult.warningCount,
          infoCount: reviewResult.infoCount,
          issueCount: reviewResult.issues.length,
          issues: reviewResult.issues,
          reviewTimeMs: reviewResult.reviewTimeMs,
          tokensUsed: reviewResult.tokensUsed,
        },
      });
    } catch (err: any) {
      console.error('[ScriptGen] review error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Export Project ─────────────────────────────────────── */
  router.post('/:id/export', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script ID' });
      }

      const script = await getGeneratedScript(id);
      if (!script) {
        return res.status(404).json({ success: false, error: 'Script not found' });
      }

      if (!script.files_generated) {
        return res.status(400).json({ success: false, error: 'No files to export' });
      }

      console.log(`[ScriptGen] Exporting project for script #${id}`);

      // Reconstruct GeneratedFile[] from stored content
      const generatedFiles: GeneratedFile[] = reconstructGeneratedFiles(
        script.script_content,
        script.files_generated,
      );

      const exporter = new ProjectExportEngine();
      const outputDir = path.join(os.tmpdir(), `levelup-export-${id}-${Date.now()}`);

      const fakeResult: GenerationResult = {
        testPlan: script.test_plan || { name: 'export', description: '', baseUrl: script.url, pageType: 'unknown', flows: [], fixtures: [], pageObjects: [], metadata: { generatedAt: '', crawlTimeMs: 0, totalElements: 0, selectorQuality: 0, model: 'unknown', tokensUsed: 0 } },
        generatedFiles,
        stats: {
          totalTests: 0,
          totalAssertions: 0,
          avgSelectorScore: 0,
          pageObjectsGenerated: 0,
          crawlTimeMs: 0,
          generationTimeMs: 0,
          tokensUsed: 0,
          model: 'unknown',
        },
        errors: [],
      };

      const exportResult = exporter.exportProject(fakeResult, outputDir);

      // Persist export
      await logProjectExport({
        script_id: id,
        project_dir: exportResult.projectDir,
        file_count: exportResult.fileCount,
        total_size: exportResult.totalSize,
        structure: exportResult.structure,
      });

      res.json({
        success: true,
        data: {
          scriptId: id,
          projectDir: exportResult.projectDir,
          fileCount: exportResult.fileCount,
          totalSize: exportResult.totalSize,
          structure: exportResult.structure,
        },
      });
    } catch (err: any) {
      console.error('[ScriptGen] export error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Push to GitHub Repository ──────────────────────────── */
  router.post('/:id/push', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script ID' });
      }

      const { repoUrl, baseBranch, branchName, createPullRequest } = req.body;
      if (!repoUrl) {
        return res.status(400).json({ success: false, error: 'repoUrl is required' });
      }

      const githubToken = process.env['GITHUB_TOKEN'];
      if (!githubToken) {
        return res.status(400).json({ success: false, error: 'GITHUB_TOKEN not configured on backend' });
      }

      const script = await getGeneratedScript(id);
      if (!script) {
        return res.status(404).json({ success: false, error: 'Script not found' });
      }

      if (!script.files_generated || !script.script_content) {
        return res.status(400).json({ success: false, error: 'No generated files to push' });
      }

      console.log(`[ScriptGen] Pushing script #${id} to GitHub: ${repoUrl}`);

      // Reconstruct generated files from stored content
      const generatedFiles: GeneratedFile[] = reconstructGeneratedFiles(
        script.script_content,
        script.files_generated,
      );

      // Export to a temp directory first
      const exporter = new ProjectExportEngine();
      const outputDir = path.join(os.tmpdir(), `levelup-push-${id}-${Date.now()}`);

      const fakeResult: GenerationResult = {
        testPlan: script.test_plan || { name: 'export', description: '', baseUrl: script.url, pageType: 'unknown', flows: [], fixtures: [], pageObjects: [], metadata: { generatedAt: '', crawlTimeMs: 0, totalElements: 0, selectorQuality: 0, model: 'unknown', tokensUsed: 0 } },
        generatedFiles,
        stats: { totalTests: 0, totalAssertions: 0, avgSelectorScore: 0, pageObjectsGenerated: 0, crawlTimeMs: 0, generationTimeMs: 0, tokensUsed: 0, model: 'unknown' },
        errors: [],
      };

      exporter.exportProject(fakeResult, outputDir);

      // Clone the target repo
      const parsed = parseRepoUrl(repoUrl);
      if (!parsed) {
        return res.status(400).json({ success: false, error: 'Invalid GitHub repository URL' });
      }

      const cloneDir = path.join(os.tmpdir(), `levelup-repo-${parsed.repo}-${Date.now()}`);
      const cloneUrl = `https://x-access-token:${githubToken}@github.com/${parsed.owner}/${parsed.repo}.git`;
      const base = baseBranch || 'main';
      const branch = branchName || `levelup/generated-tests-${id}-${Date.now()}`;

      try {
        // Clone repo
        const { execSync } = require('child_process');
        execSync(`git clone --depth 1 --branch ${base} ${cloneUrl} ${cloneDir}`, {
          encoding: 'utf-8',
          timeout: 60_000,
        });

        // Copy generated files into the cloned repo
        const copyFiles = (src: string, dest: string) => {
          const entries = fs.readdirSync(src, { withFileTypes: true });
          for (const entry of entries) {
            const srcPath = path.join(src, entry.name);
            const destPath = path.join(dest, entry.name);
            if (entry.isDirectory()) {
              fs.mkdirSync(destPath, { recursive: true });
              copyFiles(srcPath, destPath);
            } else {
              fs.mkdirSync(path.dirname(destPath), { recursive: true });
              fs.copyFileSync(srcPath, destPath);
            }
          }
        };
        copyFiles(outputDir, cloneDir);

        // Create branch, commit, push
        createBranch(cloneDir, branch, base);
        const commitSha = commitAll(cloneDir, `test: add AI-generated test scripts (LevelUp Script #${id})\n\nGenerated for: ${script.url}\nReliability score: ${script.reliability_score || 'N/A'}%\nFiles: ${generatedFiles.length}`);

        if (!commitSha) {
          return res.json({
            success: true,
            data: {
              message: 'No changes to push — files may already exist in the repository',
              branchName: branch,
            },
          });
        }

        pushBranch(cloneDir, branch);

        // Optionally create a PR
        let prInfo = null;
        if (createPullRequest !== false) {
          const pr = await createPR({
            githubToken,
            owner: parsed.owner,
            repo: parsed.repo,
            head: branch,
            base,
            title: `🧪 LevelUp: AI-Generated Test Scripts (#${id})`,
            body: [
              `## 🤖 AI-Generated Test Scripts`,
              '',
              `**Target URL:** ${script.url}`,
              `**Page Type:** ${script.page_type || 'unknown'}`,
              `**Reliability Score:** ${script.reliability_score || 'N/A'}%`,
              `**Files Generated:** ${generatedFiles.length}`,
              '',
              `### Generated Files`,
              ...generatedFiles.map(f => `- \`${f.path}\` (${f.type})`),
              '',
              `### Test Plan`,
              script.test_plan ? `\`\`\`json\n${JSON.stringify(script.test_plan, null, 2).slice(0, 2000)}\n\`\`\`` : 'N/A',
              '',
              `---`,
              `*Generated by [LevelUp AI QA](https://leveluptesting.in) Script Generation Engine*`,
            ].join('\n'),
            labels: ['levelup-ai', 'generated-tests'],
          });

          if (pr) {
            prInfo = { prUrl: pr.url, prNumber: pr.number };
          }
        }

        console.log(`[ScriptGen] ✅ Pushed to GitHub — branch: ${branch}, PR: ${prInfo?.prUrl || 'none'}`);

        // Cleanup temp directories
        try {
          fs.rmSync(outputDir, { recursive: true, force: true });
          fs.rmSync(cloneDir, { recursive: true, force: true });
        } catch { /* non-critical */ }

        res.json({
          success: true,
          data: {
            scriptId: id,
            repoUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
            branchName: branch,
            branchUrl: `https://github.com/${parsed.owner}/${parsed.repo}/tree/${branch}`,
            commitSha,
            filesCount: generatedFiles.length,
            pullRequest: prInfo,
          },
        });
      } catch (gitErr: any) {
        // Cleanup on error
        try {
          fs.rmSync(outputDir, { recursive: true, force: true });
          fs.rmSync(cloneDir, { recursive: true, force: true });
        } catch { /* non-critical */ }
        throw gitErr;
      }
    } catch (err: any) {
      console.error('[ScriptGen] push error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Maintenance Suite: Script Sync ──────────────────────────
   * POST /api/scripts/:id/sync
   *
   * Re-validate a script's locators against the *latest* crawl of its target
   * app and auto-repair selectors that no longer resolve. Returns the list of
   * proposed/applied changes. `apply` (default true) persists the rewritten
   * script (after taking a versioned backup); `dryRun: true` previews only.
   *
   * Body: { dryRun?: boolean }
   * Resp: { success, data: { changes, outdatedCount, replacedCount, unresolved, summary, applied, backupVersion } }
   */
  router.post('/:id/sync', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script ID' });
      }
      const dryRun = req.body?.dryRun === true;

      const script = await getGeneratedScript(id, companyId, projectId);
      if (!script) {
        return res.status(404).json({ success: false, error: 'Script not found' });
      }

      // Load the latest crawl for the script's target app.
      let crawlData: CrawlDataLike | null = null;
      try {
        const origin = (() => { try { return new URL(script.url).origin; } catch { return script.url; } })();
        const profile =
          (await getProfileByUrl(script.url, companyId, projectId)) ||
          (await getProfileByUrl(origin, companyId, projectId));
        crawlData = (profile?.crawl_data as CrawlDataLike) ?? null;
      } catch (profErr: any) {
        console.warn(`[ScriptGen] sync: profile lookup failed: ${profErr?.message}`);
      }
      if (!crawlData) {
        return res.status(400).json({
          success: false,
          error: 'No crawl data available for this app. Re-crawl the application before syncing.',
        });
      }

      const result = syncScript({
        scriptContent: script.script_content,
        filesGenerated: script.files_generated,
        locatorReport: (script.locator_report as any) ?? null,
        newCrawlData: crawlData,
        apply: !dryRun,
      });

      let applied = false;
      let backupVersion: number | null = null;
      if (!dryRun && result.newScriptContent && result.changes.length) {
        try {
          const backup = await saveScriptVersion({
            scriptId: id, companyId, projectId, reason: 'pre-sync',
            scriptContent: script.script_content, filesGenerated: script.files_generated,
          });
          backupVersion = backup?.version ?? null;
        } catch (bErr: any) {
          console.warn(`[ScriptGen] sync: backup failed (continuing): ${bErr?.message}`);
        }
        applied = await updateScriptContent(id, result.newScriptContent, script.files_generated, companyId, projectId);
      }

      console.log(`[ScriptGen] 🔧 sync #${id} — ${result.outdatedCount} outdated, ${result.changes.length} repaired, applied=${applied}`);

      // Loop 3: learn every confident old→new rewrite into the maintenance
      // pattern library so the healing engine can reuse it instantly later.
      // Fire-and-forget — never blocks or fails the sync response.
      if (result.changes.length) {
        learnFromSyncChanges(result.changes, { companyId, projectId }).catch((e) =>
          console.warn(`[ScriptGen] sync: pattern learning failed: ${e?.message}`));
      }

      res.json({
        success: true,
        data: {
          changes: result.changes,
          outdatedCount: result.outdatedCount,
          replacedCount: result.replacedCount,
          unresolved: result.unresolved,
          summary: result.summary,
          applied,
          dryRun,
          backupVersion,
        },
      });
    } catch (err: any) {
      console.error('[ScriptGen] sync error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Maintenance Suite: Smart Regeneration ───────────────────
   * POST /api/scripts/:id/regenerate
   *
   * Refresh a script's page-objects/locators against the latest crawl while
   * preserving hand-written test logic. The existing script is parsed with the
   * TypeScript compiler API to extract test data, assertions and custom regions
   * (`@preserve-start/-end`), which are merged back over the regenerated
   * implementation. A versioned backup is always taken first.
   *
   * Body: { dryRun?: boolean, preserveTestData?, preserveAssertions?, preserveCustomRegions? }
   * Resp: { success, data: { files, mergeReport, syncSummary, applied, backupVersion } }
   */
  router.post('/:id/regenerate', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const id = parseInt(req.params.id as string);
      if (isNaN(id)) {
        return res.status(400).json({ success: false, error: 'Invalid script ID' });
      }
      const dryRun = req.body?.dryRun === true;
      const mergeOptions: MergeOptions = {
        preserveTestData: req.body?.preserveTestData !== false,
        preserveAssertions: req.body?.preserveAssertions !== false,
        preserveCustomRegions: req.body?.preserveCustomRegions !== false,
      };

      const script = await getGeneratedScript(id, companyId, projectId);
      if (!script) {
        return res.status(404).json({ success: false, error: 'Script not found' });
      }

      // Latest crawl → refresh locators (page-object regeneration core).
      let crawlData: CrawlDataLike | null = null;
      try {
        const origin = (() => { try { return new URL(script.url).origin; } catch { return script.url; } })();
        const profile =
          (await getProfileByUrl(script.url, companyId, projectId)) ||
          (await getProfileByUrl(origin, companyId, projectId));
        crawlData = (profile?.crawl_data as CrawlDataLike) ?? null;
      } catch (profErr: any) {
        console.warn(`[ScriptGen] regenerate: profile lookup failed: ${profErr?.message}`);
      }
      if (!crawlData) {
        return res.status(400).json({
          success: false,
          error: 'No crawl data available for this app. Re-crawl the application before regenerating.',
        });
      }

      // 1. Regenerate locators/page-objects against the new crawl.
      const sync = syncScript({
        scriptContent: script.script_content,
        filesGenerated: script.files_generated,
        locatorReport: (script.locator_report as any) ?? null,
        newCrawlData: crawlData,
        apply: true,
      });
      const regenerated = sync.newScriptContent || script.script_content || '';

      // Loop 3: regeneration also rewrites stale locators — learn those too.
      if (sync.changes.length) {
        learnFromSyncChanges(sync.changes, { companyId, projectId }).catch((e) =>
          console.warn(`[ScriptGen] regenerate: pattern learning failed: ${e?.message}`));
      }

      // 2. Parse old + new files; merge preserved logic per file.
      const oldFiles = parseScriptContent(script.script_content, script.files_generated);
      const newFiles = parseScriptContent(regenerated, script.files_generated);
      const oldByPath = new Map(oldFiles.map((f) => [f.path, f]));

      const mergedFiles: Array<{ path: string; content: string; report: any }> = [];
      for (const nf of newFiles) {
        const of = oldByPath.get(nf.path);
        if (of && /\.(spec|test)\./.test(nf.path)) {
          const preserved = extractPreservedContent(of.content);
          const merged = mergeRegenerated(preserved, nf.content, mergeOptions);
          mergedFiles.push({ path: nf.path, content: merged.content, report: merged.report });
        } else {
          mergedFiles.push({ path: nf.path, content: nf.content, report: null });
        }
      }

      const newScriptContent = mergedFiles.map((f) => `// === ${f.path} ===\n${f.content}`).join('\n\n');
      const mergeReport = mergedFiles
        .filter((f) => f.report && (f.report.testDataInjected || f.report.assertionsInjected || f.report.customRegionsInjected))
        .map((f) => ({ file: f.path, ...f.report }));

      let applied = false;
      let backupVersion: number | null = null;
      if (!dryRun) {
        try {
          const backup = await saveScriptVersion({
            scriptId: id, companyId, projectId, reason: 'pre-regenerate',
            scriptContent: script.script_content, filesGenerated: script.files_generated,
          });
          backupVersion = backup?.version ?? null;
        } catch (bErr: any) {
          console.warn(`[ScriptGen] regenerate: backup failed (continuing): ${bErr?.message}`);
        }
        applied = await updateScriptContent(id, newScriptContent, script.files_generated, companyId, projectId);
      }

      console.log(`[ScriptGen] ♻️ regenerate #${id} — locator changes=${sync.changes.length}, merged files=${mergeReport.length}, applied=${applied}`);
      res.json({
        success: true,
        data: {
          files: mergedFiles.map((f) => ({ path: f.path, content: f.content })),
          mergeReport,
          syncSummary: sync.summary,
          locatorChanges: sync.changes,
          applied,
          dryRun,
          backupVersion,
        },
      });
    } catch (err: any) {
      console.error('[ScriptGen] regenerate error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Sprint 4: Validate Locators ─────────────────────────────
   * POST /api/scripts/validate-locators
   *
   * Validate a set of candidate locators against the cached DOM of the
   * Application Profile for a given URL. Used by the dashboard to surface
   * locator quality (DOM match / pattern / syntax-only) and warnings before
   * a script is committed. Backward compatible — purely additive.
   *
   * Body: { url: string, locators: string[] }
   * Resp: { success, data: { results: LocatorValidation[], summary } }
   */
  router.post('/validate-locators', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const { url, locators } = req.body ?? {};

      if (!url || typeof url !== 'string') {
        return res.status(400).json({ success: false, error: 'A "url" string is required.' });
      }
      if (!Array.isArray(locators) || locators.length === 0) {
        return res.status(400).json({ success: false, error: 'A non-empty "locators" array is required.' });
      }

      // Load the cached DOM for this URL (best source for DOM-match validation).
      let crawlData: CrawlDataLike | null = null;
      try {
        const profile = await getProfileByUrl(url, companyId, projectId);
        crawlData = (profile?.crawl_data as CrawlDataLike) ?? null;
      } catch (profErr: any) {
        console.warn(`[ScriptGen] validate-locators: profile lookup failed (continuing syntax-only): ${profErr?.message}`);
      }

      const resolver = new LocatorResolver({ crawlData });
      const results = locators
        .filter((l: unknown) => typeof l === 'string' && l.trim().length > 0)
        .map((l: string) => resolver.validateLocator(l, crawlData));

      const validCount = results.filter((r) => r.isValid).length;
      const domMatched = results.filter((r) => r.validationMethod === 'dom_match').length;
      const summary = {
        total: results.length,
        valid: validCount,
        invalid: results.length - validCount,
        domMatched,
        domAvailable: !!crawlData,
      };

      console.log(`[ScriptGen] 🔎 validate-locators — ${summary.valid}/${summary.total} valid, ${domMatched} DOM-matched (domAvailable=${summary.domAvailable})`);
      res.json({ success: true, data: { results, summary } });
    } catch (err: any) {
      console.error('[ScriptGen] validate-locators error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
