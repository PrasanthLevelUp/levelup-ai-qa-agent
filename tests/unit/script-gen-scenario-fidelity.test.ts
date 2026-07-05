/**
 * Regression test for the "Script Gen Quality" review fixes (deterministic
 * test-case build path — NOT the LLM path). Driven through the PUBLIC generate()
 * entry point with cached crawl data so no network/LLM is used.
 *
 * Locks in the 5 prioritized review fixes:
 *   P1 Scenario Intent Fidelity — the generated step IMPLEMENTS the exact scenario
 *      (whitespace / special-chars / max-length / empty / invalid), not a copied
 *      happy-path login.
 *   P2 Repository Intelligence — when a dataset record is bound to `user`, reads
 *      user.username / user.password (not literal + bare process.env).
 *   P3 Assertion Intelligence — error text is derived from the Expected Result,
 *      not the title. locked→'locked out', empty→'is required',
 *      invalid→'do not match', ambiguous→surface-only (no guessed text).
 *   P4 Repository Reuse — prefers LoginPage.open() over page.goto() and
 *      loginPage.getError() over a raw error locator, with NO duplicate navigation.
 *   P5 Coverage Metadata — header emits derived categories + repository assets
 *      reused (never "Coverage: n/a").
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

// LoginPage exposes open() + login() + getError() so the P4 reuse rewrite is
// exercised (nav method + error getter both available).
const repoProfile: any = {
  framework: 'playwright', language: 'typescript', testPattern: 'pom',
  helperFunctions: [], fixtures: [], sharedConstants: [], dataFiles: [], dependencies: [],
  pageObjects: [
    { name: 'LoginPage', filePath: 'tests/pages/LoginPage.ts', isExported: true, baseClass: null,
      methods: [
        mkMethod('open', 'tests/pages/LoginPage.ts'),
        mkMethod('login', 'tests/pages/LoginPage.ts'),
        mkMethod('getError', 'tests/pages/LoginPage.ts'),
      ], properties: [] },
  ],
};

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

// Mirrors the uploaded CSV (IDs 1392–1399): all "Locked user login attempt…"
// variants bound to the locked_users dataset, but each a DIFFERENT scenario.
const testCases: any[] = [
  { id: 1392, title: 'Locked user login attempt with valid credentials', priority: 'P0',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'Login should fail and an error message is displayed indicating the account is locked out.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter username from locked_users: locked_out_user',
      'Enter valid password', 'Click the login button'] },
  { id: 1393, title: 'Locked user login attempt with invalid credentials', priority: 'P0',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'An error message is displayed indicating credentials do not match.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter an invalid username', 'Enter an invalid password', 'Click the login button'] },
  { id: 1396, title: 'Locked user login attempt with leading/trailing whitespace', priority: 'P1',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'An error message is displayed.',
    steps: ['Navigate to https://www.saucedemo.com', "Enter ' locked_user ' with whitespace", 'Enter valid password', 'Click the login button'] },
  { id: 1397, title: 'Locked user login attempt with special characters', priority: 'P1',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'An error message is displayed.',
    steps: ['Navigate to https://www.saucedemo.com', "Enter '@locked_user' username", 'Enter valid password', 'Click the login button'] },
  { id: 1398, title: 'Locked user login attempt with empty fields', priority: 'P1',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'An error message is displayed indicating that fields are required.',
    steps: ['Leave the username field empty', 'Leave the password field empty', 'Click the login button'] },
  { id: 1399, title: 'Locked user login attempt with maximum length username', priority: 'P1',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'An error message is displayed.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter a maximum length username of 256 characters', 'Enter valid password', 'Click the login button'] },
];

async function main() {
  const engine = new ScriptGenEngine();
  const result = await engine.generate({ url: 'https://www.saucedemo.com', cachedCrawlData, repoProfile, testCases } as any);
  const byPath = new Map(result.generatedFiles.map(f => [f.path, f.content]));

  // Scenarios are CONSOLIDATED by page: all six locked-login cases live inside a
  // single login.spec.ts as separate `test(...)` blocks (coverage over file
  // count — a product requirement). Extract one scenario's block (incl. its doc
  // comment) by title using brace-depth matching.
  const scenario = (titleFrag: string): string => {
    for (const content of byPath.values()) {
      const lines = content.split('\n');
      const start = lines.findIndex(l =>
        /^\s*test(\.(fixme|skip|only))?\(/.test(l) && l.includes(titleFrag));
      if (start === -1) continue;
      let docStart = start;
      for (let i = start - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t === '') { docStart = i; continue; }
        if (t.endsWith('*/')) { while (i >= 0 && !lines[i].trim().startsWith('/**')) i--; docStart = i; }
        break;
      }
      let depth = 0, seen = false, end = lines.length - 1;
      for (let i = start; i < lines.length; i++) {
        for (const ch of lines[i]) { if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--; }
        if (seen && depth <= 0) { end = i; break; }
      }
      return lines.slice(docStart, end + 1).join('\n');
    }
    return '';
  };

  const validLocked = scenario('Locked user login attempt with valid credentials');
  const invalid = scenario('Locked user login attempt with invalid credentials');
  const whitespace = scenario('Locked user login attempt with leading/trailing whitespace');
  const special = scenario('Locked user login attempt with special characters');
  const empty = scenario('Locked user login attempt with empty fields');
  const maxlen = scenario('Locked user login attempt with maximum length username');

  console.log('=== P1: Scenario Intent Fidelity (each spec implements its OWN scenario) ===');
  ok('whitespace wraps the username with leading/trailing spaces', /\.login\(`\s\$\{user\.username \?\? ''\}\s`,/.test(whitespace));
  ok('special-chars injects the "@" literal', /\.login\('@locked_user',/.test(special));
  ok('max-length uses \'A\'.repeat(256)', /\.login\('A'\.repeat\(256\),/.test(maxlen));
  ok('empty fields log in with two empty strings', /\.login\('',\s*''\)/.test(empty));
  ok('invalid uses invalid creds (not the happy path)', /\.login\('invalid_user',\s*'wrong_password'\)/.test(invalid));
  ok('valid-creds locked case uses the bound record', /\.login\(user\.username \?\? '', user\.password \?\? ''\)/.test(validLocked));
  ok('the 6 specs are NOT identical copies', new Set([validLocked, invalid, whitespace, special, empty, maxlen].map(s => s.replace(/\/\*[\s\S]*?\*\//, ''))).size === 6);

  console.log('=== P2: Repository Intelligence (bind to the loaded record) ===');
  ok('locked case binds const user = getRecord("locked_users")', /const user = getRecord\("locked_users"\)/.test(validLocked));
  ok('valid-creds case reads user.username / user.password', /user\.username/.test(validLocked) && /user\.password/.test(validLocked));
  ok('whitespace case reuses user.username (not a hard-coded literal)', /user\.username/.test(whitespace));
  ok('no case falls back to a bare process.env.TEST_PASSWORD literal', ![validLocked, whitespace, special, maxlen].some(c => /process\.env\.TEST_PASSWORD/.test(c)));

  console.log('=== P3: Assertion Intelligence (derive text from Expected Result, not title) ===');
  ok('locked (account is locked out) asserts toContainText("locked out")', /toContainText\('locked out'\)/.test(validLocked));
  ok('invalid asserts toContainText("do not match")', /toContainText\('do not match'\)/.test(invalid));
  ok('empty asserts toContainText("is required")', /toContainText\('is required'\)/.test(empty));
  ok('whitespace (ambiguous msg) does NOT guess error text', !/toContainText\(/.test(whitespace));
  ok('special (ambiguous msg) does NOT guess error text', !/toContainText\(/.test(special));
  ok('max-length (ambiguous msg) does NOT guess error text', !/toContainText\(/.test(maxlen));
  ok('no spec blindly asserts "locked out" from the title', ![invalid, empty, whitespace, special, maxlen].some(c => /toContainText\('locked out'\)/.test(c)));

  console.log('=== P4: Repository Reuse (open() + getError(), no duplicate navigation) ===');
  ok('nav step reuses loginPage.open()', /await loginPage\.open\(\);/.test(validLocked));
  ok('error assertions reuse loginPage.getError()', /expect\(loginPage\.getError\(\)\)/.test(validLocked) && /expect\(loginPage\.getError\(\)\)/.test(invalid));
  ok('specs do NOT use a raw [data-test="error"] locator when getError() exists', ![validLocked, invalid, empty].some(c => /locator\('\[data-test="error"\]'\)/.test(c)));
  ok('valid-creds case does NOT double-navigate (open() present, no page.goto)', /loginPage\.open\(\)/.test(validLocked) && !/page\.goto/.test(validLocked));

  console.log('=== P5: Coverage Metadata (derived categories + assets, never n/a) ===');
  ok('no spec emits "Coverage: n/a"', ![validLocked, invalid, whitespace, special, empty, maxlen].some(c => /Coverage:\s*n\/a/.test(c)));
  ok('locked case categorised as Negative', /Coverage:\s*[^\n]*Negative/.test(validLocked));
  ok('whitespace/max-length categorised as Boundary', /Coverage:\s*[^\n]*Boundary/.test(whitespace) && /Coverage:\s*[^\n]*Boundary/.test(maxlen));
  ok('empty categorised as Validation', /Coverage:\s*[^\n]*Validation/.test(empty));
  ok('header lists Repository Assets Reused (LoginPage + dataset)', /Repository Assets Reused:[^\n]*LoginPage \(Page Object\)/.test(validLocked) && /Repository Assets Reused:[^\n]*locked_users/.test(validLocked));

  console.log(`\n──────── ${passed} passed, ${failed} failed ────────`);
  if (failed > 0) process.exit(1);
}
main().catch(e => { console.error(e); process.exit(1); });
