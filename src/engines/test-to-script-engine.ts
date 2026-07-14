/**
 * Test-to-Script Engine
 *
 * Converts Test Case Lab outputs (test cases with steps, preconditions,
 * expected results) into runnable Playwright test scripts, then optionally
 * commits them to GitHub via a PR.
 *
 * This is the bridge between Test Case Lab and Script Gen / GitHub.
 *
 * Quality guarantees (see /home/ubuntu/script-generation-best-practices.md):
 *   1. PERFECT COVERAGE — every input test case maps to exactly ONE emitted
 *      test. No skips, no invented tests. Coverage is *reconciled* (not
 *      assumed) by tagging each test with a `// @tc:TC<id>` marker and
 *      template-filling any case the model omits.
 *   2. SMART GROUPING — related cases are gathered into a single feature
 *      file (e.g. login.spec.ts) with nested describe blocks, instead of the
 *      one-file-per-test-case anti-pattern. Files are capped in size and
 *      split into parts when a feature is very large.
 */

import OpenAI from 'openai';
import { AnthropicClient, resolveAnthropicModel, isAnthropicConfigured } from '../ai/anthropic-client';
import { logger } from '../utils/logger';
import {
  getTestRequirement,
  getTestScenarios,
  getTestCasesByRequirement,
  getApplicationKnowledge,
  getRepository,
  getApplicationProfileForGeneration,
  getRepositoryContext,
} from '../db/postgres';
import {
  LocatorResolver,
  type CrawlDataLike,
  type LocatorReport,
  type ResolvedLocator,
} from '../services/locator-resolver';
import { buildApplicationProfileContext } from '../utils/application-profile-context';
import { analyzeRepoPatterns, type RepoPatternGuide } from '../script-gen/repo-pattern-analyzer';
import {
  applyPageObjectReuse,
  mergeRewriteReports,
  type PageObjectRewriteReport,
} from '../script-gen/page-object-rewriter';
import {
  summarizeProfileForDebug,
  formatProfileSummary,
  auditRepositoryIntelligence,
  formatAudit,
  type RepositoryProfileDebugSummary,
  type RepositoryIntelligenceAudit,
} from '../script-gen/repo-intelligence-auditor';
import { auditFramework, type GenerationContext } from '../script-gen/framework-auditor';
import { extractElementDescriptions } from '../utils/element-descriptions';
import type { KnowledgeItem } from '../ai/knowledge-optimizer';
import type { RepositoryProfile } from '../context/types';
import type { ApplicationProfileContext } from './test-coverage-engine';

const MOD = 'test-to-script-engine';

/** Maximum number of tests allowed in a single spec file before it is split. */
const MAX_TESTS_PER_FILE = 20;

/**
 * Minimum locator confidence (0–100) the LocatorResolver must reach before a
 * resolved locator is accepted instead of falling through to the next cascade
 * level. Overridable per-deployment via the `SCRIPTGEN_LOCATOR_MIN_CONFIDENCE`
 * env var (clamped to 0–100); defaults to 50.
 */
const LOCATOR_MIN_CONFIDENCE = (() => {
  const raw = Number(process.env.SCRIPTGEN_LOCATOR_MIN_CONFIDENCE);
  return Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : 50;
})();

/**
 * Fallback base URL used only when a generation request supplies none. Kept
 * configurable via `SCRIPTGEN_DEFAULT_BASE_URL` so no environment-specific host
 * is hardcoded into the engine. The generated `page.goto` is overwritten by the
 * real target whenever one is provided.
 */
const DEFAULT_BASE_URL = process.env.SCRIPTGEN_DEFAULT_BASE_URL || 'http://localhost:3000';

/** Max app-knowledge modules folded into the narrative prompt context. */
const MAX_KNOWLEDGE_CONTEXT_ITEMS = 5;

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface TestToScriptInput {
  requirementId: number;
  companyId: number;
  repositoryId?: number;
  projectId?: number;
  framework?: 'playwright';          // future: cypress, selenium
  baseUrl?: string;                   // the application URL for navigate()
  outputDir?: string;                 // e.g. "tests/generated"
}

export interface GeneratedScriptFile {
  filePath: string;       // relative, e.g. "tests/generated/login.spec.ts"
  content: string;
  testCount: number;      // ACTUAL number of test() blocks in the file
  feature: string;        // human-readable feature name
  testCaseIds: number[];  // source test case ids assigned to this file
}

export interface FileCoverage {
  filePath: string;
  feature: string;
  testCases: number;      // input cases assigned to this file
  tests: number;          // actual tests emitted
  missing: number[];      // test case ids that had to be template-filled
  aiFilled: number;       // count of tests injected by the deterministic fallback
  complete: boolean;
}

export interface CoverageReport {
  totalTestCases: number;
  totalTestsGenerated: number;
  covered: number;        // unique input test cases represented by a test
  missing: number[];      // input test case ids still uncovered (should be empty)
  extra: number;          // tests emitted that don't map to an input case
  complete: boolean;      // covered === totalTestCases && missing empty
  perFile: FileCoverage[];
}

export interface TestToScriptResult {
  requirementId: number;
  requirementTitle: string;
  files: GeneratedScriptFile[];
  totalTests: number;
  totalFiles: number;
  coverage: CoverageReport;
  /** Which intelligence layers were available + applied during generation. */
  intelligence?: IntelligenceUsage;
  /** Framework audit analysis (Phase 1: Impact Analysis + Quality Report) */
  frameworkAnalysis?: import('../script-gen/framework-auditor').FrameworkAuditResult;
  /**
   * Snapshot of the Repository Profile that reached generation (Q1). Null when
   * no repository profile was loaded (greenfield). Powers the developer
   * Repository Intelligence debug panel and the "Profile Loaded" log.
   */
  profileDebug?: RepositoryProfileDebugSummary | null;
  /**
   * Repository Intelligence Audit (Q1–Q4): did the profile load, reach the
   * prompt builder, get included in the LLM prompt, and did the generated
   * scripts follow it (per-asset checklist)? Diagnostic only — no score, no
   * gate. Always attached when a repo profile was present.
   */
  repositoryIntelligenceAudit?: RepositoryIntelligenceAudit;
}

/**
 * Audit of which intelligence layers were loaded and used. Surfaced so callers
 * (and the report endpoint) can confirm scripts were grounded in real data
 * rather than generic guesses.
 */
export interface IntelligenceUsage {
  appProfileUsed: boolean;
  appKnowledgeUsed: boolean;
  repoPatternsUsed: boolean;
  testDataUsed: boolean;
  /** Aggregated locator-resolution quality across all generated files. */
  locatorReport?: LocatorReport;
  /**
   * Repository Intelligence — which Page Objects were discovered and which were
   * actually reused (loginPage.login(...) etc.) in the generated ZIP. Lets the
   * dashboard prove Page Object reuse instead of raw `page.locator(...)`.
   * Present only when a repository profile with Page Objects was available.
   */
  repositoryIntelligence?: PageObjectRewriteReport;
}

/**
 * Bundle of pre-loaded, cached intelligence shared across all feature groups in
 * a single generation run. Built ONCE in `generate()` so the cascade
 * (App Profile DOM → App Knowledge → Repo patterns) is reused for every file
 * without re-querying or re-crawling — keeping the run token- and IO-cheap.
 *
 * Every field is optional: generation must degrade gracefully when a layer is
 * unavailable, never throw. This is the core of "use all intelligence layers".
 */
interface IntelligenceBundle {
  /** Resolves element descriptions → Playwright locators via the full cascade. */
  locatorResolver?: LocatorResolver;
  /** Compact App-Profile context (real pages/forms/selectors) for the prompt. */
  appProfileBlock?: string;
  appProfileUsed: boolean;
  appKnowledgeUsed: boolean;
  /** Repo coding-style / locator / helper guide distilled from the repo profile. */
  repoGuide?: RepoPatternGuide;
  /**
   * Raw repository profile (scanned Page Objects, helpers, fixtures). Threaded
   * to the deterministic emitter so generated specs can reuse real Page Objects
   * (loginPage.login(...)) instead of raw `page.locator(...)` sequences.
   */
  repoProfile?: RepositoryProfile;
  /** Step 1/2 debug snapshot of the loaded repo profile (for logging + panel). */
  profileDebug?: RepositoryProfileDebugSummary;
  /**
   * Real base URL from the Application Profile (e.g. https://www.saucedemo.com/).
   * Used to overwrite the generated `page.goto(...)` so scripts never navigate
   * to a hallucinated or placeholder URL.
   */
  appBaseUrl?: string;
  /** Real login URL from the profile's auth config, when configured. */
  loginUrl?: string;
  /**
   * Real test credentials from the profile's auth config. Injected into the
   * generation prompt + deterministic templates so login-dependent scripts use
   * working credentials instead of guesses like Admin/admin123. These belong to
   * the user's own test environment and are committed only to the user's repo.
   */
  credentials?: { username?: string; password?: string };
  /**
   * Test data sets available for this project (from Test Data Store).
   * Materialized as data/*.json files in the repo for the Framework Auditor to
   * discover, and passed here so Script Generation can reference real data
   * instead of hallucinating test values.
   */
  testData?: Array<{ name: string; environment: string; recordCount: number; sampleKeys: string[] }>;
  testDataUsed: boolean;
}

/** Internal: a set of related test cases that will become one spec file. */
interface FileGroup {
  feature: string;        // display name, e.g. "Login"
  featureKey: string;     // slug, e.g. "login"
  coverageType: string;
  part?: number;          // 1-based part index when a feature is split
  totalParts?: number;
  cases: any[];
}

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

export class TestToScriptEngine {
  private readonly openai: OpenAI;
  private readonly model: string;
  // Phase 1 — optional Claude provider for Test → Script. When
  // SCRIPT_PROVIDER=anthropic and a key is configured, code generation routes
  // to Claude and transparently falls back to OpenAI on ANY error.
  private readonly anthropic: AnthropicClient | null;
  private readonly scriptProvider: string;
  private readonly anthropicModel: string;

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.model = process.env.SCRIPT_GEN_MODEL || 'gpt-4o-mini';

