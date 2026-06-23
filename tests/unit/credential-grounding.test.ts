/**
 * Credential grounding for the deterministic test-case path.
 *
 * Regression guard for the "silent fill('')" defect: generated login scripts
 * must carry the real credential values written in the test steps/data (e.g.
 * "...from valid_users: standard_user" → fill('standard_user')), use a
 * meaningful value for negative cases, keep empty-field tests empty, fall back
 * to an env var (never a silent empty string) for unresolved values, and always
 * navigate before touching the page.
 *
 * Run: npx tsx tests/unit/credential-grounding.test.ts
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const crawl: any = {
  url: 'https://www.saucedemo.com/', crawlTimeMs: 1000,
  pages: [{ url: 'https://www.saucedemo.com/', title: 'Swag Labs' }],
  elements: [
    { tag: 'input', type: 'text', id: 'user-name', name: 'user-name', placeholder: 'Username' },
    { tag: 'input', type: 'password', id: 'password', name: 'password', placeholder: 'Password' },
    { tag: 'input', type: 'submit', id: 'login-button', name: 'login-button', text: 'Login' },
  ],
};

const engine = new ScriptGenEngine();
const gen = (tc: any, resolvedTestData?: any[]): string => {
  const config: any = { url: 'https://www.saucedemo.com/', framework: 'playwright', language: 'typescript', testCase: tc, resolvedTestData };
  const result = (engine as any).generateFromTestCase(config, crawl);
  return result.generatedFiles[0].content as string;
};

console.log('\n=== Credential grounding ===');

// 1) Valid login — username extracted from step; password env-backed (placeholder).
const valid = gen({
  id: 1, title: 'Valid login', test_data: 'standard_user from valid_users',
  expected_result: 'redirected to the Inventory page',
  steps: ['Navigate to https://www.saucedemo.com', 'Enter valid username from valid_users: standard_user', 'Enter valid password placeholder <password>', 'Click the login button'],
});
check('valid: username uses real value standard_user', valid.includes(`fill('standard_user')`), valid);
check('valid: no silent empty username fill', !/#user-name'\)\.fill\(''\)/.test(valid));
check('valid: password falls back to env (not empty)', valid.includes(`process.env.TEST_PASSWORD ?? ''`));
check('valid: password is NOT the username value', !valid.includes(`#password'\).fill('standard_user')`));
check('valid: navigates before interacting', valid.indexOf('page.goto') < valid.indexOf('#user-name'));

// 2) Locked user — username extracted from step.
const locked = gen({
  id: 2, title: 'Locked user', test_data: 'locked_out_user from valid_users',
  expected_result: 'account is locked',
  steps: ['Navigate to https://www.saucedemo.com', 'Enter locked user account username from valid_users: locked_out_user', 'Enter valid password placeholder <password>', 'Click the login button'],
});
check('locked: username uses locked_out_user', locked.includes(`fill('locked_out_user')`));

// 3) Invalid username — meaningful non-empty invalid value.
const invalid = gen({
  id: 3, title: 'Invalid username', test_data: 'invalid username',
  expected_result: 'error message indicating invalid credentials',
  steps: ['Navigate to https://www.saucedemo.com', 'Enter invalid username', 'Enter valid password placeholder <password>', 'Click the login button'],
});
check('invalid: uses non-empty invalid_user value', invalid.includes(`fill('invalid_user')`));

// 4) Empty fields — must stay empty AND still navigate first.
const empty = gen({
  id: 4, title: 'Empty fields', test_data: 'empty fields',
  expected_result: 'fields cannot be empty',
  steps: ['Leave username field empty', 'Leave password field empty', 'Click the login button'],
});
check('empty: username fill is empty', empty.includes(`#user-name').fill('')`));
check('empty: password fill is empty', empty.includes(`#password').fill('')`));
check('empty: navigation injected even without a navigate step', empty.includes('page.goto'));

// 5) Resolved dataset record takes precedence (binds to getRecord).
const withData = gen({
  id: 5, title: 'Valid login with dataset', test_data: 'standard_user from valid_users',
  expected_result: 'redirected to the Inventory page',
  steps: ['Navigate to https://www.saucedemo.com', 'Enter username', 'Enter password', 'Click the login button'],
}, [
  { name: 'valid_users', records: [{ key: 'standard_user', value: { username: 'standard_user', password: 'secret_sauce' } }] },
]);
check('dataset: binds to getRecord/user.username when a record resolves',
  withData.includes('getRecord(') && withData.includes('user.username'), withData);

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
