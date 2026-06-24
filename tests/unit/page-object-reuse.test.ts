/**
 * Page Object reuse for the deterministic test-case path.
 *
 * Guards against the product gap where Repository Intelligence → Page Object
 * selection adds NO value to output. When a LoginPage/InventoryPage/CartPage
 * exists in the repo profile, the engine must:
 *   1. Import the PO class
 *   2. Instantiate it
 *   3. Call its high-level methods instead of emitting raw locators
 *
 * Run: npx tsx tests/unit/page-object-reuse.test.ts
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

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
    {
      name: 'LoginPage',
      filePath: 'pages/login.page.ts',
      methods: [
        { name: 'login', parameters: [{ name: 'username' }, { name: 'password' }] },
        { name: 'navigateToLogin', parameters: [] },
      ],
    },
  ],
};

const loginTestCase: any = {
  id: 1216,
  title: 'Valid login with standard_user',
  steps: [
    'Navigate to https://www.saucedemo.com',
    'Enter valid username from valid_users: standard_user',
    'Enter valid password placeholder <password>',
    'Click the login button',
  ],
  expected_result: 'User is successfully logged in and redirected to the Inventory page.',
  test_data: 'standard_user from valid_users',
};

const crawl: any = {
  url: 'https://www.saucedemo.com/',
  elements: [
    { tag: 'input', type: 'text', id: 'user-name', name: 'user-name', attributes: { 'data-test': 'username', id: 'user-name' } },
    { tag: 'input', type: 'password', id: 'password', name: 'password', attributes: { 'data-test': 'password', id: 'password' } },
    { tag: 'input', type: 'submit', id: 'login-button', attributes: { 'data-test': 'login-button', id: 'login-button' } },
  ],
};

const engine: any = new ScriptGenEngine();

(async () => {
  console.log('\n=== Page Object reuse (LoginPage) ===');

  // WITH repo profile (LoginPage exists)
  const withPO = await engine.generate({
    url: 'https://www.saucedemo.com',
    testCase: loginTestCase,
    repoProfile,
    cachedCrawlData: crawl,
  });
  const code = withPO.generatedFiles[0].content;

  check('LoginPage is imported', code.includes("import { LoginPage }"));
  check('import path is relative to tests/', code.includes("from '../pages/login.page'"));
  check('LoginPage is instantiated', code.includes('new LoginPage(page)'));
  check('loginPage.login() is called', code.includes('loginPage.login('));
  check('username is passed to login()', code.includes("'standard_user'"));
  check('password env fallback is used', code.includes('process.env.TEST_PASSWORD'));
  check('raw locators are NOT emitted', !code.includes("page.locator('#user-name').fill("));
  check('raw password fill is NOT emitted', !code.includes("page.locator('#password').fill("));

  // WITHOUT repo profile (fallback to raw locators)
  const noPO = await engine.generate({
    url: 'https://www.saucedemo.com',
    testCase: loginTestCase,
    cachedCrawlData: crawl,
  });
  const rawCode = noPO.generatedFiles[0].content;

  check('NO LoginPage import without profile', !rawCode.includes('LoginPage'));
  check('raw locators emitted as fallback', rawCode.includes("page.locator('#user-name').fill("));
  check('raw password fill emitted', rawCode.includes("page.locator('#password').fill("));

  // Test case WITHOUT login keywords (no PO match)
  const nonLoginCase: any = {
    id: 9999,
    title: 'View product details',
    steps: ['Navigate to product page', 'Click product image', 'Verify description'],
    expected_result: 'Product details displayed',
  };
  const noMatch = await engine.generate({
    url: 'https://www.saucedemo.com',
    testCase: nonLoginCase,
    repoProfile,
    cachedCrawlData: crawl,
  });
  const noMatchCode = noMatch.generatedFiles[0].content;
  check('NO LoginPage import when keywords do not match', !noMatchCode.includes('LoginPage'));

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
