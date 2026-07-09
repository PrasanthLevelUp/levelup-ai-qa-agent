/**
 * Regression test for "Data Quality" — SCENARIO → DATASET resolution.
 *
 * One visible improvement: generated scripts now consistently choose the correct
 * test dataset for common authentication scenarios, even when the scenario does
 * NOT mention the dataset by name. Previously resolveCaseData() only bound a
 * dataset when its name (or a record key) appeared verbatim in test_data/steps;
 * a "Locked user" case with empty test_data therefore returned null and the
 * script fell back to env literals. The deterministic classifier added in this
 * change reads the case's own signals (test data → scenario → title →
 * expected result → requirement → steps, in priority order) and maps them to
 * the right dataset by NAME.
 *
 * Target mapping (the six common auth scenarios):
 *   Positive Login    → valid_users
 *   Locked User       → locked_users
 *   Invalid Password  → invalid_password_users
 *   Unknown User      → unknown_users
 *   Empty Username    → empty_username
 *   Empty Password    → empty_password
 *
 * These assertions exercise the private resolveCaseData()/buildTestDataIndex()
 * pair directly (no network, no LLM) — the same deterministic path the composer
 * uses when materializing a case's data binding.
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

// The six datasets a well-modelled SauceDemo-style auth suite would resolve.
const fullConfig: any = { resolvedTestData: [
  { name: 'valid_users',            records: [{ key: 'standard_user', value: { username: 'standard_user', password: 'secret_sauce' } }] },
  { name: 'locked_users',           records: [{ key: 'locked_out_user', value: { username: 'locked_out_user', password: 'secret_sauce' } }] },
  { name: 'invalid_password_users', records: [{ key: 'bad_pw_user', value: { username: 'standard_user', password: 'wrong_password' } }] },
  { name: 'unknown_users',          records: [{ key: 'ghost', value: { username: 'nobody', password: 'secret_sauce' } }] },
  { name: 'empty_username',         records: [{ key: 'no_user', value: { username: '', password: 'secret_sauce' } }] },
  { name: 'empty_password',         records: [{ key: 'no_pw', value: { username: 'standard_user', password: '' } }] },
]};

function main() {
  const eng: any = new ScriptGenEngine();
  const idx = eng.buildTestDataIndex(fullConfig);
  const resolve = (tc: any, steps: string[] = []) => eng.resolveCaseData(tc, steps, idx);

  console.log('\nData Quality — scenario → dataset mapping table');
  // 1) The core mapping table. Each case carries NO verbatim dataset/record
  //    reference; the dataset is inferred purely from scenario/title/expected.
  const table: Array<[string, any, string]> = [
    ['Positive Login',   { id: 1, scenario: 'Positive login',  title: 'Login with valid credentials', expected_result: 'User is logged in' }, 'valid_users'],
    ['Locked User',      { id: 2, scenario: 'Locked user',     title: 'Login with locked account',     expected_result: 'Account is locked out' }, 'locked_users'],
    ['Invalid Password', { id: 3, scenario: 'Invalid password', title: 'Login with wrong password',     expected_result: 'Credentials do not match' }, 'invalid_password_users'],
    ['Unknown User',     { id: 4, scenario: 'Unknown user',    title: 'Login with unregistered user',  expected_result: 'Credentials do not match' }, 'unknown_users'],
    ['Empty Username',   { id: 5, scenario: 'Empty username',  title: 'Login with blank username',     expected_result: 'Username is required' }, 'empty_username'],
    ['Empty Password',   { id: 6, scenario: 'Empty password',  title: 'Login with blank password',     expected_result: 'Password is required' }, 'empty_password'],
  ];
  for (const [label, tc, want] of table) {
    const r = resolve(tc);
    ok(`${label} → ${want}`, !!r && r.datasetName === want);
  }

  console.log('\nPriority order of signals');
  // 2) test_data (explicit) beats a conflicting title.
  ok('explicit test_data "locked" wins over title "valid"',
    resolve({ id: 10, test_data: 'locked user', title: 'valid login' }).datasetName === 'locked_users');
  // 3) scenario beats a conflicting expected_result.
  ok('scenario "Unknown user" wins over generic expected_result',
    resolve({ id: 11, scenario: 'Unknown user', expected_result: 'an error is shown' }).datasetName === 'unknown_users');
  // 4) title is used when scenario/test_data are absent.
  ok('title alone resolves ("Locked out user cannot log in")',
    resolve({ id: 12, title: 'Locked out user cannot log in' }).datasetName === 'locked_users');
  // 5) expected_result is used when title is generic.
  ok('expected_result resolves when title is generic',
    resolve({ id: 13, title: 'Login test', expected_result: 'the account is locked' }).datasetName === 'locked_users');
  // 6) steps are the LAST resort (lowest priority).
  ok('steps used only when no higher signal classifies',
    resolve({ id: 14, title: 'Login test' }, ['Attempt login with a locked account']).datasetName === 'locked_users');

  console.log('\nToken (not substring) disambiguation');
  // 7) "invalid password" must NOT collapse to valid_users even though the
  //    dataset name "invalid_password_users" contains the substring "valid".
  ok('invalid password → invalid_password_users (never valid_users)',
    resolve({ id: 20, scenario: 'Invalid password' }).datasetName === 'invalid_password_users');
  // 8) empty password must NOT collapse into the broad "invalid" bucket.
  ok('empty password → empty_password (not invalid_*)',
    resolve({ id: 21, scenario: 'Empty password' }).datasetName === 'empty_password');
  // 9) empty username stays distinct from empty password.
  ok('empty username → empty_username (not empty_password)',
    resolve({ id: 22, scenario: 'Empty username' }).datasetName === 'empty_username');

  console.log('\nNo over-correction');
  // 10) An explicit verbatim record reference still wins (step-1 path intact).
  const verbatim = resolve({ id: 30, scenario: 'Positive login', title: 'Successful login' },
    ['Enter username standard_user', 'Enter password']);
  ok('verbatim record "standard_user" still binds valid_users/standard_user',
    !!verbatim && verbatim.datasetName === 'valid_users' && verbatim.recordKey === 'standard_user');
  // 11) A positive scenario never binds a negative dataset.
  ok('positive login never resolves to a negative dataset',
    resolve({ id: 31, scenario: 'Positive login', title: 'Login works' }).datasetName === 'valid_users');
  // 12) A non-auth scenario is left untouched (null → caller keeps its behaviour).
  ok('non-auth scenario stays null',
    resolve({ id: 32, scenario: 'Browse catalog', title: 'View products', expected_result: 'Products are listed' }) === null);

  console.log('\nGraceful degradation');
  // 13) When only a subset of datasets exist, resolve to what IS present and
  //     do not invent a binding for a category with no matching dataset.
  const partialIdx = eng.buildTestDataIndex({ resolvedTestData: [
    { name: 'valid_users',  records: [{ key: 'standard_user', value: { username: 'standard_user', password: 'secret_sauce' } }] },
    { name: 'locked_users', records: [{ key: 'locked_out_user', value: { username: 'locked_out_user', password: 'secret_sauce' } }] },
  ]});
  ok('locked resolves against a 2-dataset index',
    eng.resolveCaseData({ id: 40, scenario: 'Locked user' }, [], partialIdx)?.datasetName === 'locked_users');
  ok('unknown-user category with no matching dataset → null (no false binding)',
    eng.resolveCaseData({ id: 41, scenario: 'Unknown user' }, [], partialIdx) === null);
  // 14) No resolved datasets at all → null (unchanged behaviour).
  const emptyIdx = eng.buildTestDataIndex({ resolvedTestData: [] });
  ok('no datasets present → null',
    eng.resolveCaseData({ id: 42, scenario: 'Locked user' }, [], emptyIdx) === null);

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main();
