/**
 * ZIP-path Repository Intelligence + assertion quality.
 *
 * Covers the Reveiew.pdf findings for the Test Case Lab → generate-scripts ZIP
 * (TestToScriptEngine), which previously emitted raw page.locator(...) and weak
 * negative assertions:
 *   • Item 1 — Page Object reuse in the ZIP path (page-object-rewriter).
 *   • Item 2 — real negative assertions ([data-test="error"] toContainText).
 *   • Item 3 — semantic locator mismatch detection.
 *
 * Run: npx tsx tests/unit/zip-page-object-reuse.test.ts
 */
// Engine constructor instantiates an OpenAI client; the helpers under test make
// no network calls, so a placeholder key is sufficient for unit testing.
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-placeholder';

import {
  applyPageObjectReuse,
  matchPageObjects,
  buildPageObjectImportPath,
  findPoMethod,
  mergeRewriteReports,
} from '../../src/script-gen/page-object-rewriter';
import { TestToScriptEngine } from '../../src/engines/test-to-script-engine';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const repoProfile: any = {
  framework: 'playwright',
  language: 'typescript',
  pageObjects: [
    { name: 'LoginPage', filePath: 'src/pages/login.page.ts', methods: [{ name: 'login' }, { name: 'logout' }] },
    { name: 'CartPage', filePath: 'src/pages/cart.page.ts', methods: [{ name: 'addItemToCart' }, { name: 'openCart' }] },
    { name: 'CheckoutPage', filePath: 'src/pages/checkout.page.ts', methods: [{ name: 'completeCheckout' }] },
    { name: 'InventoryPage', filePath: 'src/pages/inventory.page.ts', methods: [{ name: 'verifyInventoryLoaded' }] },
  ],
};

// ── Item 1: helpers ────────────────────────────────────────────────────────
console.log('\n=== Item 1: import path + method validation ===');
check('Issue 2: import path from scanned filePath (tests/generated)',
  buildPageObjectImportPath('src/pages/login.page.ts', 'tests/generated') === '../../src/pages/login.page',
  buildPageObjectImportPath('src/pages/login.page.ts', 'tests/generated'));
check('Issue 2: import path for pages/ at root (tests)',
  buildPageObjectImportPath('pages/login.page.ts', 'tests') === '../pages/login.page',
  buildPageObjectImportPath('pages/login.page.ts', 'tests'));
check('Issue 1: findPoMethod returns real method name', findPoMethod(['login', 'logout'], /^log[_]?in$/i) === 'login');
check('Issue 1: findPoMethod returns null for absent method', findPoMethod(['logout'], /^log[_]?in$/i) === null);

console.log('\n=== Item 1: matchPageObjects (more than Login) ===');
const matched = matchPageObjects('Login then add item to cart and checkout', repoProfile, 'tests/generated');
check('Login matched', matched.some(p => p.kind === 'login'));
check('Cart matched', matched.some(p => p.kind === 'cart'));
check('Checkout matched', matched.some(p => p.kind === 'checkout'));
check('No profile → empty', matchPageObjects('login', null, 'tests').length === 0);

// ── Item 1: full rewrite of a login spec ───────────────────────────────────
console.log('\n=== Item 1: login triad → loginPage.login() ===');
const loginSpec = `import { test, expect } from '@playwright/test';
import { getRecord } from './data/test-data';

test.describe('Login', () => {
  test('Valid login with standard_user', async ({ page }) => {
    // @tc:TC1216
    await page.goto('https://www.saucedemo.com');
    const user = getRecord('valid_users', 'standard_user');
    await page.locator('#user-name').fill(user.username ?? '');
    await page.locator('#password').fill(user.password ?? '');
    await page.locator('#login-button').click();
    await page.waitForLoadState('networkidle');
    await expect(page).toHaveURL(/inventory/);
  });
});`;

const loginOut = applyPageObjectReuse(loginSpec, repoProfile, 'Valid login with standard_user', 'tests/generated');
check('LoginPage imported', loginOut.code.includes("import { LoginPage } from '../../src/pages/login.page';"),
  loginOut.code.split('\n').find(l => l.includes('LoginPage')) || '');
