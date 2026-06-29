/**
 * Integration Test — End-to-end self-heal regression for the `spec_load_error`
 * production incident.
 * ============================================================================
 *
 * This exercises the EXACT path that failed in production:
 *
 *     broken locator (#username in a Page Object)
 *          ↓  RuleEngine                 (deterministic heal suggestions)
 *          ↓  CodePatcher.applyHealingFix (writes the heal into source)
 *          ↓  write patched .ts to disk   (the "patch file")
 *          ↓  TypeScript compile          (the step that BROKE in prod →
 *          ↓                               spec_load_error / Tests=0 / exit 1)
 *          ↓  transpile + require module
 *          ↓  Playwright rerun against a live DOM fixture
 *          ↓  PASS  (healed locator actually resolves & fills the field)
 *
 * Before the kind-safety fix, the patcher embedded a full locator EXPRESSION
 * (page.locator('[data-test="username"]')) inside the existing selector STRING
 * slot of this.page.locator('#username'), producing:
 *     this.page.locator('page.locator('[data-test="username"]')')
 * which is invalid TypeScript → every spec failed to import → 0 tests ran.
 * A "negative control" below proves that corrupted shape does NOT compile,
 * and the main flow proves the fixed patcher compiles AND reruns green.
 */

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as ts from 'typescript';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { chromium, type Browser } from 'playwright';

import { RuleEngine } from '../../src/engines/rule-engine';
import { CodePatcher, type HealingFix } from '../../src/services/code-patcher';
import type { FailureDetails } from '../../src/core/failure-analyzer';

/* -------------------------------------------------------------------------- */
/*  The broken Page Object (mirrors LevelUpAI_SauceDemo/pages/LoginPage.ts).  */
/* -------------------------------------------------------------------------- */

const BROKEN_POM = `import type { Page, Locator } from 'playwright';

export class LoginPage {
  private readonly page: Page;
  username: Locator;

  constructor(page: Page) {
    this.page = page;
    this.username = this.page.locator('#username');
  }

  async fillUsername(value: string): Promise<void> {
    await this.username.fill(value);
  }

  async usernameValue(): Promise<string> {
    return this.username.inputValue();
  }
}
`;

/** Count parser-level syntax errors (the kind that break spec imports). */
function parseErrorCount(src: string): number {
  const sf = ts.createSourceFile('LoginPage.ts', src, ts.ScriptTarget.Latest, true);
  // @ts-expect-error parseDiagnostics is internal but populated by the parser
  return (sf.parseDiagnostics || []).length;
}

/** Transpile TS → CJS JS and surface any syntactic diagnostics. */
function transpile(src: string): { js: string; diagnostics: number } {
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019 },
    reportDiagnostics: true,
  });
  return { js: out.outputText, diagnostics: (out.diagnostics || []).length };
}

describe('E2E: broken locator → RuleEngine → CodePatcher → compile → Playwright rerun → PASS', () => {
  let browser: Browser;
  let tmpDir: string;

  beforeAll(async () => {
    browser = await chromium.launch({ args: ['--no-sandbox'] });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-e2e-'));
  });

  afterAll(async () => {
    if (browser) await browser.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('negative control: the OLD double-wrapped patch is invalid TS (reproduces spec_load_error)', () => {
    const corrupted = BROKEN_POM.replace(
      `this.page.locator('#username')`,
      `this.page.locator('page.locator('[data-test="username"]')')`,
    );
    // This is exactly what shipped to prod — it must NOT compile.
    expect(parseErrorCount(corrupted)).toBeGreaterThan(0);
  });

  it('the fixed pipeline heals #username, compiles cleanly, and the healed locator works in a real browser', async () => {
    /* 1 ── RuleEngine participates: a broken #username yields heal candidates. */
    const failure: FailureDetails = {
      testName: 'login as standard user',
      failureType: 'locator',
      failedLocator: '#username',
      errorMessage: "Timeout: locator '#username' not found",
      errorPattern: 'locator_not_found',
      filePath: 'pages/LoginPage.ts',
      lineNumber: 9,
      failedLineCode: "this.username = this.page.locator('#username');",
      surroundingCode: 'class LoginPage { username ... }',
      screenshotPath: null,
      url: 'https://www.saucedemo.com/',
      timestamp: new Date().toISOString(),
      isTimingIssue: false,
    };
    const engineResult = new RuleEngine().generate(failure);
    expect(engineResult.suggestions.length).toBeGreaterThan(0);

    /* 2 ── The grounded heal for SauceDemo is the data-test attribute. This is
     *      delivered to the patcher as a FULL expression (the exact shape that
     *      triggered the prod corruption). */
    const fix: HealingFix = {
      testName: failure.testName,
      failedLocator: '#username',
      healedLocator: `page.locator('[data-test="username"]')`,
      strategy: 'dom_grounded',
      confidence: 0.96,
      filePath: 'pages/LoginPage.ts',
    };

    /* 3 ── Apply the patch. */
    const patch = new CodePatcher().applyHealingFix(BROKEN_POM, fix);
    expect(patch.patched).toBe(true);
    // The healed selector is written as a bare selector in the existing slot —
    // NOT a nested expression.
    expect(patch.patchedCode).toContain(`this.page.locator('[data-test="username"]')`);
    expect(patch.patchedCode).not.toContain(`locator('page.locator(`);

    /* 4 ── The patch file compiles (the step that failed in prod). */
    expect(parseErrorCount(patch.patchedCode)).toBe(0);
    const { js, diagnostics } = transpile(patch.patchedCode);
    expect(diagnostics).toBe(0);

    /* 5 ── Write & require the patched module (a real "spec load"). */
    const jsPath = path.join(tmpDir, 'LoginPage.js');
    fs.writeFileSync(jsPath, js, 'utf-8');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { LoginPage } = require(jsPath);
    expect(typeof LoginPage).toBe('function');

    /* 6 ── Playwright rerun against a live DOM fixture using the data-test attr. */
    const page = await browser.newPage();
    try {
      await page.setContent(
        `<html><body><form>
           <input data-test="username" type="text" />
           <input data-test="password" type="password" />
         </form></body></html>`,
      );
      const loginPage = new LoginPage(page);
      await loginPage.fillUsername('standard_user');
      /* 7 ── PASS: the healed locator resolved and filled the field. */
      expect(await loginPage.usernameValue()).toBe('standard_user');
    } finally {
      await page.close();
    }
  }, 60_000);
});
