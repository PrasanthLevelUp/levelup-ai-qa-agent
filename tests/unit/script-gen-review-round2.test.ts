/**
 * Script-Gen review round 2 — integration tests for the four quality fixes.
 * ========================================================================
 * Proves, end-to-end through `ScriptGenEngine.generate()`, the four issues
 * raised on the deterministic requirement-batch output:
 *
 *   #1  Test Data as complete business ENTITIES — a "valid_users" dataset stored
 *       as field-per-record rows ({key:'email'},{key:'password'}) is consumed as
 *       ONE entity, and the spec binds user.username / user.password (NEVER
 *       process.env.TEST_USERNAME / TEST_PASSWORD). A re-materialization warning
 *       is surfaced on result.testDataWarnings.
 *   #2  Navigation centralization — when a repo Page Object exposes a nav method
 *       (open/goto/navigate/load/visit), entry navigation drives through it
 *       (loginPage.open()) instead of a raw page.goto + waitForLoadState
 *       duplicated inline.
 *   #3  Configurable unmapped-step policy — an un-mappable step is reported on
 *       result.unmappedSteps and rendered per policy: 'warn' (default) emits a
 *       greppable @warning marker, 'comment' the legacy note, 'error' throws in
 *       the generated code.
 *   #4  App-Profile verification — an Expected Result naming app copy
 *       ("sees Logged in as username") asserts that copy via getByText, and an
 *       inline "Verify … is displayed" step becomes an assertion (never a fill).
 *
 * Run: npx tsx tests/unit/script-gen-review-round2.test.ts
 */
import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const engine: any = new ScriptGenEngine();

// automationexercise-style login form (email-authenticated app).
const aeCrawl: any = {
  url: 'https://automationexercise.com/login',
  pages: [{ url: 'https://automationexercise.com/login', title: 'Automation Exercise - Login' }],
  elements: [
    { tag: 'input', type: 'email', name: 'email', placeholder: 'Email Address', attributes: { 'data-qa': 'login-email' } },
    { tag: 'input', type: 'password', name: 'password', placeholder: 'Password', attributes: { 'data-qa': 'login-password' } },
    { tag: 'button', type: 'submit', text: 'Login', attributes: { 'data-qa': 'login-button' } },
  ],
};

// The REAL field-per-record shape from the uploaded ZIP's data/test-data.ts.
const fieldPerRecord = [{
  name: 'valid_users', environment: 'shared',
  records: [
    { key: 'email', value: 'paviramesh1812@gmail.com' },
    { key: 'password', value: 'Pavi1812@' },
  ],
}];

const loginCase = {
  id: 1687,
  title: 'Login with valid credentials',
  test_data: 'valid_users[0].email, valid_users[0].password',
  expected_result: 'User is logged in and sees Logged in as username',
  steps: [
    'Navigate to https://automationexercise.com/login',
    'Enter email from valid_users into login-email',
    'Enter password from valid_users into login-password',
    'Click login-button',
    'Verify Logged in as username is displayed',
  ],
};

