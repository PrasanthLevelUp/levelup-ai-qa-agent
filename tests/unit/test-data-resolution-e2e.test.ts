/**
 * End-to-end regression: the deterministic generator must NOT emit credential
 * literals scraped from step prose. For TC1392 (locked user login) it must bind
 * to the resolved dataset record instead of producing `login('username', 'in')`.
 */
import { ScriptGenEngine, type GenerationConfig } from '../../src/script-gen/script-gen-engine';

let passed = 0, failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

// Minimal cached crawl mirroring saucedemo's login form (data-test selectors).
const cachedCrawlData: any = {
  url: 'https://www.saucedemo.com',
  finalUrl: 'https://www.saucedemo.com',
  title: 'Swag Labs',
  pageType: 'login',
  inputs: [
    { selector: "[data-test='username']", attributes: { 'data-test': 'username', name: 'user-name', id: 'user-name', type: 'text' }, visible: true },
    { selector: "[data-test='password']", attributes: { 'data-test': 'password', name: 'password', id: 'password', type: 'password' }, visible: true },
  ],
  buttons: [
    { selector: "[data-test='login-button']", text: 'Login', attributes: { 'data-test': 'login-button', id: 'login-button' }, visible: true },
  ],
  elements: [
    { selector: "[data-test='username']", tag: 'input', attributes: { 'data-test': 'username' }, visible: true },
    { selector: "[data-test='password']", tag: 'input', attributes: { 'data-test': 'password' }, visible: true },
    { selector: "[data-test='login-button']", tag: 'input', attributes: { 'data-test': 'login-button' }, visible: true },
  ],
  forms: [],
  navigationLinks: [],
  headings: [],
};

const testCase: any = {
  id: 1392,
  title: 'Locked user login attempt with valid credentials',
  priority: 'P0',
  test_data: 'locked_user',
  steps: [
    '1. Navigate to the login page at https://www.saucedemo.com',
    "2. Enter the username for the locked account in [data-testid='username'] field.",
    "3. Enter the password in [data-testid='password'] field.",
    "4. Click the login button [data-testid='login-button'].",
  ],
  expected_result: 'Login should fail, the user remains on the Login page, and an error message is displayed.',
};

const config: GenerationConfig = {
  url: 'https://www.saucedemo.com',
  testCase,
  cachedCrawlData,
  resolvedTestData: [
    { name: 'locked_users', records: [{ key: 'locked_out_user', value: { username: 'locked_out_user', password: 'secret_sauce' } }] },
  ],
} as any;

(async () => {
  const engine = new ScriptGenEngine();
  const result = await engine.generate(config);
  const spec = (result.generatedFiles || []).find((f: any) => f.type === 'test');
  console.log('=== Generated spec (TC1392) ===');
  assert(!!spec, 'a test spec was generated');
  const content = spec?.content || '';
  console.log(content);

  console.log('\n=== Assertions ===');
  assert(!/login\(\s*'username'/.test(content), "no bogus login('username', …) literal");
  assert(!/'in'/.test(content), "no stray 'in' preposition literal");
  assert(/getRecord\(\s*['"]locked_users['"]/.test(content) || /user\.username/.test(content),
    'binds to the resolved dataset record (getRecord/user.username)');

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
