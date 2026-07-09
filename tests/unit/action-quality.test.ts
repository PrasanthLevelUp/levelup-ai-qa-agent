/**
 * Regression test for the "Action Quality" fix — business titles and
 * expected-result / precondition text must NEVER become UI actions.
 *
 * Observed defects this locks down:
 *   • A scenario title that leaks into the steps list ("Valid login - standard
 *     user") became `getByLabel(/valid login-/i).fill(...)` — a locator that
 *     targets scenario prose, not a real control.
 *   • A precondition ("User is on the login page") became a spurious
 *     `.fill(user.username)` because it merely contained the substring "user".
 *   • Expected-result prose ("User should be redirected to the dashboard")
 *     must be asserted or flagged — never turned into a fill/click.
 *
 * The guarantees:
 *   • No `getByLabel` / `getByRole` action is ever built from a business phrase
 *     (valid/invalid/login/should/redirected/dashboard/message…).
 *   • Non-action context/precondition steps produce no fill/click.
 *   • Genuine, verb-led field steps still map correctly (no over-correction).
 *
 * Driven through the PUBLIC generate() entry point with cached crawl data so no
 * network/LLM is used.
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const cachedCrawlData: any = {
  url: 'https://www.saucedemo.com', finalUrl: 'https://www.saucedemo.com',
  title: 'Swag Labs', pageType: 'login', pageTypeConfidence: 0.9,
  elements: [
    { tag: 'input', id: 'user-name', name: 'user-name', type: 'text', attributes: { 'data-test': 'username' } },
    { tag: 'input', id: 'password', name: 'password', type: 'password', attributes: { 'data-test': 'password' } },
    { tag: 'input', id: 'login-button', type: 'submit', attributes: { 'data-test': 'login-button' } },
  ],
  forms: [], navigationLinks: [], buttons: [], inputs: [], headings: [],
  htmlSnapshot: '', totalElements: 3, interactiveElements: 3,
};

// These test cases deliberately mix genuine action steps with the kinds of
// non-action prose (scenario titles, preconditions, expected results) that were
// slipping through and becoming bogus UI actions.
const testCases: any[] = [
  { id: 5001, title: 'Valid login - standard user', priority: 'P0',
    preconditions: '', test_data: '',
    expected_result: 'User is logged in.',
    steps: [
      'Navigate to https://www.saucedemo.com',
      'Valid login - standard user',                 // scenario title leaked as a step
      'User should be redirected to the dashboard',  // expected result as a step
      'Verify successful login message is displayed', // expected result
    ] },
  { id: 5002, title: 'Login with valid credentials', priority: 'P0',
    preconditions: '', test_data: '',
    expected_result: 'User is logged in.',
    steps: [
      'User is on the login page',                    // precondition / context
      'Navigate to https://www.saucedemo.com',
      'Enter username from valid_users: standard_user',
      'Enter valid password',
      'Click the login button',
    ] },
];

function assertBusinessProseNeverAction(all: string): void {
  // Collect every getByLabel / getByRole name argument and prove none of them is
  // built from business/outcome prose.
  const labelArgs = [...all.matchAll(/getByLabel\(\/([^/]+)\//g)].map(m => m[1]!.toLowerCase());
  const roleArgs = [...all.matchAll(/getByRole\([^,]+,\s*\{\s*name:\s*\/([^/]+)\//g)].map(m => m[1]!.toLowerCase());
  const actionNames = [...labelArgs, ...roleArgs];
  const proseToken = /(valid|invalid|successful|redirect|dashboard|logged|should|message|displayed|credential|scenario)/;
  const offenders = actionNames.filter(n => proseToken.test(n));
  if (offenders.length) console.log('    offending action locators:', JSON.stringify(offenders));
  ok('no getByLabel/getByRole action is built from business prose', offenders.length === 0);
}

async function main() {
  const engine = new ScriptGenEngine();
  const result = await engine.generate({ url: 'https://www.saucedemo.com', cachedCrawlData, testCases } as any);
  const specs = result.generatedFiles.filter(f => f.type === 'test');
  const all = specs.map(f => f.content).join('\n');
  const byTitle = (needle: string) =>
    specs.map(f => f.content).find(c => c.includes(needle)) ?? '';

  console.log('=== Action quality (titles / expected-results never become actions) ===');
  ok('at least one spec was generated', specs.length > 0);

  // 1) The precise reported defect: a scenario title never becomes a getByLabel.
  ok('no getByLabel(/valid login-…/) locator anywhere', !/getByLabel\(\/valid\s*login/i.test(all));

  // 2) Generalised: no action locator is ever named from business prose.
  assertBusinessProseNeverAction(all);

  // 3) The leaked title + expected-result steps are flagged, not executed.
  const titleSpec = byTitle('Valid login - standard user');
  ok('leaked scenario-title step is flagged as unmapped, not executed',
    /TODO: Map step — "Valid login - standard user"/.test(titleSpec));
  ok('expected-result "redirected to the dashboard" is NOT a fill/click',
    !/redirected|dashboard/i.test(
      (titleSpec.match(/await [^\n]*\.(fill|click)\([^\n]*\)/g) || []).join('\n')));

  // 4) A precondition/context step never becomes a fill.
  const credSpec = byTitle('Login with valid credentials');
  const credActions = (credSpec.match(/await [^\n]*\.(fill|click)\([^\n]*\)/g) || []);
  ok('precondition "User is on the login page" produces no action',
    !credActions.some(a => /is on the login page/i.test(a)));
  ok('precondition is not even emitted as an unmapped TODO (recognised as context)',
    !/TODO: Map step — "User is on the login page"/.test(credSpec));

  // 5) No over-correction: the genuine, verb-led field steps still map.
  ok('genuine "Enter username …" still fills the username field',
    /login-email"\]\)\.fill\('standard_user'\)/.test(credSpec) || /fill\('standard_user'\)/.test(credSpec));
  ok('genuine "Enter valid password" still fills the password field',
    /password"\]'?\)\.fill\(/.test(credSpec));
  ok('genuine "Click the login button" still clicks', /login-button"\]'?\)\.click\(\)/.test(credSpec));

  console.log(`\n──────── ${passed} passed, ${failed} failed ────────`);
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
