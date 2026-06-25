/**
 * Unit tests — Repo Intelligence Healing classifier (Phase 4 / PR #160)
 * =====================================================================
 * Proves the deterministic "is the failing file a Page Object?" gate works from
 * path + source AST alone (no DB), and that specs are correctly excluded so we
 * never mistake a test file for a shared abstraction.
 *
 * Run: npx tsx tests/unit/repo-intelligence-healing.test.ts
 */

import assert from 'node:assert';
import {
  isSpecPath,
  looksLikePageObjectPath,
  classifySource,
  classifyFailureFile,
} from '../../src/services/repo-intelligence-healing';
import { pageObjectPatchLogFields } from '../../src/core/healing-orchestrator';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: any) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

/* ---- 1. isSpecPath ---- */
console.log('isSpecPath:');
check('login.spec.ts is a spec', isSpecPath('tests/login.spec.ts'));
check('checkout.test.js is a spec', isSpecPath('e2e/checkout.test.js'));
check('helper under tests/ is NOT a spec (filename-only)', !isSpecPath('tests/helpers/foo.ts'));
check('LoginPage.ts is NOT a spec', !isSpecPath('pages/LoginPage.ts'));

/* ---- 2. looksLikePageObjectPath ---- */
console.log('\nlooksLikePageObjectPath:');
check('pages/LoginPage.ts', looksLikePageObjectPath('src/pages/LoginPage.ts'));
check('login.page.ts', looksLikePageObjectPath('e2e/login.page.ts'));
check('po/Cart.po.ts', looksLikePageObjectPath('po/Cart.po.ts'));
check('support/loginHelper.ts', looksLikePageObjectPath('cypress/support/loginHelper.ts'));
check('a plain spec is rejected', !looksLikePageObjectPath('tests/login.spec.ts'));
check('a random util is rejected', !looksLikePageObjectPath('src/utils/math.ts'));

/* ---- 3. classifySource (AST) ---- */
console.log('\nclassifySource:');
const loginPagePO = `
import { Page } from '@playwright/test';
export class LoginPage {
  constructor(private page: Page) {}
  async login(user: string, pass: string) {
    await this.page.fill('#user-name', user);
    await this.page.fill('#password', pass);
    await this.page.locator('#login-button').click();
  }
  async assertError() {
    await this.page.getByRole('alert');
  }
}`;
const c1 = classifySource(loginPagePO, 'pages/LoginPage.ts', "this.page.locator('#login-button')");
check('PO class detected', c1.isPageObject);
check('class name = LoginPage', c1.className === 'LoginPage', c1.className);
check('owning method pinpointed = login', c1.methodName === 'login', c1.methodName);

const specFile = `
import { test, expect } from '@playwright/test';
test('user can log in', async ({ page }) => {
  await page.locator('#login-button').click();
  await expect(page).toHaveURL(/inventory/);
});`;
const c2 = classifySource(specFile, 'tests/login.spec.ts', "page.locator('#login-button')");
check('spec file is NOT a page object', !c2.isPageObject);

const plainUtil = `export function add(a: number, b: number) { return a + b; }`;
check('plain util (no locators) is NOT a page object',
  !classifySource(plainUtil, 'src/utils/math.ts').isPageObject);

const helperModule = `
import { Page } from '@playwright/test';
export async function login(page: Page, u: string, p: string) {
  await page.locator('#login-button').click();
}`;
check('function-style helper with locators IS a page object/helper',
  classifySource(helperModule, 'support/auth-helper.ts').isPageObject);

/* ---- 4. classifyFailureFile end-to-end (no DB available in unit env) ---- */
console.log('\nclassifyFailureFile (source-driven, DB returns []):');
(async () => {
  const spec = await classifyFailureFile({ filePath: 'tests/login.spec.ts', source: specFile });
  check('spec → not a page object', !spec.isPageObject && spec.source === null);

  const po = await classifyFailureFile({
    filePath: 'pages/LoginPage.ts',
    source: loginPagePO,
    brokenLocator: "this.page.locator('#login-button')",
  });
  check('PO via source AST → isPageObject', po.isPageObject);
  check('PO source label = source_ast', po.source === 'source_ast', po.source);
  check('PO reasoning mentions the class', /LoginPage/.test(po.reasoning), po.reasoning);

  const byPath = await classifyFailureFile({ filePath: 'src/pages/CheckoutPage.ts' });
  check('no source → path heuristic fires', byPath.isPageObject && byPath.source === 'path_heuristic');

  const randomNoSource = await classifyFailureFile({ filePath: 'src/utils/math.ts' });
  check('random file, no source → not a page object', !randomNoSource.isPageObject);

  // AST is positive-only: an inconclusive snippet must NOT suppress the path
  // heuristic for a conventionally-named Page Object.
  const snippetPO = await classifyFailureFile({
    filePath: 'src/pages/LoginPage.ts',
    source: "const timeout = this.defaultTimeout + 1000;",
  });
  check('PO path + inconclusive snippet → still a page object (path heuristic)',
    snippetPO.isPageObject && snippetPO.source === 'path_heuristic', snippetPO.source);

  const snippetNonPO = await classifyFailureFile({
    filePath: 'src/utils/math.ts',
    source: "return a + b;",
  });
  check('non-PO path + snippet → not a page object', !snippetNonPO.isPageObject);

  /* ---- 7. pageObjectPatchLogFields (orchestrator persistence mapping) ---- */
  console.log('\npageObjectPatchLogFields:');
  const logNone = pageObjectPatchLogFields({ pageObjectPatch: undefined });
  check('no patch → not a page object patch', logNone.is_page_object_patch === false);
  check('no patch → null target file', logNone.target_file_path === null);
  check('no patch → null target line', logNone.target_line === null);
  check('no patch → zero impact', logNone.page_object_impact === 0);

  const logPo = pageObjectPatchLogFields({
    pageObjectPatch: {
      targetFile: 'pages/LoginPage.ts',
      targetLine: 42,
      className: 'LoginPage',
      methodName: 'login',
      impactedTests: 7,
      source: 'method_index',
      reasoning: 'x',
    },
  });
  check('PO patch → flagged true', logPo.is_page_object_patch === true);
  check('PO patch → target file threaded', logPo.target_file_path === 'pages/LoginPage.ts');
  check('PO patch → target line threaded', logPo.target_line === 42);
  check('PO patch → impact threaded', logPo.page_object_impact === 7);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
})();
