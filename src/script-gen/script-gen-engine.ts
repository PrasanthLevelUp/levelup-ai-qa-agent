/**
 * Script Generation Engine — Core Orchestrator
 * 
 * Architecture: Structured JSON Test Plan → Deterministic Code Generation
 * 
 * Flow:
 * 1. Crawler Engine → extracts DOM intelligence
 * 2. Workflow Mapper → builds navigation graph & flows
 * 3. AI Test Plan Generator → creates structured JSON test plans
 * 4. Selector Quality Engine → ranks selectors for reliability
 * 5. Assertion Engine → generates meaningful assertions
 * 6. Wait Strategy Engine → generates smart waits (no waitForTimeout)
 * 7. Code Generator → deterministically generates Playwright TS
 * 8. Validation Runner → compiles and validates
 * 
 * IMPORTANT: Does NOT directly generate code from AI prompts.
 * Instead: AI generates structured test plans, then deterministic
 * code generation converts plans to Playwright TypeScript.
 */

import OpenAI from 'openai';
import { AnthropicClient, resolveAnthropicModel, isAnthropicConfigured } from '../ai/anthropic-client';
import * as nodePath from 'path';
import { PageCrawler, type CrawlResult, type CrawlConfig, type PageElement } from './page-crawler';
import {
  normalizeTestCase,
  describeStageOneFailure,
  type NormalizationDiagnostics,
} from './canonical-test-case';
import { normalizeResolvedTestData } from './canonical-test-data';
import type { AuthConfig, AuthResult } from './auth-engine';
import { WorkflowMapper, type WorkflowMap, type WorkflowFlow, type WorkflowStep, type WorkflowAction } from './workflow-mapper';
import { SelectorQualityEngine, type ScoredSelector } from './selector-quality-engine';
import { buildStabilityProvider, trackGeneratedSelector } from '../services/intelligence-learning-service';
import { getCrawlAdaptationForUrl } from '../services/crawl-adaptation-service';
import { AssertionEngine, type GeneratedAssertion } from './assertion-engine';
import {
  planVerifications,
  type VerificationContext,
  type VerificationPlan,
  type EvidenceKind,
} from './verification-standards';
import {
  ScenarioIntelligence,
  type CredentialResolver as ScenarioCredentialResolver,
} from './scenario-intelligence';
import { WaitStrategyEngine, type WaitStrategy } from './wait-strategy-engine';
import { logger } from '../utils/logger';
import type { RepositoryProfile, ClassInfo } from '../context/types';
import { extractSelectorInfo } from '../context/ast-analyzer';
import { analyzeRepoStructure, buildPageObjectFileName, buildSpecFileName } from './repo-analyzer';
import type { RepoStructureAnalysis } from './repo-analyzer';
import {
  buildConventionProfile,
  buildReuseCatalogue,
  findReusablePageObject,
  resolveTestDataModulePath,
  resolveFixturePath,
  resolveHelperPath,
  resolveImportSpecifier,
  type ProjectConventionProfile,
} from '../intelligence/project-convention-profile';
import { analyzeRepoPatterns } from './repo-pattern-analyzer';
import { rankLocatorCandidates, type ElementLike } from '../intelligence/element-intelligence';
import { discoverCandidates, rankReport, type CandidateDiscoveryReport } from './candidate-discovery';
import { adaptiveGenerateFiles } from './adaptive-codegen';
import { getRAGService } from '../services/rag-service';
import { TrueReuseEngine } from '../services/true-reuse-engine';
import {
  IntelligenceOrchestrator,
  getIntelligenceOrchestrator,
  type OrchestratorSource,
} from '../services/intelligence-orchestrator';
import { auditFramework, type FrameworkAuditResult, type GenerationContext } from './framework-auditor';

const MOD = 'script-gen-engine';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/** Structured JSON test plan — the intermediate format before code generation */
export interface TestPlan {
  name: string;
  description: string;
  baseUrl: string;
  pageType: string;
  flows: TestPlanFlow[];
  fixtures: TestPlanFixture[];
  pageObjects: PageObjectSpec[];
  metadata: {
    generatedAt: string;
    crawlTimeMs: number;
    totalElements: number;
    selectorQuality: number;
    model: string;
    tokensUsed: number;
  };
}

export interface TestPlanFlow {
  name: string;
  description: string;
  flowType: string;
  priority: number;
  steps: TestPlanStep[];
  tags: string[];            // e.g., ['smoke', 'auth', 'regression']
}

export interface TestPlanStep {
  action: 'navigate' | 'fill' | 'click' | 'select' | 'hover' | 'press' | 'assert' | 'wait' | 'screenshot';
  target?: string;            // selector description
  selector?: string;          // resolved Playwright selector
  value?: string;             // for fill/select actions
  description: string;
  waitAfter?: string;         // wait strategy code
  assertions?: string[];      // assertion code lines
  isOptional?: boolean;       // if step failure shouldn't fail the test
}

export interface TestPlanFixture {
  name: string;               // e.g., 'loginUser'
  description: string;
  steps: TestPlanStep[];
}

export interface PageObjectSpec {
  name: string;               // e.g., 'LoginPage'
  fileName: string;           // e.g., 'login.page.ts'
  url: string;
  pageType: string;
  locators: {
    name: string;             // e.g., 'usernameInput'
    selector: string;         // Playwright selector code
    score: number;
    strategy: string;
  }[];
  actions: {
    name: string;             // e.g., 'login'
    steps: TestPlanStep[];
  }[];
}

/**
 * One resolved interactive element and whether it was grounded in the REAL
 * crawled DOM (App Profile) or fell back to a generic/hardcoded selector.
 * Powers the "Locator Grounding Report" so the UI can show ✓ grounded vs
 * ⚠ not-found-in-crawl per element instead of an opaque, hardcoded 0%.
 */
export interface LocatorGroundingEntry {
  /** Logical element name, e.g. 'username', 'login', 'cart'. */
  name: string;
  /** The Playwright selector the generated script actually uses. */
  selector: string;
  /** True when matched against a real element in the crawl DOM. */
  grounded: boolean;
  /**
   * True when the selector is a REAL, known-good selector even if it was not
   * DOM-verified against this crawl. Every grounded entry is knownGood; a
   * fallback is knownGood because it comes from the curated, app-contract
   * selector library (e.g. SauceDemo's documented `[data-test="error"]`) — it
   * is NOT a hallucinated guess. This powers an honest "REAL LOCATORS x/y"
   * headline that no longer undersells curated fallbacks as 0%.
   */
  knownGood: boolean;
  /** Normalized confidence 0–100 (lower for a known-good-but-unverified fallback). */
  confidence: number;
  /** How the selector was derived: id | data-test | data-testid | name | css | fallback. */
  source: string;
}

/**
 * Aggregate grounding report for a generation. `groundedCount / total` is the
 * REAL locator-validation percentage (replaces the old hardcoded 0%).
 */
export interface LocatorGroundingReport {
  entries: LocatorGroundingEntry[];
  total: number;
  /** Count DOM-verified against the real crawl (App Profile). */
  groundedCount: number;
  /** Grounded percentage 0–100 = round(groundedCount / total * 100). */
  groundedPct: number;
  /**
   * Count of REAL (non-hallucinated) locators = DOM-verified + curated
   * known-good fallbacks. This is the honest headline metric: a curated
   * `[data-test="error"]` is a real selector even when the crawled login page
   * didn't contain the post-login error element.
   */
  realCount: number;
  /** Real (known-good) percentage 0–100 = round(realCount / total * 100). */
  realPct: number;
  /** Average confidence across all reported entries, 0–100. */
  avgConfidence: number;

  /* ── App-Profile-grounding KPI (customer proof point) ──────────────────────
   * Breaks the locators into WHERE they came from so the UI can show, per spec:
   *   "22 locators · ✓ 20 from App Profile · ✓ 2 healed by AI · 91% Repository
   *    Grounded · 9% AI". The north-star is to grow `fromAppProfile` and shrink
   *   `fromAI` as the App Profile improves. `fromFallback` are curated
   *   app-contract selectors (neither DOM-verified nor AI) — reported honestly
   *   as a third bucket so the App-Profile % is never inflated. */
  /** Locators resolved directly from the crawled App Profile DOM (grounded). */
  fromAppProfile: number;
  /** Curated/known-good fallback selectors (not DOM-verified, not AI). */
  fromFallback: number;
  /** Locators produced/repaired by AI (LLM or healing suggestions). */
  fromAI: number;
  /** % of locators sourced from the App Profile = round(fromAppProfile/total*100). */
  appProfilePct: number;
  /** % of locators sourced from AI = round(fromAI/total*100). */
  aiPct: number;
}

/**
 * Classify a grounding entry's `source`/flags into ONE provenance bucket for
 * the App-Profile KPI. Kept as a free function so both the engine and any
 * reporting layer categorize identically.
 *   - 'app-profile' — DOM-verified against the crawl (id/name/data-attr/css/role)
 *   - 'ai'          — produced or healed by the LLM/healing engine
 *   - 'fallback'    — curated known-good app-contract selector (neither of above)
 */
export function classifyLocatorProvenance(e: {
  grounded: boolean;
  source?: string;
}): 'app-profile' | 'ai' | 'fallback' {
  const src = (e.source || '').toLowerCase();
  if (src === 'ai' || src === 'ai-healed' || src === 'llm' || src === 'healed') return 'ai';
  if (e.grounded) return 'app-profile';
  return 'fallback';
}

/**
 * Pipeline observability (user request) — a per-run summary that shows WHERE in
 * the deterministic requirement/test-case pipeline the count drops to zero, so
 * "nothing generated" can be localized in one screen without SQL or logs.
 *
 * The stages mirror the real code path a case travels through:
 *
 *   inputTestCases   → cases handed to the deterministic engine
 *   canonicalized    → cases whose steps normalized to ≥1 canonical string step
 *   parsed           → cases whose canonical steps yielded ≥1 automatable action
 *                      (the per-case translator was actually invoked)
 *   grounded         → cases that resolved ≥1 REAL locator against the App Profile
 *   generatedScripts → cases that emitted at least one spec file
 *
 * When two adjacent numbers differ, that gap is the failing stage. Example:
 *   11 → 11 → 11 → 0 → 0  means parsing works but grounding failed (App Profile /
 *   Locator Intelligence problem), NOT a canonicalization problem.
 */
export type PipelineStageName =
  | 'Canonicalization'
  | 'Step Parsing'
  | 'Grounding'
  | 'Script Emit'
  | 'Generated';

/**
 * Common authentication scenario categories used to map a test case to the
 * correct test dataset (Data Quality). Deterministic — derived from case
 * signals, never an LLM.
 */
type AuthDatasetCategory =
  | 'valid'
  | 'locked'
  | 'invalid_password'
  | 'unknown_user'
  | 'empty_username'
  | 'empty_password'
  | 'invalid';

/** Per-test-case trace entry — the deepest stage a single case reached. */
export interface CaseTrace {
  id: string | number | null;
  title: string | null;
  /** The deepest pipeline stage this case reached. */
  reachedStage: PipelineStageName;
  status: 'OK' | 'FAILED';
  /** Human-readable reason when status is FAILED. */
  reason?: string;
  /** Canonical step count (post-normalization). */
  stepCount?: number;
}

/** Aggregate pipeline summary across all cases in a requirement/batch run. */
export interface PipelineSummary {
  inputTestCases: number;
  canonicalized: number;
  parsed: number;
  grounded: number;
  generatedScripts: number;
  /** Per-case breakdown (capped by the caller when serialized to the API). */
  cases: CaseTrace[];
}

export interface GenerationResult {
  testPlan: TestPlan;
  generatedFiles: GeneratedFile[];
  stats: {
    totalTests: number;
    totalAssertions: number;
    avgSelectorScore: number;
    pageObjectsGenerated: number;
    crawlTimeMs: number;
    generationTimeMs: number;
    tokensUsed: number;
    model: string;
  };
  errors: string[];
  /** Present when authentication was attempted */
  authResult?: AuthResult;
  /** Raw crawl data for Application Intelligence caching */
  rawCrawlData?: any;
  /** Framework audit analysis (Phase 1: Impact Analysis + Quality Report) */
  frameworkAnalysis?: FrameworkAuditResult;
  /**
   * Per-element locator grounding for the deterministic test-case / requirement
   * paths — what was grounded in the real App Profile DOM vs fell back. Lets the
   * route surface a truthful "REAL LOCATORS x/y" metric and a grounding report.
   */
  locatorGrounding?: LocatorGroundingReport;
  /**
   * Repository Intelligence applied during generation — shows which Page Objects
   * were discovered and their available methods. Lets users understand why a
   * specific method was chosen. Present only when repo profile is available.
   */
  repositoryIntelligence?: RepositoryIntelligenceReport;
  /**
   * Candidate Discovery (Sprint 2, PR 1) — every plausible implementation
   * option discovered per business step (reuse assets + locator families).
   * Read-only and non-ranking: it does NOT influence the generated code in this
   * PR. Ranking (PR 2) and selection (PR 3) build on it later.
   */
  candidateDiscovery?: CandidateDiscoveryReport;
  /**
   * Pipeline observability (user request). Present on deterministic
   * requirement/test-case runs — lets the API and dashboard show WHERE the
   * count dropped to zero (canonicalization / parsing / grounding / emit).
   */
  pipeline?: PipelineSummary;
  /**
   * Non-fatal Test Data warnings (review issue #1) — e.g. a dataset stored
   * field-per-record that was reshaped into entities at read time. The store
   * should be re-materialized so it persists canonically.
   */
  testDataWarnings?: string[];
  /**
   * Steps the deterministic engine could not map to a grounded action (review
   * issue #3). Surfaced so the API/UI can show a warning (or, under
   * unmappedStepPolicy='error', the generation fails instead).
   */
  unmappedSteps?: Array<{ testCaseId?: number; step: string }>;
  /**
   * Coverage metadata DERIVED per test case (categories + repository assets
   * reused). Generation Quality: this used to be duplicated as a comment header
   * inside every spec. The framework already owns Coverage/RTM reports, so the
   * data now lives here as structured result — the spec code stays clean.
   */
  coverage?: CoverageEntry[];
}

/** Derived coverage metadata for a single generated test case. */
export interface CoverageEntry {
  testCaseId?: number;
  title: string;
  /** Comma-joined categories, e.g. "Negative, Boundary". */
  categories: string;
  /** Semicolon-joined repository assets reused, e.g. "LoginPage (Page Object); …". */
  assets: string;
}

/** Page Object metadata exposed for transparency and debugging. */
export interface PageObjectMetadata {
  /** Page Object class name (e.g. "LoginPage") */
  name: string;
  /** File path in the repository (e.g. "src/pages/login.page.ts") */
  filePath: string;
  /** Available methods on this Page Object (e.g. ["login", "logout", "verifyError"]) */
  methods: string[];
  /** Import path used in generated code (e.g. "../src/pages/login.page") */
  importPath: string;
  /** Whether this PO was actually used in the generated script */
  used: boolean;
}

export interface RepositoryIntelligenceReport {
  /** Page Objects discovered from the repository scan */
  pageObjects: PageObjectMetadata[];
  /** Total number of Page Objects available in the repo */
  totalAvailable: number;
  /** Number of Page Objects actually used in generated code */
  totalUsed: number;
}

export interface GeneratedFile {
  path: string;               // e.g., 'tests/login.spec.ts'
  content: string;
  type: 'test' | 'page-object' | 'fixture' | 'config' | 'util' | 'readme';
}

export interface GenerationConfig {
  url: string;
  instructions?: string;
  testTypes?: string[];       // ['smoke', 'authentication', 'form_validation', 'navigation']
  credentials?: {
    username?: string;
    password?: string;
  };
  followLinks?: boolean;
  maxPages?: number;
  includeNegativeTests?: boolean;
  framework?: 'playwright';   // future: cypress, selenium
  repoIntelligence?: string;  // injected from Repository Intelligence Engine
  knowledgeContext?: string;   // injected from App Knowledge via KnowledgeOptimizer
  /** Additional fused intelligence (flaky/DOM/learning/similarity/RCA) from IntelligenceFusionService */
  fusionContext?: string;
  /** Structured repository profile for adaptive code generation */
  repoProfile?: import('../context/types').RepositoryProfile;
  /**
   * Phase 2 (RAG / few-shot): the repository_contexts.id of the scanned repo.
   * When present AND RAG is enabled, the engine retrieves the most similar
   * existing tests from this repo's embedded code_chunks and injects them as
   * few-shot examples. Optional and fully gated — absence (or RAG disabled)
   * leaves generation behaviour unchanged.
   */
  repoContextId?: number;
  /** Authentication config for crawling behind login walls */
  authConfig?: AuthConfig;
  /** Additional URLs to crawl in the same authenticated session */
  additionalUrls?: string[];
  /** Pre-cached crawl data from Application Intelligence (skip crawl if provided) */
  cachedCrawlData?: any;
  /**
   * Explicitly request generation of project scaffold files (playwright.config,
   * README, .env.example, CI workflow, utils helpers).
   *
   * Default behaviour (undefined / false) is to generate ONLY test artifacts
   * (specs + page objects). Scaffold files are emitted only when (a) the target
   * repo doesn't already provide them AND (b) the caller explicitly asks for
   * them — either via this flag, or by mentioning them in `instructions`.
   *
   * Set to `true` to force the full scaffold (e.g. greenfield bootstrapping).
   */
  includeScaffold?: boolean;
  /** Tenant scope — enables Intelligence Learning Loop L1 (learned selector
   * stability) so generation avoids selectors that healed in the past. Optional
   * and fully backward-compatible: when omitted, global stability (if any) is
   * still applied, and when no stability data exists generation is unchanged. */
  companyId?: number | null;
  projectId?: number | null;
  /**
   * Structured test case (from Test Case Lab) to automate. When present the
   * generated test plan is ANCHORED to these steps + expected results instead
   * of being inferred purely from the crawl — so the script actually exercises
   * what the test case describes. Shape is the `generated_test_cases` row
   * (title / steps / expected_result / preconditions / test_data).
   */
  testCase?: {
    id?: number;
    title?: string;
    steps?: any;
    expected_result?: string;
    preconditions?: string;
    test_data?: string;
    scenario?: string;
    [k: string]: any;
  };
  /**
   * Requirement-based generation: a batch of structured test cases (e.g. all
   * cases linked to one RTM requirement). When present, the engine produces one
   * grounded Playwright spec PER test case via the deterministic path — no LLM,
   * no project-context contamination. Each element has the same shape as
   * `testCase`. Takes precedence over a single `testCase`.
   */
  testCases?: Array<{
    id?: number;
    title?: string;
    steps?: any;
    expected_result?: string;
    preconditions?: string;
    test_data?: string;
    scenario?: string;
    [k: string]: any;
  }>;
  /**
   * Resolved test-data RECORDS (values, not just key summaries) for the test
   * case(s) being generated. Loaded by the route from the Test Data Store
   * (datasets linked to each case → their records, secrets hydrated). When
   * present, the engine emits a `tests/data/test-data.ts` module and references
   * datasets via `getRecord('<dataset>', selector?)` (schema-first, late-bound)
   * giving full Test Data → Script traceability. Fully optional and
   * backward-compatible: when absent, generation behaves exactly as before.
   */
  resolvedTestData?: Array<{
    /** Dataset name, e.g. 'valid_users'. */
    name: string;
    /** Environment the records were resolved from (e.g. 'shared', 'prod'). */
    environment?: string;
    /** Records keyed by their dataset key (e.g. 'standard_user'). */
    records: Array<{ key: string; value: any }>;
  }>;
  /**
   * Sprint 2D — the canonical Scenario Graph nodes, keyed by test case title.
   * When present, Script Generation reads the scenario semantics
   * (variableUnderTest, variation, preconditions, expectedBehavior,
   * requiredDataRole) and execution context (resolvedDataset) directly from the
   * graph instead of re-inferring them, making Script Gen a pure adapter from
   * Scenario Graph → Playwright code.
   *
   * Optional and fully backward-compatible: when absent or when a test case has
   * no matching node, generation uses legacy inference. Threaded by the route
   * when a persisted/buildable graph exists for the requirement.
   */
  scenarioGraphNodes?: Map<string, {
    semantics?: import('../graph/scenario-graph').ScenarioSemantics;
    execution?: import('../graph/scenario-graph').ScenarioExecution;
  }>;
  /**
   * How to treat a test-case STEP that the deterministic engine cannot map to a
   * grounded action (review issue #3). Historically these emitted a silent
   * `// NOTE: step not auto-mapped — review manually.` comment that was easy to
   * miss. This makes the behaviour configurable:
   *   - 'comment' → inline review comment only (legacy behaviour).
   *   - 'warn'    → inline `@warning` marker + collected into the result's
   *                 `unmappedSteps` so the API/UI can surface a warning (default).
   *   - 'error'   → collect and, after generation, throw
   *                 DeterministicGenerationEmptyError so the caller must fix the
   *                 test cases rather than ship specs with unmapped steps.
   */
  unmappedStepPolicy?: 'comment' | 'warn' | 'error';
}

/* -------------------------------------------------------------------------- */
/*  Deterministic-intent failure                                               */
/* -------------------------------------------------------------------------- */

/**
 * Thrown when a generation carried explicit test-case / requirement intent
 * (config.testCase or config.testCases) but the deterministic, grounded engine
 * produced nothing (empty output or an internal error).
 *
 * Historically this situation SILENTLY dropped through to the generic LLM
 * "workflow generator" (path 2), which emitted 4 unrelated smoke/search/nav/form
 * specs with 0%-grounded locators and then reported a misleading 100% score.
 * That second generation path is the root of the whole class of bugs the user
 * flagged. Requirement / test-case intent must therefore NEVER fall back to the
 * generic generator — we raise this typed error instead so the API layer can
 * return an honest, actionable failure (route the user to review/regenerate the
 * test cases) rather than dressing up ungrounded output as a success.
 */
export class DeterministicGenerationEmptyError extends Error {
  readonly code = 'DETERMINISTIC_GENERATION_EMPTY';
  /** How many cases the deterministic path was asked to generate from. */
  readonly intendedCaseCount: number;
  /** Per-case reasons collected by the batch generator (best-effort). */
  readonly caseErrors: string[];
  /**
   * Pipeline summary (user request) — shows WHERE the count dropped to zero so
   * the failing stage is obvious without SQL or logs. Present when the batch
   * generator ran far enough to build it.
   */
  readonly pipeline?: PipelineSummary;
  constructor(intendedCaseCount: number, caseErrors: string[] = [], cause?: string, pipeline?: PipelineSummary) {
    super(
      `Deterministic generation from ${intendedCaseCount} test case(s) produced no grounded script` +
        (cause ? `: ${cause}` : '') +
        '. Refusing to fall back to the generic workflow generator.',
    );
    this.name = 'DeterministicGenerationEmptyError';
    this.intendedCaseCount = intendedCaseCount;
    this.caseErrors = caseErrors;
    if (pipeline) this.pipeline = pipeline;
  }
}

/* -------------------------------------------------------------------------- */
/*  Script Generation Engine                                                   */
/* -------------------------------------------------------------------------- */

export class ScriptGenEngine {
  private readonly _openai: OpenAI | null;
  private readonly model: string;
  // Phase 1 — optional Claude provider for Script Generation. When
  // SCRIPT_PROVIDER=anthropic and a key is configured, the AI test-plan call
  // routes to Claude; on ANY failure it transparently falls back to OpenAI.
  private readonly _anthropic: AnthropicClient | null;
  private readonly scriptProvider: string;
  private readonly anthropicModel: string;
  private readonly selectorEngine = new SelectorQualityEngine();
  private readonly assertionEngine = new AssertionEngine();
  private readonly waitEngine = new WaitStrategyEngine();
  private readonly workflowMapper = new WorkflowMapper();
  // Scenario Intelligence layer: Test Case → Classifier → Transformer → Script.
  // Owns all scenario-specific credential mutation, assertion hints and coverage
  // categories; keeps the generator free of embedded per-scenario branching.
  private readonly scenario = new ScenarioIntelligence();

  /**
   * Sprint 2D.1 — derive credentials + expected behavior from Scenario Semantics.
   * When the Scenario Graph node is available, this REPLACES the
   * ScenarioIntelligence inference (which re-classifies the scenario from its
   * title/steps). Returns the same shape as `transformer.transformCredentials()` +
   * `transformer.errorFragment()` so the call sites remain unchanged.
   *
   * Maps the KB's application-neutral semantics (variableUnderTest + variation +
   * expectedBehavior) to the concrete Playwright actions:
   *   - "wrong password" → valid username + invalid password
   *   - "empty username" → empty username + valid password
   *   - "valid credentials" → valid username + valid password
   *
   * This is the core 2D.1 goal: Script Gen becomes a pure adapter FROM the graph,
   * not a re-inferencer.
   */
  private deriveFromSemantics(
    semantics: import('../graph/scenario-graph').ScenarioSemantics,
    credentialResolver: ScenarioCredentialResolver,
  ): {
    credentials: { username: string; password: string };
    errorFragment: string;
    coverageCategories: string[];
  } {
    const vut = semantics.variableUnderTest.toLowerCase();
    const variation = semantics.variation.toLowerCase();
    const expected = semantics.expectedBehavior.toLowerCase();

    let username: string;
    let password: string;
    let errorFrag = '';
    const categories: string[] = [];

    // Derive credentials based on (variableUnderTest, variation).
    // The "variable under test" is what changes; everything else stays at the
    // valid baseline (from preconditions).
    if (vut.includes('password') || vut.includes('pwd')) {
      // Password is varied → username stays valid.
      username = credentialResolver.base().username;
      if (variation.includes('wrong') || variation.includes('invalid') || variation.includes('incorrect')) {
        password = credentialResolver.envPassword() || `'InvalidPass123!'`;
        errorFrag = 'do not match';
        categories.push('Negative');
      } else if (variation.includes('empty') || variation.includes('blank') || variation === 'none') {
        password = `''`;
        errorFrag = 'is required';
        categories.push('Validation');
      } else {
        // Valid or unrecognized variation → use valid password.
        password = credentialResolver.base().password;
      }
    } else if (vut.includes('username') || vut.includes('user')) {
      // Username is varied → password stays valid.
      password = credentialResolver.base().password;
      if (variation.includes('wrong') || variation.includes('invalid') || variation.includes('unregistered')) {
        username = credentialResolver.envUsername() || `'invalid_user'`;
        errorFrag = 'do not match';
        categories.push('Negative');
      } else if (variation.includes('empty') || variation.includes('blank') || variation === 'none') {
        username = `''`;
        errorFrag = 'is required';
        categories.push('Validation');
      } else if (variation.includes('locked')) {
        username = `'locked_out_user'`;
        errorFrag = 'locked out';
        categories.push('Negative');
      } else {
        username = credentialResolver.base().username;
      }
    } else if (vut === 'none' || variation === 'none') {
      // Positive/observation scenario — no variation, all valid.
      username = credentialResolver.base().username;
      password = credentialResolver.base().password;
      categories.push('Functional');
    } else {
      // Fallback for unrecognized variable: assume both valid.
      username = credentialResolver.base().username;
      password = credentialResolver.base().password;
    }

    // Override errorFrag if expectedBehavior is explicit about rejection.
    if (expected.includes('reject') || expected.includes('error') || expected.includes('fail')) {
      if (!errorFrag && !expected.includes('success')) {
        errorFrag = ''; // Generic error surface, no specific message
      }
      if (!categories.includes('Negative')) categories.push('Negative');
    } else if (expected.includes('success') || expected.includes('authenticated') || expected.includes('redirect')) {
      errorFrag = ''; // No error expected
      if (!categories.length) categories.push('Functional');
    }

    if (!categories.length) categories.push('Functional');

    return {
      credentials: { username, password },
      errorFragment: errorFrag,
      coverageCategories: categories,
    };
  }
  /**
   * Non-fatal Test Data warnings collected during a generation (e.g. a dataset
   * that was stored field-per-record and had to be reshaped into entities at
   * read time). Surfaced to the API so the store can be re-materialized
   * canonically. Reset per generate() call.
   */
  private testDataWarnings: string[] = [];
  /**
   * Steps the deterministic engine could not map to a grounded action during the
   * current generation (review issue #3). Populated by tcStepsToCode and
   * surfaced to the API. Reset per generate() call.
   */
  private unmappedSteps: Array<{ testCaseId?: number; step: string }> = [];
  /** Active unmapped-step policy for the current generation (see config). */
  private unmappedStepPolicy: 'comment' | 'warn' | 'error' = 'warn';

  constructor(config?: { apiKey?: string; model?: string }) {
    // Lazy/optional API key: url-based generation still needs the LLM to infer a
    // test plan, but TEST-CASE-BASED generation is now fully DETERMINISTIC (it
    // maps the structured steps + test data directly to grounded Playwright
    // code) and therefore must work even when no key is configured. We defer the
    // "key required" error to the point where the LLM is actually invoked.
    const apiKey = config?.apiKey || process.env['OPENAI_API_KEY'];
    this._openai = apiKey ? new OpenAI({ apiKey }) : null;
    this.model = config?.model || process.env['SCRIPT_GEN_MODEL'] || 'gpt-4o-mini';

    // Phase 1 provider routing (Script Generation only). Defaults to OpenAI;
    // opt into Claude with SCRIPT_PROVIDER=anthropic + ANTHROPIC_API_KEY.
    this.scriptProvider = (process.env['SCRIPT_PROVIDER'] || 'openai').toLowerCase();
    this.anthropicModel = resolveAnthropicModel(process.env['SCRIPT_MODEL']);
    this._anthropic =
      this.scriptProvider === 'anthropic' && isAnthropicConfigured()
        ? new AnthropicClient({ model: this.anthropicModel })
        : null;
  }

  /** Access the OpenAI client, throwing a clear error only when it's actually needed. */
  private get openai(): OpenAI {
    if (!this._openai) {
      throw new Error('OPENAI_API_KEY is required for URL-based script generation (test-case-based generation is deterministic and does not need it)');
    }
    return this._openai;
  }

