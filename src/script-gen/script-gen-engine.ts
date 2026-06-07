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
import { PageCrawler, type CrawlResult, type CrawlConfig, type PageElement } from './page-crawler';
import type { AuthConfig, AuthResult } from './auth-engine';
import { WorkflowMapper, type WorkflowMap, type WorkflowFlow, type WorkflowStep, type WorkflowAction } from './workflow-mapper';
import { SelectorQualityEngine, type ScoredSelector } from './selector-quality-engine';
import { buildStabilityProvider, trackGeneratedSelector } from '../services/intelligence-learning-service';
import { getCrawlAdaptationForUrl } from '../services/crawl-adaptation-service';
import { AssertionEngine, type GeneratedAssertion } from './assertion-engine';
import { WaitStrategyEngine, type WaitStrategy } from './wait-strategy-engine';
import { logger } from '../utils/logger';
import type { RepositoryProfile, ClassInfo } from '../context/types';
import { extractSelectorInfo } from '../context/ast-analyzer';
import { analyzeRepoStructure, buildPageObjectFileName, buildSpecFileName } from './repo-analyzer';
import type { RepoStructureAnalysis } from './repo-analyzer';
import { adaptiveGenerateFiles } from './adaptive-codegen';

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
}

/* -------------------------------------------------------------------------- */
/*  Script Generation Engine                                                   */
/* -------------------------------------------------------------------------- */

export class ScriptGenEngine {
  private readonly openai: OpenAI;
  private readonly model: string;
  private readonly selectorEngine = new SelectorQualityEngine();
  private readonly assertionEngine = new AssertionEngine();
  private readonly waitEngine = new WaitStrategyEngine();
  private readonly workflowMapper = new WorkflowMapper();

  constructor(config?: { apiKey?: string; model?: string }) {
    const apiKey = config?.apiKey || process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY is required for script generation');
    this.openai = new OpenAI({ apiKey });
    this.model = config?.model || 'gpt-4o-mini';
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
      crawlResult = {
        url: config.cachedCrawlData.url || config.url,
        finalUrl: config.cachedCrawlData.finalUrl || config.url,
        title: config.cachedCrawlData.title || '',
        pageType: config.cachedCrawlData.pageType || 'unknown',
        pageTypeConfidence: config.cachedCrawlData.pageTypeConfidence || 0.5,
        elements: config.cachedCrawlData.elements || [],
        forms: config.cachedCrawlData.forms || [],
        navigationLinks: config.cachedCrawlData.navigationLinks || [],
        buttons: config.cachedCrawlData.buttons || [],
        inputs: config.cachedCrawlData.inputs || [],
        headings: config.cachedCrawlData.headings || [],
        htmlSnapshot: config.cachedCrawlData.htmlSnapshot || '',
        totalElements: config.cachedCrawlData.totalElements || 0,
        interactiveElements: config.cachedCrawlData.interactiveElements || 0,
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
    };

    logger.info(MOD, 'Script generation complete', result.stats);
    return result;
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Step 4: AI Test Plan Generation                                        */
  /* ──────────────────────────────────────────────────────────────────────── */

  private async generateTestPlan(
    crawl: CrawlResult,
    workflowMap: WorkflowMap,
    config: GenerationConfig,
    avgSelectorScore: number,
  ): Promise<TestPlan> {
    // Build concise DOM summary for AI
    const domSummary = this.buildDOMSummary(crawl);
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
  if (config.repoIntelligence) {
    console.log(`[ScriptGenEngine] 🧠 Injecting repository intelligence into AI prompt (${config.repoIntelligence.length} chars)`);
    return `\n--- REPOSITORY INTELLIGENCE ---\nThe target repo already has existing tests. Match its style, reuse its helpers/page-objects, and follow its conventions:\n\n${config.repoIntelligence}\n--- END REPOSITORY INTELLIGENCE ---`;
  }
  console.log('[ScriptGenEngine] ℹ️ No repository intelligence available for this generation');
  return '';
})()}
${config.fusionContext ? `\n--- FUSED INTELLIGENCE ---\nAdditional intelligence from across the platform. Use it to improve reliability:\n\n${config.fusionContext}\n--- END FUSED INTELLIGENCE ---` : ''}

