/**
 * Unit tests for profile-diff-engine.ts — App Profile Versioning & Change Engine.
 *
 * The diff engine is PURE (no DB / no network), so these tests exercise the full
 * Sprint A surface directly:
 *   • computeCoverage    — crawled vs. discovered (nav links + siteMap), origin-agnostic
 *   • computeProfileSignature — enriched, backward-compatible SUPERSET of CrawlSignature
 *   • computeProfileDiff — every structured change type + no-op equality + severity
 *   • coerceProfileSignature — backward compat with a legacy stored signature
 *   • findLocatorReplacement / canonicalizeLocator — the self-healing fast-path
 *   • Graceful degradation on malformed / empty input (never throws)
 *
 * Run with: npx tsx tests/unit/profile-diff-engine.test.ts
 */

import {
  elementIdentity,
  computeCoverage,
  computeProfileSignature,
  computeProfileDiff,
  coerceProfileSignature,
  findLocatorReplacement,
  canonicalizeLocator,
  type ProfileChangeType,
} from '../../src/services/profile-diff-engine';

/* ------------------------------------------------------------------ */
/*  Tiny assert harness (mirrors repo-pattern-analyzer.test.ts)        */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function assertEqual(actual: any, expected: any, msg: string) {
  const ok = actual === expected;
  if (!ok) console.error(`     actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`);
  assert(ok, msg);
}

function countOf(changes: { type: ProfileChangeType }[], type: ProfileChangeType): number {
  return changes.filter((c) => c.type === type).length;
}

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** A login element whose recommended selector is `#loginBtn` (v1). */
function loginButton(selector: string) {
  return {
    tag: 'button',
    type: 'submit',
    role: 'button',
    nearbyLabel: 'Log in',
    textContent: 'Log in',
    selectors: { recommended: selector },
  };
}

function emailInput(selector: string) {
  return {
    tag: 'input',
    type: 'email',
    name: 'email',
    nearbyLabel: 'Email',
    placeholder: 'Email',
    selectors: { recommended: selector },
  };
}

/**
 * A heading whose IDENTITY is anchored by its stable `name` (so it is the same
 * logical element across versions) but whose visible `textContent` changes —
 * this is exactly the shape that should surface as TEXT_CHANGED (and NOT as an
 * add+remove pair).
 */
function heading(text: string) {
  return {
    tag: 'h1',
    name: 'pageTitle',
    textContent: text,
    selectors: { recommended: 'h1.title' },
  };
}

/** A v1 crawl: one login page with two elements + a form + two nav links. */
const crawlV1 = {
  pages: [
    {
      url: 'https://app.example.com/login',
      pageType: 'login',
      elements: [heading('Sign in'), loginButton('#loginBtn'), emailInput('#email')],
      forms: [{ id: 'loginForm', fields: [] }],
      navigationLinks: [
        { href: 'https://app.example.com/login' },
        { href: 'https://app.example.com/signup' },
      ],
    },
  ],
  siteMap: [
    'https://app.example.com/login',
    'https://app.example.com/signup',
    'https://app.example.com/dashboard',
    'https://app.example.com/settings',
  ],
};

/**
 * A v2 crawl of the SAME login page where:
 *   • the login button's selector moved `#loginBtn` → `[data-testid="login"]` (LOCATOR_CHANGED)
 *   • the email input's visible label changed Email → E-mail address (TEXT_CHANGED)
 *   • a brand-new "Forgot password?" link element was added (ELEMENT_ADDED)
 *   • a new /dashboard page appeared (PAGE_ADDED)
 *   • a navigation link to /help was added (NAVIGATION_CHANGED)
 */
const crawlV2 = {
  pages: [
    {
      url: 'https://app.example.com/login',
      pageType: 'login',
      elements: [
        heading('Sign in to continue'),
        loginButton('[data-testid="login"]'),
        emailInput('#email'),
        {
          tag: 'a',
          role: 'link',
          nearbyLabel: 'Forgot password?',
          textContent: 'Forgot password?',
          selectors: { recommended: 'text=Forgot password?' },
        },
      ],
      forms: [{ id: 'loginForm', fields: [] }],
      navigationLinks: [
        { href: 'https://app.example.com/login' },
        { href: 'https://app.example.com/signup' },
        { href: 'https://app.example.com/help' },
      ],
    },
    {
      url: 'https://app.example.com/dashboard',
      pageType: 'dashboard',
      elements: [{ tag: 'h1', nearbyLabel: 'Welcome', textContent: 'Welcome', selectors: { recommended: 'h1' } }],
      forms: [],
      navigationLinks: [],
    },
  ],
  siteMap: [
    'https://app.example.com/login',
    'https://app.example.com/signup',
    'https://app.example.com/dashboard',
    'https://app.example.com/settings',
  ],
};

/* ------------------------------------------------------------------ */
/*  1. elementIdentity — stable & selector-independent                 */
/* ------------------------------------------------------------------ */

