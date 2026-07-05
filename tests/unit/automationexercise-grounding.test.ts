/**
 * Deterministic grounding for a NON-SauceDemo app (automationexercise.com).
 *
 * Regression guard for the "grounded but WRONG element" defect. The deterministic
 * batch path used to force every step through a fixed SauceDemo login vocabulary,
 * so on a site whose login AND signup forms share `name="email"` inputs it would:
 *   - resolve the login-email step to the signup-name field,
 *   - map "Click Signup" to the login-button,
 *   - DROP the "Enter name" step entirely,
 *   - truncate `test@example.com` to `test@example`.
 *
 * The fix resolves each step's control PER-STEP against the crawled App Profile
 * using the step's own qualifier-aware phrase ("signup email" vs "login email"),
 * and scores the `data-qa` test hook (this site's primary hook) so otherwise
 * identical `name="email"` inputs disambiguate correctly.
 *
 * Also asserts the App-Profile KPI (customer proof point): every locator is
 * bucketed into App-Profile / curated-fallback / AI, and here 0% comes from AI.
 *
 * Run: npx tsx tests/unit/automationexercise-grounding.test.ts
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const el = (o: any) => ({ tag: 'input', textContent: '', attributes: {}, visible: true, required: false, disabled: false, ...o });

// Realistic automationexercise.com crawl. Real test hooks on this site are
// `data-qa="..."` plus name attributes. Login and signup live on /login and
// BOTH expose a `name="email"` input — the case that used to collapse grounding.
const crawl: any = {
  url: 'https://automationexercise.com/login',
  finalUrl: 'https://automationexercise.com/login',
  title: 'Automation Exercise - Signup / Login',
  pageType: 'login',
  elements: [
    // ── Login block ──
    el({ tag: 'input', type: 'email', name: 'email', placeholder: 'Email Address', attributes: { 'data-qa': 'login-email', name: 'email' } }),
    el({ tag: 'input', type: 'password', name: 'password', placeholder: 'Password', attributes: { 'data-qa': 'login-password', name: 'password' } }),
    el({ tag: 'button', type: 'submit', textContent: 'Login', attributes: { 'data-qa': 'login-button' } }),
    // ── Signup block ──
    el({ tag: 'input', type: 'text', name: 'name', placeholder: 'Name', attributes: { 'data-qa': 'signup-name', name: 'name' } }),
    el({ tag: 'input', type: 'email', name: 'email', placeholder: 'Email Address', attributes: { 'data-qa': 'signup-email', name: 'email' } }),
    el({ tag: 'button', type: 'submit', textContent: 'Signup', attributes: { 'data-qa': 'signup-button' } }),
    // ── Error text ──
    el({ tag: 'p', textContent: 'Your email or password is incorrect!', attributes: {} }),
  ],
  forms: [], buttons: [], inputs: [], headings: [], navigationLinks: [], errors: [], htmlSnapshot: '',
  totalElements: 7, interactiveElements: 6, crawlTimeMs: 0,
};

// Two uploaded test cases (the normalized shape the route builds from a CSV upload).
const testCases: any[] = [
  {
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
  },
  {
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
  },
];

const engine: any = new ScriptGenEngine();
const config: any = { url: crawl.url, testTypes: ['functional'], testCases, cachedCrawlData: crawl };

const batch = engine.generateFromTestCases(config, crawl);
if (!batch) { console.log('  ❌ deterministic batch returned null'); process.exit(1); }

// Concatenate all generated spec bodies for locator assertions.
const code = batch.generatedFiles.filter((f: any) => f.type === 'test').map((f: any) => f.content).join('\n\n');

console.log('\n== deterministic engine ==');
check('uses the deterministic engine (no AI tokens)', batch.stats.tokensUsed === 0, `tokensUsed=${batch.stats.tokensUsed}`);
check("model is 'deterministic-requirement-batch'", batch.stats.model === 'deterministic-requirement-batch', batch.stats.model);
check('produced two specs (one per case) or a consolidated spec', batch.generatedFiles.some((f: any) => f.type === 'test'));

console.log('\n== per-step grounded locators (login case) ==');
check('login email → data-qa="login-email"', code.includes(`page.locator('[data-qa="login-email"]').fill('test@example.com')`), 'wrong element or truncated value');
check('login password → data-qa="login-password"', code.includes(`page.locator('[data-qa="login-password"]').fill('Secret123')`));
check('Login button → data-qa="login-button"', code.includes(`page.locator('[data-qa="login-button"]').click()`));
check('email value NOT truncated (full test@example.com present)', code.includes('test@example.com') && !/fill\('test@example'\)/.test(code));

console.log('\n== per-step grounded locators (signup case) ==');
check('signup name step NOT dropped → data-qa="signup-name"', code.includes(`page.locator('[data-qa="signup-name"]').fill('John Doe')`), 'name step missing');
check('signup email disambiguated → data-qa="signup-email" (NOT login-email)', code.includes(`page.locator('[data-qa="signup-email"]').fill('john@example.com')`), 'resolved to login-email');
check('Signup button → data-qa="signup-button" (NOT login-button)', code.includes(`page.locator('[data-qa="signup-button"]').click()`));

console.log('\n== no ungrounded garbage ==');
check('no bare getByRole textbox guesses left in code', !/getByRole\('textbox'/.test(code));
check('no unresolved placeholder tokens', !/data-qa="signup-name"\)'\).fill\('john/.test(code));

console.log('\n== App-Profile KPI (customer proof point) ==');
const g = batch.locatorGrounding;
check('grounding report is present', !!g, 'no locatorGrounding on result');
if (g) {
  console.log(`     ${g.total} locators · ${g.fromAppProfile} from App Profile · ${g.fromFallback} curated fallback · ${g.fromAI} AI · ${g.appProfilePct}% App-Profile · ${g.aiPct}% AI`);
  check('buckets sum to total', g.fromAppProfile + g.fromFallback + g.fromAI === g.total, `${g.fromAppProfile}+${g.fromFallback}+${g.fromAI} != ${g.total}`);
  check('majority of locators come from the App Profile', g.appProfilePct >= 80, `${g.appProfilePct}%`);
  check('0% from AI on the deterministic path', g.aiPct === 0 && g.fromAI === 0, `${g.aiPct}%`);
  check('every reported locator is real (grounded or curated), none hallucinated', g.realPct === 100, `${g.realPct}%`);
  check('appProfilePct == round(fromAppProfile/total*100)', g.appProfilePct === Math.round((g.fromAppProfile / g.total) * 100));
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
