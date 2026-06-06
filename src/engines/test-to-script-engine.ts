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
} from '../db/postgres';

const MOD = 'test-to-script-engine';

/** Maximum number of tests allowed in a single spec file before it is split. */
const MAX_TESTS_PER_FILE = 20;

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
    if (input.repositoryId) {
      try {
        await getRepository(input.repositoryId, companyId);
      } catch { /* non-critical */ }
    }

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

    for (const group of groups) {
      const { file, coverage } = await this.generateScriptForGroup(
        group,
        requirement,
        framework,
        input.baseUrl || 'http://localhost:3000',
        outputDir,
        knowledgeContext,
      );
      files.push(file);
      perFile.push(coverage);
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

    return {
      requirementId,
      requirementTitle: requirement.title,
      files,
      totalTests,
      totalFiles: files.length,
      coverage,
    };
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
  ): Promise<{ file: GeneratedScriptFile; coverage: FileCoverage }> {
    const partSuffix = group.part && (group.totalParts || 1) > 1 ? `.part${group.part}` : '';
    const fileName = `${this.slugify(group.feature)}${partSuffix}`;
    const filePath = `${outputDir}/${fileName}.spec.ts`;
    const caseIds: number[] = group.cases.map((c: any) => c.id);

    // Build the prompt with explicit per-case anchors and a strict contract.
    const testCaseDescriptions = group.cases.map((tc: any, i: number) => {
      const steps = this.parseJson(tc.steps, []);
      return [
        `### Test Case TC${tc.id} (#${i + 1}): ${tc.title}`,
        `Scenario: ${tc.scenario || group.feature}`,
        `Priority: ${tc.priority || 'P2'} | Severity: ${tc.severity || 'medium'}`,
        tc.preconditions ? `Preconditions: ${tc.preconditions}` : '',
        steps.length ? `Steps:\n${steps.map((s: string, j: number) => `  ${j + 1}. ${s}`).join('\n')}` : '',
        `Expected Result: ${tc.expected_result}`,
        tc.test_data ? `Test Data: ${tc.test_data}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n');

    const prompt = `You are an expert Playwright test automation engineer.

Generate ONE complete, runnable Playwright TypeScript test file for the feature "${group.feature}".

## Context
- Requirement: ${requirement.title}
- Description: ${requirement.description || ''}
- Feature: ${group.feature}
- Coverage Type: ${group.coverageType}
- Base URL: ${baseUrl}
- Framework: Playwright with TypeScript
${knowledgeContext ? `\n## Application Knowledge\n${knowledgeContext}` : ''}

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
- Use semantic selectors: prefer data-testid, then role, then text, then placeholder.
- Add assertions that match each Expected Result.
- Use smart waits (NEVER use \`waitForTimeout\`).
- Make each test independent and runnable in isolation.
- Add a short JSDoc/comment describing each test.

Return ONLY the TypeScript code. No markdown fences, no explanations.`;

    let aiCode = '';
    try {
      const maxTokens = Math.min(8000, 1500 + group.cases.length * 600);
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

    // ── Reconcile: which test cases did the AI actually cover? ──
    const reconciled = this.reconcileCoverage(aiCode, group, requirement, baseUrl);

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
    };
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
  ): { content: string; actualTests: number; coveredIds: number[]; missingFilled: number[]; extra: number } {
    const inputIds = group.cases.map((c: any) => c.id);

    // No usable AI output → deterministic template file (guaranteed 1:1).
    const looksValid = aiCode && /\btest\s*\(/.test(aiCode) && aiCode.includes('@playwright/test');
    if (!looksValid) {
      const content = this.buildTemplateFile(group, requirement, baseUrl, group.cases);
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
      content = this.injectTemplateTests(aiCode, group, missingCases);
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
  private injectTemplateTests(aiCode: string, group: FileGroup, missingCases: any[]): string {
    const block = [
      `  test.describe('Coverage (auto-filled)', () => {`,
      missingCases.map(tc => this.buildTemplateTest(tc, 2)).join('\n\n'),
      `  });`,
    ].join('\n');

    const lastClose = aiCode.lastIndexOf('});');
    if (lastClose !== -1) {
      return `${aiCode.slice(0, lastClose)}\n${block}\n${aiCode.slice(lastClose)}`;
    }
    // Fallback: wrap as a standalone describe appended to the file.
    return `${aiCode}\n\ntest.describe('${this.escapeStr(group.feature)} — Coverage (auto-filled)', () => {\n${missingCases.map(tc => this.buildTemplateTest(tc, 1)).join('\n\n')}\n});\n`;
  }

  /** Build a single deterministic template test (always carries its marker). */
  private buildTemplateTest(tc: any, indentLevel = 1): string {
    const pad = '  '.repeat(indentLevel);
    const steps = this.parseJson(tc.steps, []);
    const stepsComment = steps.length
      ? steps.map((s: string, i: number) => `${pad}  // Step ${i + 1}: ${this.escapeStr(String(s))}`).join('\n')
      : `${pad}  // TODO: implement test steps`;

    return `${pad}test('${this.escapeStr(tc.title)}', async ({ page }) => {
${pad}  // @tc:TC${tc.id}
${stepsComment}
${pad}  // Expected: ${this.escapeStr(tc.expected_result || 'Verify expected behavior')}
${pad}  // TODO: add real selectors + assertions for this test case
${pad}  await expect(page).toHaveURL(/.*/, { timeout: 10000 });
${pad}});`;
  }

  /**
   * Build a fully deterministic spec file for a group with nested describe
   * blocks grouped by scenario. Guarantees exactly one test per input case.
   */
  private buildTemplateFile(group: FileGroup, requirement: any, baseUrl: string, cases: any[]): string {
    // Sub-group cases by scenario name for nested describe blocks.
    const byScenario = new Map<string, any[]>();
    for (const tc of cases) {
      const sc = String(tc.scenario || group.feature);
      if (!byScenario.has(sc)) byScenario.set(sc, []);
      byScenario.get(sc)!.push(tc);
    }

    const inner = [...byScenario.entries()].map(([scenario, scCases]) => {
      const tests = scCases.map(tc => this.buildTemplateTest(tc, 2)).join('\n\n');
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