console.log('\n— elementIdentity —');
{
  const idV1 = elementIdentity(loginButton('#loginBtn'));
  const idV2 = elementIdentity(loginButton('[data-testid="login"]'));
  assertEqual(idV1, idV2, 'identity is stable across a selector change (selector-independent)');
  assert(idV1.includes('button') && idV1.includes('log in'), 'identity composed of tag + semantic label');
  assert(
    elementIdentity(loginButton('#x')) !== elementIdentity(emailInput('#y')),
    'different logical elements yield different identities',
  );
  assertEqual(elementIdentity({}), '', 'empty element → empty identity (no throw)');
}

/* ------------------------------------------------------------------ */
/*  2. computeCoverage                                                 */
/* ------------------------------------------------------------------ */

console.log('\n— computeCoverage —');
{
  const cov = computeCoverage(crawlV1);
  // crawled = {/login}; discovered = {/login,/signup,/dashboard,/settings}
  assertEqual(cov.crawledPages, 1, 'crawledPages counts distinct crawled paths');
  assertEqual(cov.discoveredPages, 4, 'discoveredPages = union of crawled + nav + siteMap');
  assertEqual(cov.coveragePct, 25, 'coveragePct = round(1/4*100) = 25');
  assert(cov.uncrawled.includes('/dashboard') && cov.uncrawled.includes('/settings'),
    'uncrawled lists discovered-but-not-crawled paths');

  const full = computeCoverage(crawlV2);
  // crawled = {/login,/dashboard}; discovered adds /signup,/settings,/help
  assertEqual(full.crawledPages, 2, 'v2 crawled two pages');
  assert(full.coveragePct > 25, 'coverage rises as more pages are crawled');

  const empty = computeCoverage(null);
  assertEqual(empty.coveragePct, 0, 'null crawl → 0% coverage (no throw)');
  assertEqual(empty.crawledPages, 0, 'null crawl → 0 crawled pages');
}

/* ------------------------------------------------------------------ */
/*  3. computeProfileSignature — backward-compatible superset          */
/* ------------------------------------------------------------------ */

console.log('\n— computeProfileSignature —');
{
  const sig = computeProfileSignature(crawlV1);
  // Legacy CrawlSignature fields must be present (backward compat).
  assert(Array.isArray(sig.pages), 'retains legacy `pages` array');
  assert(Array.isArray(sig.allSelectors), 'retains legacy `allSelectors`');
  assert(typeof sig.totalElements === 'number', 'retains legacy `totalElements`');
  // Enriched fields.
  assert(Array.isArray(sig.profilePages) && sig.profilePages.length === 1, 'adds enriched `profilePages`');
  assert(!!sig.coverage && typeof sig.coverage.coveragePct === 'number', 'adds `coverage`');
  const lp = sig.profilePages[0];
  assert(lp.elements.length === 3, 'enriched page captures identity-keyed elements');
  assert(lp.navHrefs.includes('/signup'), 'navHrefs normalised to path');
  assert(lp.formKeys.includes('loginform'), 'formKeys captured (lowercased)');
}

/* ------------------------------------------------------------------ */
/*  4. computeProfileDiff — every change type                          */
/* ------------------------------------------------------------------ */

console.log('\n— computeProfileDiff (v1 → v2) —');
{
  const sigV1 = computeProfileSignature(crawlV1);
  const sigV2 = computeProfileSignature(crawlV2);
  const diff = computeProfileDiff(sigV1, sigV2);

  assert(!diff.unchanged, 'diff detects changes between versions');
  assertEqual(countOf(diff.changes, 'LOCATOR_CHANGED'), 1, 'detects the login button locator change');
  assertEqual(countOf(diff.changes, 'TEXT_CHANGED'), 1, 'detects the email label text change');
  assertEqual(countOf(diff.changes, 'ELEMENT_ADDED'), 1, 'detects the new "Forgot password?" element');
  assertEqual(countOf(diff.changes, 'PAGE_ADDED'), 1, 'detects the new /dashboard page');
  assertEqual(countOf(diff.changes, 'NAVIGATION_CHANGED'), 1, 'detects the new /help nav link');

  const loc = diff.changes.find((c) => c.type === 'LOCATOR_CHANGED')!;
  assertEqual(loc.old, '#loginBtn', 'LOCATOR_CHANGED carries the old selector');
  assertEqual(loc.new, '[data-testid="login"]', 'LOCATOR_CHANGED carries the new selector');
  assertEqual(loc.severity, 'high', 'a locator change is high severity (breaks scripts)');
  assertEqual(diff.severity, 'high', 'overall diff severity is high');
  assert(diff.summary.includes('locator'), 'summary mentions locator change');
}

