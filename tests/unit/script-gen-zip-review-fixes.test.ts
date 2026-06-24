/**
 * Regression test for the ZIP-producing engine (ScriptGenEngine) — the engine
 * behind POST /api/script-gen/generate → GET /api/script-gen/:id/download.
 *
 * Locks in the PR #142 review fixes ("the ZIP is the truth"), driven through the
 * PUBLIC generate() entry point with cached crawl data so no network/LLM is used:
 *   1. No duplicate navigation after a Page Object login()
 *   2. Preconditions reuse loginPage.login() (not the raw #user-name triad)
 *   3. Negative cases assert [data-test="error"] + toContainText (invalid/locked/empty)
 *   4/6. Honest semantic grounding — reject error→#user-name & title→#item_*_title_link
 *   5. Dataset Intelligence — getRecord(...) + tests/data/test-data.ts in the bundle
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const mkMethod = (name: string, filePath: string): any => ({
  name, filePath, isExported: true, isAsync: true, parameters: [],
  returnType: 'Promise<void>', jsdoc: '', lineNumber: 1, category: 'page-object', complexity: 1,
});

const repoProfile: any = {
  framework: 'playwright', language: 'typescript', testPattern: 'pom',
  helperFunctions: [], fixtures: [], sharedConstants: [], dataFiles: [], dependencies: [],
  pageObjects: [
    { name: 'LoginPage', filePath: 'tests/pages/LoginPage.ts', isExported: true, baseClass: null,
      methods: [mkMethod('login', 'tests/pages/LoginPage.ts')], properties: [] },
    { name: 'InventoryPage', filePath: 'tests/pages/InventoryPage.ts', isExported: true, baseClass: null,
      methods: [mkMethod('verifyInventoryLoaded', 'tests/pages/InventoryPage.ts')], properties: [] },
  ],
};

// Cached crawl deliberately includes the elements that previously caused WRONG
// grounding: an item link (#item_4_title_link) that matched "title", and inputs
// that could match "error".
const cachedCrawlData: any = {
  url: 'https://www.saucedemo.com', finalUrl: 'https://www.saucedemo.com',
  title: 'Swag Labs', pageType: 'login', pageTypeConfidence: 0.9,
  elements: [
    { tag: 'input', id: 'user-name', name: 'user-name', type: 'text', attributes: { 'data-test': 'username' } },
    { tag: 'input', id: 'password', name: 'password', type: 'password', attributes: { 'data-test': 'password' } },
    { tag: 'input', id: 'login-button', type: 'submit', attributes: { 'data-test': 'login-button' } },
    { tag: 'a', id: 'item_4_title_link', attributes: { class: 'inventory_item_label' } },
    { tag: 'a', id: 'inventory_sidebar_link', attributes: {} },
  ],
  forms: [], navigationLinks: [], buttons: [], inputs: [], headings: [],
  htmlSnapshot: '', totalElements: 5, interactiveElements: 5,
};

const testCases: any[] = [
  { id: 1216, title: 'Verify successful login with valid credentials', priority: 'P0',
    preconditions: 'User is on the login page', test_data: 'standard_user from valid_users',
    expected_result: 'User is successfully logged in and redirected to the Inventory page.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter valid username from valid_users: standard_user',
      'Enter valid password placeholder <password>', 'Click the login button'] },
  { id: 1219, title: 'Verify login attempt with invalid username', priority: 'P0',
    preconditions: 'User is on the login page', test_data: 'invalid username',
    expected_result: 'An error message is displayed indicating invalid credentials.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter invalid username',
      'Enter valid password placeholder <password>', 'Click the login button'] },
  { id: 1220, title: 'Verify login attempt with locked user account', priority: 'P0',
    preconditions: 'User is on the login page', test_data: 'locked_out_user from valid_users',
    expected_result: 'An error message is displayed indicating the account is locked.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter locked user account username from valid_users: locked_out_user',
      'Enter valid password placeholder <password>', 'Click the login button'] },
  { id: 1221, title: 'Verify login with empty username and password fields', priority: 'P1',
    preconditions: '', test_data: 'empty fields',
    expected_result: 'An error message is displayed indicating that fields cannot be empty.',
    steps: ['Leave username field empty', 'Leave password field empty', 'Click the login button'] },
  { id: 1217, title: 'Verify navigation to Inventory page after successful login', priority: 'P0',
    preconditions: 'User is successfully logged in.', test_data: 'standard_user from valid_users',
    expected_result: 'User is on the Inventory page.',
    steps: ['Verify that the URL is https://www.saucedemo.com/inventory.html', 'Check that the Inventory page elements are displayed'] },
];

async function main() {
  const engine = new ScriptGenEngine();
  const result = await engine.generate({ url: 'https://www.saucedemo.com', cachedCrawlData, repoProfile, testCases } as any);
  const byPath = new Map(result.generatedFiles.map(f => [f.path, f.content]));
  const get = (frag: string) => [...byPath.entries()].find(([p]) => p.includes(frag))?.[1] ?? '';

  const success = get('verify-successful-login');
  const invalid = get('verify-login-attempt-with-invalid');
  const locked = get('verify-login-attempt-with-locked');
  const empty = get('verify-login-with-empty');
  const nav = get('verify-navigation-to-inventory');
  const dataModule = get('data/test-data.ts');

  console.log('=== Issue 5: Dataset Intelligence (test-data module + getRecord) ===');
  ok('tests/data/test-data.ts is in the bundle', !!dataModule);
  ok('module declares the valid_users dataset', /valid_users/.test(dataModule));
  ok('module contains standard_user + locked_out_user records', /standard_user/.test(dataModule) && /locked_out_user/.test(dataModule));
  ok('successful login imports getRecord', /import\s*\{\s*getRecord\s*\}\s*from\s*'\.\/data\/test-data'/.test(success));
  ok('successful login binds const user = getRecord("valid_users")', /const user = getRecord\("valid_users"\)/.test(success));
  ok('login() reads user.username', /\.login\(user\.username/.test(success));
  ok('locked case pins getRecord("valid_users", "locked_out_user")', /getRecord\("valid_users", "locked_out_user"\)/.test(locked));

  console.log('=== Issue 1: no duplicate navigation after login() ===');
  ok('successful login has NO page.goto after loginPage.login()', !/\.login\([^\n]*\);[\s\S]*page\.goto/.test(success));
  ok('successful login still calls loginPage.login()', /loginPage\.login\(/.test(success));

  console.log('=== Issue 2: precondition reuses loginPage.login() ===');
  ok('navigation precondition uses loginPage.login()', /\/\/ Precondition[\s\S]*loginPage\.login\(/.test(nav));
  ok('navigation precondition does NOT emit raw #user-name.fill triad', !/#user-name'\)\.fill/.test(nav));

  console.log('=== Issue 3: negative assertions on [data-test="error"] ===');
  ok('invalid asserts [data-test="error"] visible', /expect\(page\.locator\('\[data-test="error"\]'\)\)\.toBeVisible/.test(invalid));
  ok('invalid asserts toContainText("do not match")', /toContainText\('do not match'\)/.test(invalid));
  ok('locked asserts toContainText("locked out")', /toContainText\('locked out'\)/.test(locked));
  ok('empty asserts toContainText("is required")', /toContainText\('is required'\)/.test(empty));
  ok('no negative case asserts #user-name as the error', ![invalid, locked, empty].some(c => /locator\('#user-name'\)\)\.toBeVisible/.test(c)));

  console.log('=== Issue 4/6: honest semantic grounding ===');
  ok('title resolves to [data-test="title"], not #item_4_title_link', /\[data-test="title"\]/.test(success) && !/#item_4_title_link/.test(success));
  const g: any = (result as any).locatorGrounding;
  ok('grounding report is present', !!g);
  ok('grounding is NOT a fake 100%', g && g.groundedPct < 100);
  ok('title is reported as NOT grounded (rejected match)', g && g.entries.some((e: any) => e.name === 'title' && e.grounded === false));
  ok('error is reported as NOT grounded (rejected match)', g && g.entries.some((e: any) => e.name === 'error' && e.grounded === false));

  console.log(`\n──────── ${passed} passed, ${failed} failed ────────`);
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