check('LoginPage instantiated', loginOut.code.includes('const loginPage = new LoginPage(page);'));
check('loginPage.login(...) emitted', /await loginPage\.login\(user\.username \?\? '', user\.password \?\? ''\);/.test(loginOut.code),
  loginOut.code.split('\n').find(l => l.includes('.login(')) || '');
check('raw #user-name fill removed', !loginOut.code.includes("locator('#user-name')"));
check('raw #password fill removed', !loginOut.code.includes("locator('#password')"));
check('raw #login-button click removed', !loginOut.code.includes("locator('#login-button')"));
check('dataset binding preserved (user.username)', loginOut.code.includes('user.username'));
check('report marks LoginPage used', loginOut.report.pageObjects.find(p => p.name === 'LoginPage')?.used === true);
check('report totalUsed = 1', loginOut.report.totalUsed === 1, String(loginOut.report.totalUsed));
check('report totalAvailable = 4', loginOut.report.totalAvailable === 4, String(loginOut.report.totalAvailable));

// ── Item 1: method validation guard (no hallucination) ─────────────────────
console.log('\n=== Item 1: method validation (no hallucinated login) ===');
const noLoginMethodProfile: any = {
  pageObjects: [{ name: 'LoginPage', filePath: 'src/pages/login.page.ts', methods: [{ name: 'submitCredentials' }] }],
};
const noMethodOut = applyPageObjectReuse(loginSpec, noLoginMethodProfile, 'login', 'tests/generated');
check('No login() method → NOT collapsed', !noMethodOut.code.includes('.login('));
check('No login() method → raw fills preserved', noMethodOut.code.includes("locator('#user-name')"));
check('No login() method → totalUsed = 0', noMethodOut.report.totalUsed === 0);

// ── Item 1: merge across files ─────────────────────────────────────────────
console.log('\n=== Item 1: mergeRewriteReports ===');
const merged = mergeRewriteReports([loginOut.report, noMethodOut.report]);
check('merged present', !!merged);
check('merged LoginPage used (any file used it)', merged!.pageObjects.find(p => p.name === 'LoginPage')?.used === true);

// ── Item 2 + 3: engine private helpers ─────────────────────────────────────
const engine: any = new TestToScriptEngine();

console.log('\n=== Item 2: negative assertions ===');
const invalidTc = { id: 1, title: 'Login with invalid credentials', expected_result: 'An error message is displayed', test_data: 'invalid_user' };
const lockedTc = { id: 2, title: 'Login with locked_out_user', expected_result: 'Error message should be displayed' };
const validTc = { id: 3, title: 'Valid login', expected_result: 'User is redirected to the inventory page' };

check('invalid case is negative', engine.isNegativeCase(invalidTc) === true);
check('locked case is negative', engine.isNegativeCase(lockedTc) === true);
check('valid case is NOT negative', engine.isNegativeCase(validTc) === false);
check('derive message: invalid → do not match', engine.deriveErrorMessage(invalidTc) === 'Username and password do not match');
check('derive message: locked → locked out', /locked out/i.test(engine.deriveErrorMessage(lockedTc) || ''));

const negLines = engine.buildNegativeAssertions(invalidTc, '  ').join('\n');
check('negative assertion uses [data-test="error"]', negLines.includes('[data-test="error"]'));
check('negative assertion checks visibility', negLines.includes('.toBeVisible()'));
check('negative assertion checks message text', negLines.includes('.toContainText('));

console.log('\n=== Item 3: semantic locator mismatch ===');
const badAssert = `await expect(page.locator('#item_4_title_link')).toHaveText(/Products/i);`;
const goodAssert = `await expect(page.locator('[data-test="title"]')).toHaveText(/Products/i);`;
const badWarns = engine.detectSemanticLocatorMismatches(badAssert);
const goodWarns = engine.detectSemanticLocatorMismatches(goodAssert);
check('flags item link asserting page title', badWarns.length === 1, JSON.stringify(badWarns));
check('does NOT flag a proper title element', goodWarns.length === 0, JSON.stringify(goodWarns));

console.log(`\n──────── ${passed} passed, ${failed} failed ────────`);
if (failed > 0) process.exit(1);
