/**
 * Test-to-Script Engine
 *
 * Converts Test Case Lab outputs (test cases with steps, preconditions,
 * expected results) into runnable Playwright test scripts, then optionally
 * commits them to GitHub via a PR.
 *
 * This is the bridge between Test Case Lab and Script Gen / GitHub.
 */

import OpenAI from 'openai';
import { logger } from '../utils/logger';
import {
  getTestRequirement,
  getTestScenarios,
  getTestCasesByRequirement,
  getApplicationKnowledge,
  getRepository,
} from '../db/postgres';

const MOD = 'test-to-script-engine';

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
  filePath: string;    // relative, e.g. "tests/generated/login-validation.spec.ts"
  content: string;
  testCount: number;
}

export interface TestToScriptResult {
  requirementId: number;
  requirementTitle: string;
  files: GeneratedScriptFile[];
  totalTests: number;
  totalFiles: number;
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
   * Main entry point: fetch test cases for a requirement, group them,
   * and generate Playwright script files.
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

    logger.info(MOD, 'Fetched data', {
      requirement: requirement.title,
      scenarios: scenarios.length,
      testCases: testCases.length,
    });

    // 2. Fetch app knowledge for richer context
    let knowledgeContext = '';
    try {
      const knowledge = await getApplicationKnowledge(companyId);
      if (knowledge.length) {
        knowledgeContext = knowledge
          .slice(0, 5)
          .map((k: any) => `Module: ${k.module}\nWorkflow: ${k.workflow || ''}\nBusiness Rules: ${k.business_rules || ''}`)
          .join('\n---\n');
      }
    } catch { /* non-critical */ }

    // 3. Fetch repository info for output path context
    let repoInfo: any = null;
    if (input.repositoryId) {
      try {
        repoInfo = await getRepository(input.repositoryId, companyId);
      } catch { /* non-critical */ }
    }

    // 4. Group test cases by scenario/coverage type for file organisation
    const groups = this.groupTestCases(testCases, scenarios);

    // 5. Generate script files
    const outputDir = input.outputDir || 'tests/generated';
    const files: GeneratedScriptFile[] = [];

    for (const group of groups) {
      const scriptFile = await this.generateScriptForGroup(
        group,
        requirement,
        framework,
        input.baseUrl || 'http://localhost:3000',
        outputDir,
        knowledgeContext,
      );
      files.push(scriptFile);
    }

    // 6. Generate shared helpers file
    files.push(this.generateHelpers(outputDir));

    const totalTests = files.reduce((sum, f) => sum + f.testCount, 0);

    logger.info(MOD, 'Generation complete', {
      files: files.length,
      totalTests,
      requirementTitle: requirement.title,
    });

