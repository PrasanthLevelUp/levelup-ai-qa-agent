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

  constructor() {
    this.openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.model = process.env.SCRIPT_GEN_MODEL || 'gpt-4o-mini';
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

    for (const group of groups) {
      const { file, coverage, locatorReport } = await this.generateScriptForGroup(
        group,
        requirement,
        framework,
        effectiveBaseUrl,
        outputDir,
        knowledgeContext,
        intel,
      );
      files.push(file);
      perFile.push(coverage);
      if (locatorReport) locatorReports.push(locatorReport);
    }

    // 6. Generate shared helpers file (not counted as coverage)
    files.push(this.generateHelpers(outputDir));

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
    const intelligence: IntelligenceUsage = {
      appProfileUsed: intel.appProfileUsed,
      appKnowledgeUsed: intel.appKnowledgeUsed,
      repoPatternsUsed: !!intel.repoGuide,
      testDataUsed: intel.testDataUsed,
      locatorReport: mergedLocatorReport,
    };
    logger.info(MOD, '🧠 Intelligence usage', {
      appProfile: intelligence.appProfileUsed,
      appKnowledge: intelligence.appKnowledgeUsed,
      repoPatterns: intelligence.repoPatternsUsed,
      testData: intelligence.testDataUsed,
      locatorsResolved: mergedLocatorReport?.totalLocators ?? 0,
      avgLocatorConfidence: mergedLocatorReport?.avgConfidence ?? 0,
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

    return {
      requirementId,
      requirementTitle: requirement.title,
      files,
      totalTests,
      totalFiles: files.length,
      coverage,
      intelligence,
      ...(frameworkAnalysis ? { frameworkAnalysis } : {}),
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
  ): Promise<{ file: GeneratedScriptFile; coverage: FileCoverage; locatorReport?: LocatorReport }> {
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
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: maxTokens,
      });
      aiCode = response.choices[0]?.message?.content?.trim() || '';
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
          const retry = await this.openai.chat.completions.create({
            model: this.model,
            messages: [{ role: 'user', content: fixPrompt }],
            temperature: 0.1,
            max_tokens: maxTokens,
          });
          let retryCode = retry.choices[0]?.message?.content?.trim() || '';
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
    const reconciled = this.reconcileCoverage(aiCode, group, requirement, baseUrl, resolvedByCase);

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
    // Error / validation messages → toContainText / toBeVisible on the message.
    if (/\b(error|invalid|fail|not allowed|denied|required|warning|message|alert|toast)\b/.test(lc)) {
      hints.push('Assert the exact message text is visible, e.g. `await expect(page.getByText(/<message>/i)).toBeVisible()` or `toContainText("<message>")`.');
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

    return issues;
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
  ): { content: string; actualTests: number; coveredIds: number[]; missingFilled: number[]; extra: number } {
    const inputIds = group.cases.map((c: any) => c.id);

    // No usable AI output → deterministic template file (guaranteed 1:1).
    const looksValid = aiCode && /\btest\s*\(/.test(aiCode) && aiCode.includes('@playwright/test');
    if (!looksValid) {
      const content = this.buildTemplateFile(group, requirement, baseUrl, group.cases, resolvedByCase);
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
      content = this.injectTemplateTests(aiCode, group, missingCases, resolvedByCase);
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
  ): string {
    const block = [
      `  test.describe('Coverage (auto-filled)', () => {`,
      missingCases.map(tc => this.buildTemplateTest(tc, 2, resolvedByCase.get(tc.id))).join('\n\n'),
      `  });`,
    ].join('\n');

    const lastClose = aiCode.lastIndexOf('});');
    if (lastClose !== -1) {
      return `${aiCode.slice(0, lastClose)}\n${block}\n${aiCode.slice(lastClose)}`;
    }
    // Fallback: wrap as a standalone describe appended to the file.
    return `${aiCode}\n\ntest.describe('${this.escapeStr(group.feature)} — Coverage (auto-filled)', () => {\n${missingCases.map(tc => this.buildTemplateTest(tc, 1, resolvedByCase.get(tc.id))).join('\n\n')}\n});\n`;
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
  private buildTemplateTest(tc: any, indentLevel = 1, resolved?: ResolvedLocator[]): string {
    const pad = '  '.repeat(indentLevel);
    const steps = this.parseJson(tc.steps, []);
    const stepsComment = steps.length
      ? steps.map((s: string, i: number) => `${pad}  // Step ${i + 1}: ${this.escapeStr(String(s))}`).join('\n')
      : `${pad}  // TODO: implement test steps`;

    const usable = (resolved || []).filter(r => r.confidence >= 40).slice(0, 3);

    if (usable.length) {
      // Real, meaningful assertions on resolved locators.
      const assertions = usable.map(r => {
        const note = r.confidence < 60 ? '  // verify: low-confidence locator' : '';
        return `${pad}  await expect(${r.locator}).toBeVisible();${note}`;
      }).join('\n');

      return `${pad}test('${this.escapeStr(tc.title)}', async ({ page }) => {
${pad}  // @tc:TC${tc.id}
${stepsComment}
${pad}  // Expected: ${this.escapeStr(tc.expected_result || 'Verify expected behavior')}
${assertions}
${pad}});`;
    }

    // No locators resolved → mark as not-yet-implemented rather than fake-pass.
    return `${pad}test.fixme('${this.escapeStr(tc.title)}', async ({ page }) => {
${pad}  // @tc:TC${tc.id}
${stepsComment}
${pad}  // Expected: ${this.escapeStr(tc.expected_result || 'Verify expected behavior')}
${pad}  // TODO: no locators could be resolved automatically — add real selectors + assertions.
${pad}});`;
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
  ): string {
    // Sub-group cases by scenario name for nested describe blocks.
    const byScenario = new Map<string, any[]>();
    for (const tc of cases) {
      const sc = String(tc.scenario || group.feature);
      if (!byScenario.has(sc)) byScenario.set(sc, []);
      byScenario.get(sc)!.push(tc);
    }

    const inner = [...byScenario.entries()].map(([scenario, scCases]) => {
      const tests = scCases.map(tc => this.buildTemplateTest(tc, 2, resolvedByCase.get(tc.id))).join('\n\n');
      return `  test.describe('${this.escapeStr(scenario)}', () => {\n${tests}\n  });`;
    }).join('\n\n');

    const partNote = group.part && (group.totalParts || 1) > 1
      ? ` (part ${group.part}/${group.totalParts})`
      : '';

    return `import { test, expect } from '@playwright/test';

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
}
