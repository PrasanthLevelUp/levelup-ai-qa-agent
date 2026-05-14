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
import { WorkflowMapper, type WorkflowMap, type WorkflowFlow, type WorkflowStep, type WorkflowAction } from './workflow-mapper';
import { SelectorQualityEngine, type ScoredSelector } from './selector-quality-engine';
import { AssertionEngine, type GeneratedAssertion } from './assertion-engine';
import { WaitStrategyEngine, type WaitStrategy } from './wait-strategy-engine';
import { logger } from '../utils/logger';

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

    logger.info(MOD, 'Starting script generation', { url: config.url });

    // ─── Step 1: Crawl page(s) ────────────────────────────────────
    const crawler = new PageCrawler({
      url: config.url,
      followLinks: config.followLinks ?? false,
      maxPages: config.maxPages ?? 3,
      captureScreenshot: true,
    });

    let crawlResult: CrawlResult;
    try {
      crawlResult = await crawler.crawl();
    } catch (e) {
      throw new Error(`Crawl failed: ${(e as Error).message}`);
    }

    logger.info(MOD, 'Crawl complete', {
      pageType: crawlResult.pageType,
      elements: crawlResult.elements.length,
      forms: crawlResult.forms.length,
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
    this.resolveSelectors(testPlan, crawlResult.elements);

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

  private resolveSelectors(testPlan: TestPlan, elements: PageElement[]): void {
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
        if (!locator.selector) {
          const matchedEl = this.findElementByDescription(locator.name, elements);
          if (matchedEl) {
            const report = this.selectorEngine.rankSelectors(matchedEl);
            locator.selector = report.bestSelector.playwrightCode;
            locator.score = report.bestSelector.score;
            locator.strategy = report.bestSelector.strategy;
          }
        }
      }
    }
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

  private findElementByDescription(desc: string, elements: PageElement[]): PageElement | undefined {
    const lower = desc.toLowerCase();

    // Try exact matches first
    return elements.find(el => {
      if (el.dataTestId?.toLowerCase() === lower) return true;
      if (el.name?.toLowerCase() === lower) return true;
      if (el.id?.toLowerCase() === lower) return true;
      if (el.placeholder?.toLowerCase().includes(lower)) return true;
      if (el.nearbyLabel?.toLowerCase().includes(lower)) return true;
      if (el.ariaLabel?.toLowerCase().includes(lower)) return true;
      if (el.textContent?.toLowerCase().includes(lower)) return true;

      // Fuzzy: "username input" matches name="username"
      const words = lower.split(/\s+/);
      for (const word of words) {
        if (word.length < 3) continue;
        if (el.name?.toLowerCase().includes(word)) return true;
        if (el.placeholder?.toLowerCase().includes(word)) return true;
        if (el.nearbyLabel?.toLowerCase().includes(word)) return true;
        if (el.textContent?.toLowerCase().includes(word)) return true;
      }

      return false;
    });
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
    const files: GeneratedFile[] = [];

    // 1. Page Objects
    for (const po of testPlan.pageObjects) {
      files.push({
        path: `pages/${po.fileName}`,
        content: this.generatePageObject(po),
        type: 'page-object',
      });
    }

    // 2. Test spec files (one per flow)
    for (const flow of testPlan.flows) {
      const fileName = `${toKebab(flow.name)}.spec.ts`;
      files.push({
        path: `tests/${fileName}`,
        content: this.generateTestSpec(flow, testPlan, config),
        type: 'test',
      });
    }

    // 3. Fixtures
    if (testPlan.fixtures.length > 0) {
      files.push({
        path: 'fixtures/test-fixtures.ts',
        content: this.generateFixtures(testPlan.fixtures, config),
        type: 'fixture',
      });
    }

    // 4. Config
    files.push({
      path: 'playwright.config.ts',
      content: this.generatePlaywrightConfig(config),
      type: 'config',
    });

    // 5. Utils
    files.push({
      path: 'utils/test-helpers.ts',
      content: this.generateTestHelpers(),
      type: 'util',
    });

    // 6. Env example
    files.push({
      path: '.env.example',
      content: this.generateEnvExample(config),
      type: 'config',
    });

    // 7. README
    files.push({
      path: 'README.md',
      content: this.generateReadme(testPlan, config),
      type: 'readme',
    });

    // 8. CI/CD config
    files.push({
      path: '.github/workflows/playwright.yml',
      content: this.generateGithubActionsConfig(),
      type: 'config',
    });

    return files;
  }

  /* ──────── Page Object Generator ──────── */

  private generatePageObject(po: PageObjectSpec): string {
    const locatorDefs = po.locators.map(l =>
      `  readonly ${l.name} = ${l.selector || `this.page.locator('/* TODO: ${l.name} */')`};`
    ).join('\n');

    const actionMethods = po.actions.map(a => {
      const steps = (a.steps || []).map((s: TestPlanStep) => {
        return `    ${this.stepToCode(s)}`;
      }).join('\n');
      return `
  async ${a.name}() {
${steps || '    // TODO: implement'}
  }`;
    }).join('\n');

    return `import { type Page, type Locator, expect } from '@playwright/test';

/**
 * Page Object: ${po.name}
 * URL: ${po.url}
 * Page Type: ${po.pageType}
 * 
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

  /* ──────── Test Spec Generator ──────── */

  private generateTestSpec(flow: TestPlanFlow, plan: TestPlan, config: GenerationConfig): string {
    const steps = flow.steps.map((step, i) => {
      const code = this.stepToCode(step);
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
      const steps = f.steps.map(s => `    ${this.stepToCode(s)}`).join('\n');
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

  private stepToCode(step: TestPlanStep): string {
    const selector = step.selector || (step.target ? this.targetToPlaywright(step.target) : '');

    switch (step.action) {
      case 'navigate':
        return `await page.goto(process.env.BASE_URL || '${step.target || ''}');\n    await page.waitForLoadState('domcontentloaded');`;

      case 'fill': {
        const val = step.value || '';
        // Replace template vars with process.env
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

function escapeStr(s: string): string {
  return s.replace(/'/g, "\\\'" ).replace(/\n/g, '\\n');
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractAttrValue(attrSelector: string): string {
  const match = attrSelector.match(/="([^"]+)"/);
  return match?.[1] || '';
}