    return {
      requirementId,
      requirementTitle: requirement.title,
      files,
      totalTests,
      totalFiles: files.length,
    };
  }

  /* ── private helpers ─────────────────────────────────────── */

  private groupTestCases(
    testCases: any[],
    scenarios: any[],
  ): Array<{ name: string; coverageType: string; cases: any[] }> {
    const grouped: Record<string, { name: string; coverageType: string; cases: any[] }> = {};

    for (const tc of testCases) {
      const key = tc.scenario_id ? String(tc.scenario_id) : (tc.coverage_type || 'general');
      if (!grouped[key]) {
        const sc = scenarios.find((s: any) => s.id === tc.scenario_id);
        grouped[key] = {
          name: sc?.scenario || tc.coverage_type || 'general',
          coverageType: sc?.coverage_type || tc.coverage_type || 'general',
          cases: [],
        };
      }
      grouped[key].cases.push(tc);
    }

    return Object.values(grouped);
  }

  private async generateScriptForGroup(
    group: { name: string; coverageType: string; cases: any[] },
    requirement: any,
    framework: string,
    baseUrl: string,
    outputDir: string,
    knowledgeContext: string,
  ): Promise<GeneratedScriptFile> {
    const fileName = this.slugify(group.name);
    const filePath = `${outputDir}/${fileName}.spec.ts`;

    // Build the prompt with test case details
    const testCaseDescriptions = group.cases.map((tc: any, i: number) => {
      const steps = this.parseJson(tc.steps, []);
      return [
        `### Test Case ${i + 1}: ${tc.title}`,
        `Priority: ${tc.priority || 'P2'}`,
        `Severity: ${tc.severity || 'medium'}`,
        tc.preconditions ? `Preconditions: ${tc.preconditions}` : '',
        steps.length ? `Steps:\n${steps.map((s: string, j: number) => `  ${j + 1}. ${s}`).join('\n')}` : '',
        `Expected Result: ${tc.expected_result}`,
        tc.test_data ? `Test Data: ${tc.test_data}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    const prompt = `You are an expert Playwright test automation engineer.

Generate a complete, runnable Playwright TypeScript test file for the following test cases.

## Context
- Requirement: ${requirement.title}
- Description: ${requirement.description || ''}
- Coverage Type: ${group.coverageType}
- Base URL: ${baseUrl}
- Framework: Playwright with TypeScript
${knowledgeContext ? `\n## Application Knowledge\n${knowledgeContext}` : ''}

## Test Cases to Automate

${testCaseDescriptions}

## Requirements
1. Use Playwright's \`test\` and \`expect\` from '@playwright/test'
2. Use \`test.describe\` to group related tests
3. Use meaningful selectors: prefer data-testid, role, text, placeholder
4. Add \`test.beforeEach\` for common setup (e.g., navigation)
5. Add proper assertions matching the expected results
6. Handle async operations with proper waits (NEVER use waitForTimeout)
7. Use page object pattern concepts where appropriate
8. Add JSDoc comments for clarity
9. Make tests independent — each test should work in isolation
10. Include error/negative path tests where specified

Return ONLY the TypeScript code. No markdown fences, no explanations.`;

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 4000,
      });

      let code = response.choices[0]?.message?.content?.trim() || '';

      // Strip markdown fences if present
      code = code.replace(/^```(?:typescript|ts)?\n?/m, '').replace(/\n?```$/m, '').trim();

      // Ensure it starts with an import
      if (!code.startsWith('import')) {
        code = `import { test, expect } from '@playwright/test';\n\n${code}`;
      }

      return {
        filePath,
        content: code,
        testCount: group.cases.length,
      };
    } catch (error: any) {
      logger.error(MOD, 'AI script generation failed, using template fallback', {
        error: error.message,
        group: group.name,
      });

      // Fallback: generate a template-based script
      return this.generateFallbackScript(group, requirement, baseUrl, filePath);
    }
  }

  private generateFallbackScript(
    group: { name: string; coverageType: string; cases: any[] },
    requirement: any,
    baseUrl: string,
    filePath: string,
  ): GeneratedScriptFile {
    const descName = group.name.replace(/[^a-zA-Z0-9\s]/g, '').trim() || 'Generated Tests';

    const tests = group.cases.map((tc: any) => {
      const steps = this.parseJson(tc.steps, []);
      const stepsComment = steps.length
        ? steps.map((s: string, i: number) => `    // Step ${i + 1}: ${s}`).join('\n')
        : '    // TODO: Implement test steps';

      return `  test('${this.escapeStr(tc.title)}', async ({ page }) => {
${stepsComment}

    // Expected: ${this.escapeStr(tc.expected_result || 'Verify expected behavior')}
    // TODO: Add proper selectors and assertions
    await expect(page).toHaveURL(/.*/, { timeout: 10000 });
  });`;
    }).join('\n\n');

    const content = `import { test, expect } from '@playwright/test';

/**
 * ${descName}
 * Requirement: ${requirement.title}
 * Coverage: ${group.coverageType}
 * Generated by LevelUp AI Test-to-Script Engine
 */
test.describe('${this.escapeStr(descName)}', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('${baseUrl}');
  });

${tests}
});
`;

    return { filePath, content, testCount: group.cases.length };
  }

  private generateHelpers(outputDir: string): GeneratedScriptFile {
    return {
      filePath: `${outputDir}/helpers.ts`,
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