Generate comprehensive test flows covering all detected functionality.`;

    try {
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

      const content = response.choices[0]?.message?.content || '{}';
      const parsed = JSON.parse(content);
      const tokens = response.usage?.total_tokens || 0;

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
          model: this.model,
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
      // Attributes ordered by selector quality / signal strength.
      const attrs: { label: string; value: string | undefined; weight: number }[] = [
        { label: 'data-testid', value: el.dataTestId, weight: 100 },
        { label: 'id', value: el.id, weight: 95 },
        { label: 'name', value: el.name, weight: 90 },
        { label: 'aria-label', value: el.ariaLabel, weight: 85 },
        { label: 'placeholder', value: el.placeholder, weight: 70 },
        { label: 'label', value: el.nearbyLabel, weight: 65 },
        { label: 'text', value: el.textContent, weight: 50 },
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
        content: this.maybeAddAuthImport(this.generatePageObject(po, config), config),
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
        content: this.maybeAddAuthImport(this.generateTestSpec(flow, testPlan, config), config),
        type: 'test',
      });
    }

    // 3. Fixtures — a functional artifact (test data the generated specs rely
    //    on), NOT a scaffold file. Generated only if the plan needs them and the
    //    repo lacks them. Always logged.
    if (testPlan.fixtures.length > 0) {
      if (!analysis?.hasFixtures) {
        files.push({
          path: 'fixtures/test-fixtures.ts',
          content: this.maybeAddAuthImport(this.generateFixtures(testPlan.fixtures, config), config),
          type: 'fixture',
        });
        logger.debug(MOD, 'Scaffold decision: fixtures/test-fixtures.ts → GENERATE', {
          reason: 'test plan declares fixtures and repo has none',
        });
      } else {
        skipped.push('fixtures/test-fixtures.ts (repo already has fixtures)');
      }
    }

    // 3b. Auth fixture (Fix #3) — when the connected repo profile carries real
    //     credentials and/or a base URL, emit `fixtures/auth.ts` so generated
    //     specs can import concrete `testCredentials`/`baseUrl` instead of
    //     relying on un-provisioned environment variables. Skipped silently for
    //     greenfield runs where no credentials are available.
    if (this.credsAvailable(config)) {
      const alreadyEmitted = files.some(f => f.path === 'fixtures/auth.ts');
      if (!alreadyEmitted) {
        files.push({
          path: 'fixtures/auth.ts',
          content: this.generateAuthFixture(config),
          type: 'fixture',
        });
        logger.info(MOD, '🔐 Emitting fixtures/auth.ts with injected credentials/baseUrl', {
          hasUsername: !!config.credentials?.username,
          hasBaseUrl: !!config.url,
        });
        console.log('[ScriptGenEngine] 🔐 Generated fixtures/auth.ts (credentials + baseUrl injected from repo profile)');
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
        path: 'utils/test-helpers.ts',
        repoHas: !!analysis?.hasUtils,
        build: () => ({ path: 'utils/test-helpers.ts', content: this.generateTestHelpers(), type: 'util' }),
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
    const pageObjects = config.repoProfile?.pageObjects;
    if (!Array.isArray(pageObjects) || pageObjects.length === 0) return null;

    try {
      const wanted = this.normalizePageObjectName(po.name);
      // 1) Exact normalized name match.
      let hit = pageObjects.find(c => this.normalizePageObjectName(c.name) === wanted);
      // 2) Containment match (LoginPage vs Login / SignInPage).
      if (!hit) {
        hit = pageObjects.find(c => {
          const n = this.normalizePageObjectName(c.name);
          return n.length > 2 && wanted.length > 2 && (n.includes(wanted) || wanted.includes(n));
        });
      }
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
  private maybeAddAuthImport(content: string, config?: GenerationConfig): string {
    if (!this.credsAvailable(config)) return content;
    const needs = /\btestCredentials\b/.test(content) || /\bbaseUrl\b/.test(content);
    if (!needs) return content;
    if (/from '[^']*fixtures\/auth'/.test(content)) return content; // already imported

    const importLine = `import { testCredentials, baseUrl } from '../fixtures/auth';`;
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
      case 'navigate':
        // Fix #3: when a profile base URL/credentials are present, use the
        // injected `baseUrl` fixture instead of a process.env lookup.
        if (useFixtures) {
          return `await page.goto(baseUrl);\n    await page.waitForLoadState('domcontentloaded');`;
        }
        return `await page.goto(process.env.BASE_URL || '${step.target || ''}');\n    await page.waitForLoadState('domcontentloaded');`;

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

      case 'assert':
        return `// Assert: ${step.description}`;

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
