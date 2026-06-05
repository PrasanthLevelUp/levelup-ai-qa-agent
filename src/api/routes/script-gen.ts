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
  getRequirement,
  getProfileByUrl,
  markTestCaseAutomated,
  getRequirementAutomationCoverage,
} from '../../db/postgres';
import { resolveBaseUrl } from '../../services/url-resolver';
import { parseScriptContent } from '../../services/script-file-parser';
import { LocatorResolver, type CrawlDataLike, type LocatorReport } from '../../services/locator-resolver';
import { FolderStructureAnalyzer } from '../../services/folder-analyzer';
import { ScriptGenEngine, type GenerationConfig, type GenerationResult, type GeneratedFile } from '../../script-gen/script-gen-engine';
import { getRepositoryContext } from '../../db/postgres';
import { KnowledgeOptimizer, type KnowledgeItem } from '../../ai/knowledge-optimizer';
import { AIReviewEngine } from '../../script-gen/ai-review-engine';
import { ValidationRunner } from '../../script-gen/validation-runner';
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

/**
 * Sprint 4 — Extract human-readable element descriptions for locator resolution.
 *
 * The Locator Resolution Service needs a flat list of UI element descriptions
 * (e.g. "Login button", "email input", "Submit") so it can walk the priority
 * cascade and produce a locator + confidence for each. Those descriptions are
 * derived from, in order of preference:
 *   1. The structured test-case steps (when generating from a test case).
 *   2. The free-text generation instructions (the url-based / legacy flow).
 *
 * Step shapes vary across the platform (plain strings, objects with
 * `action`/`step`/`description`/`text`/`element`, or JSON-encoded strings), so
 * this helper normalises all of them defensively. It always returns a
 * de-duplicated array of trimmed, non-empty strings, and never throws — locator
 * resolution is strictly best-effort and must never break generation.
 */
function extractElementDescriptions(
  testCase: any | null | undefined,
  instructions: string | null | undefined,
): string[] {
  const out: string[] = [];

  const pushText = (val: unknown): void => {
    if (val == null) return;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (trimmed) out.push(trimmed);
    } else if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      const candidate =
        obj.action ?? obj.step ?? obj.description ?? obj.text ?? obj.element ?? obj.name ?? obj.title;
      if (typeof candidate === 'string') pushText(candidate);
    }
  };

  // 1. Prefer structured test-case steps when available.
  try {
    let steps: unknown = testCase?.steps;
    if (typeof steps === 'string') {
      // Steps may arrive as a JSON-encoded string.
      try { steps = JSON.parse(steps); } catch { /* leave as raw string */ }
    }
    if (Array.isArray(steps)) {
      for (const s of steps) pushText(s);
    } else if (typeof steps === 'string' && steps.trim()) {
      // Newline / numbered-list separated free text.
      for (const line of steps.split(/\r?\n/)) pushText(line);
    }
  } catch { /* non-fatal */ }

  // 2. Fall back to (or augment with) the free-text instructions.
  if (typeof instructions === 'string' && instructions.trim()) {
    for (const line of instructions.split(/\r?\n|(?<=[.;])\s+/)) {
      const trimmed = line.trim();
      // Skip very short fragments that won't resolve to a meaningful element.
      if (trimmed.length >= 3) out.push(trimmed);
    }
  }

  // De-duplicate (case-insensitive) while preserving order.
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const item of out) {
    const key = item.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }
  // Cap to a sane number to bound locator-resolution work.
  return deduped.slice(0, 50);
}

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
        testCaseId,
        // ── Sprint 4: Enterprise Script Generation Enhancement ──
        requirementId,
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
        const profile = await getRepositoryContext(repoId, companyId);
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
        ...(Array.isArray(additionalUrls) && additionalUrls.length > 0
          ? { additionalUrls: additionalUrls.filter((u: any) => typeof u === 'string').slice(0, 10) }
          : {}),
        // Pass cached crawl data to engine if available
        ...(crawlDecision.usedCache && crawlDecision.crawlData
          ? { cachedCrawlData: crawlDecision.crawlData }
          : {}),
      };

      const engine = new ScriptGenEngine();
      const result: GenerationResult = await engine.generate(config);

      // Save crawl data to profile if a fresh crawl was performed
      if (!crawlDecision.usedCache && result.rawCrawlData) {
        try {
          await crawlOrchestrator.saveCrawlResult(url, result.rawCrawlData, companyId, {
            authConfig: sanitizedAuthConfig,
          }, projectId);
          // Learn patterns from the crawl (project-scoped)
          await patternMatcher.learnPatterns(result.rawCrawlData, companyId, projectId);
          console.log(`[ScriptGen] Profile saved + patterns learned for: ${url}`);
        } catch (profileErr: any) {
          console.warn(`[ScriptGen] Could not save profile (non-blocking): ${profileErr.message}`);
        }
      }

      const generationTimeMs = Date.now() - startTime;

      // Run validation
      const validator = new ValidationRunner();
      const validationReport = validator.validate(result.generatedFiles, result.testPlan);

      // Determine validation status
      const validationStatus = validationReport.overallScore >= 80 ? 'passed' : 'needs_review';

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
        reliability_score: validationReport.overallScore,
        tokens_used: result.stats.tokensUsed,
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
        },
      });
    } catch (err: any) {
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

      // Sprint 4B — enrich each record with a structured per-file breakdown
      // parsed from the stored `script_content` blob. `script_content` is kept
      // for backward compatibility; the new `files` array powers the redesigned
      // file-wise history view (filename, content, language, framework, …).
      const data = records.map((rec: any) => ({
        ...rec,
        files: parseScriptContent(rec.script_content, rec.files_generated),
      }));

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
