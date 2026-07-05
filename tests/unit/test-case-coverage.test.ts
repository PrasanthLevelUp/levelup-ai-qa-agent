/**
 * Test-Case Page-Coverage
 *
 * Locks the behaviour that makes locator grounding honest: Script Generation
 * must know WHICH pages a test case operates on and whether the crawl/profile
 * actually covers them. This is the root-cause fix for "cached real DOM · REAL
 * LOCATORS 0/N" — login test cases were being grounded against a home-page-only
 * profile because the crawl never visited /login.
 *
 * Run: npx tsx tests/unit/test-case-coverage.test.ts
 */
import {
  deriveTestCaseTargetUrls,
  profileCoversTargets,
  normalizeUrlPath,
  collectCrawledUrls,
} from '../../src/script-gen/test-case-coverage';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

const BASE = 'https://automationexercise.com/';

// A realistic login test case (matches the uploaded test-cases CSV shape).
const loginCase = {
  title: 'User logs in successfully with valid credentials',
  preconditions: 'User is registered and has valid credentials',
  steps: [
    '1. Navigate to the Login page (https://automationexercise.com/login)',
    "2. Enter registered email address in input[name='email']",
    "3. Enter valid password in input[name='password']",
    '4. Click Login button (selector: text=Login)',
  ],
  expected_result:
    'User is redirected to Home page (https://automationexercise.com/) and is logged in successfully',
};

const sessionCase = {
  title: 'User session remains active until logout',
  steps:
    '1. Do not log out\n2. Navigate to another page (e.g. https://automationexercise.com/products)\n3. Return to Home page',
  expected_result: 'User remains logged in',
};

console.log('\n🧪 deriveTestCaseTargetUrls');
{
  const urls = deriveTestCaseTargetUrls([loginCase], BASE);
  check('extracts the /login page a login case navigates to',
    urls.some(u => u.endsWith('/login')), JSON.stringify(urls));
  check('does NOT include the base/home page (always crawled)',
    !urls.some(u => normalizeUrlPath(u) === '/'), JSON.stringify(urls));

  const many = deriveTestCaseTargetUrls([loginCase, sessionCase], BASE);
  check('aggregates across cases (/login + /products)',
    many.some(u => u.endsWith('/login')) && many.some(u => u.endsWith('/products')),
    JSON.stringify(many));

  // De-dupe: two cases hitting /login yield one target.
  const dup = deriveTestCaseTargetUrls([loginCase, { ...loginCase }], BASE);
  check('de-dupes the same page across cases',
    dup.filter(u => u.endsWith('/login')).length === 1, JSON.stringify(dup));
}

console.log('\n🧪 relative paths + cross-origin safety');
{
  const rel = deriveTestCaseTargetUrls(
    [{ steps: ['Go to /checkout then /payment'] }],
    BASE,
  );
  check('resolves bare relative paths against baseUrl',
    rel.some(u => u === 'https://automationexercise.com/checkout') &&
    rel.some(u => u === 'https://automationexercise.com/payment'),
    JSON.stringify(rel));

  const cross = deriveTestCaseTargetUrls(
    [{ steps: ['Open https://evil.example.com/login for reference'] }],
    BASE,
  );
  check('never targets a third-party (cross-origin) URL', cross.length === 0, JSON.stringify(cross));

  check('empty input → no targets', deriveTestCaseTargetUrls([], BASE).length === 0);
}

console.log('\n🧪 normalizeUrlPath');
{
  check('strips trailing slash', normalizeUrlPath('https://x.com/login/') === '/login');
  check('drops query + hash', normalizeUrlPath('https://x.com/login?a=1#top') === '/login');
  check('root stays "/"', normalizeUrlPath('https://x.com/') === '/');
  check('bare path accepted', normalizeUrlPath('/products') === '/products');
  check('garbage rejected', normalizeUrlPath('not a url') === null);
}

console.log('\n🧪 profileCoversTargets');
{
  const targets = deriveTestCaseTargetUrls([loginCase], BASE); // → [.../login]

  // Home-page-only profile (the bug scenario): /login is NOT covered.
  const homeOnly = { url: BASE, pages: [{ url: BASE, elements: [{ tag: 'a' }] }] };
  const r1 = profileCoversTargets(homeOnly, targets);
  check('home-only profile → /login reported MISSING',
    r1.missing.length === 1 && r1.covered.length === 0, JSON.stringify(r1));

  // Profile that DID crawl /login: covered.
  const withLogin = {
    url: BASE,
    pages: [
      { url: BASE, elements: [] },
      { url: 'https://automationexercise.com/login', elements: [{ tag: 'input' }] },
    ],
  };
  const r2 = profileCoversTargets(withLogin, targets);
  check('profile containing /login → covered, nothing missing',
    r2.covered.length === 1 && r2.missing.length === 0, JSON.stringify(r2));

  // Trailing-slash / normalization tolerance.
  const slashy = { pages: [{ url: 'https://automationexercise.com/login/' }] };
  check('matches despite trailing slash mismatch',
    profileCoversTargets(slashy, targets).missing.length === 0);

  // No targets → nothing missing (cache guard must be a no-op).
  check('no targets → no missing (guard no-op)',
    profileCoversTargets(homeOnly, []).missing.length === 0);
}

console.log('\n🧪 collectCrawledUrls (shape-agnostic)');
{
  check('flat single-page shape', collectCrawledUrls({ url: BASE }).includes(BASE));
  check('multi-page shape',
    collectCrawledUrls({ pages: [{ url: 'a' }, { finalUrl: 'b' }] }).length === 2);
  check('null → []', collectCrawledUrls(null).length === 0);
}

console.log(`\n${failed === 0 ? '✅' : '❌'} test-case-coverage: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