(async () => {
  /* ───────────────── Issue #1 — Test Data as entities ───────────────── */
  console.log('\n=== Issue #1: field-per-record → entity, real credential binding ===');
  {
    const result = await engine.generate({
      url: 'https://automationexercise.com/login',
      cachedCrawlData: aeCrawl,
      testCases: [loginCase],
      resolvedTestData: fieldPerRecord,
    });
    const files = result.generatedFiles || [];
    const data = files.find((f: any) => /data\/test-data/.test(f.path))?.content as string ?? '';
    const spec = files.find((f: any) => /\.spec\./.test(f.path))?.content as string ?? '';

    check('data module collapses field rows into ONE entity record',
      /"email":\s*"paviramesh1812@gmail\.com"/.test(data) && /"password":\s*"Pavi1812@"/.test(data));
    check('entity exposes username alias (email-auth)',
      /"username":\s*"paviramesh1812@gmail\.com"/.test(data));
    check('spec resolves the dataset record', /const user = getRecord\("valid_users"\)/.test(spec));
    check('spec binds user.username (real data)', /\.fill\(user\.username \?\? ''\)/.test(spec));
    check('spec binds user.password (real data)', /\.fill\(user\.password \?\? ''\)/.test(spec));
    check('spec does NOT fall back to process.env credentials',
      !/process\.env\.TEST_USERNAME/.test(spec) && !/process\.env\.TEST_PASSWORD/.test(spec), spec);
    check('re-materialization warning surfaced on result.testDataWarnings',
      Array.isArray(result.testDataWarnings) && result.testDataWarnings.some((w: string) => /field-per-record/.test(w)));
  }

  /* ───────────────── Issue #4 — App-Profile verification ───────────────── */
  console.log('\n=== Issue #4: grounded verification, not generic ===');
  {
    const result = await engine.generate({
      url: 'https://automationexercise.com/login',
      cachedCrawlData: aeCrawl,
      testCases: [loginCase],
      resolvedTestData: fieldPerRecord,
    });
    const spec = (result.generatedFiles || []).find((f: any) => /\.spec\./.test(f.path))?.content as string ?? '';
    check('inline "Verify … is displayed" becomes an assertion (getByText), not a fill',
      /expect\(page\.getByText\(\/Logged in as\/i\)/.test(spec));
    check('verify step is NOT mis-routed to a fill', !/\.fill\('displayed'\)/.test(spec), spec);
  }

  /* ───────────────── Issue #2 — navigation centralization ───────────────── */
  console.log('\n=== Issue #2: navigation centralized in Page Object ===');
  {
    const repoProfile: any = {
      framework: 'playwright', language: 'typescript',
      pageObjects: [
        { name: 'LoginPage', filePath: 'src/pages/login.page.ts',
          methods: [{ name: 'open' }, { name: 'login' }] },
      ],
    };
    const result = await engine.generate({
      url: 'https://www.saucedemo.com',
      repoProfile,
      cachedCrawlData: {
        url: 'https://www.saucedemo.com/',
        elements: [
          { tag: 'input', id: 'user-name', attributes: { 'data-test': 'username', id: 'user-name' } },
          { tag: 'input', id: 'password', attributes: { 'data-test': 'password', id: 'password' } },
          { tag: 'input', id: 'login-button', attributes: { 'data-test': 'login-button', id: 'login-button' } },
        ],
      },
      testCase: {
        id: 42, title: 'Valid login with standard_user',
        expected_result: 'redirected to the Inventory page',
        steps: [
          'Navigate to https://www.saucedemo.com',
          'Enter valid username from valid_users: standard_user',
          'Enter valid password placeholder <password>',
          'Click the login button',
        ],
      },
    });
    const spec = (result.generatedFiles || [])[0]?.content as string ?? '';
    check('entry navigation drives through loginPage.open()', /await loginPage\.open\(\)/.test(spec), spec);
    check('no raw page.goto duplicated inline', !/await page\.goto\(/.test(spec), spec);
  }

  /* ───────────────── Issue #3 — configurable unmapped-step policy ───────── */
  console.log('\n=== Issue #3: configurable unmapped-step policy ===');
  const unmappableCase = {
    id: 99, title: 'Case with an un-mappable step',
    expected_result: 'the widget behaves',
    steps: [
      'Navigate to https://automationexercise.com/login',
      'Frobnicate the flux capacitor thoroughly',   // nothing can map this
    ],
  };
  {
    // default = warn
    const result = await engine.generate({
      url: 'https://automationexercise.com/login', cachedCrawlData: aeCrawl,
      testCases: [unmappableCase],
    });
    const spec = (result.generatedFiles || []).find((f: any) => /\.spec\./.test(f.path))?.content as string ?? '';
    check('warn policy: @warning marker emitted', /@warning: step not auto-mapped/.test(spec));
    check('warn policy: soft runtime annotation emitted', /test\.info\(\)\.annotations\.push/.test(spec));
    check('warn policy: unmapped step reported on result', 
      Array.isArray(result.unmappedSteps) && result.unmappedSteps.some((u: any) => /Frobnicate/.test(u.step)));
  }
  {
    // comment policy
    const result = await engine.generate({
      url: 'https://automationexercise.com/login', cachedCrawlData: aeCrawl,
      testCases: [unmappableCase], unmappedStepPolicy: 'comment',
    });
    const spec = (result.generatedFiles || []).find((f: any) => /\.spec\./.test(f.path))?.content as string ?? '';
    check('comment policy: legacy NOTE emitted', /NOTE: step not auto-mapped — review manually\./.test(spec));
    check('comment policy: no @warning marker', !/@warning/.test(spec));
  }
  {
    // error policy — generation should throw (never ship an unmapped spec)
    let threw = false;
    try {
      await engine.generate({
        url: 'https://automationexercise.com/login', cachedCrawlData: aeCrawl,
        testCases: [unmappableCase], unmappedStepPolicy: 'error',
      });
    } catch { threw = true; }
    check('error policy: generation throws on an unmapped step', threw);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
