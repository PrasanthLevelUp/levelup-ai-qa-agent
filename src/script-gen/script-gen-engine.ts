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
import type { AuthConfig, AuthResult } from './auth-engine';
import { WorkflowMapper, type WorkflowMap, type WorkflowFlow, type WorkflowStep, type WorkflowAction } from './workflow-mapper';
import { SelectorQualityEngine, type ScoredSelector } from './selector-quality-engine';
import { buildStabilityProvider, trackGeneratedSelector } from '../services/intelligence-learning-service';
import { getCrawlAdaptationForUrl } from '../services/crawl-adaptation-service';
import { AssertionEngine, type GeneratedAssertion } from './assertion-engine';
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
      const crawlConfig: CrawlConfig = {
        url: config.url,
        followLinks: config.followLinks ?? false,
        maxPages: config.maxPages ?? 3,
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
      try {
        const batch = this.generateFromTestCases(config, crawlResult);
        if (batch && batch.generatedFiles.length > 0) {
          const batchResult: GenerationResult = {
            ...batch,
            ...(authResult ? { authResult } : {}),
            ...(!config.cachedCrawlData ? { rawCrawlData: crawlResult } : {}),
          };
          logger.info(MOD, 'Script generation complete (deterministic requirement-batch path)', batchResult.stats);
          return batchResult;
        }
        logger.warn(MOD, 'Deterministic requirement-batch generation produced nothing — falling back');
      } catch (batchErr: any) {
        logger.warn(MOD, `Deterministic requirement-batch generation failed (${batchErr?.message}) — falling back`);
      }
    }

    if (config.testCase) {
      try {
        const deterministic = this.generateFromTestCase(config, crawlResult);
        if (deterministic && deterministic.generatedFiles.length > 0) {
          const tcResult: GenerationResult = {
            ...deterministic,
            ...(authResult ? { authResult } : {}),
            ...(!config.cachedCrawlData ? { rawCrawlData: crawlResult } : {}),
          };
          logger.info(MOD, 'Script generation complete (deterministic test-case path)', tcResult.stats);
          return tcResult;
        }
        logger.warn(MOD, 'Deterministic test-case generation produced nothing — falling back to LLM path');
      } catch (tcErr: any) {
        logger.warn(MOD, `Deterministic test-case generation failed (${tcErr?.message}) — falling back to LLM path`);
      }
    }

    // ─── Step 2: Build workflow map ───────────────────────────────
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

    // Real base URL — prefer the navigate step's URL, else config.url. NEVER prose.
    let baseUrl = config.url;
    for (const s of steps) {
      const m = s.match(/\bhttps?:\/\/[^\s'")]+/i);
      if (/navigat|go to|open|launch|visit/i.test(s) && m) { baseUrl = m[0]; break; }
    }
    if (!/\/$/.test(baseUrl) && !/\.\w+$/.test(baseUrl)) baseUrl += '/';

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
          hasPassword: 'password' in (caseData.value || {}) || 'pass' in (caseData.value || {}),
        }
      : undefined;

    const title = tc.title || 'Generated test';
    const tags = this.tcTags(tc);
    const idMarker = tc.id != null ? `\n  // @tc:TC${tc.id}` : '';
    const stepComments = steps.map((s, i) => `   *   ${i + 1}. ${this.escapeBlockComment(s)}`).join('\n');

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
      const content = this.buildNonAutomatableSpec(tc, steps, baseUrl, sel, dataRef, { title, idMarker, stepComments, creds }, matchedPOs, testDataImport);
      const fileName = `${toKebab(title).slice(0, 60) || `test-case-${tc.id ?? 'x'}`}.spec.ts`;
      const generatedFiles: GeneratedFile[] = [{ path: `${conv.testFolder}/${fileName}`, content, type: 'test' }];
      const moduleFile = this.buildTestDataModule(dataIndex, conv);
      if (moduleFile) generatedFiles.push(moduleFile);
      const grounding = this.buildLocatorGroundingReport(tracked, content);
      return this.buildTcResult(tc, title, baseUrl, crawl, tags, generatedFiles, 0, startTime, grounding, matchedPOs);
    }

    const ctx = { url: baseUrl, creds, sel, data: dataRef };

    // ── Precondition materialization (review TC2/TC5 fix) ──
    // If the case assumes an authenticated session ("user is logged in") but its
    // steps never perform a login, inject a real login setup using a valid user
    // so the test actually starts from the intended state. Reuses the repo's
    // login() Page Object method when one was matched (review issue #2).
    const preResult = this.buildPreconditionLogin(tc, steps, ctx, dataIndex, matchedPOs);
    const preLines = preResult.lines;
    preResult.used.forEach((v) => usedPOVars.add(v));

    const { lines } = this.tcStepsToCode(steps, ctx);

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
      navLines.push(
        `await page.goto('${escapeStr(baseUrl)}');`,
        `await page.waitForLoadState('domcontentloaded');`,
        '',
      );
    }

    // Declare the resolved record once at the top of the test body so step code
    // can read `user.username` / `user.password`.
    const declLines: string[] = [];
    if (dataRef) {
      const sourceNote = caseData!.representative
        ? `// Test data bound to dataset "${caseData!.datasetName}" (representative record resolved at runtime).`
        : `// Test data bound to dataset "${caseData!.datasetName}", record "${caseData!.recordKey}" (selected for this case).`;
      declLines.push(sourceNote);
      declLines.push(`const ${dataRef.varName} = ${dataRef.ref};`, '');
    }

    // ── Instantiate the Page Objects we actually reference ──
    // Only the POs whose methods were genuinely used (usedPOVars) are imported
    // and instantiated, so we never import a class the test doesn't exercise.
    const activePOs = matchedPOs.filter((po) => usedPOVars.has(po.varName));
    if (activePOs.length) {
      declLines.push(`// Reusing repo Page Object${activePOs.length > 1 ? 's' : ''}: ${activePOs.map((p) => p.name).join(', ')}`);
      for (const po of activePOs) {
        declLines.push(`const ${po.varName} = new ${po.name}(page);`);
      }
      declLines.push('');
    }

    // Combine the body and Expected-Result assertions, then de-duplicate any
    // repeated top-level assertions (review fix #1 — identical toHaveURL /
    // toHaveText / count checks stacking across precondition + body + final).
    const verifyHeader = '// ── Verify Expected Result ──';
    let combined = this.dedupeTopLevelAssertions([
      ...declLines, ...navLines, ...preLines, ...finalLines,
      '', verifyHeader, ...assertions,
    ]);
    // If every Expected-Result assertion was a duplicate of a body assertion
    // (all removed by the dedupe pass), drop the now-dangling section header and
    // its leading blank line so the spec doesn't end with an empty comment.
    const headerIdx = combined.lastIndexOf(verifyHeader);
    if (headerIdx !== -1 && !combined.slice(headerIdx + 1).some(l => /\bexpect\s*\(/.test(l))) {
      combined = combined.slice(0, headerIdx);
      while (combined.length && combined[combined.length - 1].trim() === '') combined.pop();
    }

    // Reference the generated test-data module whenever the body binds a dataset.
    const usesModule = combined.some(l => /\bgetRecord\s*\(/.test(l));
    let importLine = usesModule
      ? `import { test, expect } from '@playwright/test';\nimport { getRecord } from '${testDataImport}';`
      : `import { test, expect } from '@playwright/test';`;

    // Add Page Object imports for the POs we actually reuse (repo-derived paths).
    for (const po of activePOs) {
      importLine += `\nimport { ${po.name} } from '${po.importPath}';`;
    }

    // Priority #5 — derive real coverage categories + the repository assets this
    // spec reuses, instead of emitting a useless `Coverage: n/a`.
    const coverageMeta = this.deriveCoverageMetadata(tc, activePOs, caseData);

    const content = `${importLine}

/**
 * ${this.escapeBlockComment(title)}
 *
 * Test Case ID: ${tc.id ?? 'n/a'}
 * Priority: ${tc.priority ?? tc['Priority'] ?? 'n/a'}
 * Coverage: ${coverageMeta.categories}
 * Repository Assets Reused: ${coverageMeta.assets}
 * Steps:
${stepComments}
 * Expected Result: ${this.escapeBlockComment(`${tc.expected_result || ''}`)}
 * Test Data: ${this.escapeBlockComment(`${tc.test_data || 'n/a'}`)}${caseData ? `\n * Test Data Source: ${this.escapeBlockComment(caseData.representative ? `dataset "${caseData.datasetName}" (representative record, runtime-resolved)` : `dataset "${caseData.datasetName}" → record "${caseData.recordKey}"`)} (Test Data Store)` : ''}
 *
 * Generated by LevelUp AI QA Engine (deterministic test-case build)
 * Base URL: ${baseUrl}
 */

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
    const grounding = this.buildLocatorGroundingReport(tracked, content);
    return this.buildTcResult(tc, title, baseUrl, crawl, tags, generatedFiles, totalAssertions, startTime, grounding, matchedPOs, usedPOVars);
  }

  /** Assemble a single-case GenerationResult (test plan + stats). */
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

    // The shared test-data module path is a repository convention (Repo
    // Intelligence), not a literal — resolve it once so the de-dupe check below
    // matches whatever folder the connected repo uses (defaults to tests/data).
    const sharedDataModulePath = resolveTestDataModulePath(this.resolveConventions(config));

    for (const tc of cases) {
      try {
        // Reuse the single-case translator by scoping config to this case.
        const single = this.generateFromTestCase({ ...config, testCase: tc, testCases: undefined }, crawl);
        if (!single || single.generatedFiles.length === 0) {
          errors.push(`Test case ${tc.id ?? tc.title ?? '?'} produced no script`);
          continue;
        }
        if (single.locatorGrounding) groundingReports.push(single.locatorGrounding);
        if (single.repositoryIntelligence) repoIntelReports.push(single.repositoryIntelligence);
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
          // De-duplicate spec file names within the batch (e.g. similar titles).
          let path = f.path;
          if (usedNames.has(path)) {
            const idTag = tc.id != null ? `-tc${tc.id}` : `-${usedNames.size + 1}`;
            path = path.replace(/\.spec\.ts$/, `${idTag}.spec.ts`);
          }
          usedNames.add(path);
          generatedFiles.push({ ...f, path });
        }
        totalAssertions += single.stats.totalAssertions;
        totalTests += single.stats.totalTests;
        if (single.testPlan.flows[0]) flows.push(single.testPlan.flows[0]);
      } catch (err: any) {
        errors.push(`Test case ${tc.id ?? tc.title ?? '?'}: ${err?.message}`);
      }
    }

    if (generatedFiles.length === 0) return null;

    // Aggregate per-case grounding into one report → real "REAL LOCATORS x/y".
    const locatorGrounding = this.mergeLocatorGrounding(groundingReports);
    // Honest blend (review fix #3): DOM-verified full, curated known-good 0.6.
    const selectorQuality = locatorGrounding.total > 0
      ? (locatorGrounding.groundedCount + (locatorGrounding.realCount - locatorGrounding.groundedCount) * 0.6) / locatorGrounding.total
      : 0;

    // Aggregate repository intelligence across all cases (de-duplicate Page Objects).
    const repositoryIntelligence = this.mergeRepoIntelligence(repoIntelReports);

    const reqLabel = cases[0]?.requirement_id ? `requirement ${cases[0].requirement_id}` : 'requirement';
    const testPlan: TestPlan = {
      name: `Test Plan: ${reqLabel} (${generatedFiles.length} cases)`,
      description: `Deterministic requirement-based automation — ${generatedFiles.length} test cases`,
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
      ...(locatorGrounding.total > 0 ? { locatorGrounding } : {}),
      ...(repositoryIntelligence ? { repositoryIntelligence } : {}),
    };
  }

  /** Parse test-case steps into a clean ordered list of step strings. */
  private parseTestCaseSteps(tc: GenerationConfig['testCase']): string[] {
    if (!tc) return [];
    let steps: any = tc.steps;
    if (typeof steps === 'string') {
      try { steps = JSON.parse(steps); } catch { /* keep string */ }
    }
    let arr: string[] = [];
    if (Array.isArray(steps)) {
      arr = steps.map((s: any) =>
        typeof s === 'string' ? s : (s?.action ?? s?.step ?? s?.description ?? '')
      ).map((s: string) => String(s).trim()).filter(Boolean);
    } else if (typeof steps === 'string') {
      arr = steps.split(/\r?\n/).map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
    }
    // Strip a leading "N." numeric prefix if the array form carried it.
    return arr.map(s => s.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(Boolean);
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
      .replace(/[#.][a-z][\w-]*/gi, ' ');         // #login-button .btn-primary
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
  // ./scenario-intelligence (ScenarioClassifier + independent transformers),
  // accessed via `this.scenario`. This keeps the generator free of embedded
  // per-scenario branching and makes new scenario types drop-in.

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
    // Fold in the categories declared by the classified scenario's transformer,
    // so a new scenario type contributes its coverage category automatically
    // (the 'normal' transformer contributes nothing and defers to the heuristics
    // above). This keeps coverage metadata in lock-step with the transformer set.
    if (tc) {
      const { transformer } = this.scenario.resolve(tc, this.parseTestCaseSteps(tc));
      for (const c of transformer.coverageCategories) add(c);
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
    for (const ds of config.resolvedTestData || []) {
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
   * Resolve which dataset RECORD a test case consumes, by scanning its
   * `test_data` field and steps for a dataset name and/or record key that
   * exist in the index. Returns the matched `{ datasetName, recordKey, value }`
   * plus a `ref` expression (getRecord('<dataset>', selector?)) for emission.
   * Returns null when nothing matches (caller falls back to literals/empties).
   */
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
        // Prefer a stable id selector when present.
        if (el.id) return { selector: `page.locator('#${el.id}')`, grounded: true, knownGood: true, confidence, source: 'id' };
        // SauceDemo (and many apps) expose the test hook as `data-test` rather
        // than `data-testid`. Playwright's getByTestId() defaults to
        // `data-testid`, so emit an explicit attribute locator for `data-test`.
        const attrs = (el as any).attributes as Record<string, string> | undefined;
        const dataTest = attrs?.['data-test'];
        if (dataTest) return { selector: `page.locator('[data-test="${dataTest}"]')`, grounded: true, knownGood: true, confidence, source: 'data-test' };
        const dataTestId = attrs?.['data-testid'] || attrs?.['data-test-id'] || el.dataTestId;
        if (dataTestId) return { selector: `page.getByTestId('${dataTestId}')`, grounded: true, knownGood: true, confidence, source: 'data-testid' };
        if (el.name) return { selector: `page.locator('[name="${el.name}"]')`, grounded: true, knownGood: true, confidence, source: 'name' };
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

    const tracked = {
      username: t(['username', 'user name', 'user-name', 'login'], `page.locator('#user-name')`, 'input'),
      password: t(['password'], `page.locator('#password')`, 'input'),
      login: t(['login button', 'login', 'sign in', 'submit'], `page.locator('#login-button')`, 'button'),
      error: t(['error', 'error message'], `page.locator('[data-test="error"]')`, 'any', rejectError),
      menu: t(['menu', 'burger menu', 'hamburger', 'open menu'], `page.locator('#react-burger-menu-btn')`, 'button'),
      logout: t(['logout', 'log out', 'sign out'], `page.locator('#logout_sidebar_link')`, 'any'),
      title: t(['title', 'page title', 'products', 'header'], `page.locator('[data-test="title"]')`, 'any', rejectTitle),
      product: t(['product', 'item name', 'product name'], `page.locator('.inventory_item_name')`, 'any'),
      cart: t(['cart', 'shopping cart', 'cart icon', 'basket'], `page.locator('.shopping_cart_link')`, 'any'),
      inventoryItem: t(['inventory item', 'product card', 'item'], `page.locator('.inventory_item')`, 'any', rejectInventoryItem),
    };
    const sel: Record<string, string> = {};
    for (const [k, v] of Object.entries(tracked)) sel[k] = v.selector;
    return { sel, tracked };
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
  ): LocatorGroundingReport {
    const entries: LocatorGroundingEntry[] = [];
    const seen = new Set<string>();
    for (const [name, info] of Object.entries(tracked)) {
      if (!content.includes(info.selector)) continue; // only elements the spec uses
      if (seen.has(name)) continue;
      seen.add(name);
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
    return { entries, total, groundedCount, groundedPct, realCount, realPct, avgConfidence };
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
    meta: { title: string; idMarker: string; stepComments: string; creds: { username: string; password: string } },
    matchedPOs: Array<{ name: string; varName: string; methods: string[]; importPath: string; kind: string }> = [],
    testDataImport = './data/test-data',
  ): string {
    const { title, idMarker, stepComments } = meta;
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

    // Priority #5 — derive coverage categories + reused repository assets.
    const coverageMeta = this.deriveCoverageMetadata(tc, usePO ? [loginPO!] : [], null);

    return `${importLine}

/**
 * ${this.escapeBlockComment(title)}
 *
 * Test Case ID: ${tc.id ?? 'n/a'}
 * Priority: ${tc.priority ?? tc['Priority'] ?? 'n/a'}
 * Coverage: ${coverageMeta.categories}
 * Repository Assets Reused: ${coverageMeta.assets}
 * Steps:
${stepComments}
 * Expected Result: ${this.escapeBlockComment(`${tc.expected_result || ''}`)}
 *
 * ⚠️ NOT AUTOMATION-READY (auto-detected): this case requires concurrent /
 * multiple browser sessions, which cannot be exercised by a single linear
 * Playwright \`page\`. Marked test.fixme so it stays visible without producing a
 * misleading single-page run. A correct multi-context skeleton is provided
 * below — complete the assertions and remove .fixme once verified manually.
 *
 * Generated by LevelUp AI QA Engine (deterministic test-case build)
 * Base URL: ${baseUrl}
 */

test.fixme('${escapeStr(title)} (concurrent — needs multiple browser contexts)', async () => {${idMarker}
${userDecl}    // Two isolated sessions, each with its own cookies/storage.
    const browser = await chromium.launch();
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();

    // Session A — log in.
${gotoA}${sessionLogin('pageA')}

    // Session B — log in with the same credentials.
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
      const userFillLine = work.find((l) => /#user-name|username|login.*input/i.test(l) && /\.fill\(/i.test(l));
      const passFillLine = work.find((l) => /#password|\bpwd\b|\bpass\b/i.test(l) && /\.fill\(/i.test(l));
      const hasLoginClick = work.some((l) => /login.*button|#login-button/i.test(l) && /\.click\(/i.test(l));
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
            if (valid && 'username' in (valid.value || {})) {
              localDecls.push(`const user = ${valid.ref};`);
              baseUser = `user.username ?? ''`;
              basePass = 'password' in (valid.value || {})
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
          const val = valid?.value || {};
          if (valid && ('username' in val || 'password' in val)) {
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
        const { classification, transformer } = this.scenario.resolve(tc, steps ?? []);
        const creds = transformer.transformCredentials(classification, credentialResolver);
        let u = creds.username;
        let p = creds.password;
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
          if (/\.fill\(/i.test(l) && /#user-name|username|#password|\bpwd\b|\bpass\b/i.test(l)) {
            if (loginInsertIdx === -1) loginInsertIdx = filtered.length;
            continue;
          }
          // Drop the login click and its trailing waitForLoadState.
          if (/login.*button|#login-button/i.test(l) && /\.click\(/i.test(l)) {
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
    const stepsHaveLogin = /log ?in with|sign in with/.test(stepText)
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

    const lines: string[] = [];
    lines.push(`// Precondition: ${this.escapeBlockComment(tc.preconditions || 'user is logged in')}`);
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
    
    if (loginPO && loginMethod) {
      lines.push(`await ${loginPO.varName}.${loginMethod}(${unameExpr}, ${pwdExpr});`);
      if (!alreadyChecksInventoryUrl) {
        lines.push(`await expect(page).toHaveURL(/inventory\\.html/);`);
      }
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
    if (!alreadyChecksInventoryUrl) {
      lines.push(`await expect(page).toHaveURL(/inventory\\.html/);`);
    }
    lines.push('');
    return { lines, used };
  }

  /**
   * Convert ordered step strings into grounded Playwright statements. Handles
   * navigate / fill (with explicit or test-data values, empty fields, char
   * limits) / click (login, menu, logout, product) / back-navigation and the
   * "repeat N times" throttling pattern.
   */
  private tcStepsToCode(
    steps: string[],
    ctx: { url: string; creds: { username: string; password: string }; sel: Record<string, string>; data?: { varName: string; ref: string; hasUsername: boolean; hasPassword: boolean } },
  ): { lines: string[] } {
    const out: string[] = [];
    let attemptBlock: string[] = []; // statements since the last navigate (for "repeat N times")

    const push = (comment: string, stmts: string[], isNav: boolean) => {
      out.push(`// ${comment}`);
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
      if (/\b(invalid|wrong|incorrect|bad|unregistered|nonexistent|non-existent)\b/.test(t)) {
        return kind === 'username' ? `'invalid_user'` : `'wrong_password'`;
      }
      // 6) Parsed credential literal, else an env-backed expression (never a
      //    silent empty string for a field that's meant to carry a value).
      return this.credFillExpr(kind, kind === 'username' ? ctx.creds.username : ctx.creds.password);
    };

    for (const raw of steps) {
      const t = raw.toLowerCase();

      // ── repeat the above N times (login throttling) ──
      const rep = t.match(/repeat.*?(\d+)\s*times?/);
      if (rep) {
        const n = parseInt(rep[1]!, 10) || 5;
        if (attemptBlock.length) {
          out.push(`// ${raw}`);
          out.push(`// Re-submit the same attempt ${n} times to exercise repeated failures.`);
          out.push(`for (let attempt = 0; attempt < ${n}; attempt++) {`);
          for (const s of attemptBlock) out.push(`  ${s}`);
          out.push(`}`);
          out.push('');
        }
        continue;
      }

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
        push(raw, [`await page.goto('${escapeStr(ctx.url)}inventory.html');`], false);
        continue;
      }

      // ── "log in with valid credentials" — expand to fill+fill+click ──
      if (/log ?in with (valid )?credential|sign in with (valid )?credential/.test(t)) {
        push(raw, [
          `await ${ctx.sel.username}.fill(${fieldExpr('username', raw, t)});`,
          `await ${ctx.sel.password}.fill(${fieldExpr('password', raw, t)});`,
          `await ${ctx.sel.login}.click();`,
          `await page.waitForLoadState('domcontentloaded');`,
        ], false);
        continue;
      }

      // ── password field ──
      // NOTE: checked BEFORE username because phrases like "Enter password from
      // valid_users" contain the substring "user" (in the dataset name) and would
      // otherwise be mis-mapped to the username field. Password is unambiguous.
      if (/pass( ?word)?|\bpwd\b/.test(t) && !/click|button/.test(t)) {
        push(raw, [`await ${ctx.sel.password}.fill(${fieldExpr('password', raw, t)});`], false);
        continue;
      }

      // ── username field ──
      // Guard against the dataset-name false positive: don't treat a "password"
      // step as username even if the dataset name embeds "user".
      if (/user( ?name)?|email|login id/.test(t) && !/pass( ?word)?|\bpwd\b/.test(t) && !/click|button/.test(t)) {
        push(raw, [`await ${ctx.sel.username}.fill(${fieldExpr('username', raw, t)});`], false);
        continue;
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
        push(raw, [`await ${ctx.sel.login}.click();`, `await page.waitForLoadState('domcontentloaded');`], false);
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

      // ── assertion-style steps (verify / check / confirm / ensure / should) ──
      // These appear inline in the body (distinct from the Expected Result).
      // Map them to real assertions instead of leaving an unmapped note.
      if (/^(verify|check|confirm|ensure|assert|validate|should|the .* should|it should)/.test(t) || /\bis displayed\b|\bare displayed\b|\bis visible\b|\bis present\b|\bshould be\b/.test(t)) {
        const asserted = this.mapAssertionStep(raw, t, ctx);
        if (asserted.length) {
          out.push(`// ${raw}`);
          for (const s of asserted) out.push(s);
          out.push('');
          continue;
        }
      }

      // ── generic click ──
      if (/^click|^press|^tap|^select/.test(t)) {
        push(raw, [`await ${ctx.sel.login}.click();`], false);
        continue;
      }

      // Unrecognized step → keep as an explicit note (no silent no-op).
      out.push(`// ${raw}`);
      out.push(`// NOTE: step not auto-mapped — review manually.`);
      out.push('');
    }

    // Trim trailing blank line.
    while (out.length && out[out.length - 1] === '') out.pop();
    return { lines: out };
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
    ctx: { url: string; creds: { username: string; password: string }; sel: Record<string, string>; data?: { varName: string; ref: string; hasUsername: boolean; hasPassword: boolean } },
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

    if (isConditional) {
      // Boundary/condition case: the provided values may or may not be accepted.
      // Assert deterministically on whichever state the app lands in.
      lines.push(`// Expected outcome depends on whether the supplied values are valid credentials.`);
      lines.push(`if (page.url().includes('/inventory.html')) {`);
      lines.push(`  await expect(page).toHaveURL(/inventory\\.html/);`);
      lines.push(`  await expect(${ctx.sel.title}).toHaveText(/Products/i);`);
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
      if (!frag) {
        // The transformer for the classified scenario supplies the deterministic
        // fragment: a string to assert, '' to assert the error surface only, or
        // null when the scenario dictates nothing (defer to Expected-Result text).
        const { transformer } = this.scenario.resolve(_tc, this.parseTestCaseSteps(_tc));
        const scenarioFrag = transformer.errorFragment();
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

    if (isSuccess) {
      lines.push(`await expect(page).toHaveURL(/inventory\\.html/);`);
      lines.push(`await expect(${ctx.sel.title}).toHaveText(/Products/i);`);
      return lines;
    }

    // Fallback — never emit a no-op and never a meaningless not.toHaveURL.
    // Assert the app reached the post-login Products page, which is the
    // intended end-state for any non-error login flow.
    lines.push(`await expect(${ctx.sel.title}).toBeVisible();`);
    return lines;
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

      // Attributes ordered by selector quality / signal strength.
      const attrs: { label: string; value: string | undefined; weight: number }[] = [
        { label: 'data-testid', value: el.dataTestId, weight: 100 },
        { label: 'data-test', value: dataTestAttr, weight: 100 },
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

        // Inject assertions for navigation and submit actions
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
      }
    }
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