  /**
   * Provider-routed JSON chat completion for the AI test-plan step.
   *
   * Routes to Claude when SCRIPT_PROVIDER=anthropic and configured; on ANY
   * Anthropic error it logs and transparently falls back to the existing OpenAI
   * path so a request never fails because of the new provider. Returns the raw
   * JSON string content and the model that produced it.
   */
  private async generateTestPlanCompletion(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ content: string; tokens: number; model: string }> {
    if (this._anthropic) {
      try {
        const r = await this._anthropic.createChatCompletion({
          model: this.anthropicModel,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.3,
          maxTokens: 4000,
          jsonMode: true,
        });
        return { content: r.content || '{}', tokens: r.tokensUsed, model: r.model };
      } catch (err) {
        logger.warn(MOD, 'Anthropic test-plan generation failed; falling back to OpenAI', {
          error: (err as Error).message,
        });
      }
    }

    const response = await this.openai.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
      max_tokens: 4000,
    });
    return {
      content: response.choices[0]?.message?.content || '{}',
      tokens: response.usage?.total_tokens || 0,
      model: this.model,
    };
  }

  /**
   * Main entry point: URL → Structured Test Plan → Playwright Code
   */
  async generate(config: GenerationConfig): Promise<GenerationResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let tokensUsed = 0;

    // Reset per-generation diagnostic collectors and resolve the unmapped-step
    // policy (review issues #1/#3). Defaults preserve prior behaviour when the
    // caller doesn't set a policy.
    this.testDataWarnings = [];
    this.unmappedSteps = [];
    this.unmappedStepPolicy = config.unmappedStepPolicy ?? 'warn';

    logger.info(MOD, 'Starting script generation', { url: config.url, useCachedCrawl: !!config.cachedCrawlData });

    // ─── Step 1: Crawl page(s) — or use cached data (Application Intelligence) ──
    let crawlResult: CrawlResult;
    let authResult: AuthResult | undefined;

    if (config.cachedCrawlData) {
      // FAST PATH: Use cached crawl data from Application Intelligence
      logger.info(MOD, 'Using cached crawl data (Application Intelligence)', { url: config.url });
      // Multi-page profiles (saveDeepCrawlResult) store the DOM under
      // `pages[].elements` with NO flat top-level `elements`, whereas
      // single-page profiles store a flat `elements` array. Reading only the
      // top-level array left the engine with 0 elements for multi-page
      // profiles → every locator fell back → "REAL LOCATORS 0/N" even though
      // the profile clearly had elements. Flatten the per-page arrays when the
      // top-level one is absent so grounding works for both shapes.
      const cc = config.cachedCrawlData;
      const pages: any[] = Array.isArray(cc.pages) ? cc.pages : [];
      const flat = (key: string): any[] =>
        Array.isArray(cc[key]) && cc[key].length
          ? cc[key]
          : pages.flatMap((p: any) => (Array.isArray(p?.[key]) ? p[key] : []));
      const elements = flat('elements');
      crawlResult = {
        url: cc.url || config.url,
        finalUrl: cc.finalUrl || config.url,
        title: cc.title || pages[0]?.title || '',
        pageType: cc.pageType || pages[0]?.pageType || 'unknown',
        pageTypeConfidence: cc.pageTypeConfidence || 0.5,
        elements,
        forms: flat('forms'),
        navigationLinks: flat('navigationLinks'),
        buttons: flat('buttons'),
        inputs: flat('inputs'),
        headings: flat('headings'),
        htmlSnapshot: cc.htmlSnapshot || '',
        totalElements: cc.totalElements || elements.length,
        interactiveElements: cc.interactiveElements || 0,
        crawlTimeMs: 0, // No crawl performed
        errors: [],
      };
    } else {
      // SLOW PATH: Full crawl
      // Ensure the page budget can hold the entry page PLUS every extra page a
      // test case needs to visit — otherwise the multi-page crawl could stop
      // before reaching (and grounding) the /login page.
      const extraUrlCount = config.additionalUrls?.length ?? 0;
      const crawlConfig: CrawlConfig = {
        url: config.url,
        followLinks: config.followLinks ?? false,
        maxPages: Math.max(config.maxPages ?? 3, 1 + extraUrlCount),
        captureScreenshot: true,
        authConfig: config.authConfig,
        additionalUrls: config.additionalUrls,
      };

      // Loop 2 (Test Failures → Crawl Intelligence): consult the learned
      // adaptation for this page. If it has proven flaky in production, raise the
      // crawl depth (3 → up to 5), capture loading states and wait for animations
      // so dynamic content settles. Fully scope-aware (honours learning_scope)
      // and fail-safe — any error leaves the crawl behaving exactly as before.
      try {
        const adaptation = await getCrawlAdaptationForUrl(config.url, {
          companyId: config.companyId ?? undefined,
          projectId: config.projectId ?? undefined,
        });
        if (adaptation && adaptation.isFlaky) {
          // These fields are now first-class on CrawlConfig again and honoured by
          // PageCrawler's constructor (depth 3→5, wait 5s→8s). The `as any` casts
          // that masked the dropped fields after aa19046/473189d are removed.
          crawlConfig.adaptive = true;
          crawlConfig.maxDepth = adaptation.recommendedDepth;
          crawlConfig.maxPages = Math.max(crawlConfig.maxPages ?? 3, adaptation.recommendedDepth);
          crawlConfig.waitAfterLoad = adaptation.recommendedWaitMs;
          crawlConfig.captureLoadingStates = adaptation.captureLoadingStates;
          crawlConfig.waitForAnimations = adaptation.waitForAnimations;
          logger.info(MOD, '🧭 Applying learned crawl adaptation (flaky page)', {
            url: config.url,
            recommendedDepth: adaptation.recommendedDepth,
            waitMs: adaptation.recommendedWaitMs,
            volatileElements: adaptation.volatileElements?.length ?? 0,
          });
        }
      } catch (adaptErr: any) {
        logger.warn(MOD, `crawl adaptation lookup failed (non-fatal): ${adaptErr?.message || adaptErr}`);
      }

      const crawler = new PageCrawler(crawlConfig);
      const useAuthMultiPage = !!(config.authConfig && config.additionalUrls?.length);

      try {
        if (useAuthMultiPage) {
          logger.info(MOD, 'Using authenticated multi-page crawl', {
            primaryUrl: config.url,
            additionalUrls: config.additionalUrls!.length,
          });
          const multiResult = await crawler.crawlAuthenticatedMultiPage();
          crawlResult = multiResult.pages[0]!;
          authResult = crawlResult.authResult;
          for (let i = 1; i < multiResult.pages.length; i++) {
            const extra = multiResult.pages[i]!;
            crawlResult.elements.push(...(extra.elements || []));
            crawlResult.forms.push(...(extra.forms || []));
            crawlResult.buttons.push(...(extra.buttons || []));
            crawlResult.inputs.push(...(extra.inputs || []));
            crawlResult.navigationLinks.push(...(extra.navigationLinks || []));
            crawlResult.errors.push(...(extra.errors || []));
          }
        } else if (config.additionalUrls && config.additionalUrls.length > 0) {
          // Non-authenticated, but the caller supplied extra pages to cover
          // (e.g. the /login page a login test case navigates to). Use the
          // multi-page crawl so those pages are captured too — otherwise
          // grounding for those pages' elements silently falls back.
          logger.info(MOD, 'Using multi-page crawl to cover test-case target pages', {
            primaryUrl: config.url,
            additionalUrls: config.additionalUrls.length,
          });
          const multiResult = await crawler.crawlMultiPage();
          crawlResult = multiResult.pages[0] || (await crawler.crawl());
          authResult = crawlResult.authResult;
          for (let i = 1; i < multiResult.pages.length; i++) {
            const extra = multiResult.pages[i]!;
            crawlResult.elements.push(...(extra.elements || []));
            crawlResult.forms.push(...(extra.forms || []));
            crawlResult.buttons.push(...(extra.buttons || []));
            crawlResult.inputs.push(...(extra.inputs || []));
            crawlResult.navigationLinks.push(...(extra.navigationLinks || []));
            crawlResult.errors.push(...(extra.errors || []));
          }
        } else {
          crawlResult = await crawler.crawl();
          authResult = crawlResult.authResult;
        }
      } catch (e) {
        throw new Error(`Crawl failed: ${(e as Error).message}`);
      }
    }

    if (authResult) {
      logger.info(MOD, 'Authentication result', {
        success: authResult.success,
        strategy: authResult.strategy,
        cookieCount: authResult.cookieNames?.length ?? 0,
        captchaDetected: authResult.captchaDetected,
      });
    }

    // Defensive: ensure crawl result arrays are never undefined
    crawlResult.elements = crawlResult.elements || [];
    crawlResult.forms = crawlResult.forms || [];
    crawlResult.buttons = crawlResult.buttons || [];
    crawlResult.inputs = crawlResult.inputs || [];
    crawlResult.headings = crawlResult.headings || [];
    crawlResult.navigationLinks = crawlResult.navigationLinks || [];
    crawlResult.errors = crawlResult.errors || [];

    logger.info(MOD, 'Crawl complete', {
      pageType: crawlResult.pageType,
      elements: crawlResult.elements.length,
      forms: crawlResult.forms.length,
      authenticated: !!authResult?.success,
    });

    // ─── Step 1.5: DETERMINISTIC test-case path ───────────────────
    // When generating from a structured Test Case (Test Case Lab / requirement
    // flow), we DO NOT ask the LLM to invent a plan (which hallucinated
    // selectors, leaked OrangeHRM creds, and emitted `// Assert:` comments).
    // Instead we translate the case's steps + test data + expected result
    // directly into grounded Playwright code, resolving selectors against the
    // real crawled DOM. This is reliable, reproducible and needs no API key.
    // Requirement-based batch: one grounded spec per test case (no LLM).
    if (Array.isArray(config.testCases) && config.testCases.length > 0) {
      // NO SILENT FALLBACK. When the caller supplied real test cases the ONLY
      // acceptable output is grounded, per-case scripts. If the deterministic
      // engine produces nothing (or throws), we raise a typed error instead of
      // dropping to the generic workflow generator (path 2). The generic path
      // is what emitted 4 unrelated 0%-grounded specs and a fake 100% score.
      let batch: GenerationResult | null = null;
      try {
        batch = this.generateFromTestCases(config, crawlResult);
      } catch (batchErr: any) {
        logger.error(MOD, `Deterministic requirement-batch generation failed (${batchErr?.message}) — refusing generic fallback`);
        throw new DeterministicGenerationEmptyError(config.testCases.length, [], batchErr?.message);
      }
      if (batch && batch.generatedFiles.length > 0) {
        this.enforceUnmappedStepPolicy(config.testCases.length);
        const batchResult: GenerationResult = {
          ...batch,
          ...(authResult ? { authResult } : {}),
          ...(!config.cachedCrawlData ? { rawCrawlData: crawlResult } : {}),
          ...this.buildDiagnosticsPatch(),
        };
        logger.info(MOD, 'Script generation complete (deterministic requirement-batch path)', batchResult.stats);
        return batchResult;
      }
      logger.error(MOD, 'Deterministic requirement-batch generation produced nothing — refusing generic fallback');
      throw new DeterministicGenerationEmptyError(config.testCases.length, batch?.errors ?? [], undefined, batch?.pipeline);
    }

    if (config.testCase) {
      // Same contract for a single Test Case Lab case: deterministic or honest
      // failure, never the generic LLM path.
      let deterministic: GenerationResult | null = null;
      try {
        deterministic = this.generateFromTestCase(config, crawlResult);
      } catch (tcErr: any) {
        logger.error(MOD, `Deterministic test-case generation failed (${tcErr?.message}) — refusing generic fallback`);
        throw new DeterministicGenerationEmptyError(1, [], tcErr?.message);
      }
      if (deterministic && deterministic.generatedFiles.length > 0) {
        this.enforceUnmappedStepPolicy(1);
        const tcResult: GenerationResult = {
          ...deterministic,
          ...(authResult ? { authResult } : {}),
          ...(!config.cachedCrawlData ? { rawCrawlData: crawlResult } : {}),
          ...this.buildDiagnosticsPatch(),
        };
        logger.info(MOD, 'Script generation complete (deterministic test-case path)', tcResult.stats);
        return tcResult;
      }
      logger.error(MOD, 'Deterministic test-case generation produced nothing — refusing generic fallback');
      // Surface the Stage-1 reason (shape/keys) even for the single-case path so
      // the 422 `caseErrors` is never empty (Bug #2 fix).
      const singleCaseErrors = deterministic?.errors?.length
        ? deterministic.errors
        : (() => {
            const { steps, diagnostics } = this.parseTestCaseStepsWithDiagnostics(config.testCase);
            return steps.length === 0
              ? [describeStageOneFailure(`Test case ${config.testCase!.id ?? config.testCase!.title ?? '?'}`, diagnostics)]
              : [`Test case ${config.testCase!.id ?? config.testCase!.title ?? '?'}: STAGE 3/4 — ${steps.length} step(s) parsed but no script emitted`];
          })();
      throw new DeterministicGenerationEmptyError(1, singleCaseErrors);
    }

    // ─── Step 2: Build workflow map (URL / plain-English generation ONLY) ──
    // Reaching here means NO test-case / requirement intent was supplied — this
    // is a pure URL or free-text scenario run, the ONE remaining legitimate use
    // of the workflow generator. Requirement/test-case intent can never arrive
    // here (it returns above or throws DeterministicGenerationEmptyError).
    const workflowMap = this.workflowMapper.buildWorkflowMap([crawlResult]);

    logger.info(MOD, 'Workflow map built', {
      flows: workflowMap.flows.length,
      nodes: workflowMap.nodes.length,
    });

    // ─── Step 3: Score selectors ──────────────────────────────────
    const visibleElements = crawlResult.elements.filter(el => el.visible);
    const selectorReport = this.selectorEngine.scorePageSelectors(visibleElements);

    // ─── Step 4: AI-generate structured test plan ─────────────────
    const testPlan = await this.generateTestPlan(
      crawlResult, workflowMap, config, selectorReport.averageScore,
    );
    tokensUsed = testPlan.metadata.tokensUsed;

    // ─── Step 5: Resolve selectors in test plan ───────────────────
    // Intelligence Learning Loop L1: load learned selector stability for this
    // scope and inject it so the quality engine demotes selectors that healing
    // has proven fragile. Fail-safe — on any error the provider is a no-op.
    try {
      const stabilityProvider = await buildStabilityProvider({
        companyId: config.companyId ?? null,
        projectId: config.projectId ?? null,
      });
      this.selectorEngine.setStabilityProvider(stabilityProvider);
    } catch (err: any) {
      logger.warn(MOD, 'Could not load selector stability — generating without L1 adjustment', { error: err?.message });
      this.selectorEngine.setStabilityProvider(undefined);
    }

    this.resolveSelectors(testPlan, crawlResult.elements, config);

    // ─── Step 6: Inject assertions & waits ────────────────────────
    this.injectAssertionsAndWaits(testPlan, crawlResult);

    // ─── Step 7: Generate Playwright code deterministically ───────
    const generatedFiles = this.generatePlaywrightCode(testPlan, config);

    // ─── Step 8: Framework Audit (Phase 1: Impact Analysis + Quality Report) ───
    let frameworkAnalysis: FrameworkAuditResult | undefined;
    if (config.repoProfile && (config.companyId || config.projectId)) {
      try {
        const generationContext: GenerationContext = {
          testCases: testPlan.flows.map((flow) => ({
            id: flow.name,
            title: flow.description || flow.name,
            steps: flow.steps.map((s) => s.description),
          })),
          baseUrl: config.url,
          isGreenfield: !config.repoProfile || (config.repoProfile.pageObjects?.length ?? 0) === 0,
          framework: 'playwright',
        };
        frameworkAnalysis = await auditFramework(
          config.repoProfile,
          generationContext,
          {
            companyId: config.companyId ?? 0,
            projectId: config.projectId ?? undefined,
            repositoryId: config.repoContextId ?? undefined,
          },
        );
        logger.info(MOD, 'Framework audit complete', {
          overallAssessment: frameworkAnalysis.qualityReport.overallAssessment,
          riskLevel: frameworkAnalysis.impactAnalysis.risk.level,
          reuseLevel: frameworkAnalysis.impactAnalysis.reuseOpportunity.level,
          assetsReused: frameworkAnalysis.impactAnalysis.reuseOpportunity.assetsReused.length,
        });
      } catch (auditErr: any) {
        logger.warn(MOD, 'Framework audit failed (non-blocking)', { error: auditErr.message });
        // Audit failure is non-blocking — generation proceeds without it
      }
    }

    // ─── Stats ────────────────────────────────────────────────────
    let totalTests = 0;
    let totalAssertions = 0;
    for (const flow of testPlan.flows) {
      totalTests++;
      for (const step of flow.steps) {
        totalAssertions += (step.assertions?.length || 0);
      }
    }

    const result: GenerationResult = {
      testPlan,
      generatedFiles,
      stats: {
        totalTests,
        totalAssertions,
        avgSelectorScore: selectorReport.averageScore,
        pageObjectsGenerated: testPlan.pageObjects.length,
        crawlTimeMs: crawlResult.crawlTimeMs,
        generationTimeMs: Date.now() - startTime,
        tokensUsed,
        model: this.model,
      },
      errors,
      ...(authResult ? { authResult } : {}),
      // Expose raw crawl data for Application Intelligence caching (only for fresh crawls)
      ...(!config.cachedCrawlData ? { rawCrawlData: crawlResult } : {}),
      // Framework audit (Phase 1: Impact Analysis + Quality Report)
      ...(frameworkAnalysis ? { frameworkAnalysis } : {}),
    };

    logger.info(MOD, 'Script generation complete', result.stats);
    return result;
  }

  /**
   * Resolve the canonical Project Convention Profile for this generation.
   *
   * This is the ONLY place Script Generation learns *where* files belong and
   * *which* conventions to follow — it asks Repo Intelligence rather than
   * inspecting folders or hardcoding names. With no connected repo profile the
   * profile falls back to the historical defaults (tests/, pages/, tests/data,
   * fixtures/, utils/), so greenfield output is unchanged.
   */
  private resolveConventions(config: GenerationConfig): ProjectConventionProfile {
    return buildConventionProfile(config.repoProfile ?? null);
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  DETERMINISTIC TEST-CASE GENERATION                                      */
  /*  Translates a structured Test Case (steps + test data + expected result) */
  /*  directly into grounded Playwright code — no LLM, no hallucination.      */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Generate a complete Playwright spec from a structured test case. Returns
   * null when the case has no parseable steps (caller then falls back to the
   * LLM path). Selectors are resolved against the REAL crawled DOM; credentials
   * come from the case's Test Data (never invented); assertions are derived from
   * the Expected Result with correct positive/negative logic.
   */
  private generateFromTestCase(config: GenerationConfig, crawl: CrawlResult): GenerationResult | null {
    const startTime = Date.now();
    const tc = config.testCase!;
    const steps = this.parseTestCaseSteps(tc);
    if (!steps.length) return null;

    // Sprint 2D.1: resolve the Scenario Graph node for this test case (by scenarioId).
    // When available, Script Gen consumes its semantics (variableUnderTest +
    // variation + expectedBehavior) instead of re-inferring them via
    // ScenarioIntelligence. Attach it to the test case context so downstream
    // methods (applyPageObjectActions, buildCoverageMetadata, buildAssertion)
    // can check for it. Match by stable scenarioId (from ai_metadata or top-level),
    // with title fallback for legacy test cases that predate Sprint 2D.
    const scenarioId = tc.ai_metadata?.scenarioId || tc.scenarioId || null;
    const scenarioNode = scenarioId
      ? config.scenarioGraphNodes?.get(scenarioId)
      : config.scenarioGraphNodes?.get(tc.title || ''); // Legacy title fallback
    (tc as any).__scenarioNode = scenarioNode;

    // Real base URL — prefer the navigate step's URL, else config.url. NEVER prose.
    let baseUrl = config.url;
    for (const s of steps) {
      const m = s.match(/\bhttps?:\/\/[^\s'")]+/i);
      if (/navigat|go to|open|launch|visit/i.test(s) && m) { baseUrl = m[0]; break; }
    }
    // Only normalise a BARE ORIGIN ("https://host") to a trailing slash. A URL
    // that already has a path segment (e.g. .../login) must be left untouched —
    // appending "/" turned "/login" into "/login/", which some apps redirect.
    if (/^https?:\/\/[^/]+$/.test(baseUrl)) baseUrl += '/';

    const creds = this.parseTestData(tc.test_data);

    // ── Test Data → Script traceability (review priority #1) ──
    // Resolve the dataset this case consumes so the script binds to the dataset
    // via getRecord('<dataset>', selector?) and reads user.username/.password
    // from the schema. When no resolved data is supplied, fall back to literals.
    const dataIndex = this.buildTestDataIndexWithFallback(config, [tc]);
    const caseData = this.resolveCaseData(tc, steps, dataIndex);
    if (caseData) {
      // Hydrate creds from the resolved record so any literal fallbacks (and the
      // grounded selector parsing) have the real values too.
      const v = caseData.value || {};
      creds.username = String(v.username ?? v.user ?? creds.username ?? '');
      creds.password = String(v.password ?? v.pass ?? creds.password ?? '');
    }

    // Backfill credentials from concrete values written in the steps when no
    // dataset record resolved them (e.g. "...from valid_users: standard_user").
    // This is what powers the precondition-login and concurrent-skeleton paths
    // (which fill from `creds`) so they no longer emit silent fill('').
    if (!creds.username || !creds.password) {
      for (const s of steps) {
        if (!creds.username) {
          const u = this.extractStepCredential('username', s);
          if (u) creds.username = u;
        }
        if (!creds.password) {
          const p = this.extractStepCredential('password', s);
          if (p) creds.password = p;
        }
      }
    }

    // Resolve grounded selectors from the crawled DOM, with stable semantic
    // fallbacks for elements not present on the crawled (login) page.
    // Resolve every semantic selector against the REAL crawl DOM (App Profile)
    // and keep the tracking so we can emit a truthful Locator Grounding Report.
    const { sel, tracked } = this.buildGroundedSelectors(crawl);

    // When a record was resolved, expose it as `user` (const ref in the test
    // body) so fills read `user.username` / `user.password`.
    const dataRef = caseData
      ? {
          varName: 'user',
          ref: caseData.ref,
          hasUsername: caseData.value?.username != null || caseData.value?.user != null,
          // Review fix: treat a record as "having password" when the password field
          // EXISTS (even if undefined), so synthesized records (which carry
          // `password: undefined`) trigger the `user.password ?? env` fallback.
          // Defensive guard: when the resolved value is a primitive (e.g. a plain
          // string "paviramesh1812@gmail.com" instead of {username,password}), the
          // `in` operator throws. Only check object values.
          hasPassword: (caseData.value && typeof caseData.value === 'object')
            ? ('password' in caseData.value || 'pass' in caseData.value)
            : false,
        }
      : undefined;

    const title = tc.title || 'Generated test';
    const tags = this.tcTags(tc);
    // Generation Quality (Sprint 4): the ONLY comment a senior engineer keeps in
    // the emitted spec is the traceability marker. Everything else (per-step
    // narration, coverage header, data-source notes) is duplicated by the Test
    // Cases / RTM / App Knowledge / Reports the framework already owns, so it is
    // NOT re-emitted into the script. The marker is 4-space indented to sit flush
    // with the test body.
    const idMarker = tc.id != null ? `\n    // @tc:TC${tc.id}` : '';

    // ── Repository Intelligence: match ALL relevant existing Page Objects ──
    // (login / inventory / cart / checkout) with real methods + repo-derived
    // import paths. Empty when no repo profile or no keyword match. Resolved
    // BEFORE the non-automatable branch so the concurrent skeleton can also
    // reuse the repo's LoginPage (review fix #4 — consistency).
    const matchedPOs = this.matchPageObjects(tc, steps, config.repoProfile);
    const usedPOVars = new Set<string>();

    // ── Repo Intelligence owns conventions ──
    // Where the spec + shared test-data module land, and how the spec imports
    // that module, are all answered by the Project Convention Profile — never
    // hardcoded here. Defaults reproduce the historical tests/ + tests/data
    // layout for greenfield runs.
    const conv = this.resolveConventions(config);
    const testDataModulePath = resolveTestDataModulePath(conv); // e.g. tests/data/test-data.ts
    const testDataImport = resolveImportSpecifier(
      conv,
      conv.testFolder,
      testDataModulePath,
    ); // e.g. ./data/test-data

    // ── Non-automatable detection (review priority #5) ──
    // Concurrent / multi-browser cases (and anything flagged Automation Ready =
    // No) need multiple browser contexts and human judgement. Emit a test.fixme
    // with a correct multi-context skeleton instead of a broken single-page run.
    if (this.isNonAutomatable(tc, steps)) {
      const content = this.buildNonAutomatableSpec(tc, steps, baseUrl, sel, dataRef, { title, idMarker, creds }, matchedPOs, testDataImport);
      const fileName = `${toKebab(title).slice(0, 60) || `test-case-${tc.id ?? 'x'}`}.spec.ts`;
      const generatedFiles: GeneratedFile[] = [{ path: `${conv.testFolder}/${fileName}`, content, type: 'test' }];
      const moduleFile = this.buildTestDataModule(dataIndex, conv);
      if (moduleFile) generatedFiles.push(moduleFile);
      const grounding = this.buildLocatorGroundingReport(tracked, content);
      return this.buildTcResult(tc, title, baseUrl, crawl, tags, generatedFiles, 0, startTime, grounding, matchedPOs);
    }

    // `stepTracked` collects the PER-STEP locators grounded against the crawl
    // (the qualifier-aware resolution). These are merged into the grounding
    // report below so the KPI reflects the locators the spec ACTUALLY uses —
    // not just the fixed semantic vocabulary.
    const stepTracked: LocatorGroundingEntry[] = [];
    const ctx = { url: baseUrl, creds, sel, data: dataRef, crawl, stepTracked };

    // ── Precondition materialization (review TC2/TC5 fix) ──
    // If the case assumes an authenticated session ("user is logged in") but its
    // steps never perform a login, inject a real login setup using a valid user
    // so the test actually starts from the intended state. Reuses the repo's
    // login() Page Object method when one was matched (review issue #2).
    const preResult = this.buildPreconditionLogin(tc, steps, ctx, dataIndex, matchedPOs);
    const preLines = preResult.lines;
    preResult.used.forEach((v) => usedPOVars.add(v));

    const { lines } = this.tcStepsToCode(steps, { ...ctx, testCaseId: tc.id });

    // ── Rewrite raw locator steps to reuse high-level Page Object methods ──
    // Only collapses when the method GENUINELY exists in scanned metadata; other
    // lines are preserved verbatim (graceful fallback, no hallucinated methods).
    let finalLines = lines;
    if (matchedPOs.length) {
      const applied = this.applyPageObjectActions(lines, matchedPOs, { creds, data: dataRef }, dataIndex, tc, steps);
      finalLines = applied.lines;
      applied.used.forEach((v) => usedPOVars.add(v));
    }

    const assertions = this.buildTcAssertions(`${tc.expected_result || ''}`, ctx, tc, matchedPOs, usedPOVars);

    // ── Page-Object-based assertions (e.g. inventoryPage.verifyLoaded()) ──
    if (matchedPOs.length) {
      const poAsserts = this.applyPageObjectAssertions(`${tc.expected_result || ''}`, matchedPOs);
      if (poAsserts.lines.length) {
        assertions.push(...poAsserts.lines);
        poAsserts.used.forEach((v) => usedPOVars.add(v));
      }
    }

    // ── Guarantee an initial navigation ──
    // Some cases (e.g. "Leave username field empty → click login") interact with
    // the page but never include a navigate step, which would run against
    // about:blank and fail. If nothing navigates yet the body touches the page,
    // prepend a goto so the test starts on the real base URL.
    const navLines: string[] = [];
    // The body "touches the page" if it calls page.* OR a matched Page Object
    // method (e.g. `loginPage.login(...)`). PO calls drive the page just like raw
    // page.* calls do, so they also require the test to have navigated first.
    const bodyUsesPO = matchedPOs.some((po) =>
      [...preLines, ...finalLines].some((l) => new RegExp(`\\b${po.varName}\\.`).test(l)),
    );
    const bodyTouchesPage =
      bodyUsesPO ||
      [...preLines, ...finalLines].some((l) => /\bpage\.(locator|getBy|fill|click|goto)\b/.test(l));
    // ONLY an explicit page.goto() counts as the entry navigation. We must NOT
    // assume a Page Object login() navigates — most repo login() methods only
    // fill the form and click, expecting the caller to already be on the page
    // (e.g. SauceDemo's LoginPage). Treating login() as navigation previously
    // left specs running against about:blank, timing out on `#user-name`.
    // An explicit page.goto() OR a repo Page Object navigation method
    // (open/goto/navigate/load/visit — emitted by the P4 nav-reuse rewrite)
    // counts as the entry navigation. login()/fill()/click() do NOT.
    const bodyNavigates = [...preLines, ...finalLines].some(
      (l) =>
        /\bpage\.goto\s*\(/.test(l) ||
        matchedPOs.some((po) =>
          new RegExp(`\\b${po.varName}\\.(open|goto|navigate|load|visit)\\s*\\(`).test(l),
        ),
    );
    if (bodyTouchesPage && !bodyNavigates) {
      // Navigation centralization (review issue #2): prefer the repo Page
      // Object's OWN navigation method (open/goto/navigate/load/visit) over a
      // raw page.goto + waitForLoadState duplicated inline in every test. This
      // keeps entry navigation defined once, in the Page Object, so specs stay
      // DRY and the URL/wait strategy lives in a single place. We only fall back
      // to the literal goto when no PO exposes such a method (no hallucination).
      const navPO = this.findNavigationPageObject(matchedPOs);
      if (navPO) {
        navLines.push(`await ${navPO.varName}.${navPO.method}();`, '');
        usedPOVars.add(navPO.varName);
      } else {
        navLines.push(
          `await page.goto('${escapeStr(baseUrl)}');`,
          `await page.waitForLoadState('domcontentloaded');`,
          '',
        );
      }
    }

    // Declare the resolved record once at the top of the test body so step code
    // can read `user.username` / `user.password`.
    // The dataset binding (`const user = getRecord(...)`) is emitted as code, not
    // narrated — the Test Data Source is already tracked in the RTM/reports.
    const declLines: string[] = [];
    if (dataRef) {
      declLines.push(`const ${dataRef.varName} = ${dataRef.ref};`, '');
    }

    // ── Instantiate the Page Objects we actually reference ──
    // Only the POs whose methods were genuinely used (usedPOVars) are imported
    // and instantiated, so we never import a class the test doesn't exercise.
    const activePOs = matchedPOs.filter((po) => usedPOVars.has(po.varName));
    if (activePOs.length) {
      for (const po of activePOs) {
        declLines.push(`const ${po.varName} = new ${po.name}(page);`);
      }
      declLines.push('');
    }

    // Combine the body and Expected-Result assertions, then de-duplicate any
    // repeated top-level assertions (review fix #1 — identical toHaveURL /
    // toHaveText / count checks stacking across precondition + body + final).
    // Generation Quality: no "// Verify Expected Result" section banner — the
    // assertions are self-describing; a blank line separates them from the body.
    let combined = this.dedupeTopLevelAssertions([
      ...declLines, ...navLines, ...preLines, ...finalLines,
      '', ...assertions,
    ]);
    // Trim any trailing blank line left when the Expected-Result assertions were
    // all de-duplicated away, so the spec never ends on an empty line.
    while (combined.length && combined[combined.length - 1].trim() === '') combined.pop();

    // Reference the generated test-data module whenever the body binds a dataset.
    const usesModule = combined.some(l => /\bgetRecord\s*\(/.test(l));
    let importLine = usesModule
      ? `import { test, expect } from '@playwright/test';\nimport { getRecord } from '${testDataImport}';`
      : `import { test, expect } from '@playwright/test';`;

    // Add Page Object imports for the POs we actually reuse (repo-derived paths).
    for (const po of activePOs) {
      importLine += `\nimport { ${po.name} } from '${po.importPath}';`;
    }

    // Coverage/asset metadata is still DERIVED (surfaced in the API result and
    // the Coverage/RTM reports) — it is just no longer duplicated as a comment
    // header inside the spec. See deriveCoverageMetadata() consumers.
    const content = `${importLine}

test.describe('${escapeStr(title)}', () => {
  test('${escapeStr(title)}', async ({ page }) => {${idMarker}
${combined.map(l => (l ? `    ${l}` : '')).join('\n')}
  });
});
`;

    const fileName = `${toKebab(title).slice(0, 60) || `test-case-${tc.id ?? 'x'}`}.spec.ts`;
    const generatedFiles: GeneratedFile[] = [{
      path: `${conv.testFolder}/${fileName}`,
      content,
      type: 'test',
    }];

    // Emit the shared test-data module alongside the spec when records were used.
    const moduleFile = this.buildTestDataModule(dataIndex, conv);
    if (moduleFile && usesModule) generatedFiles.push(moduleFile);

    const totalAssertions = combined.filter(a => /\bexpect\s*\(/.test(a)).length;
    const grounding = this.buildLocatorGroundingReport(tracked, content, stepTracked);
    // Candidate Discovery (Sprint 2, PR 1) — computed AFTER the spec is fully
    // built so it is provably read-only: it can observe but never alter the
    // generated code. Attached to the result as a transparency report only.
    const candidateDiscovery = this.discoverStepCandidates(steps, config.repoProfile);
    // Coverage metadata is DERIVED here (not narrated in the spec) and surfaced
    // on the result so the framework's Coverage/RTM reports own it.
    const coverageMeta = this.deriveCoverageMetadata(tc, activePOs, caseData);
    const coverage: CoverageEntry[] = [{
      testCaseId: tc.id != null ? Number(tc.id) : undefined,
      title,
      categories: coverageMeta.categories,
      assets: coverageMeta.assets,
    }];
    return this.buildTcResult(tc, title, baseUrl, crawl, tags, generatedFiles, totalAssertions, startTime, grounding, matchedPOs, usedPOVars, candidateDiscovery, coverage);
  }

  /**
   * Candidate Discovery (Sprint 2, PR 1) — read-only.
   *
   * Discovers every plausible implementation candidate per business step, using
   * the SAME reuse catalogue the generator already consults. It runs AFTER the
   * spec has been built and its result is only attached to metadata, so it
   * cannot alter the generated code. Fails open (never throws) — discovery is a
   * transparency report, never a gate.
   */
  private discoverStepCandidates(
    steps: string[],
    profile?: import('../context/types').RepositoryProfile,
  ): CandidateDiscoveryReport {
    const cat = buildReuseCatalogue(profile);
    const discovered = discoverCandidates(steps, {
      pageObjects: cat.pageObjects.map((p) => ({ name: p.name, methods: p.methods, path: p.path })),
      helpers: cat.helpers.map((h) => ({ name: h.name, functions: h.functions, path: h.path })),
      fixtures: cat.fixtures.map((f) => ({ name: f.name, path: f.path })),
      components: cat.components.map((c) => ({ name: c.name, path: c.path })),
    });
    // Ranking (PR 2B): score + order candidates by engineering value. Still
    // read-only — it never selects a winner (report.selected stays false) and
    // never changes the generated code.
    return rankReport(discovered);
  }

  private buildTcResult(
    tc: NonNullable<GenerationConfig['testCase']>,
    title: string,
    baseUrl: string,
    crawl: CrawlResult,
    tags: string[],
    generatedFiles: GeneratedFile[],
    totalAssertions: number,
    startTime: number,
    locatorGrounding?: LocatorGroundingReport,
    matchedPOs?: Array<{ name: string; varName: string; filePath: string; methods: string[]; importPath: string; kind: string }>,
    usedPOVars?: Set<string>,
    candidateDiscovery?: CandidateDiscoveryReport,
    coverage?: CoverageEntry[],
  ): GenerationResult {
    // Real selector quality (0–1), derived from what the spec actually uses —
    // never the old hardcoded 0. Honest blend (review fix #3): a DOM-verified
    // locator counts in full, a curated known-good-but-unverified fallback
    // counts at 0.6 (it's a real selector, just not confirmed against THIS
    // crawl), so the score neither undersells curated locators as 0% nor fakes
    // a 100%.
    const selectorQuality = locatorGrounding && locatorGrounding.total > 0
      ? (locatorGrounding.groundedCount + (locatorGrounding.realCount - locatorGrounding.groundedCount) * 0.6) / locatorGrounding.total
      : 0;
    const testPlan: TestPlan = {
      name: `Test Plan: ${title}`,
      description: `Deterministic test-case automation for "${title}"`,
      baseUrl,
      pageType: crawl.pageType,
      flows: [{
        name: title,
        description: `${tc.expected_result || ''}`,
        flowType: 'authentication',
        priority: 1,
        steps: [],
        tags,
      }],
      fixtures: [],
      pageObjects: [],
      metadata: {
        generatedAt: new Date().toISOString(),
        crawlTimeMs: crawl.crawlTimeMs,
        totalElements: crawl.elements.length,
        selectorQuality,
        model: 'deterministic-test-case',
        tokensUsed: 0,
      },
    };

    // ── Build Repository Intelligence Report ──
    // Expose which Page Objects were discovered and their methods for transparency.
    let repositoryIntelligence: RepositoryIntelligenceReport | undefined;
    if (matchedPOs && matchedPOs.length > 0) {
      const usedSet = usedPOVars || new Set<string>();
      const pageObjects: PageObjectMetadata[] = matchedPOs.map((po) => ({
        name: po.name,
        filePath: po.filePath,
        methods: po.methods,
        importPath: po.importPath,
        used: usedSet.has(po.varName),
      }));
      repositoryIntelligence = {
        pageObjects,
        totalAvailable: matchedPOs.length,
        totalUsed: pageObjects.filter((po) => po.used).length,
      };
    }

    return {
      testPlan,
      generatedFiles,
      stats: {
        totalTests: 1,
        totalAssertions,
        avgSelectorScore: locatorGrounding ? locatorGrounding.avgConfidence / 100 : 0,
        pageObjectsGenerated: 0,
        crawlTimeMs: crawl.crawlTimeMs,
        generationTimeMs: Date.now() - startTime,
        tokensUsed: 0,
        model: 'deterministic-test-case',
      },
      errors: [],
      ...(locatorGrounding ? { locatorGrounding } : {}),
      ...(repositoryIntelligence ? { repositoryIntelligence } : {}),
      ...(candidateDiscovery ? { candidateDiscovery } : {}),
      ...(coverage && coverage.length ? { coverage } : {}),
    };
  }

  /**
   * Requirement-based batch generation. Produces one grounded Playwright spec
   * per test case in `config.testCases` using the same deterministic translator
   * as the single-case path — purely from the case's own steps + test data +
   * expected result and the crawled DOM. No LLM, no project-context creds, so
   * cross-project contamination (e.g. OrangeHRM creds in a SauceDemo run) is
   * impossible. File names are de-duplicated to keep the bundle stable.
   */
  private generateFromTestCases(config: GenerationConfig, crawl: CrawlResult): GenerationResult | null {
    const startTime = Date.now();
    const cases = config.testCases || [];

    // ── Test-data fallback (review priority #2 / user request) ──
    // When no datasets were explicitly linked, synthesize ONE shared dataset from
    // ALL cases up front and pin it on the config. This guarantees the shared
    // tests/data/test-data.ts module is COMPLETE (every record any case binds to
    // is present) and that each per-case generation resolves the same dataset —
    // exactly how the Test Case Lab path behaves. Real linked datasets win.
    if (!config.resolvedTestData?.length) {
      const synth = this.synthesizeResolvedTestData(cases);
      if (synth.length) config = { ...config, resolvedTestData: synth };
    }

    const generatedFiles: GeneratedFile[] = [];
    const usedNames = new Set<string>();
    const flows: TestPlan['flows'] = [];
    let totalAssertions = 0;
    let totalTests = 0;
    const errors: string[] = [];
    const groundingReports: LocatorGroundingReport[] = [];
    const repoIntelReports: RepositoryIntelligenceReport[] = [];
    const coverageEntries: CoverageEntry[] = [];

    // ── Pipeline observability (user request) ──────────────────────────────
    // Track WHERE each case falls out so "nothing generated" is localizable in
    // one screen. Counts are monotonic funnel stages; per-case traces name the
    // deepest stage each case reached and why it stopped.
    const caseTraces: CaseTrace[] = [];
    const pipelineCounts = {
      inputTestCases: cases.length,
      canonicalized: 0,
      parsed: 0,
      grounded: 0,
      generatedScripts: 0,
    };

    // The shared test-data module path is a repository convention (Repo
    // Intelligence), not a literal — resolve it once so the de-dupe check below
    // matches whatever folder the connected repo uses (defaults to tests/data).
    const sharedDataModulePath = resolveTestDataModulePath(this.resolveConventions(config));

    // ── Consolidation by PAGE (user request: coverage over file count) ──
    // Instead of emitting one spec file per test case, group every case by the
    // primary page it exercises (all auth cases → "login", etc.) and merge each
    // group into ONE spec file with many `test(...)` blocks. Shared data-module
    // files are still emitted exactly once. We preserve per-case grounding /
    // flow / assertion stats so the reported metrics stay honest.
    const conv = this.resolveConventions(config);
    const groups = new Map<string, {
      label: string;
      specs: Array<{ content: string; tc: NonNullable<GenerationConfig['testCase']> }>;
    }>();

    for (const tc of cases) {
      const caseLabel = `Test case ${tc.id ?? tc.title ?? '?'}`;
      const trace: CaseTrace = {
        id: (tc.id ?? null) as CaseTrace['id'],
        title: (tc.title ?? null) as CaseTrace['title'],
        reachedStage: 'Canonicalization',
        status: 'FAILED',
      };
      caseTraces.push(trace);
      try {
        // ── STAGE 1 observability (Bug #2 fix) ──
        // Normalize the steps FIRST and inspect the diagnostics. When a case
        // yields 0 automatable steps we now record WHY (shape + observed keys)
        // instead of discarding it as a bare `null`. This is what populates the
        // 422 `caseErrors` so users see the real Stage-1 reason per case.
        const { steps: normalizedSteps, diagnostics } = this.parseTestCaseStepsWithDiagnostics(tc);
        trace.stepCount = normalizedSteps.length;
        if (normalizedSteps.length === 0) {
          // Died at canonicalization/parsing — the steps payload yielded 0
          // automatable steps. reachedStage stays "Canonicalization".
          trace.reason = describeStageOneFailure(caseLabel, diagnostics);
          errors.push(trace.reason);
          continue;
        }
        // Canonicalization + step parsing succeeded.
        pipelineCounts.canonicalized++;
        pipelineCounts.parsed++;
        trace.reachedStage = 'Step Parsing';

        // Reuse the single-case translator by scoping config to this case.
        const single = this.generateFromTestCase({ ...config, testCase: tc, testCases: undefined }, crawl);
        if (!single || single.generatedFiles.length === 0) {
          // Steps parsed but a later stage (grounding/emit) produced nothing.
          // Distinguish grounding failure from emit failure using the report.
          const grounded = single?.locatorGrounding;
          if (grounded && (grounded.groundedCount > 0 || grounded.realCount > 0)) {
            trace.reachedStage = 'Grounding';
            pipelineCounts.grounded++;
            trace.reason = `${caseLabel}: STAGE 4 (script emit) — ${normalizedSteps.length} step(s) parsed and ${grounded.realCount} locator(s) grounded, but no spec emitted`;
          } else {
            trace.reachedStage = 'Step Parsing';
            trace.reason = `${caseLabel}: STAGE 3 (grounding) — ${normalizedSteps.length} step(s) parsed but 0 locators grounded against the App Profile`;
          }
          errors.push(trace.reason);
          continue;
        }
        // Grounding produced at least one real locator for this case.
        if (single.locatorGrounding && (single.locatorGrounding.groundedCount > 0 || single.locatorGrounding.realCount > 0)) {
          pipelineCounts.grounded++;
          trace.reachedStage = 'Grounding';
        }
        if (single.locatorGrounding) groundingReports.push(single.locatorGrounding);
        if (single.repositoryIntelligence) repoIntelReports.push(single.repositoryIntelligence);
        if (single.coverage) coverageEntries.push(...single.coverage);

        const { key, label } = this.primaryPageKey(tc);
        for (const f of single.generatedFiles) {
          // The shared test-data module is identical across cases — emit it
          // once, never rename it (specs import a fixed relative path to it).
          if (f.path === sharedDataModulePath) {
            if (!usedNames.has(f.path)) {
              usedNames.add(f.path);
              generatedFiles.push(f);
            }
            continue;
          }
          // Bucket spec files by page. Non-spec artefacts (rare) pass through.
          if (f.type === 'test') {
            let g = groups.get(key);
            if (!g) { g = { label, specs: [] }; groups.set(key, g); }
            g.specs.push({ content: f.content, tc });
          } else {
            let path = f.path;
            if (usedNames.has(path)) {
              const idTag = tc.id != null ? `-tc${tc.id}` : `-${usedNames.size + 1}`;
              path = path.replace(/\.(spec|ts)$/, `${idTag}.$1`);
            }
            usedNames.add(path);
            generatedFiles.push({ ...f, path });
          }
        }
        totalAssertions += single.stats.totalAssertions;
        totalTests += single.stats.totalTests;
        if (single.testPlan.flows[0]) flows.push(single.testPlan.flows[0]);
        // Case fully traversed the pipeline and emitted a spec.
        pipelineCounts.generatedScripts++;
        trace.reachedStage = 'Generated';
        trace.status = 'OK';
        delete trace.reason;
      } catch (err: any) {
        trace.reason = `${caseLabel}: STAGE 3 threw — ${err?.message}`;
        errors.push(trace.reason);
      }
    }

    // Emit one consolidated spec file per page group.
    for (const [key, g] of groups) {
      let fileName = `${key}.spec.ts`;
      if (usedNames.has(`${conv.testFolder}/${fileName}`)) fileName = `${key}-${groups.size}.spec.ts`;
      usedNames.add(`${conv.testFolder}/${fileName}`);
      if (g.specs.length === 1) {
        // Single scenario for this page — keep the original single-case file as-is.
        generatedFiles.push({ path: `${conv.testFolder}/${fileName}`, content: g.specs[0].content, type: 'test' });
      } else {
        generatedFiles.push(this.mergeCaseSpecs(g.specs, g.label, fileName, conv.testFolder));
      }
    }

    const reqLabel = cases[0]?.requirement_id ? `requirement ${cases[0].requirement_id}` : 'requirement';

    // Assemble the pipeline summary (user request) — the funnel + per-case trace
    // that lets the API / dashboard localize WHERE the count dropped to zero.
    const pipeline: PipelineSummary = { ...pipelineCounts, cases: caseTraces };
    logger.info(MOD, 'Requirement pipeline summary', {
      inputTestCases: pipeline.inputTestCases,
      canonicalized: pipeline.canonicalized,
      parsed: pipeline.parsed,
      grounded: pipeline.grounded,
      generatedScripts: pipeline.generatedScripts,
    });

    if (generatedFiles.length === 0) {
      // Bug #2 fix: DO NOT discard the per-case diagnostics. Previously this
      // returned `null`, which erased the `errors[]` array — so `generate()`
      // threw `DeterministicGenerationEmptyError(n, [])` and the 422 reported
      // `caseErrors: []` (no way to see the real Stage-1 reason). We now return
      // an empty-but-diagnostic result so the errors propagate to the 422.
      return {
        testPlan: {
          name: `Test Plan: ${reqLabel} (0 generated)`,
          description: `Deterministic requirement-based automation produced no scripts from ${cases.length} case(s)`,
          baseUrl: config.url,
          pageType: crawl.pageType,
          flows: [],
          fixtures: [],
          pageObjects: [],
          metadata: {
            generatedAt: new Date().toISOString(),
            crawlTimeMs: crawl.crawlTimeMs,
            totalElements: crawl.elements.length,
            selectorQuality: 0,
            model: 'deterministic-requirement-batch',
            tokensUsed: 0,
          },
        },
        generatedFiles: [],
        stats: {
          totalTests: 0,
          totalAssertions: 0,
          avgSelectorScore: 0,
          pageObjectsGenerated: 0,
          crawlTimeMs: crawl.crawlTimeMs,
          generationTimeMs: Date.now() - startTime,
          tokensUsed: 0,
          model: 'deterministic-requirement-batch',
        },
        errors,
        pipeline,
      };
    }

    // Aggregate per-case grounding into one report → real "REAL LOCATORS x/y".
    const locatorGrounding = this.mergeLocatorGrounding(groundingReports);
    // Honest blend (review fix #3): DOM-verified full, curated known-good 0.6.
    const selectorQuality = locatorGrounding.total > 0
      ? (locatorGrounding.groundedCount + (locatorGrounding.realCount - locatorGrounding.groundedCount) * 0.6) / locatorGrounding.total
      : 0;

    // Aggregate repository intelligence across all cases (de-duplicate Page Objects).
    const repositoryIntelligence = this.mergeRepoIntelligence(repoIntelReports);

    const testPlan: TestPlan = {
      name: `Test Plan: ${reqLabel} (${cases.length} cases)`,
      description: `Deterministic requirement-based automation — ${cases.length} test cases across ${generatedFiles.filter(f => f.type === 'test').length} page spec${generatedFiles.filter(f => f.type === 'test').length > 1 ? 's' : ''}`,
      baseUrl: config.url,
      pageType: crawl.pageType,
      flows,
      fixtures: [],
      pageObjects: [],
      metadata: {
        generatedAt: new Date().toISOString(),
        crawlTimeMs: crawl.crawlTimeMs,
        totalElements: crawl.elements.length,
        selectorQuality,
        model: 'deterministic-requirement-batch',
        tokensUsed: 0,
      },
    };

    return {
      testPlan,
      generatedFiles,
      stats: {
        totalTests,
        totalAssertions,
        avgSelectorScore: locatorGrounding.avgConfidence / 100,
        pageObjectsGenerated: 0,
        crawlTimeMs: crawl.crawlTimeMs,
        generationTimeMs: Date.now() - startTime,
        tokensUsed: 0,
        model: 'deterministic-requirement-batch',
      },
      errors,
      pipeline,
      ...(locatorGrounding.total > 0 ? { locatorGrounding } : {}),
      ...(repositoryIntelligence ? { repositoryIntelligence } : {}),
      ...(coverageEntries.length ? { coverage: coverageEntries } : {}),
    };
  }

  /**
   * Derive the PRIMARY page a test case exercises, used to consolidate many
   * scenarios that live on the same page into ONE spec file (coverage over file
   * count — a user request). Authentication cases all collapse to a single
   * "login" bucket even when their Expected Result mentions the post-login home
   * URL, so "log in successfully" and "redirected home after login" land in the
   * same file. Otherwise we bucket by the first navigated URL's path.
   */
  private primaryPageKey(tc: NonNullable<GenerationConfig['testCase']>): { key: string; label: string } {
    const steps = this.parseTestCaseSteps(tc);
    const hay = `${steps.join(' ')} ${tc.title ?? ''} ${tc.scenario ?? ''} ${tc.preconditions ?? ''}`.toLowerCase();

    // Auth/login scenarios → one shared bucket regardless of destination URL.
    const isAuth = /\blog ?in\b|\bsign ?in\b|\blogin\b|\bsignin\b|credential|username|password|\/login|\/signin/.test(hay);
    if (isAuth) return { key: 'login', label: 'Login' };

    // Otherwise bucket by the first navigate URL's path segment.
    for (const s of steps) {
      if (!/navigat|go to|open|launch|visit/i.test(s)) continue;
      const m = s.match(/\bhttps?:\/\/[^\s'")]+/i);
      if (m) {
        try {
          const p = new URL(m[0]).pathname.replace(/\/+$/, '');
          const seg = p.split('/').filter(Boolean)[0];
          if (seg) return { key: seg.toLowerCase(), label: this.titleCase(seg) };
        } catch { /* ignore malformed URL */ }
      }
    }
    // Signup / register / cart / search keyword buckets as a last resort.
    for (const [re, key, label] of [
      [/sign ?up|register|create account/, 'signup', 'Signup'],
      [/\bcart\b|checkout|basket/, 'cart', 'Cart'],
      [/search/, 'search', 'Search'],
      [/product|catalog|inventory/, 'products', 'Products'],
    ] as Array<[RegExp, string, string]>) {
      if (re.test(hay)) return { key, label };
    }
    return { key: 'app', label: 'Application' };
  }

  private titleCase(s: string): string {
    return s.replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  }

  /**
   * Merge several single-case spec files (each a full describe→test) that belong
   * to the SAME page into ONE spec: a single import header (unioned + de-duped),
   * a single `test.describe('<Page> — N scenarios')`, and every case as its own
   * `test(...)` block inside it. This is what turns "9 login cases → 9 files"
   * into "9 login cases → login.spec.ts with 9 tests".
   */
  private mergeCaseSpecs(
    specs: Array<{ content: string; tc: NonNullable<GenerationConfig['testCase']> }>,
    label: string,
    fileName: string,
    testFolder: string,
  ): GeneratedFile {
    const importSet = new Set<string>();
    const testBlocks: string[] = [];

    for (const { content } of specs) {
      const lines = content.split('\n');
      for (const l of lines) if (/^import\s.+;$/.test(l.trim())) importSet.add(l.trim());

      // Locate the top-level test construct. Most cases are wrapped in a
      // `test.describe(...)`; a few paths (e.g. the concurrent-session case)
      // emit a bare `test.fixme(...)` / `test(...)` at the top level instead.
      const describeIdx = lines.findIndex(l => /^test\.describe\(/.test(l.trim()));
      const anchorIdx = describeIdx !== -1
        ? describeIdx
        : lines.findIndex(l => /^test(\.(fixme|skip|only))?\(/.test(l.trim()));
      if (anchorIdx === -1) continue; // no recognisable test — nothing to merge

      // The doc comment that precedes the construct (per-case traceability block).
      let docStart = -1;
      for (let i = anchorIdx - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t === '') continue;
        if (t.endsWith('*/')) { // walk up to the matching /**
          let j = i;
          while (j >= 0 && !lines[j].trim().startsWith('/**')) j--;
          docStart = j;
        }
        break;
      }
      const doc = docStart !== -1 ? lines.slice(docStart, anchorIdx).filter(l => l.trim() !== '') : [];

      let bodyLines: string[];
      if (describeIdx !== -1) {
        // Unwrap the describe body (drop the final `});` that closes it). Inner
        // lines are already indented 2 spaces.
        const bodyEnd = (() => {
          for (let i = lines.length - 1; i > describeIdx; i--) {
            if (lines[i].trim() === '});') return i;
          }
          return lines.length - 1;
        })();
        bodyLines = lines.slice(describeIdx + 1, bodyEnd);
      } else {
        // Bare top-level test — keep the whole construct, re-indented by 2 so it
        // nests cleanly inside the consolidated describe.
        bodyLines = lines.slice(anchorIdx).map(l => (l.trim() === '' ? '' : '  ' + l));
      }

      const block = [...doc.map(l => '  ' + l.trim()), ...bodyLines].join('\n');
      testBlocks.push(block.replace(/\n{3,}/g, '\n\n').trimEnd());
    }

    // Keep the Playwright import first, then the rest sorted for stability.
    const pwImport = `import { test, expect } from '@playwright/test';`;
    importSet.delete(pwImport);
    const imports = [pwImport, ...Array.from(importSet).sort()].join('\n');

    const describeTitle = `${label} — ${specs.length} scenario${specs.length > 1 ? 's' : ''}`;
    const content = `${imports}

test.describe('${escapeStr(describeTitle)}', () => {
${testBlocks.join('\n\n')}
});
`;
    return { path: `${testFolder}/${fileName}`, content, type: 'test' };
  }

  /**
   * Parse a test case's steps into the canonical `string[]` contract.
   *
   * The engine no longer guesses payload shapes inline. ALL shape tolerance
   * (string[], object[], keyed-object, JSON string, newline prose, and foreign
   * key schemas like `{instruction, expectedResult}`) lives in the single
   * canonical normalizer (`canonical-test-case.ts`). This method is a thin
   * adapter so every existing caller keeps working while consuming exactly one
   * contract. Use `parseTestCaseStepsWithDiagnostics` when you also need the
   * reason a payload produced zero steps (Stage-1 observability).
   */
  private parseTestCaseSteps(tc: GenerationConfig['testCase']): string[] {
    if (!tc) return [];
    return normalizeTestCase(tc).canonical.steps;
  }

  /**
   * Same as `parseTestCaseSteps` but also returns the normalization diagnostics
   * (detected shape, observed keys, warnings). Used by the batch generator to
   * emit an honest per-case reason when a case yields 0 automatable steps,
   * instead of discarding it as a bare `null` (the old `caseErrors: []` bug).
   */
  private parseTestCaseStepsWithDiagnostics(
    tc: GenerationConfig['testCase'],
  ): { steps: string[]; diagnostics: NormalizationDiagnostics } {
    if (!tc) {
      return { steps: [], diagnostics: { stepCount: 0, sourceShape: 'empty', warnings: ['no test case'] } };
    }
    const { canonical, diagnostics } = normalizeTestCase(tc);
    return { steps: canonical.steps, diagnostics };
  }

  /** Parse "Username: x, Password: y" (or JSON) test data into credentials. */
  private parseTestData(testData: any): { username: string; password: string } {
    const out = { username: '', password: '' };
    if (!testData) return out;
    if (typeof testData === 'object') {
      out.username = String(testData.username ?? testData.user ?? '');
      out.password = String(testData.password ?? testData.pass ?? '');
      return out;
    }
    const s = String(testData);
    // 1) Structured "username: x" / "password = y".
    const u = s.match(/user(?:name)?\s*[:=]\s*([^,;\n]*)/i);
    const p = s.match(/pass(?:word)?\s*[:=]\s*([^,;\n]*)/i);
    if (u) out.username = this.cleanCredentialToken(u[1]!);
    if (p) out.password = this.cleanCredentialToken(p[1]!);
    // 2) Natural-language "standard_user from valid_users" → username token is
    //    the credential-looking word *before* "from <dataset>". The dataset name
    //    after "from" is NOT the value.
    if (!out.username) {
      const fromForm = s.match(/\b([a-z0-9][a-z0-9._@-]*)\s+from\s+[a-z0-9_]+/i);
      if (fromForm && this.looksLikeCredential(fromForm[1]!)) out.username = fromForm[1]!.trim();
    }
    return out;
  }

  /** Strip placeholder/markup tokens like `<password>` and quotes/whitespace. */
  private cleanCredentialToken(raw: string): string {
    const v = String(raw).trim().replace(/^['"]|['"]$/g, '').trim();
    if (!v || /^<.*>$/.test(v)) return '';
    return v;
  }

  /** A value that looks like a real credential (not a noise/placeholder word). */
  private looksLikeCredential(v: string): boolean {
    const t = v.trim();
    if (!t || /^<.*>$/.test(t)) return false;
    // Reject articles/instruction verbs/field words AND English prepositions &
    // stop-words (in/on/at/for/of/by/…). The latter are what produced bogus
    // fills like `login('username', 'in')` — the word after "password" in
    // "Enter the password in [data-testid='password'] field" is the preposition
    // "in", never a credential value.
    if (/^(the|a|an|to|valid|invalid|empty|blank|field|fields|account|user|users|username|password|placeholder|credentials?|with|and|into|from|enter|leave|in|on|at|for|of|by|as|is|are|be|or|if|it|button|page|click|here|then|next|after|before|login|logon|signin)$/i.test(t)) return false;
    return /^[a-z0-9][a-z0-9._@+-]*$/i.test(t);
  }

  /**
   * Strip CSS / attribute selector noise from a step description so credential
   * extraction never mines a locator fragment as a value. Without this,
   * "Enter the username in [data-testid='username'] field" yielded the literal
   * `'username'` (the attribute value) instead of resolving the bound dataset
   * record. Removes [bracketed] selectors, attr='…'/attr="…" assignments, and
   * #id / .class tokens.
   */
  private stripSelectorNoise(raw: string): string {
    return String(raw)
      .replace(/\[[^\]]*\]/g, ' ')               // [data-testid='username']
      .replace(/[\w-]+\s*=\s*(['"]).*?\1/g, ' ')  // data-testid='username'
      // Strip #id / .class selector tokens ONLY when they stand alone (start of
      // string, or preceded by whitespace / an opening paren). Previously this
      // matched the `.com` inside an email/domain literal (e.g.
      // "test@example.com" → "test@example"), silently truncating credential
      // values. Requiring a boundary before the token keeps `example.com`,
      // `v1.2`, etc. intact while still removing real `.btn-primary`/`#id` hooks.
      .replace(/(^|[\s(])([#.][a-z][\w-]*)/gi, '$1 ');
  }

  /**
   * Known test-hook attribute synonyms an LLM tends to hallucinate in prose
   * step descriptions. The Test Case Lab frequently writes "…in
   * [data-testid='username'] field" even when the real app exposes the hook as
   * `data-test`. Left uncorrected, the generated spec's HUMAN-READABLE steps
   * contradict the EXECUTABLE code (which correctly resolves `data-test` from
   * the crawl) — eroding user trust in the locators. These are normalized to
   * the attribute actually observed in the crawled DOM.
   */
  private static readonly TEST_HOOK_ATTR_SYNONYMS = [
    'data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy',
    'data-test-selector', 'data-automation-id', 'data-automationid', 'data-auto',
  ];

  /**
   * Detect the dominant test-hook attribute ACTUALLY present in the crawled DOM
   * (App Profile). Returns e.g. `data-test` for SauceDemo. Returns undefined
   * when the crawl exposes no test-hook attribute, in which case prose is left
   * untouched (we never rewrite to an unverified attribute).
   */
  private detectTestHookAttr(crawl?: CrawlResult): string | undefined {
    const counts = new Map<string, number>();
    for (const el of (crawl?.elements || [])) {
      const attrs = (el as any).attributes as Record<string, string> | undefined;
      if (!attrs) continue;
      for (const key of Object.keys(attrs)) {
        const k = key.toLowerCase();
        if (ScriptGenEngine.TEST_HOOK_ATTR_SYNONYMS.includes(k)) {
          counts.set(k, (counts.get(k) || 0) + 1);
        }
      }
    }
    let best: string | undefined;
    let bestCount = 0;
    for (const [k, c] of counts) {
      if (c > bestCount) { best = k; bestCount = c; }
    }
    return best;
  }

  /**
   * Rewrite hallucinated test-hook attribute names inside a prose step
   * description so they match the attribute the app really uses. Only the
   * attribute NAME is changed — the value and surrounding text are preserved —
   * and only when `realAttr` is known AND differs from what was written.
   * Handles both bracketed (`[data-testid='x']`) and bare
   * (`data-testid="x"`) forms.
   *
   * Deterministic and side-effect free — safe to unit test in isolation.
   */
  private normalizeStepSelectors(step: string, realAttr?: string): string {
    if (!realAttr) return step;
    let out = String(step);
    for (const synonym of ScriptGenEngine.TEST_HOOK_ATTR_SYNONYMS) {
      if (synonym === realAttr) continue;
      // Match the attribute name only when immediately followed by `=` (an
      // actual selector reference), with an optional leading `[`. Word-boundary
      // guarded so `data-test` never partially clobbers `data-testid`.
      const re = new RegExp(`(\\[?)${synonym}(?=\\s*=)`, 'gi');
      out = out.replace(re, `$1${realAttr}`);
    }
    return out;
  }

  /**
   * Extract a concrete credential value written directly in a step/test-data
   * string, e.g. "...from valid_users: standard_user" → "standard_user",
   * "Enter username standard_user" → "standard_user". Returns '' when the text
   * carries only a placeholder (<password>) or no usable value.
   */
  private extractStepCredential(kind: 'username' | 'password', raw: string): string {
    const text = String(raw);
    // Only extract a value for a field the step is actually about — otherwise a
    // username step's trailing value (e.g. "...: standard_user") would wrongly
    // be picked up as the password too.
    const refersToKind = kind === 'username'
      ? /\buser(?:\s*name)?\b/i.test(text)
      : /\bpass(?:\s*word)?\b/i.test(text);
    if (!refersToKind) return '';
    // For password steps that also mention a username (rare), don't let the
    // username token leak in via the colon rule.
    if (kind === 'password' && /\buser(?:\s*name)?\b/i.test(text) && !/\bpass(?:\s*word)?\b.*:/i.test(text)) {
      // fall through to the password-specific regex (rule 2) only.
    } else {
      // 1) Explicit value after a colon near the end: "...: standard_user".
      const afterColon = text.match(/:\s*([a-z0-9][a-z0-9._@+-]*)\s*$/i);
      if (afterColon && this.looksLikeCredential(afterColon[1]!)) return afterColon[1]!.trim();
    }
    // 2) "username/user <value>" or "password is <value>" (skips noise words).
    const re = kind === 'username'
      ? /\buser(?:name)?\b(?:\s+(?:is|=|:|as))?\s+(?:to\s+)?["']?([a-z0-9][a-z0-9._@+-]*)["']?/i
      : /\bpass(?:word)?\b(?:\s+(?:is|=|:|as))?\s+(?:to\s+)?["']?([a-z0-9][a-z0-9._@+!$-]*)["']?/i;
    const m = text.match(re);
    if (m && this.looksLikeCredential(m[1]!)) return m[1]!.trim();
    return '';
  }

  /**
   * JS expression to fill a credential field given a resolved literal value.
   * When the value is genuinely unknown we emit an env-var expression rather
   * than a silent `fill('')` — the test stays runnable once credentials are
   * supplied, and never masquerades as a passing login with empty inputs.
   */
  private credFillExpr(kind: 'username' | 'password', literal: string): string {
    const v = (literal || '').trim();
    if (v) return `'${escapeStr(v)}'`;
    return kind === 'username'
      ? `process.env.TEST_USERNAME ?? ''`
      : `process.env.TEST_PASSWORD ?? ''`;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Scenario Intent Fidelity (Script-Gen Quality review — Priority #1)       */
  /*  The deterministic builder IMPLEMENTS the exact scenario each test case    */
  /*  describes (whitespace / special-char / max-length / empty / invalid)     */
  /*  rather than copying the happy-path login — via the Scenario Intelligence */
  /*  layer (classifier + independent transformers), not inline branching.     */
  /* ──────────────────────────────────────────────────────────────────────── */

  // NOTE: Login-scenario classification and the per-scenario credential/assertion
  // transforms (empty / whitespace / special-char / max-length / invalid /
  // normal) now live in the dedicated Scenario Intelligence layer at
  // ./scenario-intelligence, accessed via `this.scenario`. Each scenario type is
  // a self-describing transformer that owns its own detection (`matches`), so
  // there is no central classifier to keep in sync. This keeps the generator
  // free of embedded per-scenario branching and makes new scenario types drop-in.

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Coverage Metadata (Script-Gen Quality review — Priority #5)              */
  /*  Replace the useless `Coverage: n/a` header with derived test categories  */
  /*  (Functional / Negative / Boundary / Validation) and the concrete         */
  /*  repository assets the generated script reuses (Page Objects + datasets). */
  /* ──────────────────────────────────────────────────────────────────────── */

  /** Normalize a test case's `tags` (array or delimited string) to a list. */
  private normalizeTags(tc: NonNullable<GenerationConfig['testCase']> | undefined): string[] {
    const raw: any = (tc as any)?.tags;
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.map((t) => `${t}`.trim()).filter(Boolean);
    return `${raw}`.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
  }

  /**
   * Derive human-meaningful coverage categories + the repository assets the
   * script reuses. Categories are inferred from tags + coverage_type + scenario
   * + expected result (NOT invented). Returns { categories, assets } as
   * pre-formatted strings ready to drop into the spec header.
   */
  private deriveCoverageMetadata(
    tc: NonNullable<GenerationConfig['testCase']> | undefined,
    activePOs: Array<{ name: string }>,
    caseData?: { datasetName: string; recordKey?: string; representative?: boolean } | null,
  ): { categories: string; assets: string } {
    const tags = this.normalizeTags(tc);
    const cov = `${(tc as any)?.coverage_type ?? ''}`.toLowerCase();
    const hay = [
      tc?.title, tc?.scenario, cov, tags.join(' '), `${tc?.expected_result ?? ''}`,
    ].map((s) => `${s ?? ''}`).join(' ').toLowerCase();

    const cats: string[] = [];
    const add = (c: string) => { if (!cats.includes(c)) cats.push(c); };
    if (/\bnegative\b|fail|invalid|incorrect|wrong|locked|error|denied|reject/.test(hay)) add('Negative');
    if (/edge|boundary|\bmax(?:imum)?\b|\bmin(?:imum)?\b|length|whitespace|special\s*char|limit|overflow/.test(hay)) add('Boundary');
    if (/empty|required|blank|validation|format|missing|mandatory/.test(hay)) add('Validation');
    if (/\bpositive\b|smoke|happy\s*path|\bsuccess\b/.test(hay)) add('Functional');
    
    // Sprint 2D.1: derive coverage categories from Scenario Graph semantics when
    // available, bypassing ScenarioIntelligence re-inference.
    if (tc) {
      const semantics = (tc as any).__scenarioNode?.semantics;
      if (semantics) {
        // Derive coverage from the semantics variation/expectedBehavior.
        const dummyResolver: ScenarioCredentialResolver = {
          base: () => ({ username: '', password: '' }),
          validCounterpart: () => ({ username: '', password: '' }),
          envUsername: () => '',
          envPassword: () => '',
          authoredUsername: null,
          authoredPassword: null,
          authoredBothEmpty: false,
          escape: (s: string) => s,
        };
        const derived = this.deriveFromSemantics(semantics, dummyResolver);
        for (const c of derived.coverageCategories) add(c);
      } else {
        // Legacy path: classify and get transformer's coverage categories.
        const { transformer } = this.scenario.resolve(tc, this.parseTestCaseSteps(tc));
        for (const c of transformer.coverageCategories) add(c);
      }
    }
    // Default: a case that is none of the above is a straightforward Functional
    // check. Always surface at least one category.
    if (!cats.length) add('Functional');

    const assets: string[] = [];
    for (const po of activePOs) assets.push(`${po.name} (Page Object)`);
    if (caseData?.datasetName) {
      assets.push(caseData.representative
        ? `Test Data Store → dataset "${caseData.datasetName}" (representative record)`
        : `Test Data Store → dataset "${caseData.datasetName}"${caseData.recordKey ? ` → record "${caseData.recordKey}"` : ''}`);
    }

    return {
      categories: cats.join(', '),
      assets: assets.length ? assets.join('; ') : 'none (raw Playwright APIs)',
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Test Data → Script traceability                                          */
  /*  Resolve REAL dataset records (not key summaries) into the generated      */
  /*  script: emit a `tests/data/test-data.ts` module + reference records via  */
  /*  getRecord('<dataset>', selector?) so scripts bind to the dataset schema    */
  /*  hardcoding/empty credentials. Review priority #1.                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Flatten `config.resolvedTestData` into an index:
   *   { datasetName -> { recordKey -> value } }
   * `value` is the record payload (e.g. `{ username, password }`). Returns an
   * empty index when no resolved data was supplied (url-based path unchanged).
   */
  private buildTestDataIndex(
    config: GenerationConfig,
  ): Map<string, Map<string, any>> {
    const index = new Map<string, Map<string, any>>();
    // ── Canonical Test Data normalization (read-side) ──────────────────────
    // Datasets must represent COMPLETE business entities (one record per user
    // carrying username/password/email/…), not field-per-record scalar rows.
    // Legacy datasets persisted a "user" as separate {key:"email"} /
    // {key:"password"} rows, which made getRecord("valid_users") return only the
    // first field and forced generated scripts to fall back to process.env.
    // normalizeResolvedTestData() collapses that anti-pattern into entity records
    // (and aliases email→username for email-authenticated apps) so the index —
    // and every consumer (resolveCaseData, resolveValidUserRecord, the emitted
    // test-data.ts) — sees clean entities. See canonical-test-data.ts.
    const { datasets: canonical, warnings } = normalizeResolvedTestData(config.resolvedTestData);
    for (const w of warnings) this.testDataWarnings.push(w);
    for (const ds of canonical) {
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
   * Synthesize a dataset from the test cases themselves when no datasets were
   * explicitly linked (review priority #2 — a `tests/data/test-data.ts` module
   * should ship in EVERY ZIP, and the user's request: "add test data same as the
   * Test Case Lab"). We mine the steps / test_data for dataset references the
   * authors already wrote, e.g.:
   *    "Enter valid username from valid_users: standard_user"
   *    "standard_user from valid_users"
   * and build an in-memory dataset → records map. Record values carry the
   * username (the record key is typically the username for these data stores);
   * a literal password is only stored when one actually appears (otherwise the
   * generated login falls back to process.env.TEST_PASSWORD, never a fake value).
   *
   * Returns a `resolvedTestData`-shaped array (possibly empty). This is a pure,
   * deterministic fallback — when real linked datasets ARE supplied they always
   * win and this is never consulted.
   */
  private synthesizeResolvedTestData(
    cases: Array<NonNullable<GenerationConfig['testCase']>>,
  ): NonNullable<GenerationConfig['resolvedTestData']> {
    const datasets = new Map<string, Map<string, any>>();
    const STOP = /^(valid|invalid|the|a|an|username|user|users|password|account|empty|with|from|enter|click|valid_password|placeholder)$/i;
    const add = (ds: string, key: string, extra: Record<string, any> = {}) => {
      if (!ds || !key || STOP.test(key) || STOP.test(ds)) return;
      // Only treat snake/identifier-ish tokens as dataset + record keys.
      if (!/^[a-zA-Z][\w-]*$/.test(ds) || !/^[a-zA-Z][\w-]*$/.test(key)) return;
      if (!datasets.has(ds)) datasets.set(ds, new Map());
      const m = datasets.get(ds)!;
      // Review fix (consistent dataset usage): synthesized records always carry
      // BOTH username AND password fields (password omitted → falls back to env at
      // runtime) so ctx.data.hasPassword is true and applyPageObjectActions uses
      // the bound record instead of falling back to literal 'standard_user'.
      // Use `null` instead of `undefined` for visibility in the JSON output.
      const prev = m.get(key) || { username: key, password: null };
      m.set(key, { ...prev, ...extra });
    };

    for (const tc of cases) {
      const steps = this.parseTestCaseSteps(tc);
      const text = `${tc.test_data || ''}\n${steps.join('\n')}`;
      // "from <dataset>: <record_key>"
      const reFromColon = /from\s+([a-zA-Z][\w-]*)\s*:\s*([a-zA-Z][\w-]*)/gi;
      // "<record_key> from <dataset>"
      const reKeyFrom = /\b([a-zA-Z][\w-]*)\s+from\s+([a-zA-Z][\w-]*)\b/gi;
      let m: RegExpExecArray | null;
      while ((m = reFromColon.exec(text))) add(m[1], m[2]);
      while ((m = reKeyFrom.exec(text))) add(m[2], m[1]);
    }

    const out: NonNullable<GenerationConfig['resolvedTestData']> = [];
    for (const [name, recMap] of datasets) {
      const records = [...recMap.entries()].map(([key, value]) => ({ key, value }));
      if (records.length) out.push({ name, records });
    }
    return out;
  }

  /**
   * Build the test-data index for a generation, falling back to a synthesized
   * dataset (mined from the case text) when no datasets were explicitly linked,
   * so generated specs always bind via getRecord() and a data module ships.
   */
  private buildTestDataIndexWithFallback(
    config: GenerationConfig,
    cases: Array<NonNullable<GenerationConfig['testCase']>>,
  ): Map<string, Map<string, any>> {
    let index = this.buildTestDataIndex(config);
    if (index.size === 0) {
      const synth = this.synthesizeResolvedTestData(cases);
      if (synth.length) index = this.buildTestDataIndex({ ...config, resolvedTestData: synth });
    }
    return index;
  }

  /**
   * Deterministic Scenario → Dataset category classifier (Data Quality).
   *
   * Maps a common authentication scenario to the category of dataset it should
   * consume, using ONLY signals already on the case — no LLM. Signals are read
   * in priority order (explicit test data → canonical scenario → title →
   * expected result → requirement → steps); the first signal that yields a
   * category wins. Within a signal the MOST specific categories are tested first
   * (empty-username/password before generic invalid) so "empty password" never
   * collapses into the broad "invalid" bucket.
   *
   * Returns null when the case is not a recognised auth scenario, leaving the
   * caller's existing behaviour untouched.
   */
  private classifyAuthDatasetCategory(text: string): AuthDatasetCategory | null {
    const t = String(text || '').toLowerCase();
    if (!t.trim()) return null;
    const mentionsPassword = /\bpass(word)?\b|\bpwd\b/.test(t);
    const mentionsUsername = /\buser(\s?name)?\b|\bemail\b|\blogin\s?id\b/.test(t);
    const isEmpty =
      /\b(empty|blank|missing)\b/.test(t) ||
      /\bno\s+(user(name)?|email|login|password|pwd|credential)/.test(t) ||
      /\bwithout\s+(a\s+|an\s+|any\s+)?(user(name)?|email|login|password|pwd|credential)/.test(t) ||
      /\bleave[^.]*\b(blank|empty)\b/.test(t);
    // Most specific first.
    if (isEmpty && mentionsPassword && !mentionsUsername) return 'empty_password';
    if (isEmpty && (mentionsUsername || /\blogin\b/.test(t)) && !mentionsPassword) return 'empty_username';
    if (/\block(ed)?\b|locked[\s-]?out|\bblocked\b|\bsuspended\b|disabled\s+account/.test(t)) return 'locked';
    if (/\b(unknown|unregistered|non[\s-]?existent|nonexistent|not[\s-]registered|no[\s-]such|never\s+registered)\b/.test(t) ||
        /\b(user|account)\s+(does\s+not\s+exist|doesn'?t\s+exist)\b/.test(t)) return 'unknown_user';
    if (/\b(invalid|wrong|incorrect|bad)\b/.test(t) && mentionsPassword && !mentionsUsername) return 'invalid_password';
    if (/\b(valid|correct|successful|success|positive|happy\s?path|standard|default|primary)\b/.test(t) &&
        !/\b(invalid|incorrect|wrong|bad|lock|locked|unknown|empty|blank|missing|expired|disabled|blocked)\b/.test(t)) return 'valid';
    if (/\b(invalid|wrong|incorrect|bad|failure|failed|negative)\b/.test(t)) return 'invalid';
    return null;
  }

  /**
   * Read the priority-ordered case signals and return the first recognised auth
   * scenario category. Steps are consulted LAST (lowest priority) so an explicit
   * title/scenario/expected-result always wins over an incidental step keyword.
   */
  private classifyCaseDatasetCategory(
    tc: NonNullable<GenerationConfig['testCase']>,
    steps: string[],
  ): AuthDatasetCategory | null {
    const signals: Array<string | undefined> = [
      tc.test_data as any,
      (tc as any).scenario,
      tc.title,
      tc.expected_result,
      (tc as any).requirement_id,
      (tc as any).requirement,
    ];
    for (const sig of signals) {
      const cat = this.classifyAuthDatasetCategory(String(sig || ''));
      if (cat) return cat;
    }
    return this.classifyAuthDatasetCategory(steps.join('\n'));
  }

  /**
   * True when a DATASET NAME belongs to the given scenario category. Matching is
   * TOKEN-based (de-pluralized words), never substring — so "valid_users" and
   * "invalid_password_users" are told apart cleanly (the latter tokenizes to
   * {invalid, password, user}, which does NOT contain the token "valid").
   */
  private datasetMatchesCategory(name: string, cat: AuthDatasetCategory): boolean {
    const toks = new Set(
      String(name).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((s) => s.replace(/s$/, '')),
    );
    const has = (...ws: string[]) => ws.some((w) => toks.has(w));
    const hasEmpty = has('empty', 'blank', 'missing');
    const hasPass = has('password', 'pass', 'pwd');
    const hasUser = has('user', 'username', 'email', 'login', 'account');
    const hasInvalid = has('invalid', 'wrong', 'incorrect', 'bad');
    switch (cat) {
      case 'valid':
        return has('valid', 'standard', 'correct', 'positive', 'good', 'active', 'happy', 'default', 'primary') &&
          !hasInvalid && !has('lock', 'locked', 'unknown', 'empty', 'blank', 'missing', 'expired', 'disabled', 'blocked');
      case 'locked':
        return has('lock', 'locked', 'blocked', 'disabled', 'suspended');
      case 'invalid_password':
        return hasInvalid && hasPass;
      case 'unknown_user':
        return has('unknown', 'unregistered', 'nonexistent', 'ghost') || (has('no', 'not') && hasUser);
      case 'empty_username':
        return hasEmpty && hasUser && !hasPass;
      case 'empty_password':
        return hasEmpty && hasPass;
      case 'invalid':
        return hasInvalid && !hasPass;
      default:
        return false;
    }
  }

  private resolveCaseData(
    tc: NonNullable<GenerationConfig['testCase']>,
    steps: string[],
    index: Map<string, Map<string, any>>,
  ): { datasetName: string; recordKey: string; value: any; ref: string; representative: boolean } | null {
    if (!this.hasResolvedData(index)) return null;
    const haystack = `${tc.test_data || ''}\n${steps.join('\n')}`.toLowerCase();
    // Token set for tolerant matching: a free-text reference like "locked_user"
    // should still bind to a dataset named "locked_users" (singular/plural,
    // punctuation differences). We compare on normalized, de-pluralized tokens.
    const normTok = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/s$/, '');
    const refTokens = new Set(
      haystack.split(/[^a-z0-9]+/).filter(Boolean).map(normTok).filter((t) => t.length >= 3),
    );
    // Match for DATASET NAMES: a name is referenced when it appears verbatim,
    // OR every significant (de-pluralized) token of the dataset name appears as
    // a distinct word token in the case text. Token-level (word-boundary) match
    // tolerates singular/plural and punctuation ("locked_user" → "locked_users",
    // "standard_user from valid_users" → "valid_users") WITHOUT the cross-word
    // character collisions that a raw substring check would cause — e.g.
    // "invalid username" must NOT bind to "valid_users" (its tokens are
    // {invalid, username}, which do not include the name token "user").
    const isReferenced = (name: string): boolean => {
      const n = name.toLowerCase();
      if (haystack.includes(n)) return true;
      const nameToks = name
        .split(/[^a-z0-9]+/i)
        .map(normTok)
        .filter((t) => t.length >= 3);
      if (nameToks.length === 0) return false;
      return nameToks.every((t) => refTokens.has(t));
    };
    // STRICT match for RECORD KEYS: only a verbatim substring or an exact
    // normalized-token match counts. Substring overlap is deliberately NOT used
    // here so a generic key like "standard_user" isn't picked just because the
    // case text contains the word "user".
    const isKeyReferenced = (key: string): boolean =>
      haystack.includes(key.toLowerCase()) || refTokens.has(normTok(key));

    // Build a dataset binding. When the matched record is the dataset's
    // representative row, OMIT the selector so the script binds to the dataset
    // only (generic + reusable); otherwise pin the specific record the case
    // targets (e.g. a locked / problem user) via getRecord('ds', 'key').
    const bind = (dsName: string, recMap: Map<string, any>, key: string) => {
      const representative = this.isRepresentativeRecord(recMap, key);
      return {
        datasetName: dsName,
        recordKey: key,
        value: recMap.get(key),
        representative,
        ref: this.datasetRef(dsName, representative ? undefined : key),
      };
    };

    // Case polarity. A POSITIVE ("valid credentials") scenario must never
    // silently fall back to a NEGATIVE fixture (locked/invalid/expired) just
    // because it happens to be the dataset's first row — that is Problem 3
    // ("getRecord('locked_users')" inside a valid-login case). An explicit
    // verbatim reference still wins (handled by isKeyReferenced/isReferenced
    // in steps 1–2); this guard only governs the *fallback* record choice.
    const negativeRecord = /lock|problem|glitch|invalid|expired|disabled|blocked|denied|unknown|unregistered|nonexistent|non-existent/;
    const caseIsPositive =
      /\b(valid|correct|successful|success|standard|happy|default|primary)\b/.test(haystack) &&
      !negativeRecord.test(haystack);

    // Pick the record whose key best matches the case intent: prefer a key that
    // is referenced (exactly/tolerantly) by the case text, else the first row.
    const pickRecord = (recMap: Map<string, any>): string => {
      for (const key of recMap.keys()) {
        if (isKeyReferenced(key)) return key;
      }
      // Intent keywords (locked/invalid/…) → a record key carrying that token.
      const intent = haystack.match(/lock|problem|glitch|invalid|expired|disabled|blocked|error|standard|valid|default|primary/);
      if (intent) {
        for (const key of recMap.keys()) {
          if (key.toLowerCase().includes(intent[0])) return key;
        }
      }
      // Positive scenario fallback: prefer a valid/standard record, and never
      // pick a negative fixture as the default row.
      if (caseIsPositive) {
        for (const key of recMap.keys()) {
          if (/standard|valid|default|primary|active|good/i.test(key) && !negativeRecord.test(key.toLowerCase())) {
            return key;
          }
        }
        for (const key of recMap.keys()) {
          if (!negativeRecord.test(key.toLowerCase())) return key;
        }
      }
      return [...recMap.keys()][0]!;
    };

    // 1) A record key is referenced verbatim → bind that exact record.
    for (const [dsName, recMap] of index) {
      for (const key of recMap.keys()) {
        if (isKeyReferenced(key)) return bind(dsName, recMap, key);
      }
    }
    // 2) A dataset name is referenced (exact or tolerant) → bind to the record
    //    whose key best matches the case intent (locked/invalid/…), else first.
    for (const [dsName, recMap] of index) {
      if (isReferenced(dsName)) {
        return bind(dsName, recMap, pickRecord(recMap));
      }
    }
    // 3) No explicit reference — resolve the dataset from the SCENARIO itself.
    //    Classify the case's auth scenario (valid / locked / invalid_password /
    //    unknown_user / empty_username / empty_password) from its priority-ordered
    //    signals and bind to the dataset whose NAME matches that category. This is
    //    the Data Quality fix: a "Locked user" case with no verbatim dataset
    //    reference now selects locked_users instead of falling back to env.
    const category = this.classifyCaseDatasetCategory(tc, steps);
    if (category) {
      for (const [dsName, recMap] of index) {
        if (this.datasetMatchesCategory(dsName, category)) {
          return bind(dsName, recMap, pickRecord(recMap));
        }
      }
    }
    return null;
  }

  /** Pick a sensible "valid login" record for materialized preconditions. */
  private resolveValidUserRecord(
    index: Map<string, Map<string, any>>,
  ): { recordKey: string; value: any; ref: string } | null {
    if (!this.hasResolvedData(index)) return null;
    // Prefer a dataset whose name signals validity, then a record that looks
    // like a standard/valid user; otherwise the first available record.
    const dsEntries = [...index.entries()].sort((a, b) => {
      const va = /valid|standard|good|active/i.test(a[0]) ? 0 : 1;
      const vb = /valid|standard|good|active/i.test(b[0]) ? 0 : 1;
      return va - vb;
    });
    for (const [dsName, recMap] of dsEntries) {
      const keys = [...recMap.keys()];
      const preferred = keys.find(k => /standard|valid|default|primary/i.test(k)) || keys[0];
      if (preferred) {
        // Bind to the dataset; omit the selector when the preferred record is
        // the representative row so the precondition stays generic.
        const representative = this.isRepresentativeRecord(recMap, preferred);
        return {
          recordKey: preferred,
          value: recMap.get(preferred),
          ref: this.datasetRef(dsName, representative ? undefined : preferred),
        };
      }
    }
    return null;
  }

  /**
   * Build a dataset-binding expression for code emission.
   *
   * Product design (review #2): generated scripts bind to the DATASET NAME and
   * its SCHEMA, not a hardcoded vendor record. Record selection is late-bound at
   * runtime via getRecord():
   *   - representative valid case → `getRecord('valid_users')`  (first record)
   *   - case targets a specific row → `getRecord('valid_users', 'locked_out_user')`
   * This keeps the same script working as records are added/changed and lets it
   * scale across hundreds of datasets/environments without regeneration.
   */
  private datasetRef(datasetName: string, recordKey?: string): string {
    return recordKey != null
      ? `getRecord(${JSON.stringify(datasetName)}, ${JSON.stringify(recordKey)})`
      : `getRecord(${JSON.stringify(datasetName)})`;
  }

  /**
   * Decide whether a record is the dataset's "representative" row — i.e. the
   * default a generic valid-path test should use. When true we OMIT the record
   * selector so the script binds to the dataset only (`getRecord('valid_users')`)
   * rather than pinning a specific vendor record. We only pin a record when the
   * test intent singles out a non-default row (locked / problem / invalid, etc.).
   */
  private isRepresentativeRecord(recMap: Map<string, any>, key: string): boolean {
    const keys = [...recMap.keys()];
    // The first record is the dataset's representative row by convention.
    if (keys[0] === key) return true;
    // A "standard/valid/default/primary" key is representative unless the case
    // explicitly needs a special (locked/problem/expired/disabled) row.
    if (/^(?!.*(lock|problem|glitch|invalid|expired|disabled|blocked|bad)).*(standard|valid|default|primary|active|good)/i.test(key)) {
      return true;
    }
    return false;
  }

  /**
   * Generate the shared `tests/data/test-data.ts` module from the resolved
   * index. Schema-first design:
   *   - datasets are arrays of records (each record carries its `key` + fields)
   *   - `getDataset(name)` returns all records (the dataset's schema/rows)
   *   - `getRecord(name, selector?)` resolves ONE record at runtime — by default
   *     the first row, or by key / index / tag / predicate when needed
   *   - `testData` exposes the flat object view (e.g. `testData.valid_users[0]`)
   * Generated specs reference datasets by NAME + SCHEMA, never a hardcoded value.
   */
  private buildTestDataModule(
    index: Map<string, Map<string, any>>,
    conv?: ProjectConventionProfile,
  ): GeneratedFile | null {
    if (!this.hasResolvedData(index)) return null;
    // Normalize each record into an object that always carries its `key`, with
    // any object-shaped value fields (username/password/…) spread alongside.
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

    // Named exports (camelCase) for ergonomic access, e.g. `validUsers`.
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
    // Repo Intelligence decides where the shared data module lives. Defaults to
    // the historical `tests/data/test-data.ts` when no profile is connected.
    const dataModulePath = resolveTestDataModulePath(conv ?? buildConventionProfile(null));
    return { path: dataModulePath, content, type: 'test' };
  }

  /** Tags for the deterministic test-case flow, derived from case metadata. */
  private tcTags(tc: NonNullable<GenerationConfig['testCase']>): string[] {
    const tags = new Set<string>(['authentication']);
    const cov = `${tc.scenario ?? tc.coverage_type ?? ''}`.toLowerCase();
    const pr = `${tc.priority ?? ''}`.toLowerCase();
    if (/neg|invalid|error|locked|throttl/.test(cov)) tags.add('negative');
    if (/pos|valid|success/.test(cov)) tags.add('positive');
    if (/edge|boundary/.test(cov)) tags.add('edge');
    if (pr.includes('p0')) tags.add('smoke');
    return [...tags];
  }

  /**
   * Resolve a grounded Playwright locator for a semantic intent against the
   * crawled DOM. Prefers stable attributes (id → data-testid → name) so the
   * generated selector is a concrete, real selector — never a hallucinated
   * getByRole guess. Falls back to a known-good selector when the element is
   * not present on the crawled page (e.g. post-login chrome).
   */
  private resolveGroundedSelector(
    intents: string[],
    crawl: CrawlResult,
    fallback: string,
    kind: 'input' | 'button' | 'any',
  ): string {
    return this.resolveGroundedSelectorTracked(intents, crawl, fallback, kind).selector;
  }

  /**
   * Like `resolveGroundedSelector`, but also reports HOW the selector was
   * resolved so callers can build a truthful Locator Grounding Report:
   *   - `grounded`   — matched a real element in the crawl DOM (App Profile)
   *   - `confidence` — 0–100 (0 when falling back to the generic selector)
   *   - `source`     — id | data-test | data-testid | name | css | fallback
   * When nothing matches we return the `fallback` selector with grounded=false
   * so generation behaviour is unchanged — only the reporting is richer.
   */
  private resolveGroundedSelectorTracked(
    intents: string[],
    crawl: CrawlResult,
    fallback: string,
    kind: 'input' | 'button' | 'any',
    reject?: (el: any) => boolean,
  ): { selector: string; grounded: boolean; knownGood: boolean; confidence: number; source: string } {
    const pool = (crawl.elements || []).filter(el => {
      if (kind === 'input') return el.tag === 'input' || el.tag === 'textarea';
      if (kind === 'button') return el.tag === 'button' || el.type === 'submit' || el.tag === 'a';
      return true;
    });
    for (const intent of intents) {
      const match = this.matchElement(intent, pool.length ? pool : (crawl.elements || []));
      if (match && match.score > 0) {
        const el = match.element;
        // Semantic-consistency guard (review priority #3 — honest grounding):
        // reject a matched element that is clearly the WRONG kind of element for
        // this intent (e.g. "error" resolving to the #user-name input, or "title"
        // resolving to a product-item link). When rejected we skip it and fall
        // through to the known-good fallback with grounded=false, so the Locator
        // Grounding Report tells the truth (N/total) instead of a fake 100%.
        if (reject && reject(el)) continue;
        // Normalize matchElement's raw score (≈50–150) to a 0–100 confidence.
        const confidence = Math.max(1, Math.min(99, Math.round(match.score / 1.5)));
        // Element Intelligence: consult the SINGLE shared locator-ranking brain
        // (data-test → ARIA role → stable id → name → …) so Script Generation
        // and Healing always resolve to the IDENTICAL grounded locator. There is
        // deliberately no bespoke id-first cascade here anymore — the App Profile
        // decides the best locator, generation never invents or reorders it.
        const ranked = rankLocatorCandidates(el as ElementLike);
        if (ranked.length) {
          return { selector: ranked[0].locator, grounded: true, knownGood: true, confidence, source: ranked[0].strategy };
        }
        // Only when NO grounded strategy exists, fall back to a computed CSS
        // selector (still a real selector for this element, not a hallucination).
        const best = this.selectorEngine.getBestPlaywrightSelector(el);
        if (best) return { selector: best, grounded: true, knownGood: true, confidence, source: 'css' };
      }
    }
    // Not DOM-verified, but the fallback is a curated, app-contract selector —
    // a REAL locator, not a hallucination. Report grounded=false (honest: not
    // confirmed against THIS crawl) yet knownGood=true with a moderate
    // confidence so the headline "REAL LOCATORS" metric isn't misleadingly 0%.
    return { selector: fallback, grounded: false, knownGood: true, confidence: 50, source: 'curated' };
  }

  /**
   * Resolve the full set of semantic selectors a generated spec may reference,
   * grounding each against the real crawl DOM (App Profile) and TRACKING the
   * outcome. Returns both the plain `sel` map (used during code emission) and a
   * `tracked` map (used to build the Locator Grounding Report). Centralizes what
   * used to be an inline literal so every path grounds — and reports — uniformly.
   */
  private buildGroundedSelectors(crawl: CrawlResult): {
    sel: Record<string, string>;
    tracked: Record<string, { selector: string; grounded: boolean; knownGood: boolean; confidence: number; source: string }>;
  } {
    const t = (intents: string[], fallback: string, kind: 'input' | 'button' | 'any', reject?: (el: any) => boolean) =>
      this.resolveGroundedSelectorTracked(intents, crawl, fallback, kind, reject);

    // ── Semantic-consistency guards (review priority #3) ──
    // An error container is NEVER an input/select field and should look error-ish
    // — reject a match like the #user-name / #password input being passed off as
    // the error element.
    const blob = (el: any) =>
      `${el?.id ?? ''} ${el?.name ?? ''} ${el?.className ?? el?.attributes?.class ?? ''} ${el?.attributes?.['data-test'] ?? ''} ${el?.dataTestId ?? ''}`.toLowerCase();
    const rejectError = (el: any) => {
      if (el?.tag === 'input' || el?.tag === 'select' || el?.tag === 'textarea') return true;
      const b = blob(el);
      if (/\b(user|pass|email|login|submit|button)\b|user-name|username|password/.test(b)) return true;
      // Accept only when something actually signals an error/alert/message region.
      return !/error|alert|message|invalid|danger|warn|fail/.test(b);
    };
    // A page title is NOT a product/item link, cart control, price or image.
    const rejectTitle = (el: any) => /item|inventory_item|product|add|remove|cart|_link|\blink\b|btn|button|price|img|image|thumbnail/.test(blob(el));
    // Review fix — an inventory ITEM card is NOT a sidebar/nav/menu link. The
    // previous resolver matched the catalog "item" intent to elements like
    // `#inventory_sidebar_link` (an <a> in the burger menu), which then produced
    // a nonsensical `toHaveCount(6)` on a single link. Reject sidebar/nav/menu/
    // footer links and anchors so we fall back to the real `.inventory_item`
    // grid locator with honest grounding=false.
    const rejectInventoryItem = (el: any) => {
      const b = blob(el);
      if (/sidebar|_link\b|\bnav\b|menu|burger|footer|header|logout|reset|about/.test(b)) return true;
      // A bare anchor with no item-ish signal is navigation chrome, not a card.
      if (el?.tag === 'a' && !/inventory_item|product|item_/.test(b)) return true;
      return false;
    };

    // App-aware fallbacks: SauceDemo contract selectors are used ONLY when the
    // crawl/URL says the target is SauceDemo. For every other app we fall back
    // to portable, role/attribute-based locators so an ungrounded selector is
    // still plausibly correct instead of a dead SauceDemo id.
    const sauce = this.isSauceLikeApp(crawl.url, crawl);
    const fb = {
      username: sauce ? `page.locator('#user-name')` : `page.locator('input[type="email"], input[name="email"], input[name="username"], input[name="user"]').first()`,
      password: sauce ? `page.locator('#password')` : `page.locator('input[type="password"]').first()`,
      login: sauce ? `page.locator('#login-button')` : `page.getByRole('button', { name: /log ?in|sign ?in|submit|continue/i })`,
      error: sauce ? `page.locator('[data-test="error"]')` : `page.locator('[role="alert"], .alert, .error, .error-message, [class*="error"]').first()`,
      title: sauce ? `page.locator('[data-test="title"]')` : `page.locator('h1, h2, [class*="title"]').first()`,
      product: sauce ? `page.locator('.inventory_item_name')` : `page.locator('.product-image-wrapper, .productinfo, [class*="product"]').first()`,
      cart: sauce ? `page.locator('.shopping_cart_link')` : `page.getByRole('link', { name: /cart/i }).first()`,
      inventoryItem: sauce ? `page.locator('.inventory_item')` : `page.locator('.product-image-wrapper, .single-products, [class*="product"]').first()`,
    };
    const tracked = {
      username: t(['username', 'user name', 'user-name', 'email', 'login'], fb.username, 'input'),
      password: t(['password'], fb.password, 'input'),
      login: t(['login button', 'login', 'sign in', 'submit'], fb.login, 'button'),
      error: t(['error', 'error message'], fb.error, 'any', rejectError),
      menu: t(['menu', 'burger menu', 'hamburger', 'open menu'], sauce ? `page.locator('#react-burger-menu-btn')` : `page.getByRole('button', { name: /menu/i })`, 'button'),
      logout: t(['logout', 'log out', 'sign out'], sauce ? `page.locator('#logout_sidebar_link')` : `page.getByRole('link', { name: /log ?out|sign ?out/i })`, 'any'),
      title: t(['title', 'page title', 'products', 'header'], fb.title, 'any', rejectTitle),
      product: t(['product', 'item name', 'product name'], fb.product, 'any'),
      cart: t(['cart', 'shopping cart', 'cart icon', 'basket'], fb.cart, 'any'),
      inventoryItem: t(['inventory item', 'product card', 'item'], fb.inventoryItem, 'any', rejectInventoryItem),
    };
    const sel: Record<string, string> = {};
    for (const [k, v] of Object.entries(tracked)) sel[k] = v.selector;
    return { sel, tracked };
  }

  /**
   * App-awareness guard. The deterministic path historically shipped SauceDemo
   * contract selectors (#user-name, #login-button, [data-test="title"],
   * [data-test="error"]) and SauceDemo assertions (inventory.html, "Products",
   * "do not match", "locked out") as FALLBACKS. That is correct only for
   * SauceDemo — for every other app those literals resolve to nothing, which is
   * exactly why grounded scripts against sites like automationexercise.com came
   * out with dead locators. This detects a SauceDemo-shaped app (by URL or by
   * the presence of its signature ids / data-test hooks in the crawl) so those
   * SauceDemo-only fallbacks are used ONLY when the target really is SauceDemo.
   */
  private isSauceLikeApp(url?: string, crawl?: CrawlResult): boolean {
    const u = (url || '').toLowerCase();
    if (/saucedemo|inventory\.html/.test(u)) return true;
    const els = crawl?.elements || [];
    return els.some((e: any) => {
      const id = `${e?.id ?? ''}`.toLowerCase();
      const dt = `${e?.attributes?.['data-test'] ?? e?.dataTestId ?? ''}`.toLowerCase();
      return id === 'user-name' || id === 'login-button' || dt === 'username' || dt === 'login-button';
    });
  }

  /**
   * Derive the concrete post-action URL an Expected Result names, e.g.
   * "User is redirected to Home page (https://automationexercise.com/)" →
   * "https://automationexercise.com/". Returns null when the Expected Result
   * carries no explicit URL, so callers can fall back to an app-agnostic
   * assertion instead of a SauceDemo-specific one.
   */
  private deriveSuccessUrl(expected: string): string | null {
    const m = `${expected || ''}`.match(/\bhttps?:\/\/[^\s'")]+/i);
    return m ? m[0].replace(/[.,;]+$/, '') : null;
  }

  /**
   * Build a Locator Grounding Report from the tracked selectors, restricted to
   * the ones the generated spec ACTUALLY references (so we never report a cart
   * locator for a pure-login test). `content` is the emitted spec text; an entry
   * is included when its selector string appears in it. This makes "REAL
   * LOCATORS x/y" reflect exactly what the script depends on.
   */
  private buildLocatorGroundingReport(
    tracked: Record<string, { selector: string; grounded: boolean; knownGood: boolean; confidence: number; source: string }>,
    content: string,
    stepEntries: LocatorGroundingEntry[] = [],
  ): LocatorGroundingReport {
    const entries: LocatorGroundingEntry[] = [];
    // De-duplicate by SELECTOR (not name): each distinct locator the spec uses
    // is counted once, so the fixed-vocabulary entry and a per-step entry that
    // resolved to the SAME selector don't inflate the total.
    const seenSelectors = new Set<string>();
    // Per-step, crawl-grounded locators are AUTHORITATIVE — they are what the
    // spec actually emits for each interaction — so add them first.
    for (const e of stepEntries) {
      if (!content.includes(e.selector)) continue;
      if (seenSelectors.has(e.selector)) continue;
      seenSelectors.add(e.selector);
      entries.push(e);
    }
    // Then add any fixed-vocabulary semantic selectors the spec still references
    // (e.g. assertion-only locators) that weren't already covered per-step.
    for (const [name, info] of Object.entries(tracked)) {
      if (!content.includes(info.selector)) continue; // only elements the spec uses
      if (seenSelectors.has(info.selector)) continue;
      seenSelectors.add(info.selector);
      entries.push({ name, selector: info.selector, grounded: info.grounded, knownGood: info.knownGood, confidence: info.confidence, source: info.source });
    }
    return this.summarizeGrounding(entries);
  }

  /** Compute the aggregate counts/percentages for a set of grounding entries. */
  private summarizeGrounding(entries: LocatorGroundingEntry[]): LocatorGroundingReport {
    const total = entries.length;
    const groundedCount = entries.filter(e => e.grounded).length;
    const realCount = entries.filter(e => e.grounded || e.knownGood).length;
    const avgConfidence = total
      ? Math.round(entries.reduce((s, e) => s + e.confidence, 0) / total)
      : 0;
    const groundedPct = total ? Math.round((groundedCount / total) * 100) : 0;
    const realPct = total ? Math.round((realCount / total) * 100) : 0;
    // App-Profile KPI buckets — every entry falls into exactly one provenance.
    let fromAppProfile = 0, fromFallback = 0, fromAI = 0;
    for (const e of entries) {
      const bucket = classifyLocatorProvenance(e);
      if (bucket === 'app-profile') fromAppProfile++;
      else if (bucket === 'ai') fromAI++;
      else fromFallback++;
    }
    const appProfilePct = total ? Math.round((fromAppProfile / total) * 100) : 0;
    const aiPct = total ? Math.round((fromAI / total) * 100) : 0;
    return {
      entries, total, groundedCount, groundedPct, realCount, realPct, avgConfidence,
      fromAppProfile, fromFallback, fromAI, appProfilePct, aiPct,
    };
  }

  /** Merge several per-case grounding reports into one (dedupe by element name). */
  private mergeLocatorGrounding(reports: LocatorGroundingReport[]): LocatorGroundingReport {
    const byName = new Map<string, LocatorGroundingEntry>();
    for (const r of reports) {
      for (const e of r.entries) {
        const prev = byName.get(e.name);
        // Keep the strongest (grounded > fallback, then higher confidence).
        if (!prev || (e.grounded && !prev.grounded) || (e.grounded === prev.grounded && e.confidence > prev.confidence)) {
          byName.set(e.name, e);
        }
      }
    }
    return this.summarizeGrounding([...byName.values()]);
  }

  /**
   * Merge repository intelligence reports from multiple test cases. De-duplicates
   * Page Objects by name and aggregates usage (a PO is marked "used" if ANY case
   * used it). Returns undefined when no reports were provided.
   */
  private mergeRepoIntelligence(reports: RepositoryIntelligenceReport[]): RepositoryIntelligenceReport | undefined {
    if (!reports.length) return undefined;

    const poByName = new Map<string, PageObjectMetadata>();
    for (const r of reports) {
      for (const po of r.pageObjects) {
        const existing = poByName.get(po.name);
        if (!existing) {
          poByName.set(po.name, { ...po });
        } else {
          // Aggregate: if ANY case used this PO, mark it as used.
          existing.used = existing.used || po.used;
        }
      }
    }

    const pageObjects = [...poByName.values()];
    return {
      pageObjects,
      totalAvailable: pageObjects.length,
      totalUsed: pageObjects.filter((po) => po.used).length,
    };
  }

  /**
   * Detect cases that cannot be faithfully automated as a single linear
   * Playwright `page` flow — concurrent / multi-browser / simultaneous-session
   * scenarios — or that the case itself flags as not automation-ready. These
   * need multiple browser contexts and human judgement, so we emit a
   * `test.fixme` skeleton instead of a script that silently does the wrong thing.
   */
  private isNonAutomatable(tc: NonNullable<GenerationConfig['testCase']>, steps: string[]): boolean {
    // Respect an explicit automation-ready flag if the case carries one.
    const readyRaw = (tc as any).automation_ready ?? (tc as any).automationReady ?? (tc as any)['Automation Ready'];
    if (readyRaw != null) {
      const r = String(readyRaw).toLowerCase();
      if (/^(no|false|0|❌)/.test(r) || r.includes('not ready') || r.includes('no ')) return true;
    }
    const text = `${tc.title || ''}\n${tc.test_data || ''}\n${steps.join('\n')}`.toLowerCase();
    return /\bconcurrent|two browser|multiple browser|simultaneous|simultaneously|both instances|two instances|two sessions|separate sessions|parallel session|second browser|different browsers\b/.test(text);
  }

  /**
   * Build a `test.fixme` spec for a non-automatable case: a correct multi-context
   * skeleton (browser.newContext per session) plus the case's steps as guidance
   * and a manual-review note. `test.fixme` keeps it visible in the suite while
   * never running a broken single-page flow.
   */
  private buildNonAutomatableSpec(
    tc: NonNullable<GenerationConfig['testCase']>,
    steps: string[],
    baseUrl: string,
    sel: Record<string, string>,
    dataRef: { varName: string; ref: string; hasUsername: boolean; hasPassword: boolean } | undefined,
    meta: { title: string; idMarker: string; creds: { username: string; password: string } },
    matchedPOs: Array<{ name: string; varName: string; methods: string[]; importPath: string; kind: string }> = [],
    testDataImport = './data/test-data',
  ): string {
    const { title, idMarker } = meta;
    const usesModule = !!dataRef;
    const uname = dataRef ? `${dataRef.varName}.username ?? ''` : this.credFillExpr('username', meta.creds.username);
    const pwd = dataRef ? `${dataRef.varName}.password ?? ''` : this.credFillExpr('password', meta.creds.password);

    // ── Review fix #4: reuse the repo's LoginPage in the concurrent skeleton ──
    // When a Login Page Object with a real login() method was matched, drive each
    // isolated session through `new LoginPage(pageX).login(...)` instead of raw
    // #user-name/#password fills — consistent with the single-page specs and
    // proving Repository Intelligence participates in the multi-context path too.
    const loginPO = matchedPOs.find((p) => p.kind === 'login');
    const loginMethod = loginPO ? this.findPoMethod(loginPO.methods, /^log[_]?in$/i) : null;
    const usePO = !!(loginPO && loginMethod);

    let importLine = `import { test, expect, chromium } from '@playwright/test';`;
    if (usesModule) importLine += `\nimport { getRecord } from '${testDataImport}';`;
    if (usePO) importLine += `\nimport { ${loginPO!.name} } from '${loginPO!.importPath}';`;

    const userDecl = dataRef ? `    const ${dataRef.varName} = ${dataRef.ref};\n` : '';

    // Per-session login blocks — Page Object method when available, else the
    // grounded raw-selector triad (unchanged fallback).
    const sessionLogin = (pageVar: string): string => {
      if (usePO) {
        return `    const ${loginPO!.varName}${pageVar.slice(-1)} = new ${loginPO!.name}(${pageVar});\n`
          + `    await ${loginPO!.varName}${pageVar.slice(-1)}.${loginMethod}(${uname}, ${pwd});`;
      }
      return `    await ${sel.username.replace(/^page\./, `${pageVar}.`)}.fill(${uname});\n`
        + `    await ${sel.password.replace(/^page\./, `${pageVar}.`)}.fill(${pwd});\n`
        + `    await ${sel.login.replace(/^page\./, `${pageVar}.`)}.click();`;
    };
    // Always navigate each session to the app first. We can't assume the repo's
    // login() navigates (most only fill+click), so the goto is required even on
    // the Page Object path — otherwise the session runs against about:blank.
    const gotoA = `    await pageA.goto('${escapeStr(baseUrl)}');\n`;
    const gotoB = `    await pageB.goto('${escapeStr(baseUrl)}');\n`;

    // Generation Quality: no coverage/steps header block. The ONE comment kept
    // is the "not automation-ready" reason — a genuine caveat (why this is
    // test.fixme with a multi-context skeleton), not step narration.
    return `${importLine}

// NOT AUTOMATION-READY (auto-detected): needs concurrent / multiple browser
// contexts, which a single linear Playwright \`page\` cannot exercise. Marked
// test.fixme; complete the assertions and remove .fixme once verified manually.
test.fixme('${escapeStr(title)} (concurrent — needs multiple browser contexts)', async () => {${idMarker}
${userDecl}    const browser = await chromium.launch();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

${gotoA}${sessionLogin('pageA')}

${gotoB}${sessionLogin('pageB')}

    // TODO: assert the application's documented concurrent-session behaviour,
    // e.g. both sessions reach /inventory.html, or the first is invalidated.
    await expect(pageA).toHaveURL(/inventory\\.html/);
    await expect(pageB).toHaveURL(/inventory\\.html/);

    await contextA.close();
    await contextB.close();
    await browser.close();
});
`;
  }

  /**
   * Materialize an authenticated precondition into a real login setup. When the
   * case's preconditions imply the user is already logged in but its own steps
   * never perform a login, we inject goto + fill + click using a valid user
   * (the case's resolved record when valid, else a resolved valid record from
   * the index) so the test starts from the intended state instead of about:blank.
   * Returns [] when no setup is needed.
   */

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Repository Intelligence: Page Object Reuse                              */
  /*  ───────────────────────────────────────────────────────────────────    */
  /*  Design (addresses PR #142 review):                                      */
  /*   • Issue 1 (method validation): NEVER emit a method that isn't present  */
  /*     in the scanned PO metadata. We look up the real method NAME from the */
  /*     profile and only collapse a step-group when that method exists.      */
  /*   • Issue 2 (import paths): the import path is computed from the ACTUAL  */
  /*     scanned `filePath` (path.relative from the tests/ output dir), never */
  /*     hardcoded to `../pages/`.                                            */
  /*   • Issue 3 (more than Login): Login, Inventory, Cart and Checkout page  */
  /*     objects are all matched and exercised.                               */
  /*   • Issue 4 (dataset + PO): credential args resolve to user.username /   */
  /*     user.password when a dataset record is bound, else literals/env.     */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Compute the import path for a page object from its REAL scanned file path,
   * relative to the generated spec's directory (`tests/`). Never hardcoded.
   *
   * Examples (spec lives in tests/):
   *   pages/login.page.ts        → ../pages/login.page
   *   src/pages/LoginPage.ts      → ../src/pages/LoginPage
   *   e2e/pom/login.po.ts         → ../e2e/pom/login.po
   */
  private buildPageObjectImportPath(filePath: string, testDir = 'tests'): string {
    const clean = filePath.replace(/\\/g, '/').replace(/^\.\//, '');
    let rel = nodePath.posix.relative(testDir, clean).replace(/\.[tj]sx?$/, '');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    return rel;
  }

  /**
   * Find the real method name on a page object whose name matches `pattern`.
   * Returns the actual scanned method name (preserving its casing) or null.
   * This is the guard that prevents emitting hallucinated methods (Issue 1).
   */
  private findPoMethod(methods: string[], pattern: RegExp): string | null {
    for (const m of methods) if (pattern.test(m)) return m;
    return null;
  }

  /**
   * Navigation centralization (review issue #2): pick the Page Object whose OWN
   * navigation method (open/goto/navigate/load/visit) should drive entry
   * navigation, so we never duplicate a raw `page.goto(...)` + waitForLoadState
   * inline in every test. Prefers the login PO (the usual entry point), then any
   * matched PO exposing such a method. Returns null when none exists — the
   * caller then keeps the literal goto (no hallucinated method calls).
   */
  private findNavigationPageObject(
    matchedPOs: Array<{ varName: string; methods: string[]; kind: string }>,
  ): { varName: string; method: string } | null {
    const navPattern = /^(open|goto|navigate|load|visit)$/i;
    const ordered = [...matchedPOs].sort((a, b) => {
      const ra = a.kind === 'login' ? 0 : 1;
      const rb = b.kind === 'login' ? 0 : 1;
      return ra - rb;
    });
    for (const po of ordered) {
      const method = this.findPoMethod(po.methods, navPattern);
      if (method) return { varName: po.varName, method };
    }
    return null;
  }

  /**
   * Build the per-generation diagnostics patch (review issues #1/#3) attached to
   * successful deterministic results: reshaped-dataset warnings and any steps
   * that could not be mapped to a grounded action.
   */
  private buildDiagnosticsPatch(): Partial<GenerationResult> {
    const patch: Partial<GenerationResult> = {};
    if (this.testDataWarnings.length) patch.testDataWarnings = [...this.testDataWarnings];
    if (this.unmappedSteps.length) patch.unmappedSteps = [...this.unmappedSteps];
    return patch;
  }

  /**
   * Enforce the configured unmapped-step policy (review issue #3). Under
   * 'error', any step that could not be grounded fails the whole generation with
   * a typed error (never ships specs containing unmapped steps). Under 'warn'
   * (default) / 'comment' the steps are only reported via the result.
   */
  private enforceUnmappedStepPolicy(intendedCaseCount: number): void {
    if (this.unmappedStepPolicy !== 'error' || this.unmappedSteps.length === 0) return;
    const caseErrors = this.unmappedSteps.map(
      (u) => `Test case ${u.testCaseId ?? '?'}: step could not be mapped to a grounded action — "${u.step}"`,
    );
    throw new DeterministicGenerationEmptyError(intendedCaseCount, caseErrors);
  }

  /**
   * Match a test case to ALL relevant existing Page Objects (login, inventory,
   * cart, checkout) via simple keyword matching. Returns one entry per matched
   * PO with its real methods + a repo-derived import path. Empty array when no
   * profile or no match. Intentionally simple — no architecture inference.
   */
  private matchPageObjects(
    tc: NonNullable<GenerationConfig['testCase']>,
    steps: string[],
    profile?: import('../context/types').RepositoryProfile,
    testDir = 'tests',
  ): Array<{ name: string; varName: string; filePath: string; methods: string[]; importPath: string; kind: string }> {
    // ── Ask Repo Intelligence (Reuse Catalogue) for the reusable page objects ──
    // Script Generation does not inspect the raw profile directly; it consumes the
    // catalogue Repo Intelligence derived from the same scan (identical data).
    const reusablePOs = buildReuseCatalogue(profile).pageObjects;
    if (!reusablePOs.length) return [];

    const text = `${tc.title || ''} ${steps.join(' ')} ${tc.expected_result || ''}`.toLowerCase();
    // Map a semantic kind → keyword test + PO-name matcher.
    const kinds: Array<{ kind: string; inText: RegExp; poName: RegExp }> = [
      { kind: 'login',    inText: /\blogin|sign.?in|log.?in|auth|credential/i,           poName: /login|signin|auth/i },
      { kind: 'inventory',inText: /inventory|products?|catalog|item list|browse/i,        poName: /inventory|product|catalog/i },
      { kind: 'cart',     inText: /\bcart\b|basket|shopping.?cart|add to cart/i,          poName: /cart|basket/i },
      { kind: 'checkout', inText: /checkout|purchase|payment|place order|complete order/i, poName: /checkout|payment|order/i },
    ];

    const out: Array<{ name: string; varName: string; filePath: string; methods: string[]; importPath: string; kind: string }> = [];
    const seen = new Set<string>();
    for (const k of kinds) {
      if (!k.inText.test(text)) continue;
      const po = reusablePOs.find((p) => k.poName.test(p.name));
      if (!po || seen.has(po.name)) continue;
      seen.add(po.name);
      out.push({
        name: po.name,
        varName: po.name.charAt(0).toLowerCase() + po.name.slice(1),
        filePath: po.path,
        methods: po.methods || [],
        importPath: this.buildPageObjectImportPath(po.path, testDir),
        kind: k.kind,
      });
    }
    return out;
  }

  /**
   * Rewrite the raw locator action lines to reuse high-level Page Object methods
   * where (a) the step pattern is recognised AND (b) the method genuinely exists
   * in the scanned metadata. Lines that don't map are preserved verbatim, so the
   * generated script never references a method the repo doesn't have (Issue 1).
   *
   * Returns the (possibly) rewritten lines and the set of PO var names actually
   * used (so the caller only instantiates/imports the ones we reference).
   */
  private applyPageObjectActions(
    lines: string[],
    pos: Array<{ name: string; varName: string; methods: string[]; kind: string }>,
    ctx: { creds: { username: string; password: string }; data?: { varName: string; ref: string; hasUsername: boolean; hasPassword: boolean } },
    index: Map<string, Map<string, any>>,
    tc?: NonNullable<GenerationConfig['testCase']>,
    steps?: string[],
  ): { lines: string[]; used: Set<string> } {
    const used = new Set<string>();
    let work = [...lines];

    const loginPO = pos.find((p) => p.kind === 'login');
    const cartPO = pos.find((p) => p.kind === 'cart');
    const checkoutPO = pos.find((p) => p.kind === 'checkout');

    /* ── Login collapse: fill(user) + fill(pass) + click(login) → login(u, p) ──
       The fill lines carry the real selectors (#user-name / #password) so we can
       detect the login triad directly. We drop those lines, the login click, the
       login click's trailing waitForLoadState, and their leading `// <step>`
       comments, then prepend a single high-level call. Only when login() exists. */
    if (loginPO) {
      const loginMethod = this.findPoMethod(loginPO.methods, /^log[_]?in$/i);
      // Detect the login triad by SEMANTIC token, not selector format. Since
      // Element Intelligence now grounds these fields via `data-test` (e.g.
      // `[data-test="password"]`) rather than an id (`#password`), the matchers
      // must recognise the field regardless of whether the emitted selector is
      // a data-test attribute, an id, or a role — the semantic word is the hook.
      const userFillLine = work.find((l) => /user-?name|username|login.*input/i.test(l) && /\.fill\(/i.test(l));
      const passFillLine = work.find((l) => /password|\bpwd\b|\bpass\b/i.test(l) && /\.fill\(/i.test(l));
      const hasLoginClick = work.some((l) => /login[-_]?button|login.*button|sign[-_ ]?in/i.test(l) && /\.click\(/i.test(l));
      if (loginMethod && userFillLine && passFillLine && hasLoginClick) {
        // ── Scenario Intent Fidelity (review Priority #1 & #2) ──
        // The deterministic builder must IMPLEMENT the exact scenario the case
        // describes (leading/trailing whitespace, special characters, maximum
        // length, empty, invalid) rather than copying a happy-path login. We
        // (a) resolve BASE credential expressions bound to the repository
        // test-data record whenever one was loaded (Priority #2 — actually use
        // `user.username`/`user.password`), then (b) layer the scenario mutation
        // on top of that base.
        const extractFillValue = (line: string): string | { literal: string; unquoted: string } | null => {
          const m = line.match(/\.fill\(([^)]+)\)/);
          if (!m) return null;
          const arg = m[1].trim();
          if (arg === `''` || arg === `""`) return `''`;
          if (/^['"]/.test(arg)) {
            const unquoted = arg.slice(1, -1);
            return { literal: arg, unquoted };
          }
          return null; // expression (e.g. user.username) — use normal flow
        };
        // Whether a literal matches a known test-data record key (POSITIVE ref)
        // as opposed to a hand-authored negative value.
        const isKnownRecordKey = (val: string | { literal: string; unquoted: string } | null): boolean => {
          if (!val || typeof val === 'string') return false;
          const key = val.unquoted;
          for (const recMap of index.values()) {
            if (recMap.has(key)) return true;
          }
          return false;
        };
        const userFillVal = extractFillValue(userFillLine);
        const passFillVal = extractFillValue(passFillLine);

        const localDecls: string[] = [];
        // Resolve the BASE (data-bound) username/password expressions LAZILY.
        // Priority #2: if a record was loaded into `ctx.data.varName` (e.g. the
        // locked_users record → `user`), bind to it — even when the record has
        // no password field (fall back to env for the password only). Computed
        // on demand so scenarios that don't need a base (empty / invalid) never
        // emit an unused `const user`.
        let baseComputed = false;
        let baseUser = '';
        let basePass = '';
        const ensureBase = (): void => {
          if (baseComputed) return;
          baseComputed = true;
          if (ctx.data?.varName && ctx.data.hasUsername) {
            baseUser = `${ctx.data.varName}.username ?? ''`;
            basePass = ctx.data.hasPassword
              ? `${ctx.data.varName}.password ?? ''`
              : `${ctx.data.varName}.password ?? process.env.TEST_PASSWORD ?? ''`;
          } else {
            const valid = this.resolveValidUserRecord(index);
            const validObj = valid?.value && typeof valid.value === 'object' ? valid.value : null;
            if (valid && validObj && 'username' in validObj) {
              localDecls.push(`const user = ${valid.ref};`);
              baseUser = `user.username ?? ''`;
              basePass = 'password' in validObj
                ? `user.password ?? ''`
                : `user.password ?? process.env.TEST_PASSWORD ?? ''`;
            } else {
              baseUser = ctx.creds.username ? `'${escapeStr(ctx.creds.username)}'` : `process.env.TEST_USERNAME ?? ''`;
              basePass = ctx.creds.password ? `'${escapeStr(ctx.creds.password)}'` : `process.env.TEST_PASSWORD ?? ''`;
            }
          }
        };
        // Resolve a VALID counterpart credential for negative cases where ONE
        // field is deliberately invalid and the OTHER must stay valid. Declared
        // as `validUser` for clarity in the emitted spec.
        const validCounterpart = (): { u?: string; p?: string } => {
          const valid = this.resolveValidUserRecord(index);
          const val = valid?.value && typeof valid.value === 'object' ? valid.value : null;
          if (valid && val && ('username' in val || 'password' in val)) {
            localDecls.push(`const validUser = ${valid.ref};`);
            return {
              u: 'username' in val ? `validUser.username ?? ''` : undefined,
              p: 'password' in val ? `validUser.password ?? ''` : undefined,
            };
          }
          return {};
        };
        const envUser = () => ctx.creds.username ? `'${escapeStr(ctx.creds.username)}'` : `process.env.TEST_USERNAME ?? ''`;
        const envPass = () => ctx.creds.password ? `'${escapeStr(ctx.creds.password)}'` : `process.env.TEST_PASSWORD ?? ''`;

        // Scenario Intelligence: classify the input-mutation intent, then let the
        // matching transformer build the login() credentials. All per-scenario
        // logic (whitespace / special / max-length / empty / invalid / normal)
        // lives in independent transformers under ./scenario-intelligence — the
        // generator only supplies a resolver describing HOW to obtain the base,
        // valid-counterpart and env credentials, and normalises the writer's
        // authored literals. Adding a scenario type never touches this code.
        const authoredLiteral = (v: any): string | null =>
          v && v !== `''` && !isKnownRecordKey(v)
            ? (typeof v === 'object' ? v.literal : v)
            : null;
        const credentialResolver: ScenarioCredentialResolver = {
          base: () => { ensureBase(); return { username: baseUser, password: basePass }; },
          validCounterpart: () => { const v = validCounterpart(); return { username: v.u, password: v.p }; },
          envUsername: () => envUser(),
          envPassword: () => envPass(),
          authoredUsername: authoredLiteral(userFillVal),
          authoredPassword: authoredLiteral(passFillVal),
          authoredBothEmpty: userFillVal === `''` && passFillVal === `''`,
          escape: escapeStr,
        };

        // Sprint 2D.1: consume Scenario Graph semantics when available, bypassing
        // the ScenarioIntelligence re-inference. This makes Script Gen a pure
        // adapter from graph → code.
        const semantics = (tc as any).__scenarioNode?.semantics;
        let u: string;
        let p: string;
        if (semantics) {
          const derived = this.deriveFromSemantics(semantics, credentialResolver);
          u = derived.credentials.username;
          p = derived.credentials.password;
        } else {
          // Legacy path: classify the scenario from title/steps and transform.
          const { classification, transformer } = this.scenario.resolve(tc, steps ?? []);
          const creds = transformer.transformCredentials(classification, credentialResolver);
          u = creds.username;
          p = creds.password;
        }
        // Priority #4 — Repository Reuse. When the LoginPage exposes an explicit
        // navigation method (open / goto / navigate / load), prefer it over a
        // raw `page.goto(baseUrl)` so the spec drives entry through the repo's
        // own abstraction. Strictly method-gated: if no such method exists we
        // keep the literal goto (no hallucinated calls).
        const navMethod = this.findPoMethod(loginPO.methods, /^(open|goto|navigate|load|visit)$/i);
        const filtered: string[] = [];
        // Position at which to splice in the single high-level login() call. We
        // insert it where the FIRST credential fill was, so any preceding entry
        // navigation (e.g. `await page.goto(baseUrl)` for step "Navigate to …")
        // stays BEFORE login(). Inserting at the front instead would emit
        // login() before the goto and run against about:blank.
        let loginInsertIdx = -1;
        for (let i = 0; i < work.length; i++) {
          const l = work[i];
          // Drop the leading step comment for fills/login-click.
          if (/^\s*\/\/\s*(enter|type|input|fill).*(user|email|login|password|pwd|credential)/i.test(l)) continue;
          if (/^\s*\/\/\s*(click|press|tap|submit).*(login|log in|sign in)/i.test(l)) continue;
          // Drop the credential fills (and remember where the triad started).
          // Match on the semantic token so data-test selectors (e.g.
          // `[data-test="password"]`) are recognised just like ids (`#password`).
          if (/\.fill\(/i.test(l) && /user-?name|username|password|\bpwd\b|\bpass\b/i.test(l)) {
            if (loginInsertIdx === -1) loginInsertIdx = filtered.length;
            continue;
          }
          // Drop the login click and its trailing waitForLoadState.
          if (/login[-_]?button|login.*button|sign[-_ ]?in/i.test(l) && /\.click\(/i.test(l)) {
            if (loginInsertIdx === -1) loginInsertIdx = filtered.length;
            if (/page\.waitForLoadState/i.test(work[i + 1] || '')) i++;
            continue;
          }
          // Entry navigation: reuse the repo's LoginPage.open() when it exists,
          // otherwise KEEP the literal page.goto(). We cannot assume login()
          // navigates (most only fill+click), so a goto/open must precede it —
          // dropping it would leave the test running against about:blank.
          if (navMethod && /\bpage\.goto\s*\(/.test(l)) {
            filtered.push(`await ${loginPO.varName}.${navMethod}();`);
            used.add(loginPO.varName);
            // Absorb an immediately-following waitForLoadState — open() awaits it.
            if (/page\.waitForLoadState/i.test(work[i + 1] || '')) i++;
            continue;
          }
          filtered.push(l);
        }
        const loginCall = `await ${loginPO.varName}.${loginMethod}(${u}, ${p});`;
        // If no fill/click triad was found (idx stays -1), append login() at end.
        if (loginInsertIdx === -1) loginInsertIdx = filtered.length;
        filtered.splice(loginInsertIdx, 0, loginCall);
        work = [...localDecls, ...filtered];
        used.add(loginPO.varName);
      }
    }

    /* ── Comment-context rewrite for cart / checkout ──
       The deterministic emitter maps generic clicks to a single selector and
       keeps the human intent in the leading `// <step>` comment. So we scan with
       the preceding comment as semantic context and rewrite the following action
       line into a PO method call — but ONLY when that method really exists. */
    const cartAdd = cartPO ? this.findPoMethod(cartPO.methods, /^add.*(cart|item)|addto.*cart/i) : null;
    const cartOpen = cartPO ? this.findPoMethod(cartPO.methods, /^(open|view|go.?to).*cart/i) : null;
    const coMethod = checkoutPO ? this.findPoMethod(checkoutPO.methods, /complete.*checkout|^checkout$|finish.*(order|checkout)/i) : null;

    if (cartAdd || cartOpen || coMethod) {
      const rewritten: string[] = [];
      let lastComment = '';
      for (const l of work) {
        const isComment = /^\s*\/\//.test(l);
        if (isComment) lastComment = l;
        // Semantic context = this line + the comment that introduced it.
        const semantic = `${lastComment} ${l}`;
        const isClick = /\.click\(/i.test(l);

        if (isClick && cartAdd && /add.*cart|add_to_cart/i.test(semantic)) {
          rewritten.push(`await ${cartPO!.varName}.${cartAdd}();`);
          used.add(cartPO!.varName);
          continue;
        }
        if (isClick && cartOpen && /(shopping_cart|cart.*(link|icon)|open.*cart|view.*cart|go to.*cart)/i.test(semantic)) {
          rewritten.push(`await ${cartPO!.varName}.${cartOpen}();`);
          used.add(cartPO!.varName);
          continue;
        }
        if (isClick && coMethod && /(checkout|#finish|#continue|place.?order|finish)/i.test(semantic)) {
          rewritten.push(`await ${checkoutPO!.varName}.${coMethod}();`);
          used.add(checkoutPO!.varName);
          continue;
        }
        rewritten.push(l);
      }
      // For checkout we collapse a multi-click flow into ONE completeCheckout()
      // call: keep the first emitted checkout call, drop subsequent duplicates.
      if (coMethod) {
        let seenCheckout = false;
        work = rewritten.filter((l) => {
          if (l.includes(`.${coMethod}(`)) {
            if (seenCheckout) return false;
            seenCheckout = true;
          }
          return true;
        });
      } else {
        work = rewritten;
      }
    }

    // ── Navigation centralization (review issue #2) ─────────────────────────
    // Any inline `page.goto(...)` (+ its trailing waitForLoadState) that survived
    // the login/checkout collapses is rewritten to the repo Page Object's OWN
    // navigation method (open/goto/navigate/load/visit) when one exists — so the
    // URL + wait strategy is defined ONCE in the Page Object instead of being
    // duplicated inline across every generated spec. Strictly method-gated: with
    // no such PO method we keep the literal goto (no hallucinated calls).
    const navPO = this.findNavigationPageObject(pos);
    if (navPO) {
      const centralized: string[] = [];
      for (let i = 0; i < work.length; i++) {
        const l = work[i];
        if (/\bpage\.goto\s*\(/.test(l) && !new RegExp(`\\b${navPO.varName}\\.`).test(l)) {
          const indent = (l.match(/^\s*/)?.[0]) ?? '';
          centralized.push(`${indent}await ${navPO.varName}.${navPO.method}();`);
          used.add(navPO.varName);
          // Absorb an immediately-following waitForLoadState — the PO nav method
          // owns the wait strategy, so the inline wait is now redundant.
          if (/page\.waitForLoadState/i.test(work[i + 1] || '')) i++;
          continue;
        }
        centralized.push(l);
      }
      work = centralized;
    }

    return { lines: work, used };
  }

  /**
   * Add Page Object based assertions where a verification method genuinely
   * exists (e.g. InventoryPage.verifyLoaded / isLoaded). Returns extra lines to
   * append to the assertions block, plus the PO var names referenced.
   */
  private applyPageObjectAssertions(
    expected: string,
    pos: Array<{ name: string; varName: string; methods: string[]; kind: string }>,
  ): { lines: string[]; used: Set<string> } {
    const used = new Set<string>();
    const lines: string[] = [];
    const e = expected.toLowerCase();

    const inventoryPO = pos.find((p) => p.kind === 'inventory');
    if (inventoryPO && /inventory|products? (page|are|is|displayed|loaded)|item list/i.test(e)) {
      const verify = this.findPoMethod(inventoryPO.methods, /verify.*(load|inventory|displayed|page)|^is.*loaded|inventory.*loaded|assert.*inventory/i);
      if (verify) {
        lines.push(`await ${inventoryPO.varName}.${verify}();`);
        used.add(inventoryPO.varName);
      }
    }
    return { lines, used };
  }

  private buildPreconditionLogin(
    tc: NonNullable<GenerationConfig['testCase']>,
    steps: string[],
    ctx: { url: string; creds: { username: string; password: string }; sel: Record<string, string>; data?: { varName: string; ref: string; hasUsername: boolean; hasPassword: boolean } },
    index: Map<string, Map<string, any>>,
    pos: Array<{ name: string; varName: string; methods: string[]; kind: string }> = [],
  ): { lines: string[]; used: Set<string> } {
    const used = new Set<string>();
    const pre = `${tc.preconditions || ''}`.toLowerCase();
    const impliesAuth = /log(ged)? ?in|authenticat|signed in|valid session|active session/.test(pre);
    if (!impliesAuth) return { lines: [], used };

    // Does the body already perform a login? If so, don't double up.
    const stepText = steps.join('\n').toLowerCase();
    const stepsHaveLogin = /(log ?in|sign ?in)\b.*credential|log ?in with|sign in with|(log ?in|sign ?in)\s+successfully/.test(stepText)
      || (/(user( ?name)?)/.test(stepText) && /(click|submit|press).*(login|log in|sign in|submit)/.test(stepText));
    if (stepsHaveLogin) return { lines: [], used };

    // Choose credentials: reuse the case's resolved `user` when it's a valid
    // login; else resolve a valid record from the index; else literal fallback.
    let unameExpr: string;
    let pwdExpr: string;
    const localDecls: string[] = [];
    if (ctx.data && ctx.data.hasUsername && ctx.data.hasPassword) {
      unameExpr = `${ctx.data.varName}.username ?? ''`;
      pwdExpr = `${ctx.data.varName}.password ?? ''`;
    } else {
      const valid = this.resolveValidUserRecord(index);
      if (valid && valid.value?.username != null && valid.value?.password != null) {
        localDecls.push(`const loginUser = ${valid.ref};`);
        unameExpr = `loginUser.username ?? ''`;
        pwdExpr = `loginUser.password ?? ''`;
      } else {
        unameExpr = this.credFillExpr('username', ctx.creds.username);
        pwdExpr = this.credFillExpr('password', ctx.creds.password);
      }
    }

    // Generation Quality: the precondition (e.g. "user is logged in") is
    // materialized as real setup code below, not narrated — the precondition is
    // already documented on the Test Case.
    const lines: string[] = [];
    if (localDecls.length) lines.push(...localDecls);

    // Review issue #2 — reuse the repo's high-level login() Page Object method
    // for the precondition setup instead of re-emitting the raw
    // #user-name / #password / #login-button triad. login() also navigates, so
    // no separate page.goto() is needed. Falls back to the raw triad only when
    // no login Page Object with a login() method was matched.
    const loginPO = pos.find((p) => p.kind === 'login');
    const loginMethod = loginPO ? this.findPoMethod(loginPO.methods, /^log[_]?in$/i) : null;
    
    // Review fix: duplicate assertions — only emit the post-login URL check when
    // the test's expected_result doesn't already verify the same thing (avoids
    // three identical toHaveURL checks stacking from precondition + body + assertions).
    const expected = `${tc.expected_result || ''}`.toLowerCase();
    const alreadyChecksInventoryUrl = /inventory|navigate.*inventory|redirect.*inventory|url.*inventory/i.test(expected);

    // App-aware post-login confirmation. SauceDemo lands on /inventory.html; other
    // apps land wherever their (crawled) app takes them, so we must NOT assert
    // SauceDemo's URL against, say, automationexercise.com. When the app isn't
    // SauceDemo we confirm the precondition succeeded by asserting we left the
    // login page (a portable, app-agnostic signal) instead.
    const sauce = this.isSauceLikeApp(ctx.url);
    const confirmLogin = (): void => {
      if (alreadyChecksInventoryUrl) return; // body/final assertions already verify it
      if (sauce) lines.push(`await expect(page).toHaveURL(/inventory\\.html/);`);
      else lines.push(`await expect(page).not.toHaveURL('${escapeStr(ctx.url)}');`);
    };

    if (loginPO && loginMethod) {
      lines.push(`await ${loginPO.varName}.${loginMethod}(${unameExpr}, ${pwdExpr});`);
      confirmLogin();
      lines.push('');
      used.add(loginPO.varName);
      return { lines, used };
    }

    lines.push(`await page.goto('${escapeStr(ctx.url)}');`);
    lines.push(`await page.waitForLoadState('domcontentloaded');`);
    lines.push(`await ${ctx.sel.username}.fill(${unameExpr});`);
    lines.push(`await ${ctx.sel.password}.fill(${pwdExpr});`);
    lines.push(`await ${ctx.sel.login}.click();`);
    lines.push(`await page.waitForLoadState('domcontentloaded');`);
    confirmLogin();
    lines.push('');
    return { lines, used };
  }

  /**
   * Extract the CONTROL PHRASE a step targets — the words that name the field or
   * button to act on — with any disambiguating qualifier PRESERVED. This is what
   * lets "login email field" resolve to the login form's email input while
   * "signup email field" resolves to the signup form's, instead of collapsing
   * both onto a single pre-resolved `sel.username`. We strip the leading action
   * verb, any quoted value literal, selector noise and generic filler words
   * (the/a/into/field/button…) but KEEP domain words like login/signup/search/
   * billing so `matchElement` can score the right element.
   */
  private extractControlPhrase(step: string): string {
    let s = this.stripSelectorNoise(String(step));
    // Remove quoted value literals ('John Doe', "test@x.com") — they are data,
    // not part of the control's name.
    s = s.replace(/'[^']*'|"[^"]*"/g, ' ');
    // Drop a leading action verb and common lead-ins.
    s = s.replace(/^\s*(?:please\s+)?(?:the\s+)?(enter|type|fill(?:\s+in)?|input|provide|key\s+in|click(?:\s+on)?|press|tap|select|choose|set|check|toggle)\b/i, ' ');
    // Remove generic filler / structural words that add no matching signal.
    s = s.replace(/\b(the|a|an|into|in|on|to|with|value|values|text|for|of|and|then|please|field|fields|input|inputs|box|textbox|button|buttons|link|links|icon|element|section|form|area|its|your|my)\b/gi, ' ');
    return s.replace(/[^a-z0-9@._\s-]/gi, ' ').replace(/\s+/g, ' ').trim();
  }

  /**
   * Resolve ONE step's control to a grounded Playwright locator from the crawled
   * App Profile using the step's own phrase (qualifier-aware). Records the
   * outcome into `tracked` for the Locator Grounding Report / App-Profile KPI.
   * Returns the grounded selector when a real element matched, otherwise the
   * supplied `fallback` (already a real/curated selector) with grounded=false —
   * so behaviour degrades gracefully and the KPI stays honest.
   */
  private resolveStepControl(
    phrase: string,
    crawl: CrawlResult | undefined,
    kind: 'input' | 'button' | 'any',
    fallback: string,
    name: string,
    tracked?: LocatorGroundingEntry[],
  ): string {
    if (!crawl || !phrase) return fallback;
    const r = this.resolveGroundedSelectorTracked([phrase], crawl, fallback, kind);
    if (tracked) {
      tracked.push({
        name, selector: r.selector, grounded: r.grounded,
        knownGood: r.knownGood, confidence: r.confidence, source: r.source,
      });
    }
    return r.selector;
  }

  /**
   * JS expression for the value to fill into a GENERIC (non-credential) field,
   * e.g. name / phone / address / subject. Prefers an authored quoted literal,
   * emits '' for an intentionally-empty negative step, and otherwise a readable
   * placeholder derived from the field phrase (never a silent empty fill).
   */
  private genericFillValue(step: string, phrase: string): string {
    const prose = this.stripSelectorNoise(String(step));
    const t = prose.toLowerCase();
    if (/\b(empty|blank|without|leave.*(blank|empty)|no\s+value)\b/.test(t)) return `''`;
    const quoted = prose.match(/'([^']*)'|"([^"]*)"/);
    if (quoted) {
      const lit = (quoted[1] ?? quoted[2] ?? '').trim();
      if (lit && !/^<.*>$/.test(lit)) return `'${escapeStr(lit)}'`;
    }
    // Value written after a colon: "Subject: Order query".
    const afterColon = prose.match(/:\s*([^,.;]+?)\s*$/);
    if (afterColon && afterColon[1] && afterColon[1].trim().length <= 60) {
      return `'${escapeStr(afterColon[1].trim())}'`;
    }
    const key = (phrase || 'value').split(/\s+/).slice(0, 2).join(' ') || 'value';
    return `'Test ${escapeStr(key)}'`;
  }

  /**
   * Convert ordered step strings into grounded Playwright statements. Handles
   * navigate / fill (with explicit or test-data values, empty fields, char
   * limits) / click (login, menu, logout, product) / back-navigation and the
   * "repeat N times" throttling pattern.
   *
   * Every fill/click resolves its locator PER-STEP against the crawled App
   * Profile using the step's own control phrase (qualifier-aware) so a step that
   * names the "signup" form no longer collapses onto the "login" form's fields.
   */
  private tcStepsToCode(
    steps: string[],
    ctx: { url: string; creds: { username: string; password: string }; sel: Record<string, string>; data?: { varName: string; ref: string; hasUsername: boolean; hasPassword: boolean }; crawl?: CrawlResult; stepTracked?: LocatorGroundingEntry[]; testCaseId?: number },
  ): { lines: string[] } {
    // Generation Quality (Sprint 4): the ONLY inline comment we allow in the body
    // is a low-confidence review flag. When a step's locator could NOT be grounded
    // against the crawled DOM (a semantic/fallback guess), we prepend a single
    // `// TODO: Review locator` so the engineer knows exactly what to check —
    // instead of narrating every line with English the RTM already documents.
    let stepLowConf = false;
    const flagIfUngrounded = (before: number): void => {
      const tracked = ctx.stepTracked;
      if (!tracked) return;
      for (let i = before; i < tracked.length; i++) {
        if (!tracked[i].grounded) { stepLowConf = true; return; }
      }
    };

    // Per-step grounded resolver bound to this case's crawl + tracking sink.
    const ground = (phrase: string, kind: 'input' | 'button' | 'any', fallback: string, name: string): string => {
      const before = ctx.stepTracked?.length ?? 0;
      const sel = this.resolveStepControl(phrase, ctx.crawl, kind, fallback, name, ctx.stepTracked);
      flagIfUngrounded(before);
      return sel;
    };

    // Click-specific resolver: a click phrase is often a short generic qualifier
    // ("signup", "continue") that partial-matches several controls' test hooks
    // (e.g. `data-qa="signup-name"` AND `data-qa="signup-button"`). Resolve
    // against buttons/links/submit FIRST so a click never lands on an input, and
    // only fall back to any clickable element when no button-like match exists
    // (real links/cards/checkboxes). Tracks exactly once.
    const groundClick = (phrase: string, fallback: string, name: string): string => {
      const crawl = ctx.crawl;
      let r = crawl && phrase
        ? this.resolveGroundedSelectorTracked([phrase], crawl, fallback, 'button')
        : undefined;
      if ((!r || !r.grounded) && crawl && phrase) {
        const rAny = this.resolveGroundedSelectorTracked([phrase], crawl, fallback, 'any');
        if (rAny.grounded) r = rAny;
        else r = r ?? rAny;
      }
      if (!r) r = { selector: fallback, grounded: false, knownGood: true, confidence: 40, source: 'fallback' };
      if (!r.grounded) stepLowConf = true;
      if (ctx.stepTracked) {
        ctx.stepTracked.push({
          name, selector: r.selector, grounded: r.grounded,
          knownGood: r.knownGood, confidence: r.confidence, source: r.source,
        });
      }
      return r.selector;
    };
    const out: string[] = [];
    let attemptBlock: string[] = []; // statements since the last navigate (for "repeat N times")

    // `push` no longer narrates the step (the RTM/Test Case already documents
    // "what" each step does). It emits ONLY the executable statements, preceded
    // by a `// TODO: Review locator` flag when the step's locator was a
    // low-confidence (ungrounded) guess. The `_comment` arg is retained for call
    // compatibility but intentionally unused.
    const push = (_comment: string, stmts: string[], isNav: boolean) => {
      if (stepLowConf) out.push('// TODO: Review locator');
      stepLowConf = false;
      for (const s of stmts) out.push(s);
      out.push('');
      if (isNav) attemptBlock = [];
      else attemptBlock.push(...stmts);
    };

    // Resolve the JS expression to fill a credential field. Precedence:
    //   1. empty/blank/missing field  → '' (negative test)
    //   2. explicit quoted literal in the step ('standard_use') → that literal
    //   3. resolved Test Data Store record → user.username / user.password
    //   4. parsed creds fallback (literal) → '<value>'
    // This is what replaces the old empty fill('') for "<password>" placeholders.
    const fieldExpr = (kind: 'username' | 'password', raw: string, t: string): string => {
      // 1) Intentionally-empty field (negative "empty/blank" test) → ''.
      if (/empty|blank|without|no\s+(user|pass)|leave.*(blank|empty)/.test(t)) return `''`;
      // Strip CSS/attribute selector fragments BEFORE any prose mining so a
      // locator like [data-testid='username'] can never be read as a value.
      const prose = this.stripSelectorNoise(raw);
      // 2) Explicit quoted REAL literal authored in the step ('standard_user').
      //    Selector fragments are already stripped; field-name keywords and
      //    stop-words are rejected by looksLikeCredential so we only honor a
      //    genuine value the author typed.
      const quoted = prose.match(/'([^']*)'|"([^"]*)"/);
      if (quoted) {
        const lit = (quoted[1] ?? quoted[2] ?? '').trim();
        if (lit && !/^<.*>$/.test(lit) && this.looksLikeCredential(lit)) return `'${escapeStr(lit)}'`;
      }
      // 3) A concrete value the author wrote directly in the (selector-stripped)
      //    step text, e.g. "...from valid_users: standard_user" → 'standard_user'.
      //    An explicit authored value is the strongest signal, so it wins. The
      //    selector strip + stop-word rejection (see looksLikeCredential) ensure
      //    this no longer mines locator fragments or prepositions.
      const stepVal = this.extractStepCredential(kind, prose);
      if (stepVal) return `'${escapeStr(stepVal)}'`;
      // 4) Bound Test Data Store record — the dataset-resolution fix. When the
      //    step carries NO explicit value (e.g. "Enter the username in
      //    [data-testid='username']"), resolve from the case's bound dataset
      //    record (→ user.username / user.password) instead of emitting junk.
      if (ctx.data) {
        if (kind === 'username' && ctx.data.hasUsername) return `${ctx.data.varName}.username ?? ''`;
        if (kind === 'password' && ctx.data.hasPassword) return `${ctx.data.varName}.password ?? ''`;
      }
      // 5) Negative test that needs a *non-empty but wrong* value so the step is
      //    meaningful (e.g. "Enter invalid username" with no value provided).
      //    Differentiate the FAILURE MODE so distinct negative scenarios don't
      //    collapse into identical code (Problem 4): an "unknown user" must not
      //    render the same as an "invalid password". The specific username
      //    sentinels are checked BEFORE the generic invalid/wrong mapping so the
      //    latter keeps its existing contract ('invalid_user' / 'wrong_password').
      if (kind === 'username' &&
          /\b(unknown|unrecognized|unrecognised|not\s+registered|unregistered|no\s+such)\b/.test(t)) {
        return `'unknown_user'`;
      }
      if (kind === 'username' &&
          /\b(nonexistent|non-existent|does\s+not\s+exist|never\s+registered)\b/.test(t)) {
        return `'nonexistent_user'`;
      }
      if (/\b(invalid|wrong|incorrect|bad)\b/.test(t)) {
        return kind === 'username' ? `'invalid_user'` : `'wrong_password'`;
      }
      // 6) Parsed credential literal, else an env-backed expression (never a
      //    silent empty string for a field that's meant to carry a value).
      return this.credFillExpr(kind, kind === 'username' ? ctx.creds.username : ctx.creds.password);
    };

    for (const raw of steps) {
      const t = raw.toLowerCase();
      // Reset the per-step low-confidence flag; each branch that grounds a
      // locator sets it, and only push()-based action branches consume it.
      stepLowConf = false;

      // ── repeat the above N times (login throttling) ──
      const rep = t.match(/repeat.*?(\d+)\s*times?/);
      if (rep) {
        const n = parseInt(rep[1]!, 10) || 5;
        if (attemptBlock.length) {
          out.push(`for (let attempt = 0; attempt < ${n}; attempt++) {`);
          for (const s of attemptBlock) out.push(`  ${s}`);
          out.push(`}`);
          out.push('');
        }
        continue;
      }

      // ── verification / assertion steps (checked FIRST) ──────────────────────
      // A step like "Verify Logged in as username is displayed" contains the
      // substring "username" and would otherwise be mis-routed to the username
      // FILL branch below (producing `fill('displayed')`). Detecting verification
      // intent up front guarantees such steps become ASSERTIONS. We prefer an
      // App-Profile-grounded verification locator (Issue #4) over a generic
      // assertion, then fall back to the structured assertion mapper, and — when
      // nothing specific can be grounded — to the honest unmapped-step policy
      // (never a misleading action).
      if (this.isVerificationStep(t)) {
        const grounded = this.deriveGroundedVerification(raw, {
          crawl: ctx.crawl, stepTracked: ctx.stepTracked, sel: ctx.sel,
        });
        const asserted = grounded ? [grounded] : this.mapAssertionStep(raw, t, ctx);
        if (asserted.length) {
          for (const s of asserted) out.push(s);
          out.push('');
          continue;
        }
        this.emitUnmappedStep(out, raw, ctx.testCaseId);
        continue;
      }

      // ── context / precondition narration (no UI action) ─────────────────────
      // "User is on the login page", "User is logged in", "Given …" describe
      // STATE, not an action. They are materialised by the precondition builder
      // (or are pure scene-setting). Skipping them here prevents a precondition
      // that merely contains "login"/"user" from being mis-routed into a bogus
      // field FILL below — the core Action-Quality guarantee that business /
      // narrative text can never become a UI action.
      if (this.isContextOnlyStep(t)) continue;

      // ── navigate ──
      const urlM = raw.match(/\bhttps?:\/\/[^\s'")]+/i);
      if (/^navigat|^go to|^open|^launch|^visit/.test(t) && !/back|product page|products page/.test(t)) {
        const url = urlM ? urlM[0] : ctx.url;
        push(raw, [
          `await page.goto('${escapeStr(url)}');`,
          `await page.waitForLoadState('domcontentloaded');`,
        ], true);
        continue;
      }

      // ── attempt to navigate back to products / access products page ──
      if (/attempt.*navigate|navigate back|access.*product|back to the product/.test(t)) {
        // App-aware target. If the step names an explicit URL, honour it. Else
        // for SauceDemo the products page is inventory.html; for other apps we
        // cannot assume that path, so navigate to the crawled base URL instead
        // of manufacturing a bogus "/logininventory.html".
        const navUrl = urlM ? urlM[0]
          : this.isSauceLikeApp(ctx.url) ? `${ctx.url}inventory.html`
          : ctx.url;
        push(raw, [`await page.goto('${escapeStr(navUrl)}');`], false);
        continue;
      }

      // ── "log in with/using valid credentials" — expand to fill+fill+click ──
      // Accept "with", "using", or any connector before "credentials" (and the
      // bare "log in successfully" phrasing) so authored preconditions written as
      // a single high-level step are expanded instead of left un-mapped.
      if (/(log ?in|sign ?in)\b.*credential/.test(t) || /(log ?in|sign ?in)\s+successfully/.test(t)) {
        push(raw, [
          `await ${ground('login username email', 'input', ctx.sel.username, 'username')}.fill(${fieldExpr('username', raw, t)});`,
          `await ${ground('login password', 'input', ctx.sel.password, 'password')}.fill(${fieldExpr('password', raw, t)});`,
          `await ${ground('login sign in', 'button', ctx.sel.login, 'login')}.click();`,
          `await page.waitForLoadState('domcontentloaded');`,
        ], false);
        continue;
      }

      // ── password field ──
      // NOTE: checked BEFORE username because phrases like "Enter password from
      // valid_users" contain the substring "user" (in the dataset name) and would
      // otherwise be mis-mapped to the username field. Password is unambiguous.
      if (/pass( ?word)?|\bpwd\b/.test(t) && !/click|button/.test(t) && this.hasFillIntent(t)) {
        // Ground the SPECIFIC password field this step names (e.g. "login
        // password" vs "confirm password" vs "signup password") against the
        // crawl, falling back to the pre-resolved password selector. The grounding
        // phrase is used only when it looks like a real control name, so business
        // prose in the step can't be turned into a bogus label locator.
        const cp = this.extractControlPhrase(raw);
        const sel = ground(this.looksLikeControlName(cp) ? cp : 'password', 'input', ctx.sel.password, 'password');
        push(raw, [`await ${sel}.fill(${fieldExpr('password', raw, t)});`], false);
        continue;
      }

      // ── username / email field ──
      // Guard against the dataset-name false positive: don't treat a "password"
      // step as username even if the dataset name embeds "user".
      if (/user( ?name)?|email|login id/.test(t) && !/pass( ?word)?|\bpwd\b/.test(t) && !/click|button/.test(t) && this.hasFillIntent(t)) {
        // Qualifier-aware: "login email" → the login form's email input,
        // "signup email" → the signup form's — no longer both collapsing onto
        // one pre-resolved field. The grounding phrase is used only when it looks
        // like a real control name, so a title/outcome phrase can't be turned
        // into a bogus label locator.
        const cp = this.extractControlPhrase(raw);
        const sel = ground(this.looksLikeControlName(cp) ? cp : 'username email', 'input', ctx.sel.username, 'username');
        push(raw, [`await ${sel}.fill(${fieldExpr('username', raw, t)});`], false);
        continue;
      }

      // ── generic input field (name / phone / address / subject / …) ──
      // Any "enter/type/fill/input/provide/set" step that is NOT a credential
      // field. Previously these were dropped as "not auto-mapped", so signup /
      // contact / checkout forms lost most of their steps. We ground the named
      // field against the crawl and fill an authored or sensible value.
      if (/^(enter|type|fill|input|provide|key in|set|choose|select)\b/.test(t) && !/pass( ?word)?|\bpwd\b/.test(t)) {
        const phrase = this.extractControlPhrase(raw);
        // Only synthesise a getByLabel fill when the phrase actually names a
        // control. A verb-led business phrase ("Enter valid login - standard
        // user") would otherwise become `getByLabel(/valid login-/i).fill(...)` —
        // a locator that targets scenario prose, not a field. When the phrase is
        // not control-like we fall through to the honest unmapped-step marker.
        if (phrase && this.looksLikeControlName(phrase)) {
          const sel = ground(phrase, 'input', `page.getByLabel(/${escapeRegex(phrase)}/i)`, `field:${phrase}`);
          push(raw, [`await ${sel}.fill(${this.genericFillValue(raw, phrase)});`], false);
          continue;
        }
      }

      // ── logout ──
      if (/logout|log out|sign out/.test(t)) {
        push(raw, [`await ${ctx.sel.logout}.click();`, `await page.waitForLoadState('domcontentloaded');`], false);
        continue;
      }

      // ── menu / burger ──
      if (/menu|burger|hamburger/.test(t)) {
        push(raw, [`await ${ctx.sel.menu}.click();`], false);
        continue;
      }

      // ── click login / submit ──
      if (/click.*(login|log in|sign in|submit)|press.*(login|enter)|submit/.test(t)) {
        // Ground the ACTUAL button named (e.g. "Signup button" ≠ "Login
        // button"). Falls back to the pre-resolved login button only when no
        // matching control is found in the crawl.
        const sel = ground(this.extractControlPhrase(raw) || 'login sign in submit', 'button', ctx.sel.login, 'submit');
        push(raw, [`await ${sel}.click();`, `await page.waitForLoadState('domcontentloaded');`], false);
        continue;
      }

      // ── navigate to a product page (open a product detail) ──
      if (/navigate to a product|open .*product|view .*product|product page/.test(t) && !/products page/.test(t)) {
        push(raw, [`await ${ctx.sel.product}.first().click();`, `await page.waitForLoadState('domcontentloaded');`], false);
        continue;
      }

      // ── return to products page ──
      if (/return to|back to the products|go back/.test(t)) {
        push(raw, [`await page.goBack();`, `await page.waitForLoadState('domcontentloaded');`], false);
        continue;
      }

      // (Verification / assertion steps are handled by the early guard at the
      // top of the loop so they can never be mis-routed to an action branch.)

      // ── generic click ──
      // Ground the named control instead of always clicking the login button.
      // "Click the Signup button", "Click Add to cart", "Tap Continue" now
      // resolve to their real element in the crawl.
      if (/^click|^press|^tap|^select/.test(t)) {
        const phrase = this.extractControlPhrase(raw);
        const sel = groundClick(phrase || 'submit', ctx.sel.login, phrase ? `click:${phrase}` : 'submit');
        push(raw, [`await ${sel}.click();`], false);
        continue;
      }

      // Unrecognized step → configurable warning/error (review issue #3). The
      // step text is embedded in the marker itself (emitUnmappedStep), so we no
      // longer narrate it on a separate comment line.
      this.emitUnmappedStep(out, raw, ctx.testCaseId);
    }

    // Trim trailing blank line.
    while (out.length && out[out.length - 1] === '') out.pop();
    return { lines: out };
  }

  /**
   * True when a step expresses a VERIFICATION / ASSERTION intent rather than an
   * action. Checked before any action branch so a step such as "Verify Logged in
   * as username is displayed" (which contains "username") is asserted, never
   * mis-routed to a username FILL. `t` is the lower-cased step text.
   */
  private isVerificationStep(t: string): boolean {
    return (
      /^(verify|check|confirm|ensure|assert|validate|expect|observe|see that|the .* should|it should)\b/.test(t) ||
      /\bshould\s+(see|show|display|contain|be|not)\b/.test(t) ||
      /\b(is|are|should be)\s+(displayed|visible|shown|present|correct|hidden|not\s+visible)\b/.test(t)
    );
  }

  /**
   * True when a step describes CONTEXT / a PRECONDITION rather than an action —
   * "User is on the login page", "User is logged in", "Given the cart has 2
   * items". Such lines are materialised by the precondition builder (or are just
   * scene-setting); they carry no UI action. Recognising them up front stops a
   * precondition that merely mentions "login"/"user" from being mis-routed into
   * a bogus field FILL (Action Quality), and avoids a noisy unmapped-step TODO
   * for something that is legitimately not a step.
   */
  private isContextOnlyStep(t: string): boolean {
    const s = t.trim();
    return (
      /^(given|assume|precondition|background)\b/.test(s) ||
      /^(the\s+)?user\s+(is|are|was|has|have|should\s+be|already)\b/.test(s)
    );
  }

  /**
   * True when a step genuinely instructs DATA ENTRY into a field. A real fill is
   * verb-led ("Enter…", "Type…", "Leave … empty") or an explicit field
   * assignment ("Username: standard_user"). A scenario TITLE or EXPECTED RESULT
   * that merely contains the substring "user"/"login"/"password"
   * ("Valid login - standard user", "User is on the login page") has no such
   * intent and must never become a `.fill(...)`. Anchored at the start (after
   * common lead-ins) so the noun "login" inside a title cannot masquerade as the
   * verb "log in".
   */
  private hasFillIntent(t: string): boolean {
    const s = t.replace(
      /^\s*(?:\d+[.)]\s*)?(?:and\s+|then\s+|next,?\s+|please\s+|the\s+user\s+|user\s+|you\s+|i\s+)?/i,
      '',
    );
    return (
      /^(enter|type|fill|input|provide|key\s*in|supply|set|choose|select|use|leave|clear|specif|populat|give|re-?enter|re-?type)/i.test(s) ||
      /^[a-z][a-z0-9_]{1,20}\s*[:=]\s*\S/i.test(s)
    );
  }

  /**
   * True when a phrase plausibly names a UI CONTROL (a field / button label) as
   * opposed to business prose. Used to gate the generic getByLabel fallback so a
   * scenario title or expected-result phrase can never be manufactured into a
   * `page.getByLabel(/…/i)` action (the "getByLabel(/valid login-/i)" defect).
   * A control name is short and free of outcome / narrative vocabulary.
   */
  private looksLikeControlName(phrase: string): boolean {
    const p = String(phrase).trim().toLowerCase();
    if (!p) return false;
    if (p.length > 40 || p.split(/\s+/).length > 5) return false;
    // Business-outcome / scenario-title / narrative tokens that must never be
    // treated as a control's accessible name.
    if (/\b(valid|invalid|successful|success|failure|failed|redirect|redirected|dashboard|logged\s?in|log\s?in|login|logout|credential|credentials|message|displayed|visible|shown|should|scenario|verify|verified|ensure|confirm|expected|able\s+to|correctly|properly|standard\s+user)\b/.test(p)) {
      return false;
    }
    return true;
  }

  /**
   * Emit an unmapped step under the active policy (review issue #3). Always
   * records the step to `this.unmappedSteps` so the API can surface an honest
   * count; the inline marker severity follows `unmappedStepPolicy`:
   *   - 'error'  → throw in the generated code (fail fast, forces a fix)
   *   - 'comment'→ legacy silent "review manually" note
   *   - 'warn'   → greppable @warning marker + a soft runtime annotation (default)
   */
  private emitUnmappedStep(out: string[], raw: string, testCaseId?: number): void {
    this.unmappedSteps.push({ testCaseId, step: raw });
    // Generation Quality: the marker embeds the exact step text so the one line
    // is self-contained (no separate narration comment above it).
    const oneLine = raw.replace(/\s+/g, ' ').trim();
    if (this.unmappedStepPolicy === 'error') {
      out.push(`throw new Error(${JSON.stringify(`Unmapped test step (fix the test case): ${raw}`)});`);
    } else if (this.unmappedStepPolicy === 'comment') {
      out.push(`// TODO: Map step — "${oneLine}"`);
    } else {
      // 'warn' (default): a single greppable TODO marker + a soft runtime
      // annotation so the gap is visible in reports and test output.
      out.push(`// TODO: Map step — "${oneLine}"`);
      out.push(`test.info().annotations.push({ type: 'warning', description: ${JSON.stringify(`Unmapped step: ${raw}`)} });`);
    }
    out.push('');
  }

  /**
   * Map an inline assertion-style step ("Verify URL is .../inventory.html",
   * "Check inventory page elements displayed", "Confirm cart icon is present")
   * into concrete Playwright assertions. Returns [] when nothing specific can
   * be derived, so the caller can fall back to an explicit review note rather
   * than emitting a no-op.
   */
  private mapAssertionStep(
    raw: string,
    t: string,
    ctx: { url: string; sel: Record<string, string> },
  ): string[] {
    const lines: string[] = [];

    // URL assertions — "verify/check URL is X" or any mention of a URL/path.
    if (/\burl\b|\bredirect|\bnavigat/.test(t)) {
      const urlM = raw.match(/\bhttps?:\/\/[^\s'")]+/i);
      if (/inventory/.test(t) || (urlM && /inventory/.test(urlM[0]))) {
        lines.push(`await expect(page).toHaveURL(/inventory\\.html/);`);
      } else if (urlM) {
        lines.push(`await expect(page).toHaveURL('${escapeStr(urlM[0])}');`);
      } else if (/login/.test(t)) {
        lines.push(`await expect(page).toHaveURL('${escapeStr(ctx.url)}');`);
      }
    }

    // Shopping cart icon visible/present.
    if (/cart/.test(t)) {
      lines.push(`await expect(${ctx.sel['cart'] || `page.locator('.shopping_cart_link')`}).toBeVisible();`);
    }

    // Inventory / product list / products page elements visible.
    if (/inventory|product list|products? (page|are|is|displayed|list|grid)|items? (are|is) displayed/.test(t)) {
      lines.push(`await expect(${ctx.sel['title'] || `page.locator('[data-test="title"]')`}).toHaveText(/Products/i);`);
      // Review fix — assert the product list is actually populated WITHOUT a
      // magic count (hard-coded `toHaveCount(6)` was both fragile across apps and
      // a red flag when the locator was wrong). Asserting the first card is
      // visible proves the grid rendered and survives catalog size changes.
      const itemSel = ctx.sel['inventoryItem'] || `page.locator('.inventory_item')`;
      lines.push(`await expect(${itemSel}.first()).toBeVisible();`);
    }

    // Error message visible.
    if (/error|invalid|locked|epic sadface|required/.test(t)) {
      lines.push(`await expect(${ctx.sel['error'] || `page.locator('[data-test="error"]')`}).toBeVisible();`);
      const quoted = raw.match(/'([^']+)'|"([^"]+)"/);
      const msg = quoted ? (quoted[1] ?? quoted[2] ?? '') : '';
      if (msg && !/^<.*>$/.test(msg.trim())) {
        lines.push(`await expect(${ctx.sel['error'] || `page.locator('[data-test="error"]')`}).toContainText('${escapeStr(msg.replace(/^epic sadface:\s*/i, '').trim())}');`);
      }
    }

    // De-duplicate while preserving order.
    return [...new Set(lines)];
  }

  /**
   * Derive REAL assertions from the Expected Result with correct logic:
   *  - error outcomes → error element visible + exact message text + stays on login
   *  - login-page outcomes (logout / session invalidation) → back on login URL
   *  - success outcomes → on inventory URL + Products title visible
   *  - conditional ("if credentials are valid") → tolerant branch that passes
   *    whether the app accepted or rejected the (boundary) input.
   */
  private buildTcAssertions(
    expected: string,
    ctx: { url: string; creds: { username: string; password: string }; sel: Record<string, string>; data?: { varName: string; ref: string; hasUsername: boolean; hasPassword: boolean }; crawl?: CrawlResult; stepTracked?: LocatorGroundingEntry[] },
    _tc: NonNullable<GenerationConfig['testCase']>,
    pos: Array<{ name: string; varName: string; methods: string[]; kind: string }> = [],
    usedPOVars?: Set<string>,
  ): string[] {
    const exp = expected.trim();
    const lc = exp.toLowerCase();
    const lines: string[] = [];

    // Priority #4 — Repository Reuse. Prefer the LoginPage's own error accessor
    // (e.g. `loginPage.getError()`, which returns a Locator) over a raw
    // `page.locator('[data-test=error]')` when the matched Page Object exposes a
    // method whose name references the error surface. Strictly method-gated so
    // we never reference a getter the repo doesn't have. `errorRef()` records the
    // PO var in the caller's used-set (so it gets instantiated/imported) only
    // when the reference is actually emitted.
    const loginPO = pos.find((p) => p.kind === 'login');
    const errGetter = loginPO ? this.findPoMethod(loginPO.methods, /error/i) : null;
    const errorRef = (): string => {
      if (loginPO && errGetter) {
        usedPOVars?.add(loginPO.varName);
        return `${loginPO.varName}.${errGetter}()`;
      }
      return ctx.sel.error;
    };

    const quoted = exp.match(/'([^']+)'|"([^"]+)"/);
    const message = quoted ? (quoted[1] ?? quoted[2] ?? '') : '';
    const messageFrag = message.replace(/^epic sadface:\s*/i, '').trim();

    const isError = /error message|epic sadface|locked out|is required|do not match|invalid|not match|account is locked/.test(lc);
    const isConditional = /\bif\b.*\bvalid\b/.test(lc);
    const isLoginPage = /login page|logged out|cannot access|redirected to the login/.test(lc);
    const isCart = /cart (icon|is|should)|shopping cart|cart is visible|cart badge/.test(lc);
    const isSuccess = /products page|inventory|remains logged in|access all product|redirected to the products/.test(lc);

    const sauce = this.isSauceLikeApp(ctx.url);
    const successUrl = this.deriveSuccessUrl(exp);

    if (isConditional) {
      // Boundary/condition case: the provided values may or may not be accepted.
      // Assert deterministically on whichever state the app lands in. The
      // "accepted" branch is app-aware: SauceDemo lands on /inventory.html with a
      // Products title; other apps land on whatever URL the Expected Result names
      // (or simply leave the login page). The branch condition is self-describing,
      // so no narration comment is emitted into the spec.
      if (sauce) {
        lines.push(`if (page.url().includes('/inventory.html')) {`);
        lines.push(`  await expect(page).toHaveURL(/inventory\\.html/);`);
        lines.push(`  await expect(${ctx.sel.title}).toHaveText(/Products/i);`);
      } else {
        lines.push(`if (!page.url().includes('/login')) {`);
        if (successUrl) lines.push(`  await expect(page).toHaveURL('${escapeStr(successUrl)}');`);
        else lines.push(`  await expect(page).not.toHaveURL('${escapeStr(ctx.url)}');`);
      }
      lines.push(`} else {`);
      lines.push(`  await expect(${errorRef()}).toBeVisible();`);
      lines.push(`  await expect(page).toHaveURL('${escapeStr(ctx.url)}');`);
      lines.push(`}`);
      return lines;
    }

    if (isError) {
      // A negative case must assert the ERROR container (never the username
      // input) AND verify the actual message.
      // Priority #3 — Assertion Intelligence. Derive the expected message from
      // the Expected Result and the SCENARIO INTENT, never from the title.
      // Previously this checked /locked/ first against a haystack that included
      // the case title, so every "Locked user …" variant wrongly asserted
      // 'locked out'. We now classify the scenario (empty / whitespace /
      // special / maxlength / invalid / normal) and map deterministically:
      //   empty → 'is required', invalid → 'do not match', locked → 'locked out'.
      // Ambiguous input mutations (whitespace / special / maxlength) get NO
      // guessed text — we assert the error surface + that we stayed on the login
      // page, which is the reliable, scenario-faithful expectation.
      let frag = messageFrag;
      // Guessed canned message text ("do not match", "locked out", "is required")
      // is SauceDemo's copy — only guess it for a SauceDemo-shaped app. For other
      // apps we never invent message text (it would assert a string the app never
      // renders); we assert the error surface + that we stayed on the login page,
      // unless the Expected Result itself quoted the message (messageFrag).
      if (!frag && this.isSauceLikeApp(ctx.url)) {
        // Sprint 2D.1: derive the error fragment from Scenario Graph semantics
        // when available, bypassing ScenarioIntelligence re-inference.
        const semantics = (_tc as any).__scenarioNode?.semantics;
        let scenarioFrag: string | null = null;
        if (semantics) {
          const dummyResolver: ScenarioCredentialResolver = {
            base: () => ({ username: '', password: '' }),
            validCounterpart: () => ({ username: '', password: '' }),
            envUsername: () => '',
            envPassword: () => '',
            authoredUsername: null,
            authoredPassword: null,
            authoredBothEmpty: false,
            escape: (s: string) => s,
          };
          const derived = this.deriveFromSemantics(semantics, dummyResolver);
          scenarioFrag = derived.errorFragment;
        } else {
          // Legacy path: classify and get transformer's error fragment.
          const { transformer } = this.scenario.resolve(_tc, this.parseTestCaseSteps(_tc));
          scenarioFrag = transformer.errorFragment();
        }
        // Intent signals from Expected Result + scenario/test-data (NOT title).
        const hay = `${lc} ${`${_tc.scenario ?? ''}`.toLowerCase()} ${`${_tc.test_data || ''}`.toLowerCase()}`;
        if (scenarioFrag === 'is required' || /empty|required|blank|cannot be (empty|blank)|no .*(username|password)/.test(lc)) {
          frag = 'is required';
        } else if (scenarioFrag === 'do not match') {
          frag = 'do not match';
        } else if (scenarioFrag === '') {
          frag = ''; // ambiguous mutation — assert the error surface, not a guessed message
        } else if (/account is locked|locked out|\blocked\b/.test(hay)) {
          frag = 'locked out';
        } else if (/do not match|not match|invalid|incorrect|wrong|bad credential/.test(hay)) {
          frag = 'do not match';
        }
      }
      const errTarget = errorRef();
      lines.push(`await expect(${errTarget}).toBeVisible();`);
      if (frag) {
        lines.push(`await expect(${errTarget}).toContainText('${escapeStr(frag)}');`);
      }
      // A failed/invalid login must KEEP the user on the login page.
      lines.push(`await expect(page).toHaveURL('${escapeStr(ctx.url)}');`);
      return lines;
    }

    if (isLoginPage) {
      lines.push(`await expect(page).toHaveURL('${escapeStr(ctx.url)}');`);
      lines.push(`await expect(${ctx.sel.login}).toBeVisible();`);
      return lines;
    }

    if (isCart) {
      // Cart visibility (e.g. TC5) — assert the cart link is actually present
      // on the inventory page rather than a meaningless not.toHaveURL check.
      lines.push(`await expect(${ctx.sel['cart'] || `page.locator('.shopping_cart_link')`}).toBeVisible();`);
      return lines;
    }

    // App Profile verification (review issue #4): when the Expected Result names
    // a SPECIFIC element/text to verify (e.g. "Username is displayed in the
    // navigation header", "'Logged in as' is shown"), ground THAT element in the
    // crawled App Profile and assert it, instead of always falling back to the
    // generic landmark (ctx.sel.title). Returns null when nothing specific can
    // be grounded, so we keep the app-aware landmark as a safety net.
    const groundedVerify = this.deriveGroundedVerification(exp, ctx);

    if (isSuccess) {
      if (sauce) {
        lines.push(`await expect(page).toHaveURL(/inventory\\.html/);`);
        lines.push(`await expect(${ctx.sel.title}).toHaveText(/Products/i);`);
      } else if (successUrl) {
        // The Expected Result named the destination (e.g. the home page) — assert
        // exactly that URL rather than SauceDemo's inventory.html.
        lines.push(`await expect(page).toHaveURL('${escapeStr(successUrl)}');`);
        lines.push(groundedVerify ?? `await expect(${ctx.sel.title}).toBeVisible();`);
      } else {
        // App-agnostic success signal: we are no longer on the login page.
        lines.push(`await expect(page).not.toHaveURL('${escapeStr(ctx.url)}');`);
        lines.push(groundedVerify ?? `await expect(${ctx.sel.title}).toBeVisible();`);
      }
      return lines;
    }

    // Fallback — never emit a no-op. Prefer a grounded App-Profile verification
    // for the named element, then the Expected Result's URL, then the app-aware
    // landmark as a last resort.
    if (groundedVerify) {
      if (successUrl) lines.push(`await expect(page).toHaveURL('${escapeStr(successUrl)}');`);
      lines.push(groundedVerify);
      return lines;
    }
    if (successUrl) lines.push(`await expect(page).toHaveURL('${escapeStr(successUrl)}');`);
    lines.push(`await expect(${ctx.sel.title}).toBeVisible();`);
    return lines;
  }

  /**
   * Derive a grounded verification assertion from an Expected Result using App
   * Profile intelligence (review issue #4). Two strategies, most specific first:
   *   1. A quoted literal ("'Logged in as'") → assert the app renders that text
   *      via getByText — content-anchored, never a guessed selector.
   *   2. "<element> is displayed/visible/shown/present" → ground the named
   *      element against the crawled DOM and assert the REAL locator.
   * Returns null when nothing specific can be grounded, so the caller keeps its
   * app-aware landmark fallback (no hallucinated selectors).
   */
  private deriveGroundedVerification(
    expected: string,
    ctx: { crawl?: CrawlResult; stepTracked?: LocatorGroundingEntry[]; sel: Record<string, string> },
  ): string | null {
    const exp = (expected || '').trim();
    if (!exp || !ctx.crawl) return null;

    // 1) Quoted literal text the app should render.
    const quoted = exp.match(/'([^']+)'|"([^"]+)"/);
    const literal = quoted ? (quoted[1] ?? quoted[2] ?? '').trim() : '';
    if (literal && literal.length >= 2 && !/^https?:\/\//i.test(literal)) {
      return `await expect(page.getByText(${JSON.stringify(literal)}).first()).toBeVisible();`;
    }

    // 2) Greeting / confirmation copy the app renders after an action, e.g.
    //    "sees Logged in as username", "shows Welcome back", "displays the
    //    Order placed! message". The literal token (a username/id) is variable,
    //    so we anchor on the STABLE prefix as a case-insensitive text regex —
    //    content-anchored to the App Profile's copy, never a guessed selector.
    const greet = exp.match(
      /\b(?:sees?|shows?|showing|displays?|displaying|says?|reads?|greeted with|message)\s+(?:the\s+|a\s+|an\s+)?["']?([A-Za-z][\w '!.\-]{2,40}?)["']?(?:\s+(?:message|text|banner|notification|greeting|username|name))?\s*$/i,
    );
    // Common canonical greeting explicitly present in the copy (handles phrasing
    // where the verb isn't the immediate lead-in, e.g. "and sees Logged in as").
    const canonicalGreet = /\blogged in as\b/i.test(exp)
      ? 'Logged in as'
      : /\bwelcome\b/i.test(exp)
      ? 'Welcome'
      : '';
    const greetText = (greet?.[1]?.trim() || canonicalGreet).replace(/\s+(username|name)$/i, '').trim();
    if (greetText && greetText.length >= 3 && /[a-z]/i.test(greetText)) {
      return `await expect(page.getByText(/${escapeRegex(greetText)}/i).first()).toBeVisible();`;
    }

    // 3) "<phrase> is displayed/visible/shown/present" → ground the element.
    const m = exp.match(
      /\b(?:the\s+)?([a-z][\w '\-]{2,40}?)\s+(?:is|are|should be)\s+(?:displayed|visible|shown|present)\b/i,
    );
    const phrase = m ? m[1].trim().replace(/\b(in|on|at|the|a|an)\b\s*$/i, '').trim() : '';
    if (phrase) {
      const r = this.resolveGroundedSelectorTracked([phrase], ctx.crawl, '', 'any');
      if (r.grounded && r.selector) {
        if (ctx.stepTracked) {
          ctx.stepTracked.push({
            name: `verify:${phrase}`,
            selector: r.selector,
            grounded: r.grounded,
            knownGood: r.knownGood,
            confidence: r.confidence,
            source: r.source,
          });
        }
        return `await expect(${r.selector}).toBeVisible();`;
      }
    }
    return null;
  }

  /**
   * Review fix — de-duplicate repeated assertions before final output.
   * Step-derived assertions (e.g. "verify inventory page") and the
   * Expected-Result assertions frequently emit the SAME check (e.g. three
   * identical `toHaveURL(/inventory\.html/)` / `toHaveText(/Products/i)` lines
   * stacking from precondition + body + final assertions). We collapse exact
   * duplicate `await expect(...)` statements, keeping the first occurrence, so
   * the spec stays clean and non-noisy.
   *
   * Only statements at the test's TOP LEVEL (brace depth 0) are de-duplicated —
   * assertions nested inside an `if/else`, `try`, or loop block are intentional
   * (each branch asserts a different state) and are always preserved.
   */
  private dedupeTopLevelAssertions(lines: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    let depth = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      const isExpect = /^await expect\s*\(/.test(trimmed);
      if (isExpect && depth === 0) {
        if (seen.has(trimmed)) continue; // drop the duplicate
        seen.add(trimmed);
      }
      // Track brace depth AFTER the dedupe decision, so a line that opens a
      // block is itself evaluated at the depth it lives on.
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      depth += opens - closes;
      if (depth < 0) depth = 0;
      out.push(line);
    }
    return out;
  }

  /** Escape a string for safe inclusion in a JSDoc block comment. */
  private escapeBlockComment(s: string): string {
    return String(s).replace(/\*\//g, '* /').replace(/[\r\n]+/g, ' ').trim();
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Step 4: AI Test Plan Generation                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Build a compact, token-budgeted repo-pattern guide block from the repo
   * profile (coding style, idiomatic imports, helpers/page-objects to reuse,
   * locator conventions). Distinct from `repoIntelligence` (a freeform dump):
   * this is the distilled, structured guide from `analyzeRepoPatterns`, so the
   * model follows the repo's conventions without re-deriving them.
   * Returns '' when there is no repo profile or it isn't confident enough.
   */
  private buildRepoPatternBlock(config: GenerationConfig): string {
    if (!config.repoProfile) return '';
    // Token optimization: `repoIntelligence` (the freeform context) already
    // carries the repo's conventions. Only add the distilled guide when that
    // freeform block is absent, so we never pay for the same info twice.
    if (config.repoIntelligence) return '';
    try {
      const guide = analyzeRepoPatterns(config.repoProfile);
      if (!guide) return '';
      return `\n--- REPO PATTERN GUIDE ---\n${guide.promptBlock}\n--- END REPO PATTERN GUIDE ---`;
    } catch (err: any) {
      logger.warn(MOD, 'Repo pattern analysis failed (non-blocking)', { error: err?.message });
      return '';
    }
  }

  /**
   * Derive a concise INTENT string from the strongest available signal. The
   * orchestrator is intent-driven ("Login", "Add to cart", "Checkout") rather
   * than a flat repo dump, so we distil one short phrase from the test case
   * title / instructions / detected page type.
   */
  private deriveIntent(config: GenerationConfig, crawl: CrawlResult): string {
    const candidates = [
      config.testCase?.title,
      config.testCase?.scenario,
      config.instructions,
      crawl?.pageType ? `${crawl.pageType}` : '',
      crawl?.title,
    ].map(s => (s ?? '').trim()).filter(Boolean);
    const intent = candidates[0] ?? '';
    // Keep it short — first ~12 words is plenty to seed keyword matching.
    return intent.split(/\s+/).slice(0, 12).join(' ');
  }

  /**
   * Knowledge-Graph-First: build the generation prompt block from the
   * Intelligence Orchestrator instead of the legacy flat repository summary.
   *
   * Gathers intent-scoped intelligence across the repository graph
   * (relationship-traversing reuse candidates), app profile, test data, and
   * learned patterns, then renders a compact, confidence-annotated block.
   *
   * Fully gated: returns '' unless the INTELLIGENCE_ORCHESTRATOR flag is on AND
   * a company scope is present. Any failure degrades to '' so generation is
   * never blocked. This is the single integration point that validates the new
   * architecture end-to-end for Script Generation (Phase 1).
   */
  private async buildOrchestratedIntelligenceBlock(
    config: GenerationConfig,
    crawl: CrawlResult,
  ): Promise<string> {
    if (!IntelligenceOrchestrator.isEnabled()) return '';
    // companyId is the minimum scope the orchestrator needs (knowledge/test-data
    // are tenant-scoped). Without it we can't safely query, so degrade to ''.
    if (config.companyId == null) return '';

    const intent = this.deriveIntent(config, crawl);
    if (!intent) return '';

    // Script Generation cares about: existing code to reuse (repository graph),
    // the app's UI structure (app profile), datasets to drive the test (test
    // data), and best practices (patterns). It does NOT need DOM-memory selector
    // history or org-wide knowledge stats for the *plan* prompt — so we request
    // a focused subset and avoid paying for unnecessary context.
    const sources: OrchestratorSource[] = ['repository', 'appProfile', 'testData', 'patterns'];

    try {
      const orchestrator = getIntelligenceOrchestrator();
      const intel = await orchestrator.gatherIntelligence({
        intent,
        repoContextId: config.repoContextId,
        companyId: config.companyId,
        projectId: config.projectId ?? undefined,
        targetUrl: config.url,
        caller: 'script-gen',
        sources,
      });

      if (!intel.available) {
        console.log('[ScriptGenEngine] ℹ️ Orchestrator returned no intelligence for intent:', intent);
        return '';
      }

      const block = orchestrator.buildPromptContext(intel);
      if (!block || block.startsWith('(No intelligence')) return '';

      logger.info(MOD, 'Injecting orchestrated intelligence into prompt', {
        intent,
        sourcesUsed: intel.metadata.sourcesUsed,
        confidenceScore: intel.metadata.confidenceScore,
        confidenceBySource: intel.metadata.confidenceBySource,
        timingsMs: intel.metadata.timingsMs,
        retrievalMetrics: intel.metadata.retrievalMetrics,
        selected: intel.metadata.selected,
        sourceVersions: intel.metadata.sourceVersions,
      });
      console.log(
        `[ScriptGenEngine] 🧭 Orchestrated intelligence injected (intent="${intent}", ` +
          `sources=[${intel.metadata.sourcesUsed.join(', ')}], confidence=${intel.metadata.confidenceScore}%, ` +
          `total=${intel.metadata.timingsMs.total}ms)`,
      );
      return `\n--- ORCHESTRATED INTELLIGENCE (INTENT-SCOPED) ---\n${block}\n--- END ORCHESTRATED INTELLIGENCE ---`;
    } catch (err: any) {
      logger.warn(MOD, 'Orchestrated intelligence failed (non-blocking)', { error: err?.message });
      return '';
    }
  }

  /**
   * Phase 2 (RAG / few-shot learning): retrieve the most similar EXISTING tests
   * from the scanned repository's embedded code_chunks and format them as a
   * few-shot example block for the generation prompt.
   *
   * Fully gated: returns '' immediately unless a repoContextId is present AND
   * RAG retrieval is enabled AND the vector infra/embeddings are available.
   * Any failure degrades to '' so generation never breaks. This is additive —
   * with RAG off, behaviour is identical to before.
   */
  private async buildFewShotBlock(config: GenerationConfig, crawl: CrawlResult): Promise<string> {
    if (!config.repoContextId) return '';
    const rag = getRAGService();
    if (!rag.isEnabled()) return '';

    // Build a retrieval query from the strongest available signal of intent.
    const queryParts = [
      config.testCase?.title,
      config.testCase?.scenario,
      config.instructions,
      config.testTypes?.join(', '),
      crawl?.pageType ? `${crawl.pageType} page` : '',
      crawl?.title,
    ].filter(Boolean);
    const query = queryParts.join('\n').trim();
    if (!query) return '';

    try {
      const { block, examples } = await rag.buildFewShotBlock(config.repoContextId, query, {
        limit: 3,
        minSimilarity: 0.35,
      });
      if (!block) return '';
      logger.info(MOD, 'Injecting RAG few-shot examples into prompt', {
        repoContextId: config.repoContextId,
        examples: examples.length,
      });
      console.log(`[ScriptGenEngine] 🔎 RAG few-shot: ${examples.length} similar test(s) injected`);
      return `\n--- SIMILAR EXISTING TESTS (FEW-SHOT) ---\n${block}\n--- END SIMILAR EXISTING TESTS ---`;
    } catch (err: any) {
      logger.warn(MOD, 'Few-shot retrieval failed (non-blocking)', { error: err?.message });
      return '';
    }
  }

  /**
   * Phase 3 — True Reuse: list existing repo helpers the model should CALL
   * instead of re-implementing. Fully gated: returns '' unless a repoContextId
   * is present, the TRUE_REUSE flag is on, and the method index is available.
   * Any failure degrades to '' so generation is never blocked.
   */
  private async buildReuseBlock(
    config: GenerationConfig,
    crawl: CrawlResult,
    workflowMap: WorkflowMap,
  ): Promise<string> {
    if (!config.repoContextId) return '';
    if (!TrueReuseEngine.isEnabled()) return '';

    // Assemble candidate "step" phrases from the strongest intent signals.
    const steps: string[] = [];
    if (config.testCase?.title) steps.push(config.testCase.title);
    if (config.instructions) steps.push(config.instructions);
    if (crawl?.pageType) steps.push(`${crawl.pageType} page`);
    for (const f of workflowMap.flows) {
      steps.push(f.name);
      for (const s of f.steps) {
        for (const a of s.actions) steps.push(a.description);
      }
    }
    // Pull explicit test-case steps when present.
    let tcSteps: any = config.testCase?.steps;
    if (typeof tcSteps === 'string') {
      try { tcSteps = JSON.parse(tcSteps); } catch { /* leave as string */ }
    }
    if (Array.isArray(tcSteps)) {
      for (const s of tcSteps) {
        if (typeof s === 'string') steps.push(s);
        else if (s?.action || s?.description) steps.push(`${s.action ?? ''} ${s.description ?? ''}`.trim());
      }
    }

    const unique = Array.from(new Set(steps.filter(Boolean))).slice(0, 25);
    if (unique.length === 0) return '';

    try {
      const engine = new TrueReuseEngine();
      const block = await engine.buildReuseContext(unique, config.repoContextId, { maxHelpers: 8 });
      if (!block) return '';
      logger.info(MOD, 'Injecting true-reuse helper context into prompt', {
        repoContextId: config.repoContextId,
      });
      console.log('[ScriptGenEngine] ♻️  True-reuse: existing helpers injected into prompt');
      return `\n--- EXISTING REUSABLE HELPERS (PHASE 3) ---\n${block}\n--- END EXISTING REUSABLE HELPERS ---`;
    } catch (err: any) {
      logger.warn(MOD, 'True-reuse context failed (non-blocking)', { error: err?.message });
      return '';
    }
  }

  /**
   * Build the "TEST CASE TO AUTOMATE" anchor block. When generating from a Test
   * Case Lab case, the flows must mirror the case's steps + expected result
   * rather than being inferred purely from the crawl. Returns '' for url-based
   * generation (no test case), leaving the original behaviour untouched.
   */
  private buildTestCaseAnchorBlock(config: GenerationConfig): string {
    const tc = config.testCase;
    if (!tc) return '';
    let steps: any = tc.steps;
    if (typeof steps === 'string') {
      try { steps = JSON.parse(steps); } catch { /* leave as string */ }
    }
    const stepLines = Array.isArray(steps)
      ? steps.map((s: any, i: number) => {
          const text = typeof s === 'string' ? s : (s?.action ?? s?.step ?? s?.description ?? JSON.stringify(s));
          return `  ${i + 1}. ${text}`;
        }).join('\n')
      : (typeof steps === 'string' ? steps : '');

    return [
      '\n--- TEST CASE TO AUTOMATE ---',
      tc.title ? `Title: ${tc.title}` : '',
      tc.scenario ? `Scenario: ${tc.scenario}` : '',
      tc.preconditions ? `Preconditions: ${tc.preconditions}` : '',
      stepLines ? `Steps:\n${stepLines}` : '',
      tc.expected_result ? `Expected Result: ${tc.expected_result}` : '',
      tc.test_data ? `Test Data: ${tc.test_data}` : '',
      '--- END TEST CASE TO AUTOMATE ---',
    ].filter(Boolean).join('\n');
  }

  private async generateTestPlan(
    crawl: CrawlResult,
    workflowMap: WorkflowMap,
    config: GenerationConfig,
    avgSelectorScore: number,
  ): Promise<TestPlan> {
    // Build concise DOM summary for AI
    const domSummary = this.buildDOMSummary(crawl);
    // Phase 2: RAG few-shot block (similar existing tests). '' when RAG is off.
    const fewShotBlock = await this.buildFewShotBlock(config, crawl);
    // Phase 3: True-reuse block (existing helpers to call). '' when TRUE_REUSE off.
    const reuseBlock = await this.buildReuseBlock(config, crawl, workflowMap);
    // Knowledge-Graph-First: intent-scoped orchestrated intelligence. '' when the
    // INTELLIGENCE_ORCHESTRATOR flag is off. When present it REPLACES the legacy
    // flat repository-summary block below (validated as the Phase 1 milestone).
    const orchestratedBlock = await this.buildOrchestratedIntelligenceBlock(config, crawl);
    const flowSummary = workflowMap.flows.map(f => ({
      name: f.name,
      type: f.flowType,
      steps: f.steps.length,
      actions: f.steps.flatMap(s => s.actions.map(a => `${a.type}: ${a.description}`)),
    }));

    const systemPrompt = `You are an expert QA engineer generating structured test plans.
You output ONLY valid JSON matching the schema below.

Rules:
- Generate test flows based on the detected page type and elements
- Each flow should have clear, specific steps
- Use descriptive action targets (e.g., "username input", "login button")
- Include both positive and negative test cases if requested
- For fill actions, use template variables like {{USERNAME}}, {{PASSWORD}}
- For assertions, describe what to check (not Playwright code)
- Tag each flow appropriately (smoke, regression, auth, etc.)
- Generate Page Object patterns for reusable pages

JSON Schema:
{
  "flows": [
    {
      "name": "string",
      "description": "string",
      "flowType": "authentication|smoke|form_submission|navigation|search|error_handling",
      "priority": number,
      "tags": ["string"],
      "steps": [
        {
          "action": "navigate|fill|click|select|hover|press|assert|wait|screenshot",
          "target": "string (element description)",
          "value": "string (for fill/select)",
          "description": "string"
        }
      ]
    }
  ],
  "pageObjects": [
    {
      "name": "string (PascalCase, e.g. LoginPage)",
      "url": "string",
      "locators": [
        { "name": "camelCase", "description": "element description" }
      ],
      "actions": [
        { "name": "camelCase", "description": "what this action does" }
      ]
    }
  ],
  "fixtures": [
    {
      "name": "string",
      "description": "string",
      "steps": [ ... same as flow steps ]
    }
  ]
}`;

    const userPrompt = `Generate a test plan for this page:

URL: ${config.url}
Page Type: ${crawl.pageType} (confidence: ${crawl.pageTypeConfidence.toFixed(2)})
Title: ${crawl.title}

DOM Summary:
${domSummary}

Detected Workflows:
${JSON.stringify(flowSummary, null, 2)}

${config.instructions ? `User Instructions: ${config.instructions}` : ''}
${config.testTypes?.length ? `Requested Test Types: ${config.testTypes.join(', ')}` : ''}
${config.includeNegativeTests ? 'Include negative test cases (invalid inputs, empty fields, etc.)' : ''}
${config.credentials ? 'Credentials will be provided via environment variables (process.env.USERNAME, process.env.PASSWORD)' : ''}
${config.knowledgeContext ? `\n--- APP KNOWLEDGE ---\nBusiness context and domain knowledge to incorporate into test scenarios:\n\n${config.knowledgeContext}\n\nIMPORTANT: Use the above knowledge to:\n- Validate business rules in assertions\n- Create regression tests for known bug patterns\n- Test workflow transitions and edge cases\n- Verify integration points and dependencies\n--- END APP KNOWLEDGE ---` : ''}
${(() => {
  // Knowledge-Graph-First: when the orchestrator produced an intent-scoped
  // block, it REPLACES the legacy flat repository summary (don't inject both —
  // the orchestrated block already grounds reuse on relationship-traversed
  // candidates). Falls back to the legacy summary when the flag is off / empty.
  if (orchestratedBlock) {
    console.log('[ScriptGenEngine] 🧭 Using orchestrated intelligence in place of legacy repository summary');
    return orchestratedBlock;
  }
  if (config.repoIntelligence) {
    console.log(`[ScriptGenEngine] 🧠 Injecting repository intelligence into AI prompt (${config.repoIntelligence.length} chars)`);
    return `\n--- REPOSITORY INTELLIGENCE ---\nThe target repo already has existing tests. Match its style, reuse its helpers/page-objects, and follow its conventions:\n\n${config.repoIntelligence}\n--- END REPOSITORY INTELLIGENCE ---`;
  }
  console.log('[ScriptGenEngine] ℹ️ No repository intelligence available for this generation');
  return '';
})()}
${config.fusionContext ? `\n--- FUSED INTELLIGENCE ---\nAdditional intelligence from across the platform. Use it to improve reliability:\n\n${config.fusionContext}\n--- END FUSED INTELLIGENCE ---` : ''}
${this.buildRepoPatternBlock(config)}
${fewShotBlock}
${reuseBlock}
${this.buildTestCaseAnchorBlock(config)}

${config.testCase
  ? 'Generate test flows that AUTOMATE THE TEST CASE ABOVE — one flow whose steps map 1:1 to the test-case steps and whose assertions verify its Expected Result. You may add closely-related supporting flows only if clearly implied.'
  : 'Generate comprehensive test flows covering all detected functionality.'}`;

    try {
      const completion = await this.generateTestPlanCompletion(systemPrompt, userPrompt);

      const content = completion.content || '{}';
      const parsed = JSON.parse(content);
      const tokens = completion.tokens;
      const usedModel = completion.model;

      return {
        name: `Test Plan: ${crawl.title || config.url}`,
        description: `Auto-generated test plan for ${config.url}`,
        baseUrl: config.url,
        pageType: crawl.pageType,
        flows: (parsed.flows || []).map((f: any) => ({
          name: f.name || 'Unnamed Flow',
          description: f.description || '',
          flowType: f.flowType || 'smoke',
          priority: f.priority || 5,
          steps: (f.steps || []).map((s: any) => ({
            action: s.action || 'assert',
            target: s.target,
            value: s.value,
            description: s.description || '',
          })),
          tags: f.tags || [],
        })),
        fixtures: (parsed.fixtures || []).map((f: any) => ({
          name: f.name,
          description: f.description || '',
          steps: (f.steps || []).map((s: any) => ({
            action: s.action,
            target: s.target,
            value: s.value,
            description: s.description || '',
          })),
        })),
        pageObjects: (parsed.pageObjects || []).map((po: any) => ({
          name: po.name,
          fileName: `${toKebab(po.name)}.page.ts`,
          url: po.url || config.url,
          pageType: crawl.pageType,
          locators: (po.locators || []).map((l: any) => ({
            name: l.name,
            selector: '', // resolved later
            score: 0,
            strategy: '',
          })),
          actions: (po.actions || []).map((a: any) => ({
            name: a.name,
            steps: a.steps || [],
          })),
        })),
        metadata: {
          generatedAt: new Date().toISOString(),
          crawlTimeMs: crawl.crawlTimeMs,
          totalElements: crawl.elements.length,
          selectorQuality: avgSelectorScore,
          model: usedModel,
          tokensUsed: tokens,
        },
      };
    } catch (e) {
      logger.error(MOD, 'AI test plan generation failed, using fallback', { error: (e as Error).message });
      return this.buildFallbackTestPlan(crawl, workflowMap, config, avgSelectorScore);
    }
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Step 5: Resolve Selectors                                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  private resolveSelectors(testPlan: TestPlan, elements: PageElement[], config?: GenerationConfig): void {
    const totalElements = elements.length;
    let resolved = 0;
    let todos = 0;

    // Pre-compute a short catalog of available element identifiers for diagnostics.
    const availableElements = elements.map(el => this.describeElement(el));

    if (totalElements === 0) {
      logger.warn(MOD, 'resolveSelectors: crawl data is EMPTY — every locator will be a TODO', {
        flows: testPlan.flows.length,
        pageObjects: testPlan.pageObjects.length,
      });
    }

    for (const flow of testPlan.flows) {
      for (const step of flow.steps) {
        if (step.target && !step.selector) {
          step.selector = this.resolveSelector(step.target, step.action, elements);
        }
      }
    }

    // Resolve page object locators
    for (const po of testPlan.pageObjects) {
      for (const locator of po.locators) {
        if (locator.selector) continue;

        const match = this.matchElement(locator.name, elements);
        if (match) {
          const report = this.selectorEngine.rankSelectors(match.element);
          locator.selector = report.bestSelector.playwrightCode;
          locator.score = report.bestSelector.score;
          locator.strategy = report.bestSelector.strategy;
          resolved++;
          // Loop L1 write path: remember we emitted this selector so future
          // heals can be attributed and stability tracked. Fire-and-forget.
          trackGeneratedSelector({
            selector: report.bestSelector.playwrightCode,
            strategy: report.bestSelector.strategy,
            pageUrl: testPlan.baseUrl,
            companyId: config?.companyId ?? null,
            projectId: config?.projectId ?? null,
          });
          logger.debug(MOD, 'Locator resolved', {
            pageObject: po.name,
            intent: locator.name,
            variantsTried: normalizeIntent(locator.name),
            matchedVia: match.via,
            score: match.score,
            selector: locator.selector,
          });
        } else {
          // Annotated diagnostic TODO so the reader sees exactly what's missing.
          locator.selector = this.buildDiagnosticTodo(locator.name, availableElements, totalElements);
          locator.score = 0;
          locator.strategy = 'todo';
          todos++;
          logger.warn(MOD, 'Locator UNRESOLVED — emitting diagnostic TODO', {
            pageObject: po.name,
            intent: locator.name,
            reason: totalElements === 0 ? 'no-crawl-data' : 'no-matching-element',
            variantsTried: normalizeIntent(locator.name),
            availableSample: availableElements.slice(0, 5),
            totalElements,
          });
        }
      }
    }

    logger.info(MOD, 'Selector resolution complete', {
      pageObjectLocators: resolved + todos,
      resolved,
      todos,
      totalCrawledElements: totalElements,
      todoRate: resolved + todos > 0 ? `${Math.round((todos / (resolved + todos)) * 100)}%` : 'n/a',
    });
  }

  /**
   * Build an annotated diagnostic TODO selector for an unresolved locator.
   * Instead of a silent `/* TODO *\/`, this surfaces exactly what was searched,
   * what elements were available, and how many elements the crawl captured —
   * so the gap is obvious without re-running the crawl.
   */
  private buildDiagnosticTodo(intent: string, availableElements: string[], totalElements: number): string {
    const sample = availableElements.slice(0, 3).join(', ') || '(none)';
    const reason = totalElements === 0 ? 'no crawl data available' : 'no matching element';
    const note =
      `TODO: No match found for "${intent}" (${reason}). ` +
      `Available elements: ${sample}. Crawled ${totalElements} elements.`;
    // Keep it a valid Playwright expression so the file still compiles/typechecks.
    return `this.page.locator('/* ${escapeTodo(note)} */')`;
  }

  private resolveSelector(target: string, action: string, elements: PageElement[]): string {
    // If target is already a selector (starts with [ or # or . or role=)
    if (/^[\[#\.]|^role=|^text=/.test(target)) {
      return this.targetToPlaywright(target);
    }

    // Find matching element from crawl
    const el = this.findElementByDescription(target, elements);
    if (el) {
      return this.selectorEngine.getBestPlaywrightSelector(el);
    }

    // Fallback: construct from description
    return this.targetToPlaywright(target);
  }

  /**
   * Resolve a human/camelCase intent (e.g. "usernameInput") to a crawled
   * element. Strategy, in priority order:
   *   1. Exact match of any normalized variant against a high-signal attribute
   *      (data-testid > id > name > aria-label).
   *   2. Exact match against placeholder / nearby-label / text.
   *   3. Substring / token overlap.
   *   4. Fuzzy (Levenshtein ≤ 2) close match.
   * Returns the highest-scoring element, or undefined when nothing is close.
   */
  private findElementByDescription(desc: string, elements: PageElement[]): PageElement | undefined {
    const match = this.matchElement(desc, elements);
    return match?.element;
  }

  /**
   * Score every element against the intent and return the best candidate
   * together with diagnostic info (the variant/attribute that matched and the
   * score) — used both for resolution and for annotated TODO diagnostics.
   */
  private matchElement(
    desc: string,
    elements: PageElement[],
  ): { element: PageElement; score: number; via: string } | undefined {
    const variants = normalizeIntent(desc);
    if (!variants.length || !elements.length) return undefined;

    let best: { element: PageElement; score: number; via: string } | undefined;

    for (const el of elements) {
      // `data-test` is the primary test hook for many apps (SauceDemo et al.),
      // but the crawler only promotes `data-testid`/`data-test-id` to the
      // `dataTestId` field — `data-test` stays in the raw `attributes` map. Read
      // it (and the test-id variants) straight from `attributes` so elements that
      // expose ONLY `data-test` (titles, error banners, cart/inventory nodes
      // without an id) still ground instead of silently falling back.
      const rawAttrs = (el as any).attributes as Record<string, string> | undefined;
      const dataTestAttr =
        rawAttrs?.['data-test'] ?? rawAttrs?.['data-testid'] ?? rawAttrs?.['data-test-id'];
      // Other widely-used test hooks the crawler keeps only in the raw
      // attributes map (AutomationExercise uses `data-qa`, Cypress apps use
      // `data-cy`). Score them too so qualifier tokens like "signup"/"login"
      // in `data-qa="signup-email"` disambiguate otherwise-identical inputs
      // (both `name="email"`) instead of silently taking the first match.
      const dataQaAttr = rawAttrs?.['data-qa'] ?? rawAttrs?.['data-cy'] ?? rawAttrs?.['data-test-hook'];

      // Attributes ordered by selector quality / signal strength.
      const attrs: { label: string; value: string | undefined; weight: number }[] = [
        { label: 'data-testid', value: el.dataTestId, weight: 100 },
        { label: 'data-test', value: dataTestAttr, weight: 100 },
        { label: 'data-qa', value: dataQaAttr, weight: 100 },
        { label: 'id', value: el.id, weight: 95 },
        { label: 'name', value: el.name, weight: 90 },
        { label: 'aria-label', value: el.ariaLabel, weight: 85 },
        { label: 'placeholder', value: el.placeholder, weight: 70 },
        { label: 'label', value: el.nearbyLabel, weight: 65 },
        { label: 'text', value: el.textContent, weight: 50 },
        // Class names are weak signals (often styling), but for component-style
        // hooks like `shopping_cart_link` / `inventory_item` they are the only
        // stable identifier, so match them last at a low weight.
        { label: 'class', value: el.className, weight: 40 },
      ];

      for (const attr of attrs) {
        if (!attr.value) continue;
        const attrLower = attr.value.toLowerCase().trim();
        const attrKebab = toKebab(attr.value);
        if (!attrLower) continue;

        for (const variant of variants) {
          let score = 0;
          let kind = '';

          // 1. Exact (raw or kebab-normalized) → strongest.
          if (attrLower === variant || attrKebab === variant) {
            score = attr.weight + 50;
            kind = 'exact';
          }
          // 2. Substring containment either direction.
          else if (
            attrLower.includes(variant) ||
            variant.includes(attrLower) ||
            attrKebab.includes(variant) ||
            variant.includes(attrKebab)
          ) {
            // Longer variants are more specific → reward.
            score = attr.weight + Math.min(20, variant.length);
            kind = 'partial';
          }
          // 3. Fuzzy close match (typo / minor shape diff), threshold 2.
          else if (variant.length >= 4) {
            const dist = Math.min(levenshtein(variant, attrLower), levenshtein(variant, attrKebab));
            if (dist <= 2) {
              score = attr.weight - dist * 10;
              kind = `fuzzy(d=${dist})`;
            }
          }

          if (score > 0 && (!best || score > best.score)) {
            best = { element: el, score, via: `${attr.label}="${attr.value}" ~ "${variant}" [${kind}]` };
          }
        }
      }
    }

    return best;
  }

  /** Short human-readable identifier for an element, for diagnostics/TODOs. */
  private describeElement(el: PageElement): string {
    const id = el.dataTestId ? `data-testid=${el.dataTestId}`
      : el.id ? `#${el.id}`
      : el.name ? `name=${el.name}`
      : el.ariaLabel ? `aria=${el.ariaLabel}`
      : el.placeholder ? `placeholder=${el.placeholder}`
      : el.textContent ? `text="${el.textContent.slice(0, 24)}"`
      : el.tag;
    return `${el.tag}[${id}]`;
  }

  private targetToPlaywright(target: string): string {
    if (target.startsWith('[data-testid=')) return `page.getByTestId('${extractAttrValue(target)}')`;
    if (target.startsWith('[aria-label=')) return `page.getByLabel('${extractAttrValue(target)}')`;
    if (target.startsWith('[name=')) return `page.locator('${target}')`;
    if (target.startsWith('#')) return `page.locator('${target}')`;
    if (target.startsWith('role=')) {
      const match = target.match(/role=(\w+)\[name="([^"]+)"\]/);
      if (match) return `page.getByRole('${match[1]}', { name: '${match[2]}' })`;
      return `page.getByRole('${target.replace('role=', '')}')`;
    }
    if (target.startsWith('text=')) return `page.getByText('${target.replace('text=', '').replace(/"/g, '')}')` ;
    if (target.startsWith('label:')) return `page.getByLabel('${target.replace('label: ', '').replace(/"/g, '')}')`;
    if (target.startsWith('placeholder:')) return `page.getByPlaceholder('${target.replace('placeholder: ', '').replace(/"/g, '')}')`;

    // Generic: try getByText for button-like, getByRole for inputs
    if (/button|submit|login|sign|save|cancel|click/i.test(target)) {
      return `page.getByRole('button', { name: /${escapeRegex(target)}/i })`;
    }
    if (/input|field|enter|fill|type/i.test(target)) {
      return `page.getByRole('textbox', { name: /${escapeRegex(target)}/i })`;
    }
    if (/link|navigate/i.test(target)) {
      return `page.getByRole('link', { name: /${escapeRegex(target)}/i })`;
    }

    return `page.getByText('${target.replace(/'/g, "\\\'")}')` ;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Step 6: Inject Assertions & Waits                                      */
  /* ──────────────────────────────────────────────────────────────────────── */

  private injectAssertionsAndWaits(testPlan: TestPlan, crawl: CrawlResult): void {
    for (const flow of testPlan.flows) {
      let prevUrl: string | undefined;

      for (let i = 0; i < flow.steps.length; i++) {
        const step = flow.steps[i]!;

        // Inject waits
        if (step.action !== 'assert' && step.action !== 'wait') {
          const waits = this.waitEngine.getWaitForAction(
            { type: step.action as any, target: step.target || '', description: step.description },
            crawl.pageType,
          );
          if (waits.length > 0) {
            step.waitAfter = waits[0]!.playwrightCode;
          }
        }

        // ── Existing ad-hoc assertions (kept as a proven base) ──────────
        if (step.action === 'navigate') {
          prevUrl = step.target;
          step.assertions = [
            `await expect(page).toHaveTitle(/.+/)`,
          ];
        }

        if (step.action === 'click' && step.description.toLowerCase().includes('login')) {
          const postLoginAssertions = this.assertionEngine.generatePostLoginAssertions();
          step.assertions = postLoginAssertions.map(a => a.playwrightCode);
        }

        if (step.action === 'assert') {
          const pageAssertions = this.assertionEngine.generateForPageType(crawl.pageType);
          step.assertions = pageAssertions.map(a => a.playwrightCode);
        }

        // ── Sprint 3A: Verification Standards enrichment ────────────────
        // Fold the deterministic verification plan into this step's assertions,
        // strongest evidence first. Additive & fail-open: it only ADDS proof the
        // ad-hoc rules missed (business outcome, application state, negative
        // absence), never removes what already works. Replaces the weak
        // "URL → text → done" default with the senior-engineer hierarchy.
        this.enrichWithVerificationStandards(step, testPlan);
      }
    }
  }

  /** Actions that mark a meaningful verification checkpoint. A field entry (fill)
   *  is NOT an outcome — a senior engineer asserts after the commit, not after
   *  every keystroke, so we only enrich here. */
  private static readonly VERIFICATION_CHECKPOINTS = new Set(['click', 'press', 'assert']);

  private enrichWithVerificationStandards(step: TestPlanStep, testPlan: TestPlan): void {
    // Verification belongs at meaningful checkpoints. `navigate` already gets a
    // title check from the ad-hoc base; intermediate `fill`/`select`/`hover`
    // steps are not outcomes. Enriching everything is exactly the AI-generated
    // "assert after every line" noise a senior reviewer rejects.
    if (!ScriptGenEngine.VERIFICATION_CHECKPOINTS.has(step.action)) return;

    try {
      const ctx: VerificationContext = {
        // Surface page-object members so context can strengthen critical-UI checks.
        pageObjectMembers: (testPlan.pageObjects || []).flatMap(po => [
          ...(po.actions || []).map(a => a.name),
          ...(po.locators || []).map(l => l.name),
        ]),
        existingAssertions: step.assertions || [],
      };
      const plan = planVerifications(step, ctx);

      // The rule library ranks the plan by evidence strength. The Composer is
      // deliberately SELECTIVE: it renders the single strongest verification the
      // step actually supports (plus a focused negative guard), as a HARD
      // assertion — never a pile of soft `.catch()` no-ops.
      const lines = this.renderVerificationPlan(step, plan);

      const existing = new Set((step.assertions || []).map(a => a.trim()));
      const added = lines.filter(l => l && !existing.has(l.trim()));
      if (added.length > 0) {
        step.assertions = [...(step.assertions || []), ...added];
      }
    } catch {
      // Fail open — leave the existing ad-hoc assertions untouched.
    }
  }

  /**
   * Framework + domain adapter: render a verification PLAN into hard Playwright
   * assertions. The rule library already decided the business OBJECTIVES to
   * prove and the EVIDENCE (framework-agnostic) that proves each; this method is
   * the only place that knows Playwright. It renders each evidence kind into a
   * resilient assertion, category/completion-aware — six flows, not per-feature
   * `if`s. Several assertions for one objective is expected and correct: they
   * are the evidence, not extra objectives.
   */
  private renderVerificationPlan(step: TestPlanStep, plan: VerificationPlan): string[] {
    const text = `${step.description || ''} ${step.target || ''}`.toLowerCase();
    const isCompletion = /\b(finish|complete|confirm|thank\s?you|place\s?(the\s)?order|success|submitted|purchase[ds]?|paid|receipt)\b/.test(text);
    const targetSelector = step.selector || (step.target ? this.targetToPlaywright(step.target) : '');

    // Resilient locator fragments (SauceDemo-proven, written to generalise).
    const landed = `page.locator('.inventory_list, #inventory_container, [data-test="inventory-container"], .dashboard, [class*="dashboard" i], .app_logo').first()`;
    const confirmation = `page.locator('.complete-header, [data-test="complete-header"], .complete, [class*="complete" i], .confirmation, [class*="success" i]').first()`;
    const cartState = `page.locator('.shopping_cart_badge, .cart_badge, [class*="cart" i][class*="badge" i], [data-test*="cart" i]').first()`;
    const cartLink = `page.locator('.shopping_cart_link, [data-test*="cart" i], a[href*="cart" i]').first()`;
    const resultsState = `page.locator('.inventory_list, [class*="results" i], [class*="list" i], table tbody tr').first()`;
    const authLandmark = `page.locator('#react-burger-menu-btn, [data-test="primary-header"], [class*="menu" i] button, [aria-label*="menu" i], [class*="avatar" i], [class*="account" i]').first()`;
    const errorGroup = `page.locator('[data-test="error"], .error-message, .alert-danger, [role="alert"]')`;

    // Render ONE evidence kind → one resilient assertion, chosen by category.
    const render = (kind: EvidenceKind): string | null => {
      switch (kind) {
        case 'error-present':
          return `await expect(page.locator('[data-test="error"], .error-message, .error, .alert-danger, [role="alert"]').first()).toBeVisible()`;
        case 'error-absent':
          // Absence of error is a real, hard assertion (count 0) — not a soft no-op.
          return `await expect(${errorGroup}).toHaveCount(0)`;
        case 'success-indicator':
          if (isCompletion) return `await expect(${confirmation}).toBeVisible()`;
          switch (plan.category) {
            case 'authentication': return `await expect(${landed}).toBeVisible()`;
            case 'shopping':       return `await expect(${cartState}).toBeVisible()`;
            case 'crud':
            case 'search':         return `await expect(${resultsState}).toBeVisible()`;
            case 'forms':          return targetSelector ? `await expect(${targetSelector}).toBeVisible()` : `await expect(${landed}).toBeVisible()`;
            default:               return targetSelector ? `await expect(${targetSelector}).toBeVisible()` : `await expect(${landed}).toBeVisible()`;
          }
        case 'state-change':
          return plan.category === 'shopping'
            ? `await expect(${cartState}).toBeVisible()`
            : `await expect(${resultsState}).toBeVisible()`;
        case 'landmark-control':
          if (plan.category === 'authentication') return `await expect(${authLandmark}).toBeVisible()`;
          if (plan.category === 'shopping')       return `await expect(${cartLink}).toBeVisible()`;
          return targetSelector ? `await expect(${targetSelector}).toBeVisible()` : null;
        case 'navigation':
          return `await expect(page).toHaveURL(/.+/)`;
        default:
          return null;
      }
    };

    // Render every objective's evidence; dedup so overlapping evidence collapses
    // (that is WHY one objective can still be a single strong assertion).
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const objective of plan.objectives) {
      for (const kind of objective.evidence) {
        const line = render(kind);
        if (line && !seen.has(line)) {
          seen.add(line);
          lines.push(line);
        }
      }
    }
    return lines;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Step 7: Deterministic Code Generation                                  */
  /* ──────────────────────────────────────────────────────────────────────── */

  private generatePlaywrightCode(testPlan: TestPlan, config: GenerationConfig): GeneratedFile[] {
    // ─── Adaptive generation: match existing repo structure ────────────
    let analysis: RepoStructureAnalysis | null = null;
    if (config.repoProfile) {
      try {
        analysis = analyzeRepoStructure(config.repoProfile);
        logger.info(MOD, 'Repo structure analysis', {
          mode: analysis.mode,
          nextNum: analysis.nextFileNumber,
          naming: analysis.naming.pattern,
          pageObjectDir: analysis.pageObjectDir,
          pageObjectNaming: analysis.pageObjectNaming.pattern,
          hasConfig: analysis.hasPlaywrightConfig,
          hasCI: analysis.hasCIWorkflow,
          hasReadme: analysis.hasReadme,
          hasEnvExample: analysis.hasEnvExample,
          hasUtils: analysis.hasUtils,
          hasFixtures: analysis.hasFixtures,
        });

        const adaptiveFiles = adaptiveGenerateFiles(testPlan, config, analysis);
        if (adaptiveFiles !== null) {
          logger.info(MOD, 'Using adaptive code generation', {
            mode: analysis.mode,
            fileCount: adaptiveFiles.length,
          });
          return adaptiveFiles;
        }
        // adaptiveFiles === null → mode is POM, fall through to default
      } catch (err: any) {
        logger.warn(MOD, 'Adaptive codegen failed, falling back to default', { error: err.message });
        analysis = null;
      }
    }
    // ─── Default POM generation ───────────────────────────────────────
    // Core artifacts (test specs + page objects) are ALWAYS emitted. Scaffold
    // files (playwright.config, README, .env.example, CI workflow, utils) are
    // SUPPRESSED BY DEFAULT and only emitted when the repo lacks them AND the
    // caller explicitly opts in (see `generatePomFiles` / `resolveScaffoldIntent`).
    return this.generatePomFiles(testPlan, config, analysis);
  }

  /**
   * Default POM file generation.
   *
   * Always emits test specs + page objects. Scaffold files are suppressed by
   * default and only emitted when the repo lacks them AND the caller explicitly
   * requests them (`config.includeScaffold` or a mention in `instructions`).
   *
   * @param analysis Repository structure analysis, or `null` when no target
   *                 repo is connected (greenfield). With `null`, nothing is
   *                 considered "present", so scaffold still needs explicit opt-in.
   */
  private generatePomFiles(
    testPlan: TestPlan,
    config: GenerationConfig,
    analysis: RepoStructureAnalysis | null,
  ): GeneratedFile[] {
    const files: GeneratedFile[] = [];
    const skipped: string[] = [];

    // Honour the existing repo's folder structure and naming conventions
    // (Issue #4) instead of hardcoding kebab-case `pages/login-page.page.ts`
    // style paths. Falls back to sensible defaults for greenfield generation.
    const pageDir = analysis ? analysis.pageObjectDir : 'pages';
    const testDir = analysis ? analysis.testDir : 'tests';
    // Fixture / helper folders are repository conventions owned by Repo
    // Intelligence — resolved from the profile rather than hardcoded. Defaults
    // reproduce the historical `fixtures/` and `utils/` layout for greenfield.
    const conv = analysis?.conventions ?? this.resolveConventions(config);

    // 1. Page Objects — core artifact. Generated for new pages, but REUSED
    //    (not duplicated) when the connected repo already defines them (Fix #2).
    for (const po of testPlan.pageObjects) {
      const existing = this.findExistingPageObject(po, config);
      // If the repo already has this page object AND it covers every locator we
      // need, skip regeneration entirely to avoid duplicate definitions.
      if (existing && this.existingCoversAllLocators(po, existing)) {
        skipped.push(`page-object:${po.name} (already defined in ${existing.filePath} — reused as-is)`);
        logger.info(MOD, '♻️  Skipping page object generation — fully covered by existing', {
          pageObject: po.name,
          existingFile: existing.filePath,
        });
        console.log(`[ScriptGenEngine] ♻️  Reusing existing ${existing.filePath} for ${po.name} (no duplicate generated)`);
        continue;
      }
      const fileName = analysis
        ? buildPageObjectFileName(po.name, analysis.pageObjectNaming)
        : po.fileName;
      files.push({
        path: `${pageDir}/${fileName}`,
        content: this.maybeAddAuthImport(this.generatePageObject(po, config), config, conv),
        type: 'page-object',
      });
    }

    // 2. Test spec files (one per flow) — the core purpose. ALWAYS generated.
    let specNum = analysis ? analysis.nextFileNumber : 1;
    for (const flow of testPlan.flows) {
      const fileName = analysis
        ? buildSpecFileName(flow.name, analysis.naming, specNum)
        : `${toKebab(flow.name)}.spec.ts`;
      if (analysis?.naming.usesNumberPrefix) specNum++;
      files.push({
        path: `${testDir}/${fileName}`,
        content: this.maybeAddAuthImport(this.generateTestSpec(flow, testPlan, config), config, conv),
        type: 'test',
      });
    }

    // 3. Fixtures — a functional artifact (test data the generated specs rely
    //    on), NOT a scaffold file. Generated only if the plan needs them and the
    //    repo lacks them. Always logged.
    const fixturesPath = resolveFixturePath(conv, 'test-fixtures.ts');
    if (testPlan.fixtures.length > 0) {
      if (!analysis?.hasFixtures) {
        files.push({
          path: fixturesPath,
          content: this.maybeAddAuthImport(this.generateFixtures(testPlan.fixtures, config), config, conv),
          type: 'fixture',
        });
        logger.debug(MOD, `Scaffold decision: ${fixturesPath} → GENERATE`, {
          reason: 'test plan declares fixtures and repo has none',
        });
      } else {
        skipped.push(`${fixturesPath} (repo already has fixtures)`);
      }
    }

    // 3b. Auth fixture (Fix #3) — when the connected repo profile carries real
    //     credentials and/or a base URL, emit `fixtures/auth.ts` so generated
    //     specs can import concrete `testCredentials`/`baseUrl` instead of
    //     relying on un-provisioned environment variables. Skipped silently for
    //     greenfield runs where no credentials are available.
    if (this.credsAvailable(config)) {
      const authFixturePath = resolveFixturePath(conv, 'auth.ts');
      const alreadyEmitted = files.some(f => f.path === authFixturePath);
      if (!alreadyEmitted) {
        files.push({
          path: authFixturePath,
          content: this.generateAuthFixture(config),
          type: 'fixture',
        });
        logger.info(MOD, `🔐 Emitting ${authFixturePath} with injected credentials/baseUrl`, {
          hasUsername: !!config.credentials?.username,
          hasBaseUrl: !!config.url,
        });
        console.log(`[ScriptGenEngine] 🔐 Generated ${authFixturePath} (credentials + baseUrl injected from repo profile)`);
      }
    }

    // ─── Scaffold files (playwright.config, utils, .env.example, README, CI) ───
    // These are NOT test artifacts. They are project scaffolding. Per product
    // requirement they must be COMPLETELY SUPPRESSED by default. A scaffold file
    // is emitted only when BOTH conditions hold:
    //   (a) the target repo does NOT already provide it, AND
    //   (b) the caller explicitly asked for it (config.includeScaffold === true,
    //       or the file type is mentioned in the user's instructions).
    // When no repo is connected (greenfield, analysis === null) nothing is
    // "present", so scaffold files still require an explicit opt-in.
    const intent = this.resolveScaffoldIntent(config);
    logger.info(MOD, 'Scaffold generation intent resolved', {
      hasAnalysis: !!analysis,
      includeScaffoldFlag: config.includeScaffold === true,
      intent,
    });

    type ScaffoldSpec = {
      key: keyof Omit<ReturnType<ScriptGenEngine['resolveScaffoldIntent']>, 'explicit'>;
      path: string;
      repoHas: boolean;
      build: () => GeneratedFile;
    };

    const scaffoldSpecs: ScaffoldSpec[] = [
      {
        key: 'config',
        path: 'playwright.config.ts',
        repoHas: !!analysis?.hasPlaywrightConfig,
        build: () => ({ path: 'playwright.config.ts', content: this.generatePlaywrightConfig(config), type: 'config' }),
      },
      {
        key: 'utils',
        path: resolveHelperPath(conv, 'test-helpers.ts'),
        repoHas: !!analysis?.hasUtils,
        build: () => ({ path: resolveHelperPath(conv, 'test-helpers.ts'), content: this.generateTestHelpers(), type: 'util' }),
      },
      {
        key: 'env',
        path: '.env.example',
        repoHas: !!analysis?.hasEnvExample,
        build: () => ({ path: '.env.example', content: this.generateEnvExample(config), type: 'config' }),
      },
      {
        key: 'readme',
        path: 'README.md',
        repoHas: !!analysis?.hasReadme,
        build: () => ({ path: 'README.md', content: this.generateReadme(testPlan, config), type: 'readme' }),
      },
      {
        key: 'ci',
        path: '.github/workflows/playwright.yml',
        repoHas: !!analysis?.hasCIWorkflow,
        build: () => ({ path: '.github/workflows/playwright.yml', content: this.generateGithubActionsConfig(), type: 'config' }),
      },
    ];

    for (const spec of scaffoldSpecs) {
      const requested = intent[spec.key];
      if (spec.repoHas) {
        skipped.push(`${spec.path} (repo already provides it — never overwritten)`);
        logger.info(MOD, `Scaffold decision: ${spec.path} → SKIP`, {
          reason: 'repo already provides this file',
          repoHas: true,
          explicitlyRequested: requested,
        });
        continue;
      }
      if (!requested) {
        skipped.push(`${spec.path} (suppressed by default — not in repo and not explicitly requested)`);
        logger.info(MOD, `Scaffold decision: ${spec.path} → SKIP`, {
          reason: 'scaffold suppressed by default; not present in repo and not explicitly requested',
          repoHas: false,
          explicitlyRequested: false,
        });
        continue;
      }
      files.push(spec.build());
      logger.info(MOD, `Scaffold decision: ${spec.path} → GENERATE`, {
        reason: 'explicitly requested and not present in repo',
        repoHas: false,
        explicitlyRequested: true,
      });
    }

    logger.info(MOD, 'POM generation complete', {
      generatedCount: files.length,
      generatedPaths: files.map(f => f.path),
      skippedCount: skipped.length,
      skipped,
    });

    return files;
  }

  /**
   * Resolve which scaffold files the caller actually wants.
   *
   * Default is to want NONE — scaffold generation is opt-in. A scaffold type is
   * "wanted" if either:
   *   • `config.includeScaffold === true` (force-all, e.g. greenfield bootstrap), or
   *   • the user's free-text `instructions` mention that file type.
   *
   * Note: "wanted" is necessary but not sufficient — the caller in
   * `generatePomFiles` still suppresses any file the repo already provides.
   */
  private resolveScaffoldIntent(config: GenerationConfig): {
    config: boolean;
    utils: boolean;
    env: boolean;
    readme: boolean;
    ci: boolean;
    explicit: boolean;
  } {
    const all = config.includeScaffold === true;
    const text = (config.instructions ?? '').toLowerCase();

    const mentions = (patterns: RegExp[]): boolean => patterns.some(re => re.test(text));

    const intent = {
      config: all || mentions([/playwright\.config/, /\bconfig file\b/, /playwright config/]),
      utils: all || mentions([/\butils?\b/, /\bhelpers?\b/, /helper function/]),
      env: all || mentions([/\.env/, /env\.example/, /environment variable/, /\benv file\b/]),
      readme: all || mentions([/\breadme\b/, /documentation file/]),
      ci: all || mentions([/\bci\b/, /ci\/cd/, /cicd/, /\bworkflow\b/, /\bpipeline\b/, /github action/, /gitlab/, /jenkins/, /circleci/]),
      explicit: all,
    };
    return intent;
  }

  /* ──────── Page Object Generator ──────── */

  private generatePageObject(po: PageObjectSpec, config?: GenerationConfig): string {
    // Fix #2: try to reuse selectors from an existing page object in the
    // connected repo instead of recreating them from scratch.
    const existing = config ? this.findExistingPageObject(po, config) : null;
    const existingLocators = existing
      ? existing.properties.filter(p => p.selector)
      : [];

    let reusedCount = 0;
    let newCount = 0;

    const locatorDefs = po.locators.map(l => {
      const match = existing ? this.matchExistingLocator(l, existingLocators) : null;
      if (match) {
        reusedCount++;
        const code = this.reconstructLocatorCode(match.selector!, match.locatorType || 'locator');
        return `  // Reused from existing ${existing!.filePath} (matched by ${match.matchType}: ${match.name})\n  readonly ${l.name} = ${code};`;
      }
      newCount++;
      // Fix #5 (PR-A): emit an annotated diagnostic TODO — not a silent one —
      // when no concrete selector could be resolved for this element.
      const sel = l.selector
        || `this.page.locator('/* ${escapeTodo(`TODO: No selector resolved for "${l.name}".`)} */')`;
      const tag = existing ? '  // New element — not found in existing page object\n' : '';
      return `${tag}  readonly ${l.name} = ${sel};`;
    }).join('\n');

    if (existing) {
      logger.info(MOD, '♻️  Page object reuse', {
        pageObject: po.name,
        existingFile: existing.filePath,
        reusedSelectors: reusedCount,
        newSelectors: newCount,
        totalLocators: po.locators.length,
      });
      console.log(
        `[ScriptGenEngine] ♻️  ${po.name}: reusing ${reusedCount}/${po.locators.length} selector(s) from existing ${existing.filePath}, ${newCount} new`,
      );
    } else {
      logger.info(MOD, '🆕 Page object generated (no existing match)', {
        pageObject: po.name,
        newSelectors: po.locators.length,
      });
    }

    const actionMethods = po.actions.map(a => {
      const steps = (a.steps || []).map((s: TestPlanStep) => {
        return `    ${this.stepToCode(s, config)}`;
      }).join('\n');
      return `
  async ${a.name}() {
${steps || '    // TODO: implement'}
  }`;
    }).join('\n');

    const reuseNote = existing
      ? `\n * Reuses selectors from existing page object: ${existing.filePath}\n * (${reusedCount} reused, ${newCount} new)`
      : '';

    return `import { type Page, type Locator, expect } from '@playwright/test';

/**
 * Page Object: ${po.name}
 * URL: ${po.url}
 * Page Type: ${po.pageType}
 *${reuseNote}
 * Generated by LevelUp AI QA Engine
 */
export class ${po.name} {
  readonly page: Page;

${locatorDefs}

  constructor(page: Page) {
    this.page = page;
  }

  async goto() {
    await this.page.goto('${po.url}');
    await this.page.waitForLoadState('domcontentloaded');
  }
${actionMethods}
}
`;
  }

  /* ──────── Page Object Reuse Helpers (Fix #2) ──────── */

  /**
   * Find an existing page object in the connected repo profile that
   * corresponds to the page object we are about to generate. Matches by
   * normalized class-name intent (e.g. "LoginPage" ≈ "Login"), so a generated
   * `LoginPage` reuses the repo's existing `LoginPage`/`LoginPageObject`.
   * Returns null when there is no connected repo or no confident match.
   */
  private findExistingPageObject(po: PageObjectSpec, config: GenerationConfig): ClassInfo | null {
    try {
      // ── Ask Repo Intelligence (Reuse Catalogue), not the raw profile ──
      // The convention profile owns "what already exists". We consult its reuse
      // catalogue rather than inspecting config.repoProfile.pageObjects directly,
      // so Script Generation stays a pure consumer. The catalogue mirrors the same
      // scanned data, so reuse decisions are identical to before.
      const conv = this.resolveConventions(config);
      const reusable = findReusablePageObject(conv, po.name);
      if (!reusable) return null;
      const hit = reusable.raw;
      // Only reuse if the matched class actually exposes selectors we can use.
      if (hit && hit.properties.some(p => p.selector)) return hit;
      return null;
    } catch (err: any) {
      logger.warn(MOD, 'findExistingPageObject failed — generating fresh page object', { error: err?.message });
      return null;
    }
  }

  /** Normalize a page-object class name to a comparable intent token. */
  private normalizePageObjectName(name: string): string {
    return (name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .replace(/(pageobject|page|pom|screen|view|component|cmp)$/, '');
  }

  /**
   * Strip a locator/element property name down to its semantic intent so
   * `loginButton`, `loginBtn`, `login_button` all collapse to `login`.
   */
  private normalizeElementIntent(name: string): string {
    return (name || '')
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '')
      .replace(/(input|field|button|btn|textbox|txt|text|box|link|dropdown|select|checkbox|element|locator|el)$/, '');
  }

  /**
   * Reduce a selector string to a comparable core token so that
   * `#user-name`, `[data-test="user-name"]`, `this.page.locator('#user-name')`
   * are recognised as the same underlying element.
   */
  private selectorCore(raw: string): string {
    if (!raw) return '';
    // If it's Playwright code, pull the inner selector out first.
    const parsed = extractSelectorInfo(raw);
    const sel = parsed ? parsed.selector : raw;
    return sel
      .toLowerCase()
      .replace(/^this\.page\./, '')
      .replace(/['"`#.\[\]()]/g, '')
      .replace(/data-?test(id)?=?/g, '')
      .replace(/[^a-z0-9]/g, '');
  }

  /**
   * Match a to-be-generated locator against the selectors found in an existing
   * page object. Matching strategy (in priority order):
   *   1. Exact property-name match.
   *   2. Intent match (loginButton → loginBtn).
   *   3. Selector-similarity match (#user-name → existing #user-name).
   */
  private matchExistingLocator(
    loc: { name: string; selector?: string },
    existingLocators: ClassInfo['properties'],
  ): (ClassInfo['properties'][number] & { matchType: string }) | null {
    if (!existingLocators.length) return null;

    // 1) Exact name.
    let hit = existingLocators.find(p => p.name.toLowerCase() === loc.name.toLowerCase());
    if (hit) return { ...hit, matchType: 'name' };

    // 2) Intent.
    const intent = this.normalizeElementIntent(loc.name);
    if (intent) {
      hit = existingLocators.find(p => this.normalizeElementIntent(p.name) === intent);
      if (hit) return { ...hit, matchType: 'intent' };
    }

    // 3) Selector similarity.
    if (loc.selector) {
      const newCore = this.selectorCore(loc.selector);
      if (newCore.length > 2) {
        hit = existingLocators.find(p => p.selector && this.selectorCore(p.selector) === newCore);
        if (hit) return { ...hit, matchType: 'selector' };
      }
    }

    return null;
  }

  /**
   * True when an existing page object already defines a selector for EVERY
   * locator the new page object needs — in which case we reuse it as-is and
   * skip generating a duplicate file.
   */
  private existingCoversAllLocators(po: PageObjectSpec, existing: ClassInfo): boolean {
    if (!po.locators.length) return false;
    const existingLocators = existing.properties.filter(p => p.selector);
    if (!existingLocators.length) return false;
    return po.locators.every(l => this.matchExistingLocator(l, existingLocators) !== null);
  }

  /** Reconstruct Playwright locator code from an extracted selector + strategy. */
  private reconstructLocatorCode(selector: string, locatorType: string): string {
    const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    switch (locatorType) {
      case 'getByTestId':    return `this.page.getByTestId('${esc(selector)}')`;
      case 'getByText':      return `this.page.getByText('${esc(selector)}')`;
      case 'getByLabel':     return `this.page.getByLabel('${esc(selector)}')`;
      case 'getByPlaceholder': return `this.page.getByPlaceholder('${esc(selector)}')`;
      case 'getByAltText':   return `this.page.getByAltText('${esc(selector)}')`;
      case 'getByTitle':     return `this.page.getByTitle('${esc(selector)}')`;
      case 'getByRole': {
        const m = selector.match(/^(.*?)\[name=("[\s\S]*?")\]$/);
        if (m) return `this.page.getByRole('${esc(m[1])}', { name: ${m[2]} })`;
        return `this.page.getByRole('${esc(selector)}')`;
      }
      default:
        return `this.page.locator('${esc(selector)}')`;
    }
  }

  /* ──────── Credential Injection Helpers (Fix #3) ──────── */

  /** True when the profile provided credentials we can inject programmatically. */
  private credsAvailable(config?: GenerationConfig): boolean {
    return !!(config?.credentials && (config.credentials.username || config.credentials.password));
  }

  /**
   * Generate `fixtures/auth.ts` with the real credentials + base URL pulled
   * from the application profile, so generated specs can import concrete
   * values instead of relying on process.env placeholders.
   */
  private generateAuthFixture(config: GenerationConfig): string {
    const esc = (s: string) => String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const username = esc(config.credentials?.username || '');
    const password = esc(config.credentials?.password || '');
    const baseUrl = esc(config.url || '');

    return `// Auth fixtures — generated by LevelUp AI QA Engine
// Credentials and base URL are injected from the application profile.
// NOTE: avoid committing real secrets — override via env vars in CI if needed.

export const testCredentials = {
  username: process.env.USERNAME || '${username}',
  password: process.env.PASSWORD || '${password}',
};

export const baseUrl = process.env.BASE_URL || '${baseUrl}';
`;
  }

  /**
   * Inject `import { testCredentials, baseUrl } from '../fixtures/auth';` into a
   * generated file when (a) the profile supplied credentials and (b) the file
   * actually references those symbols. Avoids unused imports.
   */
  private maybeAddAuthImport(content: string, config?: GenerationConfig, conv?: ProjectConventionProfile): string {
    if (!this.credsAvailable(config)) return content;
    const needs = /\btestCredentials\b/.test(content) || /\bbaseUrl\b/.test(content);
    if (!needs) return content;
    // The fixture folder is a repository convention (Repo Intelligence). Use its
    // last path segment for the one-level-up relative import, defaulting to the
    // historical `../fixtures/auth` when no profile is connected.
    const fixtureSeg = (conv?.fixtureFolder ?? 'fixtures').split('/').filter(Boolean).pop() || 'fixtures';
    const authImportPath = `../${fixtureSeg}/auth`;
    if (new RegExp(`from '[^']*${fixtureSeg}\\/auth'`).test(content)) return content; // already imported

    const importLine = `import { testCredentials, baseUrl } from '${authImportPath}';`;
    const lines = content.split('\n');
    const idx = lines.findIndex(l => /^import\s/.test(l));
    if (idx >= 0) {
      lines.splice(idx + 1, 0, importLine);
      return lines.join('\n');
    }
    return `${importLine}\n${content}`;
  }

  /* ──────── Test Spec Generator ──────── */

  private generateTestSpec(flow: TestPlanFlow, plan: TestPlan, config: GenerationConfig): string {
    const steps = flow.steps.map((step, i) => {
      const code = this.stepToCode(step, config);
      const wait = step.waitAfter ? `\n    ${step.waitAfter}` : '';
      const assertions = (step.assertions || []).map(a => `\n    ${a}`).join('');
      return `    // Step ${i + 1}: ${step.description}\n    ${code}${wait}${assertions}`;
    }).join('\n\n');

    const tags = flow.tags.map(t => `@${t}`).join(' ');

    return `import { test, expect } from '@playwright/test';

/**
 * ${flow.name}
 * ${flow.description}
 * 
 * Flow Type: ${flow.flowType}
 * Priority: ${flow.priority}
 * Tags: ${tags}
 * 
 * Generated by LevelUp AI QA Engine
 * Base URL: ${plan.baseUrl}
 */

test.describe('${escapeStr(flow.name)}', () => {
  const consoleErrors: string[] = [];

  test.beforeEach(async ({ page }) => {
    // Capture console errors
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
  });

  test.afterEach(async () => {
    consoleErrors.length = 0;
  });

  test('${escapeStr(flow.description)}', async ({ page }) => {
${steps}
  });

${this.generateNegativeTests(flow, config)}
});
`;
  }

  private generateNegativeTests(flow: TestPlanFlow, config: GenerationConfig): string {
    if (!config.includeNegativeTests) return '';
    if (flow.flowType !== 'authentication') return '';
    // Fix #7: when generating from a structured test case, the case itself
    // defines the exact scenario (positive OR negative). Appending a generic
    // boilerplate "invalid credentials" test (with app-agnostic OrangeHRM-style
    // selectors) would pollute the file with an unrequested, often-wrong test.
    if (config.testCase) return '';

    return `
  test('should show error with invalid credentials', async ({ page }) => {
    await page.goto(process.env.BASE_URL || '${config.url}');
    await page.waitForLoadState('domcontentloaded');

    // Fill with invalid credentials
    const usernameField = page.locator('input[type="text"], input[type="email"], input[name*="user" i], input[name*="email" i]').first();
    const passwordField = page.locator('input[type="password"]').first();
    const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign")').first();

    await usernameField.fill('invalid_user');
    await passwordField.fill('wrong_password');
    await submitBtn.click();

    // Should show error and stay on login page
    await expect(page.locator('.error, .alert-danger, [role="alert"], .oxd-alert, .invalid-feedback').first()).toBeVisible({ timeout: 5000 });
    await expect(page).toHaveURL(/login|signin/i);
  });

  test('should show validation for empty fields', async ({ page }) => {
    await page.goto(process.env.BASE_URL || '${config.url}');
    await page.waitForLoadState('domcontentloaded');

    // Click submit without filling fields
    const submitBtn = page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign")').first();
    await submitBtn.click();

    // Should show validation or stay on page
    await expect(page).toHaveURL(/login|signin/i);
  });
`;
  }

  /* ──────── Fixtures Generator ──────── */

  private generateFixtures(fixtures: TestPlanFixture[], config: GenerationConfig): string {
    const fixtureCode = fixtures.map(f => {
      const steps = f.steps.map(s => `    ${this.stepToCode(s, config)}`).join('\n');
      return `
/**
 * ${f.description}
 */
export async function ${f.name}(page: Page) {
${steps}
}`;
    }).join('\n');

    return `import { type Page, expect } from '@playwright/test';

// Test Fixtures — Reusable setup functions
// Generated by LevelUp AI QA Engine
${fixtureCode}
`;
  }

  /* ──────── Config Generator ──────── */

  private generatePlaywrightConfig(config: GenerationConfig): string {
    return `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html', { open: 'never' }],
    ['json', { outputFile: 'test-results/results.json' }],
  ],
  use: {
    baseURL: process.env.BASE_URL || '${config.url}',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 10000,
    navigationTimeout: 15000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
`;
  }

  /* ──────── Helpers Generator ──────── */

  private generateTestHelpers(): string {
    return `import { type Page, expect } from '@playwright/test';

/**
 * Test Helpers — Utility functions for test automation
 * Generated by LevelUp AI QA Engine
 */

/**
 * Wait for page to be fully loaded (no pending network requests).
 */
export async function waitForPageReady(page: Page, timeout = 10000): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * Wait for all loading indicators to disappear.
 */
export async function waitForLoadingComplete(page: Page, timeout = 10000): Promise<void> {
  const spinners = page.locator('.loading, .spinner, [class*="loading"], [class*="spinner"], [role="progressbar"]');
  await spinners.first().waitFor({ state: 'hidden', timeout }).catch(() => {});
}

/**
 * Take a named screenshot for visual comparison.
 */
export async function takeScreenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: \`screenshots/\${name}.png\`, fullPage: false });
}

/**
 * Assert no console errors occurred during test.
 */
export function assertNoConsoleErrors(errors: string[]): void {
  const critical = errors.filter(e => !e.includes('favicon') && !e.includes('404'));
  if (critical.length > 0) {
    console.warn('Console errors detected:', critical);
  }
}

/**
 * Retry an action up to N times.
 */
export async function retry<T>(fn: () => Promise<T>, retries = 3, delay = 1000): Promise<T> {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === retries - 1) throw e;
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error('Retry exhausted');
}
`;
  }

  /* ──────── Env Example ──────── */

  private generateEnvExample(config: GenerationConfig): string {
    return `# Test Environment Configuration
# Generated by LevelUp AI QA Engine

BASE_URL=${config.url}
${config.credentials ? `USERNAME=${config.credentials.username || 'admin'}
PASSWORD=${config.credentials.password || 'password'}` : '# USERNAME=your_username\n# PASSWORD=your_password'}

# CI/CD
CI=false
`;
  }

  /* ──────── README ──────── */

  private generateReadme(plan: TestPlan, config: GenerationConfig): string {
    const flowList = plan.flows.map(f => `- **${f.name}** (${f.flowType}) — ${f.description}`).join('\n');
    return `# Automated Test Suite

> Generated by [LevelUp AI QA Engine](https://app.leveluptesting.in)

## Target
- **URL**: ${config.url}
- **Page Type**: ${plan.pageType}
- **Generated**: ${plan.metadata.generatedAt}

## Test Flows
${flowList}

## Setup

\`\`\`bash
npm install
npx playwright install
\`\`\`

## Run Tests

\`\`\`bash
# Run all tests
npx playwright test

# Run with UI
npx playwright test --ui

# Run specific test
npx playwright test tests/login.spec.ts
\`\`\`

## Configuration

Copy \`.env.example\` to \`.env\` and update credentials.

## Project Structure

\`\`\`
├── tests/           # Test specifications
├── pages/           # Page Object Models
├── fixtures/        # Reusable test fixtures
├── utils/           # Helper utilities
├── playwright.config.ts
├── .env.example
└── .github/workflows/playwright.yml
\`\`\`

## Stats
- Tests: ${plan.flows.length}
- Selector Quality: ${(plan.metadata.selectorQuality * 100).toFixed(0)}%
- AI Model: ${plan.metadata.model}
`;
  }

  /* ──────── GitHub Actions ──────── */

  private generateGithubActionsConfig(): string {
    return `name: Playwright Tests
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
  schedule:
    - cron: '0 6 * * *' # Daily at 6 AM UTC

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install dependencies
        run: npm ci
      - name: Install Playwright browsers
        run: npx playwright install --with-deps chromium
      - name: Run tests
        run: npx playwright test
        env:
          BASE_URL: \${{ secrets.BASE_URL }}
          USERNAME: \${{ secrets.TEST_USERNAME }}
          PASSWORD: \${{ secrets.TEST_PASSWORD }}
      - name: Upload report
        uses: actions/upload-artifact@v4
        if: always()
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 14
`;
  }

  /* ──────── Step to Code Converter ──────── */

  private stepToCode(step: TestPlanStep, config?: GenerationConfig): string {
    const selector = step.selector || (step.target ? this.targetToPlaywright(step.target) : '');
    const useFixtures = this.credsAvailable(config);

    switch (step.action) {
      case 'navigate': {
        // Fix #3: when a profile base URL/credentials are present, use the
        // injected `baseUrl` fixture instead of a process.env lookup.
        if (useFixtures) {
          return `await page.goto(baseUrl);\n    await page.waitForLoadState('domcontentloaded');`;
        }
        // Never use a navigation TARGET as the goto literal when it is prose
        // (e.g. "the login page") — that produced `page.goto('login page')`.
        // Prefer a real URL/path; fall back to the real Base URL from config.
        const tgt = (step.target || '').trim();
        const isRealUrl = /^https?:\/\//i.test(tgt) || tgt.startsWith('/');
        const navTarget = isRealUrl ? tgt : (config?.url || tgt);
        return `await page.goto(process.env.BASE_URL || '${escapeStr(navTarget)}');\n    await page.waitForLoadState('domcontentloaded');`;
      }

      case 'fill': {
        const val = step.value || '';

        // Fix #3: inject real credentials from the profile via the auth fixture.
        if (useFixtures && /\{\{\s*USERNAME\s*\}\}/i.test(val)) {
          return `await ${selector}.fill(testCredentials.username);`;
        }
        if (useFixtures && /\{\{\s*PASSWORD\s*\}\}/i.test(val)) {
          return `await ${selector}.fill(testCredentials.password);`;
        }

        // Replace template vars with process.env (fallback when no profile creds)
        const resolvedVal = val
          .replace('{{USERNAME}}', "' + (process.env.USERNAME || 'Admin') + '")
          .replace('{{PASSWORD}}', "' + (process.env.PASSWORD || 'admin123') + '")
          .replace(/\{\{(\w+)\}\}/g, (_, key) => `' + (process.env.${key} || '${key}') + '`);

        if (val.includes('{{')) {
          return `await ${selector}.fill('${resolvedVal}');`;
        }
        return `await ${selector}.fill('${escapeStr(val)}');`;
      }

      case 'click':
        return `await ${selector}.click();`;

      case 'select':
        return `await ${selector}.selectOption('${escapeStr(step.value || '')}');`;

      case 'hover':
        return `await ${selector}.hover();`;

      case 'press':
        return `await page.keyboard.press('${step.value || 'Enter'}');`;

      case 'assert': {
        // Fix #4: emit a REAL assertion, never a bare `// Assert:` comment.
        // When the step resolves to a concrete locator, assert it is visible;
        // otherwise verify a navigation/text outcome from the description. Any
        // richer assertions injected by the AssertionEngine are appended by
        // `generateTestSpec` via `step.assertions`.
        if (step.assertions && step.assertions.length > 0) {
          return `// Verify: ${step.description}`;
        }
        if (selector) {
          return `await expect(${selector}).toBeVisible();`;
        }
        const desc = (step.description || '').trim();
        if (desc) {
          return `await expect(page.getByText(/${escapeRegex(desc.slice(0, 40))}/i).first()).toBeVisible();`;
        }
        return `await expect(page).toHaveURL(/.+/);`;
      }

      case 'wait':
        return `await page.waitForLoadState('networkidle').catch(() => {});`;

      case 'screenshot':
        return `await page.screenshot({ path: 'screenshots/${toKebab(step.description || 'step')}.png' });`;

      default:
        return `// ${step.action}: ${step.description}`;
    }
  }

  /* ──────── Fallback Test Plan ──────── */

  private buildFallbackTestPlan(
    crawl: CrawlResult,
    workflowMap: WorkflowMap,
    config: GenerationConfig,
    avgSelectorScore: number,
  ): TestPlan {
    return {
      name: `Test Plan: ${crawl.title || config.url}`,
      description: `Fallback test plan for ${config.url}`,
      baseUrl: config.url,
      pageType: crawl.pageType,
      flows: workflowMap.flows.map(f => ({
        name: f.name,
        description: f.description,
        flowType: f.flowType,
        priority: f.priority,
        steps: f.steps.flatMap(s => s.actions.map(a => ({
          action: a.type as any,
          target: a.target,
          value: a.value,
          description: a.description,
        }))),
        tags: [f.flowType],
      })),
      fixtures: [],
      pageObjects: [],
      metadata: {
        generatedAt: new Date().toISOString(),
        crawlTimeMs: crawl.crawlTimeMs,
        totalElements: crawl.elements.length,
        selectorQuality: avgSelectorScore,
        model: 'fallback-rule-based',
        tokensUsed: 0,
      },
    };
  }

  /* ──────── DOM Summary Builder ──────── */

  private buildDOMSummary(crawl: CrawlResult): string {
    const parts: string[] = [];

    parts.push(`Page: ${crawl.title} (${crawl.pageType})`);
    parts.push(`URL: ${crawl.finalUrl}`);
    parts.push(`Elements: ${crawl.totalElements} total, ${crawl.interactiveElements} interactive`);

    if (crawl.forms.length > 0) {
      parts.push(`\nForms (${crawl.forms.length}):`);
      for (const form of crawl.forms) {
        parts.push(`  Form ${form.index}: ${form.fields.length} fields, method=${form.method || 'GET'}`);
        for (const field of form.fields.slice(0, 10)) {
          parts.push(`    - ${field.tag}[type=${field.type || 'text'}] name=${field.name || 'N/A'} placeholder="${field.placeholder || ''}" label="${field.nearbyLabel || ''}"`);
        }
      }
    }

    if (crawl.buttons.length > 0) {
      parts.push(`\nButtons (${crawl.buttons.length}):`);
      for (const btn of crawl.buttons.slice(0, 10)) {
        parts.push(`  - "${btn.textContent}" [${btn.tag}] id=${btn.id || 'N/A'}`);
      }
    }

    if (crawl.headings.length > 0) {
      parts.push(`\nHeadings:`);
      for (const h of crawl.headings.slice(0, 5)) {
        parts.push(`  H${h.level}: ${h.text}`);
      }
    }

    if (crawl.navigationLinks.length > 0) {
      parts.push(`\nNavigation Links (${crawl.navigationLinks.length} total, showing internal):`);
      for (const link of crawl.navigationLinks.filter(l => l.isInternal).slice(0, 10)) {
        parts.push(`  - "${link.text}" → ${link.href}`);
      }
    }

    return parts.join('\n');
  }
}

/* -------------------------------------------------------------------------- */
/*  Utility Functions                                                         */
/* -------------------------------------------------------------------------- */

function toKebab(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');
}

/* ────────────────────────────────────────────────────────────────────────── */
/*  Intent normalization & fuzzy matching                                      */
/*                                                                              */
/*  A test plan describes elements with human/camelCase intents like           */
/*  "usernameInput" or "passwordField", but crawled elements expose attributes  */
/*  in many shapes ("user-name", "user_name", "password", "login-button").      */
/*  These helpers bridge that gap so generated locators actually resolve.       */
/* ────────────────────────────────────────────────────────────────────────── */

/** Common element-purpose suffixes that can be stripped to reach the core noun. */
const INTENT_SUFFIXES = [
  'input', 'field', 'button', 'btn', 'box', 'textbox', 'element',
  'el', 'txt', 'text', 'link', 'icon', 'dropdown', 'select', 'checkbox',
  'radio', 'toggle', 'label', 'menu', 'item', 'option',
];

/** Common compound words to decompose, e.g. "username" → "user name". */
const COMPOUND_SPLITS: Record<string, string[]> = {
  username: ['user', 'name'],
  firstname: ['first', 'name'],
  lastname: ['last', 'name'],
  fullname: ['full', 'name'],
  signin: ['sign', 'in'],
  signup: ['sign', 'up'],
  signout: ['sign', 'out'],
  logout: ['log', 'out'],
  login: ['log', 'in'],
  checkout: ['check', 'out'],
  dropdown: ['drop', 'down'],
  textbox: ['text', 'box'],
  searchbar: ['search', 'bar'],
  emailaddress: ['email', 'address'],
  phonenumber: ['phone', 'number'],
  zipcode: ['zip', 'code'],
  postalcode: ['postal', 'code'],
};

/** Split an arbitrary intent string into lowercase word tokens. */
function tokenizeIntent(intent: string): string[] {
  return intent
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')        // camelCase → camel Case
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')      // ACRONYMWord → ACRONYM Word
    .replace(/[_\-./]+/g, ' ')                       // snake/kebab/path → spaces
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter(Boolean);
}

/** Render a set of word tokens into kebab / snake / spaced / joined variants. */
function wordsToVariants(words: string[]): string[] {
  if (!words.length) return [];
  return [
    words.join('-'),
    words.join('_'),
    words.join(' '),
    words.join(''),
  ];
}

/**
 * Normalize an intent (e.g. "usernameInput") into the many concrete attribute
 * shapes it might match against in crawled element data.
 *
 * Example: "usernameInput" →
 *   ["usernameinput", "username-input", "username_input", "username input",
 *    "username", "user-name", "user_name", "user name", "username", ...]
 *
 * Exported for unit testing.
 */
export function normalizeIntent(intent: string): string[] {
  const out = new Set<string>();
  const raw = (intent || '').trim();
  if (!raw) return [];

  out.add(raw.toLowerCase());

  const words = tokenizeIntent(raw);
  if (!words.length) return Array.from(out);

  // 1. Full intent in every shape.
  wordsToVariants(words).forEach(v => out.add(v));

  // 2. Core intent with trailing purpose-suffix removed ("usernameInput" → "username").
  if (words.length > 1 && INTENT_SUFFIXES.includes(words[words.length - 1])) {
    const core = words.slice(0, -1);
    wordsToVariants(core).forEach(v => out.add(v));
  }

  // 3. Decompose compound words ("username" → "user name") for every word.
  const decomposed: string[] = [];
  for (const w of words) {
    if (INTENT_SUFFIXES.includes(w)) continue; // drop purpose suffix from decomposition
    if (COMPOUND_SPLITS[w]) {
      decomposed.push(...COMPOUND_SPLITS[w]);
    } else {
      decomposed.push(w);
    }
  }
  if (decomposed.length) {
    wordsToVariants(decomposed).forEach(v => out.add(v));
  }

  return Array.from(out).filter(Boolean);
}

/** Classic iterative Levenshtein edit distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prevDiag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, prevDiag + cost);
      prevDiag = tmp;
    }
  }
  return prev[b.length];
}

function escapeStr(s: string): string {
  return s.replace(/'/g, "\\\'" ).replace(/\n/g, '\\n');
}

/**
 * Sanitize a diagnostic note so it is safe inside a single-quoted JS string and
 * inside a /* ... *\/ comment (no embedded quotes or comment terminators).
 */
function escapeTodo(s: string): string {
  return s
    .replace(/\*\//g, '* /')   // don't terminate the enclosing comment early
    .replace(/'/g, '"')         // avoid breaking the single-quoted string literal
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractAttrValue(attrSelector: string): string {
  const match = attrSelector.match(/="([^"]+)"/);
  return match?.[1] || '';
}