    this.scriptProvider = (process.env.SCRIPT_PROVIDER || 'openai').toLowerCase();
    this.anthropicModel = resolveAnthropicModel(process.env.SCRIPT_MODEL);
    this.anthropic =
      this.scriptProvider === 'anthropic' && isAnthropicConfigured()
        ? new AnthropicClient({ model: this.anthropicModel })
        : null;
  }

  /**
   * Provider-routed plain-text (code) completion for Test → Script generation.
   *
   * Routes to Claude when SCRIPT_PROVIDER=anthropic and configured; on ANY
   * Anthropic error it logs and transparently falls back to OpenAI so a request
   * never fails because of the new provider. Returns the raw model text.
   */
  private async completeCode(prompt: string, temperature: number, maxTokens: number): Promise<string> {
    if (this.anthropic) {
      try {
        const r = await this.anthropic.createChatCompletion({
          model: this.anthropicModel,
          messages: [{ role: 'user', content: prompt }],
          temperature,
          maxTokens,
        });
        return r.content || '';
      } catch (err) {
        logger.warn(MOD, 'Anthropic code generation failed; falling back to OpenAI', {
          error: (err as Error).message,
        });
      }
    }
    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      temperature,
      max_tokens: maxTokens,
    });
    return response.choices[0]?.message?.content?.trim() || '';
  }

  /**
   * Main entry point: fetch test cases for a requirement, group them by
   * feature, and generate Playwright script files with provable 1:1 coverage.
   */
  async generate(input: TestToScriptInput): Promise<TestToScriptResult> {
    const { requirementId, companyId, framework = 'playwright' } = input;

    logger.info(MOD, 'Starting test-to-script generation', { requirementId, companyId });

    // 1. Fetch requirement, scenarios, and test cases
    const requirement = await getTestRequirement(requirementId, companyId);
    if (!requirement) throw new Error(`Requirement #${requirementId} not found`);

    const scenarios = await getTestScenarios(requirementId);
    const testCases = await getTestCasesByRequirement(requirementId);

    if (!testCases.length) {
      throw new Error(`No test cases found for requirement #${requirementId}`);
    }

    // 2. Fetch app knowledge for richer context. Keep both the prompt string
    //    (for narrative context) and the raw items (so the LocatorResolver can
    //    mine any documented selectors from them).
    let knowledgeContext = '';
    let knowledgeItems: KnowledgeItem[] = [];
    try {
      const knowledge = await getApplicationKnowledge(companyId, input.projectId);
      if (knowledge.length) {
        knowledgeItems = knowledge as KnowledgeItem[];
        knowledgeContext = knowledge
          .slice(0, MAX_KNOWLEDGE_CONTEXT_ITEMS)
          .map((k: any) => `Module: ${k.module}\nWorkflow: ${k.workflow || ''}\nBusiness Rules: ${k.business_rules || ''}`)
          .join('\n---\n');
      }
    } catch { /* non-critical */ }

    // 3. Fetch repository info for output path context (non-blocking).
    if (input.repositoryId) {
      try {
        await getRepository(input.repositoryId, companyId);
      } catch { /* non-critical */ }
    }

    // 3b. INTELLIGENCE — load every available layer ONCE and build a shared
    //     bundle (App Profile DOM + App Knowledge + Repo patterns). This is the
    //     core fix: previously this engine ignored the App Profile, the
    //     LocatorResolver and repo patterns entirely, so generated scripts were
    //     generic guesses. All loads are defensive and non-blocking.
    const intel = await this.loadIntelligence(input, companyId, knowledgeItems);

    // 4. SMART GROUPING — gather related cases into feature-cohesive files
    const groups = this.buildFeatureGroups(testCases, requirement);

    // 🧮 Pre-generation coverage intent
    logger.info(MOD, '🧮 Coverage plan', {
      requirement: requirement.title,
      testCases: testCases.length,
      features: new Set(groups.map(g => g.featureKey)).size,
      files: groups.length,
      plan: `Generating tests for ${testCases.length} test case(s) across ${new Set(groups.map(g => g.featureKey)).size} feature(s) → ${groups.length} file(s)`,
    });

    // 5. Generate script files (one per group) with reconciliation
    const outputDir = input.outputDir || 'tests/generated';
    const files: GeneratedScriptFile[] = [];
    const perFile: FileCoverage[] = [];
    const locatorReports: LocatorReport[] = [];

    // Resolve the effective base URL (fixes review issue C1 — hallucinated /
    // placeholder URLs). Prefer the REAL App Profile base URL over the caller's
    // value whenever the caller did not pass one or only passed the generic
    // localhost default (routes hardcode 'http://localhost:3000'). This way the
    // crawled production/staging host wins and scripts navigate to a real page.
    const callerBaseUrl = (input.baseUrl || '').trim();
    const callerIsDefault = !callerBaseUrl || /^https?:\/\/localhost(:\d+)?\/?$/i.test(callerBaseUrl);
    const effectiveBaseUrl = (callerIsDefault && intel.appBaseUrl)
      ? intel.appBaseUrl
      : (callerBaseUrl || intel.appBaseUrl || DEFAULT_BASE_URL);
    logger.info(MOD, 'Resolved base URL for generation', {
      callerBaseUrl: callerBaseUrl || '(none)',
      appProfileBaseUrl: intel.appBaseUrl || '(none)',
      effectiveBaseUrl,
    });

    // 5b. Test Data → Script traceability: load FULL dataset records for all
    // linked datasets across ALL test cases. These are materialized into a
    // tests/data/test-data.ts module so generated specs bind to the dataset
    // schema (getRecord('valid_users')) rather than hardcoded values. Best-effort.
    let resolvedTestData: Array<{ name: string; environment?: string; records: Array<{ key: string; value: any }> }> = [];
    try {
      const { getLinkedDatasets, getTestDataRecords, resolveTestData } = await import('../db/postgres');
      const linkedDatasetIds = new Set<number>();
      const datasetById = new Map<number, { name: string; environment?: string }>();
      for (const tc of testCases) {
        const linked = await getLinkedDatasets(tc.id).catch(() => []);
        for (const ds of linked) {
          linkedDatasetIds.add(ds.id);
          datasetById.set(ds.id, { name: ds.name, environment: ds.environment });
        }
      }
      if (linkedDatasetIds.size > 0) {
        const seenDatasets = new Set<string>();
        for (const dsId of linkedDatasetIds) {
          const ds = datasetById.get(dsId);
          if (!ds) continue;
          const dedupeKey = `${ds.name}::${ds.environment}`;
          if (seenDatasets.has(dedupeKey)) continue;
          seenDatasets.add(dedupeKey);
          // Prefer resolveTestData (hydrates secrets); fall back to raw records.
          let records: Array<{ key: string; value: any }> = [];
          try {
            const resolved = await resolveTestData(ds.name, companyId, input.projectId, ds.environment);
            if (Array.isArray(resolved) && resolved.length > 0) {
              records = resolved.map((r: any) => ({ key: String(r.key), value: r.value }));
            }
          } catch { /* fall through */ }
          if (records.length === 0) {
            const raw = await getTestDataRecords(dsId).catch(() => []);
            records = raw.map((r: any) => ({ key: String(r.key), value: r.value_jsonb }));
          }
          if (records.length > 0) {
            resolvedTestData.push({ name: ds.name, environment: ds.environment, records });
          }
        }
        if (resolvedTestData.length > 0) {
          const totalRecords = resolvedTestData.reduce((n, d) => n + d.records.length, 0);
          logger.info(MOD, '🔗 Test data resolved (full records for module generation)', {
            datasets: resolvedTestData.length,
            records: totalRecords,
            testCases: testCases.length,
          });
        }
      }
    } catch (tdErr: any) {
      logger.warn(MOD, 'Could not resolve test data (non-blocking):', tdErr?.message);
    }

    // Build the test-data index for downstream use in script generation.
    const dataIndex = this.buildTestDataIndex(resolvedTestData);

    const repoIntelReports: PageObjectRewriteReport[] = [];
    for (const group of groups) {
      const { file, coverage, locatorReport, repoIntelReport } = await this.generateScriptForGroup(
        group,
        requirement,
        framework,
        effectiveBaseUrl,
        outputDir,
        knowledgeContext,
        intel,
        dataIndex,
      );
      files.push(file);
      perFile.push(coverage);
      if (locatorReport) locatorReports.push(locatorReport);
      if (repoIntelReport) repoIntelReports.push(repoIntelReport);
    }

    // 6. Generate shared helpers file (not counted as coverage)
    files.push(this.generateHelpers(outputDir));

    // 6b. Generate test-data module when resolved records are available (fixes
    // Critical Issue #1 & #2 from review: no test-data.ts in ZIP, fill('') generated).
    const dataModule = this.buildTestDataModule(dataIndex);
    if (dataModule) {
      files.push(dataModule);
      logger.info(MOD, '📦 Test-data module generated', {
        filePath: dataModule.filePath,
        datasets: resolvedTestData.length,
      });
    }

    // 7. Build the overall coverage report by reconciling in vs out
    const coverage = this.buildCoverageReport(testCases, perFile);

    const totalTests = files.reduce((sum, f) => sum + f.testCount, 0);

    // ✅/⚠️ Post-generation coverage result
    if (coverage.complete) {
      logger.info(MOD, '✅ Coverage complete', {
        message: `All ${coverage.totalTestCases} test case(s) covered in ${groups.length} file(s)`,
        totalTestsGenerated: coverage.totalTestsGenerated,
        extra: coverage.extra,
      });
    } else {
      logger.warn(MOD, '⚠️ Coverage incomplete after reconciliation', {
        message: `Only ${coverage.covered}/${coverage.totalTestCases} test case(s) covered`,
        missing: coverage.missing,
      });
    }

    // 🧠 Summarise intelligence usage so callers can prove scripts were
    //    grounded in real data (and so token/quality wins are observable).
    const mergedLocatorReport = this.mergeLocatorReports(locatorReports);
    const mergedRepoIntel = mergeRewriteReports(repoIntelReports);
    const intelligence: IntelligenceUsage = {
      appProfileUsed: intel.appProfileUsed,
      appKnowledgeUsed: intel.appKnowledgeUsed,
      repoPatternsUsed: !!intel.repoGuide,
      testDataUsed: intel.testDataUsed,
      locatorReport: mergedLocatorReport,
      ...(mergedRepoIntel ? { repositoryIntelligence: mergedRepoIntel } : {}),
    };
    logger.info(MOD, '🧠 Intelligence usage', {
      appProfile: intelligence.appProfileUsed,
      appKnowledge: intelligence.appKnowledgeUsed,
      repoPatterns: intelligence.repoPatternsUsed,
      testData: intelligence.testDataUsed,
      locatorsResolved: mergedLocatorReport?.totalLocators ?? 0,
      avgLocatorConfidence: mergedLocatorReport?.avgConfidence ?? 0,
      pageObjectsAvailable: mergedRepoIntel?.totalAvailable ?? 0,
      pageObjectsReused: mergedRepoIntel?.totalUsed ?? 0,
    });

    // 🏗️ Framework Audit (Phase 1: Impact Analysis + Quality Report)
    let frameworkAnalysis: import('../script-gen/framework-auditor').FrameworkAuditResult | undefined;
    if (input.repositoryId && (input.companyId || input.projectId)) {
      try {
        const repoProfile = await getRepositoryContext(String(input.repositoryId), input.companyId, input.projectId);
        if (repoProfile) {
          const generationContext: GenerationContext = {
            testCases: testCases.map((tc) => ({
              id: String(tc.id),
              title: tc.title || `Test Case ${tc.id}`,
              steps: tc.steps ? JSON.parse(tc.steps).map((s: any) => s.description || s.action || '') : [],
            })),
            baseUrl: input.baseUrl || intel.appBaseUrl,
            isGreenfield: !repoProfile || (repoProfile.pageObjects?.length ?? 0) === 0,
            framework: 'playwright',
          };
          frameworkAnalysis = await auditFramework(
            repoProfile,
            generationContext,
            {
              companyId: input.companyId,
              projectId: input.projectId,
              repositoryId: input.repositoryId,
            },
          );
          logger.info(MOD, '🏗️ Framework audit complete', {
            overallAssessment: frameworkAnalysis.qualityReport.overallAssessment,
            riskLevel: frameworkAnalysis.impactAnalysis.risk.level,
            reuseLevel: frameworkAnalysis.impactAnalysis.reuseOpportunity.level,
            assetsReused: frameworkAnalysis.impactAnalysis.reuseOpportunity.assetsReused.length,
          });
        }
      } catch (auditErr: any) {
        logger.warn(MOD, 'Framework audit failed (non-blocking)', { error: auditErr.message });
        // Audit failure is non-blocking — generation proceeds without it
      }
    }

    // ── Repository Intelligence Audit (diagnostic, NEVER a gate).
    //    Answers 4 questions on real data: (Q1) did the Repository Profile
    //    load? (Q2) did it reach the Prompt Builder? (Q3) was it actually
    //    included in the LLM prompt — showing the exact prompt section? (Q4)
    //    did the generated script follow it — a per-asset PASS/FAIL checklist.
    //    No score, no threshold, no enforcement. Runs only when a profile was
    //    loaded (otherwise the run is greenfield and there is nothing to audit).
    let repositoryIntelligenceAudit: RepositoryIntelligenceAudit | undefined;
    if (intel.repoProfile) {
      try {
        repositoryIntelligenceAudit = auditRepositoryIntelligence({
          profile: intel.repoProfile,
          files: files.map((f) => ({ path: f.filePath, content: f.content })),
          promptSection: intel.repoGuide?.promptBlock ?? null,
          reachedPromptBuilder: !!intel.repoGuide,
        });
        const anyFail = repositoryIntelligenceAudit.checklist.some(
          (row) => row.status === 'FAIL',
        );
        const rendered = formatAudit(repositoryIntelligenceAudit);
        if (anyFail) {
          logger.warn(MOD, `Repository Intelligence Audit — divergences found\n${rendered}`);
        } else {
          logger.info(MOD, `Repository Intelligence Audit\n${rendered}`);
        }
      } catch (auditErr: any) {
        // A diagnostic must never break generation.
        logger.warn(MOD, 'Repository Intelligence Audit failed (non-blocking)', {
          error: auditErr?.message,
        });
      }
    }

    return {
      requirementId,
      requirementTitle: requirement.title,
      files,
      totalTests,
      totalFiles: files.length,
      coverage,
      intelligence,
      ...(frameworkAnalysis ? { frameworkAnalysis } : {}),
      ...(intel.profileDebug ? { profileDebug: intel.profileDebug } : {}),
      ...(repositoryIntelligenceAudit ? { repositoryIntelligenceAudit } : {}),
    };
  }

  /* ── intelligence loading ────────────────────────────────── */

  /**
   * Load and assemble every available intelligence layer ONCE for the whole
   * run. Each step is independently guarded so a failure in one layer never
   * blocks generation — the engine simply falls back to whatever is available
   * (down to generic generation when nothing is).
   */
  private async loadIntelligence(
    input: TestToScriptInput,
    companyId: number,
    knowledgeItems: KnowledgeItem[],
  ): Promise<IntelligenceBundle> {
    const bundle: IntelligenceBundle = {
      appProfileUsed: false,
      appKnowledgeUsed: knowledgeItems.length > 0,
      testDataUsed: false,
    };

    // 1. Application Profile → cached DOM (crawl_data) + compact prompt context.
    let crawlData: CrawlDataLike | null = null;
    try {
      const profile = await getApplicationProfileForGeneration(companyId, input.projectId);
      if (profile) {
        // Capture the REAL base/login URLs and test credentials so generated
        // scripts navigate to the actual app and log in with working creds
        // (fixes hallucinated URLs/credentials — review issues C1 & C2). The
        // raw auth_config is read here (not via the sanitized context) because
        // executable scripts genuinely need the password; it is committed only
        // to the user's own repository.
        const authConfig: any = profile.auth_config || {};
        const creds = authConfig.credentials || authConfig || {};
        if (profile.base_url) bundle.appBaseUrl = profile.base_url;
        if (authConfig.loginUrl) bundle.loginUrl = authConfig.loginUrl;
        if (creds.username || creds.password) {
          bundle.credentials = {
            username: creds.username || undefined,
            password: creds.password || undefined,
          };
        }
      }
      if (profile?.crawl_data) {
        crawlData = profile.crawl_data as CrawlDataLike;
        const ctx = buildApplicationProfileContext(profile);
        if (ctx) {
          bundle.appProfileBlock = this.formatAppProfileBlock(ctx, bundle);
          bundle.appProfileUsed = true;
        }
        logger.info(MOD, '✅ App Profile loaded for grounding', {
          baseUrl: profile.base_url,
          pages: profile.page_count,
          elements: profile.total_elements,
          forms: profile.total_forms,
          hasCredentials: !!bundle.credentials,
        });
      } else if (bundle.appBaseUrl || bundle.credentials) {
        // Profile exists but hasn't been crawled yet — still surface the URLs
        // and credentials so scripts are grounded even without a DOM snapshot.
        bundle.appProfileBlock = this.formatAppProfileBlock(undefined, bundle);
        bundle.appProfileUsed = true;
        logger.info(MOD, '✅ App Profile (no crawl) loaded for URL/credential grounding', {
          baseUrl: bundle.appBaseUrl, hasCredentials: !!bundle.credentials,
        });
      } else {
        logger.info(MOD, 'ℹ️ No Application Profile available — locators fall back to knowledge/repo/heuristics');
      }
    } catch (err: any) {
      logger.warn(MOD, 'App Profile load failed (non-blocking)', { error: err?.message });
    }

    // 2. Repository profile → repo-consistent coding style / locator / helper guide.
    let repoProfile: RepositoryProfile | null = null;
    if (input.repositoryId) {
      try {
        repoProfile = await getRepositoryContext(String(input.repositoryId), companyId, input.projectId);
        if (repoProfile) {
          bundle.repoProfile = repoProfile;
          // ── Step 1: "Repository Profile Loaded" — prove the profile reached
          //    generation, with the concrete assets it carries. If any critical
          //    bucket is empty this log makes it obvious BEFORE prompt building.
          const profileDebug = summarizeProfileForDebug(repoProfile, {
            repositoryId: input.repositoryId ?? null,
          });
          bundle.profileDebug = profileDebug;
          logger.info(MOD, `📥 Repository Profile Loaded\n${formatProfileSummary(profileDebug)}`, {
            repositoryId: profileDebug.repositoryId,
            pageObjects: profileDebug.pageObjects.length,
            utilities: profileDebug.utilities.length,
            businessFlows: profileDebug.businessFlows,
            testSuites: profileDebug.testSuites,
            envConfigModule: profileDebug.envConfigModule,
            looksComplete: profileDebug.looksComplete,
          });
          if (!profileDebug.looksComplete) {
            logger.warn(
              MOD,
              '⚠️ Repository Profile is INCOMPLETE — one or more critical asset ' +
                'buckets (page objects / utilities / business flows / test suites) ' +
                'are empty. Generated scripts may fall back to generic code.',
            );
          }
          bundle.repoGuide = analyzeRepoPatterns(repoProfile);
          if (bundle.repoGuide) {
            logger.info(MOD, '✅ Repo patterns loaded for grounding', {
              framework: bundle.repoGuide.summary.framework,
              language: bundle.repoGuide.summary.language,
              confidence: bundle.repoGuide.summary.confidence,
              helpers: bundle.repoGuide.summary.helpers.length,
              pageObjects: bundle.repoGuide.summary.pageObjects.length,
            });
          }
        } else if (input.repositoryId) {
          // Explicit, loud signal: a repositoryId WAS supplied but no scanned
          // profile came back — this is the upstream gate failure the audit is
          // designed to surface (nothing to reuse → generic scripts).
          logger.warn(
            MOD,
            `❌ Repository Profile MISSING for repositoryId=${input.repositoryId} ` +
              `(companyId=${companyId}, projectId=${input.projectId ?? 'none'}). ` +
              'No scanned repository_contexts row matched — generation will be ' +
              'greenfield and cannot reuse repository assets.',
          );
        }
      } catch (err: any) {
        logger.warn(MOD, 'Repo context load failed (non-blocking)', { error: err?.message });
      }
    }

    // 2.5. Test Data Store → available datasets for this project. Script Generation
    //      can now reference real data (e.g., `import users from '../data/valid_users.json'`)
    //      instead of hallucinating test values.
    bundle.testDataUsed = false;
    if (input.projectId) {
      try {
        const { getTestDataSetSummaries } = await import('../db/postgres');
        // Token-safe: only names + record counts + a few sample KEYS (never values,
        // never secrets, never full rows). The generated script imports the data
        // FILE; we never embed the dataset contents in the prompt.
        const summaries = await getTestDataSetSummaries(companyId, input.projectId, undefined, 5);
        if (summaries.length > 0) {
          bundle.testData = summaries.slice(0, 10);
          bundle.testDataUsed = true;
          logger.info(MOD, '✅ Test data sets loaded (metadata only)', { count: summaries.length });
        }
      } catch (err: any) {
        logger.warn(MOD, 'Test data load failed (non-blocking)', { error: err?.message });
      }
    }

    // 3. Build the LocatorResolver from whatever layers we got. Even with no
    //    crawl data it still resolves via knowledge → repo → smart fallback.
    try {
      bundle.locatorResolver = new LocatorResolver({
        crawlData,
        knowledgeItems,
        repoProfile,
        minConfidence: LOCATOR_MIN_CONFIDENCE,
      });
    } catch (err: any) {
      logger.warn(MOD, 'LocatorResolver init failed (non-blocking)', { error: err?.message });
    }

    return bundle;
  }

  /**
   * Format the App-Profile projection into a token-budgeted prompt block.
   *
   * The block now leads with the REAL base/login URLs and test credentials
   * (from `bundle`) so the model can never fall back to placeholder URLs or
   * invented credentials, followed by the real form/element selectors.
   */
  private formatAppProfileBlock(
    ctx: ApplicationProfileContext | undefined,
    bundle?: Pick<IntelligenceBundle, 'appBaseUrl' | 'loginUrl' | 'credentials'>,
  ): string {
    const lines: string[] = [];

    // ── Real URLs + credentials (ground truth — must be used verbatim) ──
    const urlCredLines: string[] = [];
    if (bundle?.appBaseUrl) urlCredLines.push(`- Base URL: ${bundle.appBaseUrl}`);
    if (bundle?.loginUrl) urlCredLines.push(`- Login URL: ${bundle.loginUrl}`);
    if (bundle?.credentials?.username) urlCredLines.push(`- Username: ${bundle.credentials.username}`);
    if (bundle?.credentials?.password) urlCredLines.push(`- Password: ${bundle.credentials.password}`);
    if (urlCredLines.length) {
      lines.push('## Real Application URLs & Test Credentials (use these EXACT values — never invent)');
      lines.push(...urlCredLines);
      lines.push('');
    }

    if (!ctx) {
      return lines.length ? lines.join('\n').trimEnd() : '';
    }

    lines.push('## Real Application Structure (use these EXACT selectors)');

    for (const form of (ctx.forms || []).slice(0, 4)) {
      const where = form.page ? ` on ${form.page}` : '';
      lines.push(`\n### Form${where}`);
      for (const f of (form.fields || []).slice(0, 10)) {
        const sel = f.selector ? ` → \`${f.selector}\`` : '';
        const req = f.required ? ' (required)' : '';
        lines.push(`- ${f.label || f.name || f.type}${req}${sel}`);
      }
      if (form.submitSelector) lines.push(`- Submit → \`${form.submitSelector}\``);
    }

    const keyEls = (ctx.keyElements || []).filter(e => e.selector).slice(0, 18);
    if (keyEls.length) {
      lines.push('\n### Key Elements');
      for (const e of keyEls) {
        lines.push(`- ${e.label || e.role || e.tag} → \`${e.selector}\``);
      }
    }

    return lines.length > 1 ? lines.join('\n') : '';
  }

  /** Merge per-file locator reports into one run-level summary (for the audit). */
  private mergeLocatorReports(reports: LocatorReport[]): LocatorReport | undefined {
    if (!reports.length) return undefined;
    const merged: LocatorReport = {
      totalLocators: 0,
      validatedCount: 0,
      todoCount: 0,
      avgConfidence: 0,
      sources: { app_profile: 0, app_knowledge: 0, repo_patterns: 0, smart_fallback: 0 },
      locators: [],
      warnings: [],
    };
    let confidenceSum = 0;
    for (const r of reports) {
      merged.totalLocators += r.totalLocators;
      merged.validatedCount += r.validatedCount;
      merged.todoCount += r.todoCount;
      confidenceSum += r.avgConfidence * r.totalLocators;
      for (const k of Object.keys(r.sources) as Array<keyof typeof r.sources>) {
        merged.sources[k] += r.sources[k];
      }
      merged.locators.push(...r.locators);
      merged.warnings.push(...r.warnings);
    }
    merged.avgConfidence = merged.totalLocators
      ? Math.round(confidenceSum / merged.totalLocators)
      : 0;
    // Keep the stored detail compact.
    merged.locators = merged.locators.slice(0, 100);
    merged.warnings = [...new Set(merged.warnings)].slice(0, 25);
    return merged;
  }

  /* ── grouping ────────────────────────────────────────────── */

  /** Stopwords that mark the boundary between a feature name and a qualifier. */
  private static readonly QUALIFIER_TOKENS = new Set([
    'with', 'when', 'using', 'for', 'via', 'without', 'and', 'or', 'the', 'a', 'an',
    'to', 'of', 'on', 'in', 'as', 'by', 'should', 'must', 'given', 'then',
    'valid', 'invalid', 'empty', 'blank', 'missing', 'wrong', 'correct', 'incorrect',
    'negative', 'positive', 'happy', 'path', 'edge', 'case', 'cases', 'boundary',
    'successful', 'successfully', 'success', 'fail', 'fails', 'failed', 'failure',
    'error', 'errors', 'duplicate', 'expired', 'locked', 'disabled', 'enabled',
  ]);

  /**
   * Group test cases into feature-cohesive files.
   *
   * Strategy:
   *   1. Derive a feature key per case from its scenario name (leading words
   *      before the first qualifier token), falling back to coverage_type and
   *      then the requirement title.
   *   2. Bucket cases by feature key — one file per feature.
   *   3. Split a feature that exceeds MAX_TESTS_PER_FILE into ordered parts.
   */
  private buildFeatureGroups(testCases: any[], requirement: any): FileGroup[] {
    const buckets = new Map<string, { feature: string; coverageType: string; cases: any[] }>();

    for (const tc of testCases) {
      const source = (tc.scenario || tc.coverage_type || requirement.title || 'tests') as string;
      const { key, display } = this.deriveFeature(source);
      const featureKey = key || 'tests';
      if (!buckets.has(featureKey)) {
        buckets.set(featureKey, {
          feature: display,
          coverageType: tc.coverage_type || 'functional',
          cases: [],
        });
      }
      buckets.get(featureKey)!.cases.push(tc);
    }

    const groups: FileGroup[] = [];
    for (const [featureKey, bucket] of buckets) {
      // Stable ordering: priority then id, so file content is deterministic.
      const ordered = [...bucket.cases].sort((a, b) => {
        const pa = String(a.priority || 'P9');
        const pb = String(b.priority || 'P9');
        if (pa !== pb) return pa < pb ? -1 : 1;
        return (a.id || 0) - (b.id || 0);
      });

      if (ordered.length <= MAX_TESTS_PER_FILE) {
        groups.push({
          feature: bucket.feature,
          featureKey,
          coverageType: bucket.coverageType,
          cases: ordered,
        });
      } else {
        // Split oversized feature into bounded parts, preserving 1:1 coverage.
        const totalParts = Math.ceil(ordered.length / MAX_TESTS_PER_FILE);
        for (let p = 0; p < totalParts; p++) {
          groups.push({
            feature: bucket.feature,
            featureKey,
            coverageType: bucket.coverageType,
            part: p + 1,
            totalParts,
            cases: ordered.slice(p * MAX_TESTS_PER_FILE, (p + 1) * MAX_TESTS_PER_FILE),
          });
        }
      }
    }

    return groups;
  }

  /**
   * Derive a feature key + display name from a scenario / coverage string.
   * Takes leading significant words up to the first qualifier token.
   */
  private deriveFeature(source: string): { key: string; display: string } {
    const cleaned = String(source)
      // split on common delimiters first — keep the part before the delimiter
      .split(/[\-:–—|(/]/)[0]
      .trim();

    const words = cleaned
      .replace(/[^a-zA-Z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    const featureWords: string[] = [];
    for (const w of words) {
      const lw = w.toLowerCase();
      if (featureWords.length > 0 && TestToScriptEngine.QUALIFIER_TOKENS.has(lw)) break;
      featureWords.push(w);
      if (featureWords.length >= 3) break; // cap feature name length
    }

    const display = (featureWords.length ? featureWords : words.slice(0, 2))
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ') || 'Tests';

    const key = this.slugify(display);
    return { key, display };
  }

  /* ── generation + reconciliation ─────────────────────────── */

  private async generateScriptForGroup(
    group: FileGroup,
    requirement: any,
    framework: string,
    baseUrl: string,
    outputDir: string,
    knowledgeContext: string,
    intel: IntelligenceBundle,
    dataIndex?: Map<string, Map<string, any>>,
  ): Promise<{ file: GeneratedScriptFile; coverage: FileCoverage; locatorReport?: LocatorReport; repoIntelReport?: PageObjectRewriteReport }> {
    // Use the repo's own file-naming convention when we have a repo guide so the
    // committed file looks native to the target codebase; otherwise default.
    const partSuffix = group.part && (group.totalParts || 1) > 1 ? `.part${group.part}` : '';
    const slug = `${this.slugify(group.feature)}${partSuffix}`;
    const fileName = intel.repoGuide
      ? intel.repoGuide.buildFileName(slug)
      : `${slug}.spec.ts`;
    const filePath = `${outputDir}/${fileName}`;
    const caseIds: number[] = group.cases.map((c: any) => c.id);

    // ── LOCATOR RESOLUTION ──────────────────────────────────────────────
    // For every test case, turn its natural-language steps into concrete
    // Playwright locators via the cascade (App Profile DOM → Knowledge →
    // Repo patterns → smart fallback). The resolved locators are (a) fed to
    // the AI as ground truth and (b) used by the deterministic template
    // fallback so even auto-filled tests carry real selectors + assertions.
    const resolvedByCase = new Map<number, ResolvedLocator[]>();
    let locatorReport: LocatorReport | undefined;
    if (intel.locatorResolver) {
      try {
        const allResolved: ResolvedLocator[] = [];
        for (const tc of group.cases) {
          const descriptions = extractElementDescriptions(
            tc,
            [tc.title, tc.expected_result, tc.test_data].filter(Boolean).join('. '),
          );
          if (!descriptions.length) continue;
          const { resolved } = intel.locatorResolver.resolveAll(descriptions);
          if (resolved.length) {
            resolvedByCase.set(tc.id, resolved);
            allResolved.push(...resolved);
          }
        }
        if (allResolved.length) {
          // Build a single quality report over everything we resolved for this file.
          locatorReport = this.buildGroupLocatorReport(allResolved);
        }
      } catch (err: any) {
        logger.warn(MOD, 'Locator resolution failed for group (non-blocking)', {
          feature: group.feature, error: err?.message,
        });
      }
    }

    // ── DETERMINISTIC DATASET SELECTION ─────────────────────────────────────
    // Load datasets linked to the test cases in this group. If any case has
    // linkage, we use ONLY those datasets (deterministic); otherwise fall back
    // to project-level datasets (all available). This closes the "which dataset
    // should I use?" guessing problem: TC-001 Login → valid_users → generation
    // knows exactly what to import.
    let groupTestData: Array<{ name: string; environment: string; recordCount: number; sampleKeys: string[] }> = [];
    try {
      const { getLinkedDatasets, getTestDataSetSummaries } = await import('../db/postgres');
      const linkedDatasetIds = new Set<number>();
      for (const tc of group.cases) {
        const linked = await getLinkedDatasets(tc.id);
        linked.forEach(ds => linkedDatasetIds.add(ds.id));
      }
      if (linkedDatasetIds.size > 0) {
        // Deterministic path: use only the linked datasets for this group's cases.
        // getTestDataSetSummaries filters by dataset ID when the 5th param is provided.
        groupTestData = await getTestDataSetSummaries(
          requirement.company_id,
          requirement.project_id,
          undefined,
          5,
          [...linkedDatasetIds],
        );
        logger.info(MOD, '✅ Deterministic dataset selection via linkage', {
          feature: group.feature,
          caseIds: group.cases.map((c: any) => c.id),
          linkedDatasets: groupTestData.map(d => d.name),
        });
      } else {
        // Fallback: no linkage, use project-level datasets (original behavior).
        groupTestData = intel.testData || [];
      }
    } catch (err: any) {
      logger.warn(MOD, 'Dataset linkage load failed (non-blocking)', { error: err?.message });
      groupTestData = intel.testData || [];
    }

    // Build the prompt with explicit per-case anchors and a strict contract.
    const testCaseDescriptions = group.cases.map((tc: any, i: number) => {
      const steps = this.parseJson(tc.steps, []);
      const resolved = resolvedByCase.get(tc.id) || [];
      const locatorHints = resolved.length
        ? `Resolved Locators (use these EXACT locators):\n${resolved
            .slice(0, 12)
            .map(r => `  - ${r.elementDescription} → ${r.locator}${r.confidence < 60 ? '  // verify' : ''}`)
            .join('\n')}`
        : '';
      // H1 — map this case's Expected Result into concrete assertion guidance so
      // the AI emits a real expect(...) for every expected outcome instead of a
      // no-op. The derived hints are suggestions; the AI still writes the code.
      const assertionHints = this.deriveRequiredAssertions(tc, baseUrl);
      const assertionBlock = assertionHints.length
        ? `Required Assertions (map each Expected Result to a real expect):\n${assertionHints.map(a => `  - ${a}`).join('\n')}`
        : '';
      return [
        `### Test Case TC${tc.id} (#${i + 1}): ${tc.title}`,
        `Scenario: ${tc.scenario || group.feature}`,
        `Priority: ${tc.priority || 'P2'} | Severity: ${tc.severity || 'medium'}`,
        tc.preconditions ? `Preconditions: ${tc.preconditions}` : '',
        steps.length ? `Steps:\n${steps.map((s: string, j: number) => `  ${j + 1}. ${s}`).join('\n')}` : '',
        `Expected Result: ${tc.expected_result}`,
        tc.test_data ? `Test Data: ${tc.test_data}` : '',
        locatorHints,
        assertionBlock,
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    // Repo-pattern guidance (coding style, imports, helpers to reuse) and the
    // real app structure are injected so output matches the target codebase and
    // points at real selectors instead of guesses.
    const repoBlock = intel.repoGuide ? `\n${intel.repoGuide.promptBlock}` : '';
    const appProfileBlock = intel.appProfileBlock ? `\n${intel.appProfileBlock}` : '';
    // Token-safe test data block: list datasets with their record count + a few
    // sample keys ONLY. We deliberately never embed full rows or values here — the
    // generated test imports the data/*.json FILE and reads values at runtime.
    // NOTE: groupTestData is either (a) linked datasets for this group's test cases
    // (deterministic), or (b) project-level datasets (fallback when no linkage).
    const testDataBlock = groupTestData.length > 0
      ? `\n## Available Test Data (Materialized as data/*.json)\n\nThese datasets live in the repository's \`data/\` folder. Import the FILE and read values at runtime — do NOT hardcode or inline the dataset contents.\n${groupTestData.map(td => {
          const keys = td.sampleKeys.length ? ` — sample keys: ${td.sampleKeys.slice(0, 5).join(', ')}` : '';
          return `- \`data/${td.name}.json\` (${td.environment}, ${td.recordCount} record${td.recordCount === 1 ? '' : 's'})${keys}`;
        }).join('\n')}\n\nUsage pattern:\n\`\`\`typescript\nimport dataset from '../data/<name>.json';\nconst record = dataset.find((r) => r.key === '<key>');\nconst value = record?.value;\n\`\`\`\n\nPrefer these real datasets over hardcoded test values.`
      : '';

    const prompt = `You are an expert Playwright test automation engineer.

Generate ONE complete, runnable Playwright TypeScript test file for the feature "${group.feature}".

## Context
- Requirement: ${requirement.title}
- Description: ${requirement.description || ''}
- Feature: ${group.feature}
- Coverage Type: ${group.coverageType}
- Base URL: ${baseUrl}
- Framework: Playwright with TypeScript
${knowledgeContext ? `\n## Application Knowledge\n${knowledgeContext}` : ''}${appProfileBlock}${repoBlock}${testDataBlock}

## Test Cases to Automate (${group.cases.length})

${testCaseDescriptions}

## STRICT COVERAGE CONTRACT (must follow exactly)
1. Emit EXACTLY ONE \`test(...)\` per test case above — no more, no fewer.
2. Do NOT merge two test cases into one test. Do NOT invent extra tests.
3. The FIRST line inside each test body MUST be the marker comment: \`// @tc:TC<id>\`
   using that test case's id. Example: \`// @tc:TC42\`.
4. Wrap everything in a single top-level \`test.describe('${this.escapeStr(group.feature)}', () => { ... })\`.
5. Group related cases with nested \`test.describe(...)\` blocks named after their Scenario.

## Quality Requirements
- Import \`test\` and \`expect\` from '@playwright/test'.
- Add a \`test.beforeEach\` that navigates to the base URL.
- When "Resolved Locators" are provided for a case, USE THOSE EXACT locators — do not invent new ones.
- Otherwise prefer semantic selectors: data-testid, then role, then text, then placeholder.
- Add MEANINGFUL assertions that verify each Expected Result (assert on real elements/state).
  NEVER emit no-op assertions such as \`await expect(page).toHaveURL(/.*/)\`.
- Use smart waits (NEVER use \`waitForTimeout\`).
- Make each test independent and runnable in isolation.
- Add a short JSDoc/comment describing each test.

Return ONLY the TypeScript code. No markdown fences, no explanations.`;

    let aiCode = '';
    const maxTokens = Math.min(8000, 1500 + group.cases.length * 600);
    try {
      aiCode = await this.completeCode(prompt, 0.2, maxTokens);
      aiCode = aiCode.replace(/^```(?:typescript|ts)?\n?/m, '').replace(/\n?```$/m, '').trim();
      if (aiCode && !aiCode.startsWith('import')) {
        aiCode = `import { test, expect } from '@playwright/test';\n\n${aiCode}`;
      }
    } catch (error: any) {
      logger.error(MOD, 'AI script generation failed, using template fallback', {
        error: error.message, feature: group.feature,
      });
      aiCode = '';
    }

    // ── PHASE 5: POST-GENERATION VALIDATION + ONE CORRECTIVE RETRY ──────────
    // Scan the AI output for the exact defects the review flagged (placeholder
    // URLs, hallucinated credentials, no-op assertions, hard waits). If the
    // output is usable but has fixable issues, do ONE bounded corrective pass
    // with the concrete problems listed. Never throw — fall through to the
    // deterministic template reconciliation either way (review issue C4/H1).
    if (aiCode) {
      const issues = this.validateGeneratedScript(aiCode, baseUrl, intel);
      if (issues.length) {
        logger.warn(MOD, '⚠️ Generated script failed validation — attempting corrective retry', {
          feature: group.feature, issues,
        });
        try {
          const fixPrompt = `${prompt}\n\n## PREVIOUS ATTEMPT FAILED VALIDATION\nYour previous output had these defects that MUST be fixed:\n${issues.map(i => `- ${i}`).join('\n')}\n\nRegenerate the COMPLETE file fixing ALL of the above. Use the real Base URL "${baseUrl}" verbatim in navigation. Use ONLY the provided credentials and locators. Every Expected Result must map to a concrete, meaningful expect(...). Return ONLY TypeScript code.`;
          let retryCode = await this.completeCode(fixPrompt, 0.1, maxTokens);
          retryCode = retryCode.replace(/^```(?:typescript|ts)?\n?/m, '').replace(/\n?```$/m, '').trim();
          if (retryCode && !retryCode.startsWith('import')) {
            retryCode = `import { test, expect } from '@playwright/test';\n\n${retryCode}`;
          }
          if (retryCode) {
            const remaining = this.validateGeneratedScript(retryCode, baseUrl, intel);
            if (remaining.length < issues.length) {
              aiCode = retryCode;
              logger.info(MOD, '✅ Corrective retry improved script', {
                feature: group.feature, before: issues.length, after: remaining.length,
              });
            }
          }
        } catch (err: any) {
          logger.warn(MOD, 'Corrective retry failed (non-blocking)', {
            feature: group.feature, error: err?.message,
          });
        }
      }
    }

    // ── Reconcile: which test cases did the AI actually cover? ──
    const reconciled = this.reconcileCoverage(aiCode, group, requirement, baseUrl, resolvedByCase, dataIndex);

    // ── REVIEW FIX (Issue 4): Strengthen negative assertions ───────────────
    // Replace weak "toBeVisible on form field" assertions in negative tests
    // with real error-element checks before any other post-processing.
    reconciled.content = this.strengthenNegativeAssertions(reconciled.content, group.cases);

    // ── Repository Intelligence: Page Object reuse ──────────────────────────
    // Post-process the FINAL code (AI output OR deterministic template — same
    // path) so recognised raw locator sequences collapse into real Page Object
    // method calls (loginPage.login(...)), with validated methods + repo-derived
    // import paths. No-op when the repo profile carries no matching Page Object.
    let repoIntelReport: PageObjectRewriteReport | undefined;
    if (intel.repoProfile?.pageObjects?.length) {
      try {
        const contextText = [
          group.feature,
          ...group.cases.map((c: any) =>
            `${c.title || ''} ${this.parseJson(c.steps, []).join(' ')} ${c.expected_result || ''}`,
          ),
        ].join(' ');
        const rewrite = applyPageObjectReuse(reconciled.content, intel.repoProfile, contextText, outputDir);
        reconciled.content = rewrite.code;
        repoIntelReport = rewrite.report;
        if (rewrite.report.totalUsed > 0) {
          logger.info(MOD, '✅ Page Object reuse applied', {
            feature: group.feature,
            used: rewrite.report.pageObjects.filter((p) => p.used).map((p) => p.name),
            available: rewrite.report.totalAvailable,
          });
        }
      } catch (err: any) {
        logger.warn(MOD, 'Page Object reuse failed (non-blocking)', {
          feature: group.feature, error: err?.message,
        });
      }
    }

    const coverage: FileCoverage = {
      filePath,
      feature: group.feature,
      testCases: caseIds.length,
      tests: reconciled.actualTests,
      missing: reconciled.missingFilled, // template-filled (now covered) — empty means clean AI pass
      aiFilled: reconciled.missingFilled.length,
      complete: reconciled.actualTests >= caseIds.length && reconciled.coveredIds.length === caseIds.length,
    };

    if (reconciled.missingFilled.length) {
      logger.warn(MOD, '⚠️ AI omitted test cases — template-filled to guarantee coverage', {
        feature: group.feature,
        missing: reconciled.missingFilled,
        filePath,
      });
    }
    if (reconciled.extra > 0) {
      logger.warn(MOD, '⚠️ AI emitted unmapped (extra) tests', {
        feature: group.feature, extra: reconciled.extra, filePath,
      });
    }

    return {
      file: {
        filePath,
        content: reconciled.content,
        testCount: reconciled.actualTests,
        feature: group.feature,
        testCaseIds: caseIds,
      },
      coverage,
      locatorReport,
      repoIntelReport,
    };
  }

  /** Build a compact LocatorReport from a flat list of resolved locators. */
  private buildGroupLocatorReport(resolved: ResolvedLocator[]): LocatorReport {
    const sources: LocatorReport['sources'] = {
      app_profile: 0, app_knowledge: 0, repo_patterns: 0, smart_fallback: 0,
    };
    let confidenceSum = 0;
    let validatedCount = 0;
    let todoCount = 0;
    const locators: LocatorReport['locators'] = [];
    for (const r of resolved) {
      sources[r.source] = (sources[r.source] || 0) + 1;
      confidenceSum += r.confidence;
      if (r.validated) validatedCount++;
      if (r.todoComment) todoCount++;
      locators.push({
        elementDescription: r.elementDescription,
        locator: r.locator,
        source: r.source,
        confidence: r.confidence,
        validated: r.validated,
      });
    }
    return {
      totalLocators: resolved.length,
      validatedCount,
      todoCount,
      avgConfidence: resolved.length ? Math.round(confidenceSum / resolved.length) : 0,
      sources,
      locators,
      warnings: [],
    };
  }

  /**
   * H1 — Derive concrete assertion guidance from a test case's Expected Result.
   * Maps common outcome phrasings to real Playwright assertions so the AI (and,
   * indirectly, reviewers) can see exactly which expect(...) each case needs.
   * Returns human-readable hints (not code) that are injected into the prompt.
   */
  private deriveRequiredAssertions(tc: any, baseUrl: string): string[] {
    const expected = `${tc?.expected_result || ''}`.trim();
    if (!expected) return [];
    const lc = expected.toLowerCase();
    const hints: string[] = [];

    // Navigation / redirect outcomes → toHaveURL with a real path.
    if (/\b(redirect|navigate|land on|taken to|go to|sent to)\b/.test(lc) ||
        /\b(dashboard|home ?page|inventory|profile|cart|checkout|landing)\b/.test(lc)) {
      hints.push(`Assert navigation with \`await expect(page).toHaveURL(/<real-path>/)\` (derive the path from the destination named in the Expected Result; base URL is "${baseUrl}"). Do NOT use \`toHaveURL(/.*/)\`.`);
    }
    // Error / validation messages → assert on the dedicated error container.
    if (/\b(error|invalid|fail|not allowed|denied|required|warning|message|alert|toast)\b/.test(lc)) {
      const msg = this.deriveErrorMessage(tc);
      const containsHint = msg
        ? `Then assert its text with \`.toContainText(${JSON.stringify(msg)})\`.`
        : 'Then assert it contains the exact message named in the Expected Result with `.toContainText("<message>")`.';
      hints.push(
        `Assert the error message is shown on the dedicated error element, e.g. ` +
        '`await expect(page.locator(\'[data-test="error"]\')).toBeVisible()`. ' +
        containsHint +
        ' Do NOT settle for asserting the username field is still visible or that the URL is unchanged.',
      );
    }
    // Visibility / presence outcomes.
    if (/\b(display|shown|appear|visible|see|present|render)\b/.test(lc)) {
      hints.push('Assert the relevant element is visible with `await expect(<locator>).toBeVisible()`.');
    }
    // Disappearance / hidden outcomes.
    if (/\b(hidden|disappear|removed|not (?:be )?(?:visible|shown|displayed)|no longer)\b/.test(lc)) {
      hints.push('Assert the element is gone with `await expect(<locator>).toBeHidden()` or `.toHaveCount(0)`.');
    }
    // Count / quantity outcomes.
    if (/\b(\d+\s+(?:items?|results?|rows?|products?|entries|records?))\b/.test(lc) || /\bcount\b/.test(lc)) {
      hints.push('Assert the expected quantity with `await expect(<locator>).toHaveCount(<n>)`.');
    }
    // Enabled/disabled state.
    if (/\b(enabled|disabled|clickable|greyed|grayed)\b/.test(lc)) {
      hints.push('Assert control state with `await expect(<locator>).toBeEnabled()` or `.toBeDisabled()`.');
    }
    // Value / field content.
    if (/\b(value|contains|equals|set to|populated|pre-?filled|text)\b/.test(lc)) {
      hints.push('Assert content with `await expect(<locator>).toHaveText(...)` / `.toHaveValue(...)` matching the Expected Result.');
    }

    // Always require at least one meaningful assertion tied to the outcome.
    if (!hints.length) {
      hints.push(`Add at least one meaningful assertion that verifies: "${expected.slice(0, 160)}". Never use a no-op like \`toHaveURL(/.*/)\`.`);
    }
    return hints;
  }

  /**
   * Selector used to assert error/validation messages in generated scripts.
   * Defaults to the conventional `[data-test="error"]` (SauceDemo-style) but is
   * overridable per-deployment via SCRIPTGEN_ERROR_SELECTOR.
   */
  private errorSelector(): string {
    return process.env.SCRIPTGEN_ERROR_SELECTOR || '[data-test="error"]';
  }

  /**
   * Is this a NEGATIVE test case (one whose Expected Result is an error/denial)?
   * Detected from the title, expected result and any embedded test-data hints —
   * the cases the reviewer flagged: invalid user, locked user, empty/missing
   * credentials, wrong password, etc.
   */
  private isNegativeCase(tc: any): boolean {
    const hay = `${tc?.title || ''} ${tc?.expected_result || ''} ${tc?.test_data || ''} ${this.parseJson(tc?.steps, []).join(' ')}`.toLowerCase();
    const expectsError = /\berror\b|not match|do not match|invalid|incorrect|denied|not allowed|locked|blank|empty|required|missing|unauthori[sz]ed|fail/i.test(hay);
    const expectsSuccess = /redirect|inventory|dashboard|logged in|success|land on/i.test(`${tc?.expected_result || ''}`.toLowerCase());
    // A case is negative when it expects an error AND does not primarily assert a success outcome.
    return expectsError && !expectsSuccess;
  }

  /**
   * Best-effort exact error message for a negative case. Pulls a quoted/explicit
   * message from the Expected Result when present, else maps well-known SauceDemo
   * failure modes. Returns null when nothing specific can be derived (caller then
   * asserts visibility only — still far better than the old no-op).
   */
  private deriveErrorMessage(tc: any): string | null {
    const expected = `${tc?.expected_result || ''}`.trim();
    // 1. Explicit quoted message in the expected result.
    const quoted = expected.match(/["“']([^"”']{6,})["”']/);
    if (quoted) return quoted[1].trim();

    // 2. Known failure modes (text fragments are matched case-insensitively at runtime).
    const hay = `${tc?.title || ''} ${expected} ${tc?.test_data || ''}`.toLowerCase();
    if (/locked/.test(hay)) return 'Sorry, this user has been locked out';
    if (/(empty|blank|missing).*(user|email)|user(name)? (is )?required/.test(hay)) return 'Username is required';
    if (/(empty|blank|missing).*(pass)|password (is )?required/.test(hay)) return 'Password is required';
    if (/invalid|incorrect|wrong|do not match|not match|bad credential/.test(hay)) return 'Username and password do not match';
    return null;
  }

  /**
   * Build real negative assertions for a failing case: assert the dedicated error
   * element is visible and (when derivable) contains the expected message. This
   * replaces the weak `expect(usernameField).toBeVisible()` / `toHaveURL(base)`
   * pattern the reviewer flagged as "verifies almost nothing".
   */
  private buildNegativeAssertions(tc: any, pad: string): string[] {
    const sel = this.errorSelector();
    const lines: string[] = [
      `${pad}// Negative case — the requirement says an error message must be displayed.`,
      `${pad}await expect(page.locator('${sel}')).toBeVisible();`,
    ];
    const msg = this.deriveErrorMessage(tc);
    if (msg) {
      lines.push(`${pad}await expect(page.locator('${sel}')).toContainText(/${this.escapeRegex(msg)}/i);`);
    }
    return lines;
  }

  /** Escape a literal string for safe embedding inside a RegExp literal. */
  private escapeRegex(s: string): string {
    return String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }

  /**
   * REVIEW FIX (Issue 4): Replace weak negative assertions with real error-element
   * checks. Detects tests that look negative (invalid/locked/error keywords) but
   * only assert `expect(#user-name).toBeVisible()` + `toHaveURL(base)` — a pattern
   * that verifies almost nothing — and injects proper error selector assertions.
   */
  private strengthenNegativeAssertions(code: string, cases: any[]): string {
    const lines = code.split('\n');
    const out: string[] = [];
    let currentTestCaseId: number | null = null;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // Track which test case we're in via the marker
      const marker = line.match(/@tc:TC(\d+)/);
      if (marker) {
        currentTestCaseId = parseInt(marker[1], 10);
      }

      // Detect weak negative assertion pattern: toBeVisible() on a form field in a negative test
      const isWeakAssertion =
        /expect\(.*?(#user-name|#password|#login-button|\['user|username|password).*?\)\.toBeVisible\(\)/.test(line);
      
      if (isWeakAssertion && currentTestCaseId) {
        const tc = cases.find((c: any) => c.id === currentTestCaseId);
        if (tc && this.isNegativeCase(tc)) {
          // Replace this weak assertion with a strong error assertion
          const pad = line.match(/^(\s*)/)?.[1] || '    ';
          const errorSel = this.errorSelector();
          const msg = this.deriveErrorMessage(tc);
          
          out.push(`${pad}// Strengthened: was weak ${line.match(/expect\((.*?)\)\.toBeVisible/)?.[1] || 'assertion'}`);
          out.push(`${pad}await expect(page.locator('${errorSel}')).toBeVisible();`);
          if (msg) {
            out.push(`${pad}await expect(page.locator('${errorSel}')).toContainText(/${this.escapeRegex(msg)}/i);`);
          }
          
          // Skip subsequent weak toHaveURL(base) assertion on the next line if present
          if (i + 1 < lines.length && /expect\(page\)\.toHaveURL\(['"]https?:\/\/.*?['"]?\)/.test(lines[i + 1])) {
            i++; // skip it
          }
          continue;
        }
      }

      out.push(line);
    }

    return out.join('\n');
  }

  /**
   * PHASE 5 — Validate a generated script against the review's defect list.
   * Returns a list of human-readable issues (empty = clean). Detects:
   *  - placeholder / hallucinated navigation targets (e.g. goto('login page'))
   *  - hallucinated credentials when real ones are available
   *  - no-op assertions (toHaveURL(/.*\/)/)
   *  - hard waits (waitForTimeout)
   *  - missing assertions entirely
   * Purely heuristic + non-throwing; used only to decide on a corrective retry.
   */
  private validateGeneratedScript(code: string, baseUrl: string, intel: IntelligenceBundle): string[] {
    const issues: string[] = [];
    if (!code) return issues;

    // 1. Placeholder navigation targets — goto() must point at a real URL/path,
    //    never an English phrase like 'login page' or 'the dashboard'.
    const gotoMatches = [...code.matchAll(/\.goto\(\s*[`'"]([^`'"]*)[`'"]/g)];
    for (const m of gotoMatches) {
      const target = (m[1] || '').trim();
      const looksLikeUrl = /^https?:\/\//i.test(target) || target.startsWith('/') || target === '' || target.includes('${') || target.startsWith('.');
      const looksLikePhrase = /\s/.test(target) || /^(the\s|login|dashboard|home|sign[\s-]?in|landing)\b/i.test(target);
      if (!looksLikeUrl && looksLikePhrase) {
        issues.push(`page.goto("${target}") is a placeholder phrase, not a URL. Navigate to the real Base URL "${baseUrl}" or a real path.`);
      }
    }

    // 2. Hallucinated credentials — if the profile gave us real creds, the
    //    common invented defaults must not appear.
    if (intel.credentials?.username || intel.credentials?.password) {
      const realU = (intel.credentials.username || '').toLowerCase();
      const realP = (intel.credentials.password || '').toLowerCase();
      const lc = code.toLowerCase();
      const invented = ['admin123', 'password123', 'test@test.com', 'user@example.com', 'admin@admin.com'];
      for (const bad of invented) {
        if (lc.includes(bad) && bad !== realU && bad !== realP) {
          issues.push(`Found likely hallucinated credential "${bad}". Use ONLY the provided test credentials.`);
        }
      }
    }

    // 3. No-op assertions.
    if (/toHaveURL\(\s*\/\.\*\/\s*\)/.test(code) || /toHaveURL\(\s*[`'"]?\s*[`'"]?\s*\)/.test(code)) {
      issues.push('Contains a no-op assertion `toHaveURL(/.*/)`. Replace with a real, specific assertion.');
    }

    // 4. Hard waits.
    if (/waitForTimeout\s*\(/.test(code)) {
      issues.push('Uses `waitForTimeout` (hard wait). Use web-first assertions / auto-waiting locators instead.');
    }

    // 5. Missing assertions entirely.
    if (!/\bexpect\s*\(/.test(code)) {
      issues.push('No `expect(...)` assertions found. Every test must verify its Expected Result.');
    }

    // 6. Semantic locator mismatches — "locator exists" ≠ "correct locator".
    issues.push(...this.detectSemanticLocatorMismatches(code));

    return issues;
  }

  /**
   * Item 3 — Semantic locator validation (REVIEW ENHANCEMENT).
   *
   * A locator existing in the DOM does NOT mean it is the RIGHT element. The
   * reviewer flagged cases such as:
   *
   *   1. await expect(page.locator('#item_4_title_link')).toHaveText(/Products/i);
   *      → #item_4_title_link is a product link, not the "Products" page title
   *
   *   2. error → #user-name (from dashboard screenshot)
   *      → username field is NOT the error message container
   *
   * This deterministic linter detects common mismatch classes WITHOUT needing
   * the DOM: when ELEMENT TYPE (inferred from the selector) is inconsistent with
   * ASSERTED CONTENT or when element descriptions clearly don't match selectors.
   * Conservative by design — only flags confident mismatches.
   */
  private detectSemanticLocatorMismatches(code: string): string[] {
    const warnings: string[] = [];
    
    // Rule 1: Title-on-item mismatch
    const textAssertRe = /expect\(\s*page\.locator\(\s*[`'"]([^`'"]+)[`'"]\s*\)\s*\)\s*(?:\.[a-zA-Z]+\([^)]*\)\s*)*?\.(toHaveText|toContainText)\(\s*([^)]+)\)/g;
    const itemLike = /(item|link|btn|button|add[-_]?to[-_]?cart|product[-_]?(link|img|name)|_title_link|cart[-_]?(link|badge|icon))/i;
    const titleLike = /products?|inventory|dashboard|home\s*page|cart\s*page|checkout|your\s+cart|overview/i;

    let m: RegExpExecArray | null;
    while ((m = textAssertRe.exec(code)) !== null) {
      const sel = m[1];
      const asserted = m[3];
      if (itemLike.test(sel) && titleLike.test(asserted)) {
        warnings.push(
          `Semantic locator mismatch: asserting page/section title (${asserted.trim().slice(0, 40)}) on an item/link selector "${sel}". ` +
          'This is "locator exists" but likely the WRONG element. Assert the title on a heading/title element (e.g. .title / [data-test="title"]).',
        );
      }
    }

    // Rule 2: Error-on-input-field mismatch (REVIEW FIX Issue 5)
    // Detects when looking for an "error" but the selector is clearly a form field.
    const inputSelectors = /#user-name|#username|#password|#email|#login-button|data-test=["']username["']|data-test=["']password["']/i;
    const errorContext = /error|message|alert|notification|invalid|incorrect|fail/i;
    
    // Check comments/variable names that suggest "error" but use input field selectors
    const commentErrorRe = /\/\/.*?(error|message).*/gi;
    let commentMatch: RegExpExecArray | null;
    const codeLines = code.split('\n');
    
    for (let i = 0; i < codeLines.length; i++) {
      const line = codeLines[i];
      const nextLine = codeLines[i + 1] || '';
      
      // If comment mentions "error" but next line uses an input field selector
      if (errorContext.test(line) && inputSelectors.test(nextLine)) {
        warnings.push(
          `Semantic mismatch (line ${i + 1}): comment/context suggests looking for "error" but selector targets a form field (user-name/password). ` +
          `Error messages typically live in [data-test="error"] or .error-message elements, not input fields.`
        );
      }
    }
    
    return warnings;
  }

  /**
   * Reconcile AI output against the input test cases for a group.
   * - Parses `// @tc:TC<id>` markers to find covered cases.
   * - Template-fills any omitted case so coverage is always 100%.
   * - Falls back to a fully deterministic file if the AI output is unusable.
   * Returns the final file content and exact counts.
   */
  private reconcileCoverage(
    aiCode: string,
    group: FileGroup,
    requirement: any,
    baseUrl: string,
    resolvedByCase: Map<number, ResolvedLocator[]>,
    dataIndex?: Map<string, Map<string, any>>,
  ): { content: string; actualTests: number; coveredIds: number[]; missingFilled: number[]; extra: number } {
    const inputIds = group.cases.map((c: any) => c.id);

    // No usable AI output → deterministic template file (guaranteed 1:1).
    const looksValid = aiCode && /\btest\s*\(/.test(aiCode) && aiCode.includes('@playwright/test');
    if (!looksValid) {
      const content = this.buildTemplateFile(group, requirement, baseUrl, group.cases, resolvedByCase, dataIndex);
      return {
        content,
        actualTests: group.cases.length,
        coveredIds: [...inputIds],
        missingFilled: [], // a clean deterministic build, not a partial fill
        extra: 0,
      };
    }

    // Parse markers from the AI output.
    const markerIds = this.extractMarkerIds(aiCode);
    const coveredIds = inputIds.filter(id => markerIds.has(id));
    const missing = inputIds.filter(id => !markerIds.has(id));
    const totalTestsInAi = this.countTests(aiCode);
    // Extra = tests that don't correspond to a known input marker.
    const extra = Math.max(0, totalTestsInAi - coveredIds.length);

    let content = aiCode;
    if (missing.length) {
      const missingCases = group.cases.filter((c: any) => missing.includes(c.id));
      content = this.injectTemplateTests(aiCode, group, missingCases, resolvedByCase, dataIndex);
    }

    const actualTests = this.countTests(content);

    return {
      content,
      actualTests,
      coveredIds: inputIds.filter(id => this.extractMarkerIds(content).has(id)),
      missingFilled: missing,
      extra,
    };
  }

  /** Extract the set of test case ids referenced by `// @tc:TC<id>` markers. */
  private extractMarkerIds(code: string): Set<number> {
    const ids = new Set<number>();
    const re = /@tc:TC(\d+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(code)) !== null) {
      ids.add(parseInt(m[1], 10));
    }
    return ids;
  }

  /** Count actual test() blocks (excludes describe/beforeEach/afterEach). */
  private countTests(code: string): number {
    const matches = code.match(/\btest\s*(\.(skip|only|fixme))?\s*\(/g);
    return matches ? matches.length : 0;
  }

  /**
   * Inject template tests for omitted cases into the AI file. Inserts a nested
   * describe block just before the final closing of the top-level describe;
   * if that can't be located, appends a standalone describe at the end.
   */
  private injectTemplateTests(
    aiCode: string,
    group: FileGroup,
    missingCases: any[],
    resolvedByCase: Map<number, ResolvedLocator[]>,
    dataIndex?: Map<string, Map<string, any>>,
  ): string {
    const block = [
      `  test.describe('Coverage (auto-filled)', () => {`,
      missingCases.map(tc => this.buildTemplateTest(tc, 2, resolvedByCase.get(tc.id), dataIndex)).join('\n\n'),
      `  });`,
    ].join('\n');

    const lastClose = aiCode.lastIndexOf('});');
    if (lastClose !== -1) {
      return `${aiCode.slice(0, lastClose)}\n${block}\n${aiCode.slice(lastClose)}`;
    }
    // Fallback: wrap as a standalone describe appended to the file.
    return `${aiCode}\n\ntest.describe('${this.escapeStr(group.feature)} — Coverage (auto-filled)', () => {\n${missingCases.map(tc => this.buildTemplateTest(tc, 1, resolvedByCase.get(tc.id), dataIndex)).join('\n\n')}\n});\n`;
  }

  /**
   * Build a single deterministic template test (always carries its marker).
   *
   * Quality fix (Phase 3): the old template emitted a no-op "match any URL"
   * assertion that ALWAYS passes — a fake-green test.
   * Now:
   *   • If the LocatorResolver produced concrete locators for this case, we
   *     emit real `await expect(<locator>).toBeVisible()` assertions grounded
   *     in the actual app, plus a low-confidence `// verify` note where needed.
   *   • If NO locators could be resolved, we emit `test.fixme(...)` so the test
   *     is honestly reported as "not yet implemented" instead of falsely
   *     passing. Coverage is still tracked via the `// @tc:` marker.
   */
  private buildTemplateTest(
    tc: any,
    indentLevel = 1,
    resolved?: ResolvedLocator[],
    dataIndex?: Map<string, Map<string, any>>,
  ): string {
    const pad = '  '.repeat(indentLevel);
    const steps = this.parseJson(tc.steps, []);
    const stepsComment = steps.length
      ? steps.map((s: string, i: number) => `${pad}  // Step ${i + 1}: ${this.escapeStr(String(s))}`).join('\n')
      : `${pad}  // TODO: implement test steps`;

    const usable = (resolved || []).filter(r => r.confidence >= 40).slice(0, 3);

    // Detect if this is a login-flow test case and bind test data if available.
    const isLoginTest = /login|authenticate|sign.?in|credential/i.test(`${tc.title} ${steps.join(' ')}`);
    let loginBlock = '';
    let importGetRecord = false;
    if (isLoginTest && dataIndex && this.hasResolvedData(dataIndex)) {
      // Find the first dataset with "username" + "password" fields.
      for (const [dsName, recMap] of dataIndex) {
        const firstRec = recMap.values().next().value;
        if (firstRec && (firstRec.username != null || firstRec.password != null)) {
          // Check if this specific test targets a non-representative record (locked, etc.)
          let recordKey: string | undefined;
          let selector: string;
          const haystack = `${tc.title} ${tc.test_data || ''} ${steps.join(' ')}`.toLowerCase();
          for (const key of recMap.keys()) {
            if (haystack.includes(key.toLowerCase()) && !this.isRepresentativeRecord(recMap, key)) {
              recordKey = key;
              break;
            }
          }
          selector = this.datasetRef(dsName, recordKey);
          loginBlock = `${pad}  const user = ${selector};
${pad}  await page.locator('#user-name').fill(user.username ?? '');
${pad}  await page.locator('#password').fill(user.password ?? '');
${pad}  await page.locator('#login-button').click();
`;
          importGetRecord = true;
          break;
        }
      }
    }

    // Negative case → assert the error message is actually displayed. The
    // requirement explicitly says "an error message should be displayed", so a
    // login attempt followed by an error-element assertion is a real, runnable
    // test — far stronger than the old `expect(usernameField).toBeVisible()`.
    const negative = this.isNegativeCase(tc);
    if (negative && loginBlock) {
      const negAssertions = this.buildNegativeAssertions(tc, `${pad}  `).join('\n');
      return `${pad}test('${this.escapeStr(tc.title)}', async ({ page }) => {
${pad}  // @tc:TC${tc.id}
${stepsComment}
${pad}  // Expected: ${this.escapeStr(tc.expected_result || 'Verify expected behavior')}
${loginBlock}${negAssertions}
${pad}});`;
    }

    if (usable.length) {
      // Real, meaningful assertions on resolved locators. For negative cases we
      // additionally assert the error element so the failure is truly verified.
      const assertions = usable.map(r => {
        const note = r.confidence < 60 ? '  // verify: low-confidence locator' : '';
        return `${pad}  await expect(${r.locator}).toBeVisible();${note}`;
      }).join('\n');
      const extra = negative ? `\n${this.buildNegativeAssertions(tc, `${pad}  `).join('\n')}` : '';

      return `${pad}test('${this.escapeStr(tc.title)}', async ({ page }) => {
${pad}  // @tc:TC${tc.id}
${stepsComment}
${pad}  // Expected: ${this.escapeStr(tc.expected_result || 'Verify expected behavior')}
${loginBlock}${assertions}${extra}
${pad}});`;
    }

    // No locators resolved → mark as not-yet-implemented rather than fake-pass.
    return `${pad}test.fixme('${this.escapeStr(tc.title)}', async ({ page }) => {
${pad}  // @tc:TC${tc.id}
${stepsComment}
${pad}  // Expected: ${this.escapeStr(tc.expected_result || 'Verify expected behavior')}
${loginBlock ? loginBlock : `${pad}  // TODO: no locators could be resolved automatically — add real selectors + assertions.\n`}${pad}});`;
  }

  /**
   * Build a fully deterministic spec file for a group with nested describe
   * blocks grouped by scenario. Guarantees exactly one test per input case.
   */
  private buildTemplateFile(
    group: FileGroup,
    requirement: any,
    baseUrl: string,
    cases: any[],
    resolvedByCase: Map<number, ResolvedLocator[]>,
    dataIndex?: Map<string, Map<string, any>>,
  ): string {
    // Sub-group cases by scenario name for nested describe blocks.
    const byScenario = new Map<string, any[]>();
    for (const tc of cases) {
      const sc = String(tc.scenario || group.feature);
      if (!byScenario.has(sc)) byScenario.set(sc, []);
      byScenario.get(sc)!.push(tc);
    }

    const inner = [...byScenario.entries()].map(([scenario, scCases]) => {
      const tests = scCases.map(tc => this.buildTemplateTest(tc, 2, resolvedByCase.get(tc.id), dataIndex)).join('\n\n');
      return `  test.describe('${this.escapeStr(scenario)}', () => {\n${tests}\n  });`;
    }).join('\n\n');

    const partNote = group.part && (group.totalParts || 1) > 1
      ? ` (part ${group.part}/${group.totalParts})`
      : '';

    // Detect if any test case uses test data (getRecord) to conditionally import it.
    const usesTestData = inner.includes('getRecord(');
    const importLine = usesTestData
      ? `import { test, expect } from '@playwright/test';\nimport { getRecord } from './data/test-data';`
      : `import { test, expect } from '@playwright/test';`;

    return `${importLine}

/**
 * ${this.escapeStr(group.feature)}${partNote}
 * Requirement: ${this.escapeStr(requirement.title)}
 * Coverage: ${group.coverageType}
 * Generated by LevelUp AI Test-to-Script Engine (deterministic build)
 */
test.describe('${this.escapeStr(group.feature)}', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('${baseUrl}');
  });

${inner}
});
`;
  }

  private generateHelpers(outputDir: string): GeneratedScriptFile {
    return {
      filePath: `${outputDir}/helpers.ts`,
      feature: 'helpers',
      testCaseIds: [],
      content: `/**
 * Shared test helpers — generated by LevelUp AI
 */

/** Wait for network to be idle (useful after navigation/form submit) */
export async function waitForNetworkIdle(page: import('@playwright/test').Page, timeout = 5000) {
  await page.waitForLoadState('networkidle', { timeout });
}

/** Fill a form field by label, placeholder, or data-testid */
export async function fillField(
  page: import('@playwright/test').Page,
  identifier: string,
  value: string,
) {
  const locator = page.locator(
    \`input[data-testid="\${identifier}"], input[placeholder*="\${identifier}" i], label:has-text("\${identifier}") + input, label:has-text("\${identifier}") input\`,
  ).first();
  await locator.fill(value);
}

/** Click a button by text, role, or data-testid */
export async function clickButton(
  page: import('@playwright/test').Page,
  identifier: string,
) {
  const locator = page.locator(
    \`button:has-text("\${identifier}"), [data-testid="\${identifier}"], [role="button"]:has-text("\${identifier}")\`,
  ).first();
  await locator.click();
}

/** Assert that a toast/notification message is visible */
export async function expectToast(
  page: import('@playwright/test').Page,
  text: string,
) {
  await expect(page.locator(\`text=\${text}\`).first()).toBeVisible({ timeout: 5000 });
}

import { expect } from '@playwright/test';
`,
      testCount: 0,
    };
  }

  /* ── coverage report ─────────────────────────────────────── */

  private buildCoverageReport(testCases: any[], perFile: FileCoverage[]): CoverageReport {
    const totalTestCases = testCases.length;
    const totalTestsGenerated = perFile.reduce((s, f) => s + f.tests, 0);
    // A case is "covered" if its file accounts for it (tests >= testCases per file
    // is guaranteed by template-fill, so covered === sum of input cases per file).
    const covered = perFile.reduce((s, f) => s + f.testCases, 0);
    const missing = perFile.flatMap(f => (f.complete ? [] : f.missing));
    const extra = Math.max(0, totalTestsGenerated - covered);

    return {
      totalTestCases,
      totalTestsGenerated,
      covered: Math.min(covered, totalTestCases),
      missing,
      extra,
      complete: covered >= totalTestCases && missing.length === 0,
      perFile,
    };
  }

  /* ── utils ───────────────────────────────────────────────── */

  private slugify(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'test';
  }

  private escapeStr(s: string): string {
    return (s || '').replace(/'/g, "\\'").replace(/\n/g, ' ').slice(0, 120);
  }

  private parseJson(val: any, fallback: any): any {
    if (Array.isArray(val)) return val;
    if (typeof val === 'string') {
      try { return JSON.parse(val); } catch { return fallback; }
    }
    return fallback;
  }

  /* ── Test Data → Script traceability (ported from script-gen-engine) ── */

  /**
   * Flatten resolved dataset records into an index:
   *   { datasetName -> { recordKey -> value } }
   */
  private buildTestDataIndex(
    resolvedTestData?: Array<{ name: string; environment?: string; records: Array<{ key: string; value: any }> }>,
  ): Map<string, Map<string, any>> {
    const index = new Map<string, Map<string, any>>();
    for (const ds of resolvedTestData || []) {
      if (!ds?.name || !Array.isArray(ds.records)) continue;
      const recMap = new Map<string, any>();
      for (const rec of ds.records) {
        if (rec?.key == null) continue;
        recMap.set(String(rec.key), rec.value);
      }
      if (recMap.size > 0) index.set(ds.name, recMap);
    }
    return index;
  }

  /** True when the resolved-data index actually carries records. */
  private hasResolvedData(index: Map<string, Map<string, any>>): boolean {
    return index.size > 0;
  }

  /**
   * Decide whether a record is the dataset's "representative" row — the
   * default a generic valid-path test should use. When true we omit the record
   * selector so the script binds to the dataset only.
   */
  private isRepresentativeRecord(recMap: Map<string, any>, key: string): boolean {
    const keys = [...recMap.keys()];
    if (keys[0] === key) return true;
    if (/^(?!.*(lock|problem|glitch|invalid|expired|disabled|blocked|bad)).*(standard|valid|default|primary|active|good)/i.test(key)) {
      return true;
    }
    return false;
  }

  /**
   * Build a dataset-binding expression. Scripts bind to DATASET NAME + SCHEMA,
   * not a hardcoded vendor record. Record selection is late-bound at runtime.
   */
  private datasetRef(datasetName: string, recordKey?: string): string {
    return recordKey != null
      ? `getRecord(${JSON.stringify(datasetName)}, ${JSON.stringify(recordKey)})`
      : `getRecord(${JSON.stringify(datasetName)})`;
  }

  /**
   * Generate the shared `tests/data/test-data.ts` module from resolved records.
   * Schema-first: datasets are arrays, getDataset() returns all rows,
   * getRecord() resolves one record late-bound (default first row, or by
   * key/index/tag/predicate). Generated specs reference datasets by NAME.
   */
  private buildTestDataModule(index: Map<string, Map<string, any>>): GeneratedScriptFile | null {
    if (!this.hasResolvedData(index)) return null;
    // Normalize each record into { key, ...fields }
    const datasetsObj: Record<string, Array<Record<string, any>>> = {};
    const dsNames: string[] = [];
    for (const [dsName, recMap] of index) {
      dsNames.push(dsName);
      const rows: Array<Record<string, any>> = [];
      for (const [key, value] of recMap) {
        const row: Record<string, any> =
          value && typeof value === 'object' && !Array.isArray(value)
            ? { key, ...value }
            : { key, value };
        rows.push(row);
      }
      datasetsObj[dsName] = rows;
    }

    const namedExports = dsNames.map(name => {
      const camel = name.replace(/[_-]+(\w)/g, (_, c) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '');
      const safe = /^[a-zA-Z_$]/.test(camel) ? camel : `dataset_${camel}`;
      return `export const ${safe} = datasets[${JSON.stringify(name)}] ?? [];`;
    }).join('\n');

    const content = `/**
 * Generated test-data module — sourced from the LevelUp Test Data Store.
 *
 * Datasets: ${dsNames.join(', ')}
 *
 * Generated specs bind to DATASET NAMES + SCHEMA and resolve a concrete record
 * at runtime via getRecord(), so they keep working as the underlying data
 * changes. Regenerate from the Test Data Store rather than editing by hand.
 */

export interface DataRecord {
  /** The record's key within its dataset (e.g. "standard_user"). */
  key: string;
  username?: string;
  password?: string;
  /** Optional classification tags from the Test Data Store. */
  tags?: string[];
  [field: string]: unknown;
}

/** Selector for resolving one record from a dataset (late-bound). */
export type RecordSelector =
  | string                                   // match by record key
  | number                                   // match by index
  | { tag: string }                          // first record carrying a tag
  | { where: (r: DataRecord) => boolean };   // first record matching a predicate

/** All datasets, keyed by name → ordered list of records (schema-first). */
const datasets: Record<string, DataRecord[]> = ${JSON.stringify(datasetsObj, null, 2)};

/** Return every record in a dataset (its full schema/rows). */
export function getDataset(name: string): DataRecord[] {
  const ds = datasets[name];
  if (!ds) throw new Error('Unknown dataset: ' + name);
  return ds;
}

/**
 * Resolve ONE record from a dataset. Selection is intentionally late-bound so
 * the generated script keeps working as records are added/changed:
 *   - no selector → the first record (a representative row)
 *   - string      → match by record key
 *   - number      → match by index
 *   - { tag }     → first record carrying that tag
 *   - { where }   → first record matching a predicate
 */
export function getRecord(name: string, selector?: RecordSelector): DataRecord {
  const ds = getDataset(name);
  let rec: DataRecord | undefined;
  if (selector == null) rec = ds[0];
  else if (typeof selector === 'number') rec = ds[selector];
  else if (typeof selector === 'string') rec = ds.find(r => r.key === selector);
  else if ('tag' in selector) rec = ds.find(r => (r.tags ?? []).includes(selector.tag));
  else rec = ds.find(selector.where);
  if (!rec) throw new Error('No record in dataset "' + name + '" for selector ' + JSON.stringify(selector));
  return rec;
}

${namedExports}

/** Flat object view, e.g. \`testData.valid_users[0]\`. */
export const testData = datasets;

export default datasets;
`;
    return {
      filePath: 'tests/data/test-data.ts',
      content,
      testCount: 0,
      feature: 'test-data',
      testCaseIds: [],
    };
  }
}