console.log('\n— computeProfileDiff (removals) —');
{
  // v2 → v1 should report the dashboard page removal + element removals.
  const diff = computeProfileDiff(computeProfileSignature(crawlV2), computeProfileSignature(crawlV1));
  assertEqual(countOf(diff.changes, 'PAGE_REMOVED'), 1, 'detects /dashboard removal going backwards');
  assertEqual(countOf(diff.changes, 'ELEMENT_REMOVED'), 1, 'detects "Forgot password?" element removal');
  const removed = diff.changes.find((c) => c.type === 'PAGE_REMOVED')!;
  assertEqual(removed.severity, 'high', 'page removal is high severity');
}

console.log('\n— computeProfileDiff (no-op equality) —');
{
  const sig = computeProfileSignature(crawlV1);
  const diff = computeProfileDiff(sig, sig);
  assert(diff.unchanged, 'identical signatures → unchanged');
  assertEqual(diff.changes.length, 0, 'identical signatures → zero changes');
  assertEqual(diff.severity, 'none', 'identical signatures → severity none');
  assertEqual(diff.summary, 'No changes detected', 'unchanged summary text');
}

/* ------------------------------------------------------------------ */
/*  5. coerceProfileSignature — backward compat with legacy snapshots  */
/* ------------------------------------------------------------------ */

console.log('\n— coerceProfileSignature (legacy signature) —');
{
  // Simulate a snapshot persisted BEFORE this feature: a bare CrawlSignature
  // with no profilePages / coverage. It must coerce without throwing and diff
  // cleanly against an enriched signature.
  const legacy = {
    pages: [{ url: 'https://app.example.com/login', pageType: 'login', selectors: ['#loginBtn'], elementCount: 2, formCount: 1 }],
    allSelectors: ['#loginBtn', '#email'],
    totalElements: 2, totalForms: 1, totalSelectors: 2, pageCount: 1,
  };
  const coerced = coerceProfileSignature(legacy);
  assert(Array.isArray(coerced.profilePages) && coerced.profilePages.length === 1, 'legacy signature coerced to profilePages');
  assert(!!coerced.coverage, 'coerced signature has a coverage object');
  assertEqual(coerced.profilePages[0].elements.length, 0, 'legacy has no identity-keyed elements (degrades gracefully)');

  // Diffing legacy (prev) → enriched (curr) must not throw and should at least
  // see the new /dashboard page.
  const diff = computeProfileDiff(legacy, computeProfileSignature(crawlV2));
  assert(countOf(diff.changes, 'PAGE_ADDED') >= 1, 'legacy→enriched diff still detects added page');
}

/* ------------------------------------------------------------------ */
/*  6. findLocatorReplacement / canonicalizeLocator — healing fast-path */
/* ------------------------------------------------------------------ */

console.log('\n— canonicalizeLocator —');
{
  assertEqual(canonicalizeLocator('#loginBtn'), '#loginBtn', 'bare #id canonicalises to #id form');
  assertEqual(canonicalizeLocator('page.locator("#loginBtn")'), '#loginBtn', 'extracts #id from wrapper');
  assertEqual(canonicalizeLocator('getByTestId("login")'), '[data-testid="login"]', 'normalises getByTestId → attr form');
  assertEqual(canonicalizeLocator('[data-testid="login"]'), '[data-testid="login"]', 'data-testid attr canonical');
  assertEqual(canonicalizeLocator('[name="email"]'), '[name="email"]', 'name attr canonical');
}

console.log('\n— findLocatorReplacement —');
{
  const diff = computeProfileDiff(computeProfileSignature(crawlV1), computeProfileSignature(crawlV2));
  const changes = diff.changes.map((c) => ({ type: c.type, old: c.old, new: c.new }));

  assertEqual(findLocatorReplacement(changes, '#loginBtn'), '[data-testid="login"]',
    'finds the new selector for a broken old locator');
  assertEqual(findLocatorReplacement(changes, 'page.locator("#loginBtn")'), '[data-testid="login"]',
    'matches even when the broken locator is wrapped');
  assertEqual(findLocatorReplacement(changes, '#nonexistent'), null,
    'returns null when no LOCATOR_CHANGED matches');
  assertEqual(findLocatorReplacement(changes, ''), null, 'empty locator → null');
  assertEqual(findLocatorReplacement([], '#loginBtn'), null, 'empty change set → null');
}

/* ------------------------------------------------------------------ */
/*  7. Graceful degradation on malformed input                         */
/* ------------------------------------------------------------------ */

console.log('\n— malformed input —');
{
  let threw = false;
  try {
    computeProfileSignature(undefined as any);
    computeProfileSignature({} as any);
    computeProfileSignature({ pages: 'not-an-array' } as any);
    computeProfileDiff(null, null);
    computeProfileDiff({ garbage: true }, { pages: [{}] });
    computeCoverage('a string' as any);
  } catch {
    threw = true;
  }
  assert(!threw, 'malformed / empty inputs never throw (graceful degradation)');

  const emptyDiff = computeProfileDiff(null, null);
  assert(emptyDiff.unchanged, 'null vs null → unchanged');
}

/* ------------------------------------------------------------------ */
/*  Summary                                                            */
/* ------------------------------------------------------------------ */

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
