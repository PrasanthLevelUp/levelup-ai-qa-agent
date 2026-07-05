/**
 * End-to-end guard: all THREE script-generation entry flows converge on the
 * SAME deterministic, App-Profile-grounded engine (no LLM, tokensUsed = 0).
 *
 * The API route (src/api/routes/script-gen.ts) normalizes each UI flow into one
 * of two engine config shapes, then calls `ScriptGenEngine.generate(config)`:
 *
 *   1. Test Case Lab  — a single selected case      → config.testCase
 *        (route: `...(testCase ? { testCase } : {})`)
 *   2. Requirement    — requirementId → linked cases → config.testCases
 *        (route: `...(requirementTestCases.length > 0 ? { testCases } : {})`)
 *   3. Upload CSV      — inline cases normalized into requirementTestCases
 *        (route path label `uploaded-batch-deterministic`) → config.testCases
 *
 * `generate()` then dispatches: config.testCases → generateFromTestCases,
 * config.testCase → generateFromTestCase — BOTH deterministic (model starts
 * with "deterministic-", tokensUsed = 0). This test drives the PUBLIC
 * `generate()` with each shape (using a cached crawl so no network crawl runs)
 * and asserts every flow stays on the deterministic, grounded path.
 *
 * Run: npx tsx tests/unit/three-flows-deterministic.test.ts
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const el = (o: any) => ({ tag: 'input', textContent: '', attributes: {}, visible: true, required: false, disabled: false, ...o });

// Shared App Profile (cached crawl) — automationexercise.com login/signup page.
const crawl: any = {
  url: 'https://automationexercise.com/login',
  finalUrl: 'https://automationexercise.com/login',
  title: 'Automation Exercise - Signup / Login',
  pageType: 'login',
  elements: [
    el({ tag: 'input', type: 'email', name: 'email', placeholder: 'Email Address', attributes: { 'data-qa': 'login-email', name: 'email' } }),
    el({ tag: 'input', type: 'password', name: 'password', placeholder: 'Password', attributes: { 'data-qa': 'login-password', name: 'password' } }),
    el({ tag: 'button', type: 'submit', textContent: 'Login', attributes: { 'data-qa': 'login-button' } }),
    el({ tag: 'input', type: 'text', name: 'name', placeholder: 'Name', attributes: { 'data-qa': 'signup-name', name: 'name' } }),
    el({ tag: 'input', type: 'email', name: 'email', placeholder: 'Email Address', attributes: { 'data-qa': 'signup-email', name: 'email' } }),
    el({ tag: 'button', type: 'submit', textContent: 'Signup', attributes: { 'data-qa': 'signup-button' } }),
  ],
  forms: [], buttons: [], inputs: [], headings: [], navigationLinks: [], errors: [], htmlSnapshot: '',
  totalElements: 6, interactiveElements: 6, crawlTimeMs: 0,
};

const loginCase = {
  id: 101, title: 'Login with valid credentials',
  steps: [
    'Navigate to https://automationexercise.com/login',
    "Enter email 'test@example.com' in the login email field",
    "Enter password 'Secret123' in the login password field",
    'Click the Login button',
  ].join('\n'),
  expected_result: 'User is logged in and redirected to the home page',
  test_data: 'email: test@example.com, password: Secret123',
  priority: 'High', module: 'Authentication',
};
const signupCase = {
  id: 102, title: 'Register a new user',
  steps: [
    'Navigate to https://automationexercise.com/login',
    "Enter name 'John Doe' in the signup name field",
    "Enter email 'john@example.com' in the signup email field",
    'Click the Signup button',
  ].join('\n'),
  expected_result: 'User proceeds to the account information page',
  test_data: 'name: John Doe, email: john@example.com',
  priority: 'High', module: 'Registration',
};

const engine = new ScriptGenEngine();

function assertDeterministic(label: string, res: any) {
  console.log(`\n== flow: ${label} ==`);
  check(`${label}: returned a result`, !!res);
  if (!res) return;
  check(`${label}: model is deterministic (no LLM)`, typeof res.stats?.model === 'string' && res.stats.model.startsWith('deterministic-'), res.stats?.model);
  check(`${label}: tokensUsed === 0`, res.stats?.tokensUsed === 0, String(res.stats?.tokensUsed));
  check(`${label}: generated at least one spec`, Array.isArray(res.generatedFiles) && res.generatedFiles.some((f: any) => f.type === 'test'));
  const g = res.locatorGrounding;
  check(`${label}: has an App-Profile grounding report`, !!g);
  if (g) {
    console.log(`     ${g.total} locators · ${g.fromAppProfile} App Profile · ${g.fromFallback} fallback · ${g.fromAI} AI · ${g.appProfilePct}% App-Profile · ${g.aiPct}% AI`);
    check(`${label}: grounds locators from the App Profile`, g.fromAppProfile > 0, `${g.appProfilePct}%`);
    check(`${label}: 0% from AI on the deterministic path`, g.aiPct === 0);
  }
}

(async () => {
  // Flow 1 — Test Case Lab (single selected case → config.testCase).
  const lab = await engine.generate({ url: crawl.url, testTypes: ['functional'], cachedCrawlData: crawl, testCase: loginCase } as any);
  assertDeterministic('Test Case Lab (config.testCase)', lab);
  check("Test Case Lab: model === 'deterministic-test-case'", lab?.stats?.model === 'deterministic-test-case', lab?.stats?.model);

  // Flow 2 — Requirement (linked cases → config.testCases batch).
  const req = await engine.generate({ url: crawl.url, testTypes: ['functional'], cachedCrawlData: crawl, testCases: [loginCase, signupCase] } as any);
  assertDeterministic('Requirement batch (config.testCases)', req);
  check("Requirement: model === 'deterministic-requirement-batch'", req?.stats?.model === 'deterministic-requirement-batch', req?.stats?.model);

  // Flow 3 — Upload CSV (inline cases normalized into config.testCases — the
  // route calls this path `uploaded-batch-deterministic`). Same engine entry.
  const upload = await engine.generate({ url: crawl.url, testTypes: ['functional'], cachedCrawlData: crawl, testCases: [loginCase] } as any);
  assertDeterministic('Upload CSV batch (config.testCases)', upload);
  check("Upload: model === 'deterministic-requirement-batch'", upload?.stats?.model === 'deterministic-requirement-batch', upload?.stats?.model);

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
