/**
 * Unit tests for repo-pattern-analyzer.ts
 *
 * Verifies that a RepositoryProfile is distilled into a usable RepoPatternGuide
 * (structured summary + prompt block + repo-consistent file naming), that the
 * confidence gate works, and that the TTL cache returns a stable instance.
 *
 * Run with: npx tsx tests/unit/repo-pattern-analyzer.test.ts
 */

import {
  analyzeRepoPatterns,
  clearRepoPatternCache,
} from '../../src/script-gen/repo-pattern-analyzer';
import type { RepositoryProfile } from '../../src/context/types';

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

const baseProfile: RepositoryProfile = {
  framework: 'playwright',
  language: 'typescript',
  testPattern: 'page-object-model',
  locatorStrategy: 'data-testid',
  folderStructure: {
    testFolder: 'tests',
    pageObjectFolder: 'pages',
    fixtureFolder: 'fixtures',
    utilsFolder: 'utils',
    testDataFolder: 'data',
    apiFolder: null,
    configFiles: ['playwright.config.ts'],
    supportFiles: [],
  },
  totalFiles: 30,
  totalTestFiles: 12,
  totalHelperFiles: 4,
  totalLineCount: 2400,
  codingStyle: {
    namingConvention: 'camelCase',
    testNaming: 'should_x_when_y',
    stepStyle: 'describe-it',
    tagConvention: '@smoke',
    indentStyle: 'spaces-2',
    quoteStyle: 'single',
    semicolons: true,
  },
  helperFunctions: [
    { name: 'login', filePath: 'utils/auth.ts', params: ['page', 'user'], returnType: 'Promise<void>', isExported: true, isAsync: true, lineNumber: 1 } as any,
  ],
  pageObjects: [
    { name: 'LoginPage', filePath: 'pages/login.page.ts', isExported: true, baseClass: null, methods: [{ name: 'login' } as any], properties: [], category: 'page-object', lineNumber: 1 } as any,
  ],
  fixtures: [
    { name: 'authedPage', filePath: 'fixtures/authed.ts' } as any,
  ],
  customCommands: [],
  sharedConstants: [],
  businessFlows: [],
  testSuites: [
    { name: 'Login', filePath: 'tests/login.spec.ts', testCount: 2, testNames: ['a', 'b'], describeName: 'Login', tags: ['@auth'], category: 'auth' } as any,
  ],
  preferredLocators: ['getByRole', 'getByTestId'],
  avoidPatterns: ['xpath', 'nth-child'],
  dependencies: [{ name: '@playwright/test', version: '^1.40.0', isDev: true }],
  assertionLibrary: '@playwright/test',
  hasApiLayer: false,
  hasCustomFixtures: true,
  hasMocking: false,
  hasVisualTesting: false,
  ciIntegration: 'github-actions',
} as RepositoryProfile;

/* ------------------------------------------------------------------ */
/*  Tiny assertion harness (matches repo-analyzer.test.ts style)       */
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

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

clearRepoPatternCache();

console.log('\n=== Rich profile → guide ===');
const guide = analyzeRepoPatterns(baseProfile);
assert(!!guide, 'guide should be produced for a rich profile');
if (guide) {
  assertEqual(guide.summary.framework, 'playwright', 'framework carried through');
  assertEqual(guide.summary.language, 'typescript', 'language carried through');
  assert(guide.summary.confidence >= 15, 'confidence above gate');
  assert(guide.summary.preferredLocators.length > 0, 'preferred locators captured');
  assert(guide.summary.helpers.length > 0, 'helpers captured for reuse');
  assert(guide.summary.pageObjects.length > 0, 'page objects captured for reuse');
  assert(guide.promptBlock.length > 0, 'prompt block is non-empty');
  assert(/playwright/i.test(guide.promptBlock), 'prompt block mentions the framework');

  // Repo-consistent file naming: camelCase + .spec (from testNaming/suites).
  const fileName = guide.buildFileName('user-login');
  assert(fileName.endsWith('.ts'), 'file name has .ts extension for typescript');
  assert(fileName.includes('spec') || fileName.includes('test'), 'file name uses a spec/test suffix');
  console.log(`     buildFileName('user-login') => ${fileName}`);
}

console.log('\n=== Confidence gate ===');
const sparse = analyzeRepoPatterns({
  framework: '' as any,
  language: '' as any,
  testPattern: '' as any,
} as RepositoryProfile);
assert(sparse === undefined, 'empty/sparse profile returns undefined (below confidence gate)');

assert(analyzeRepoPatterns(null) === undefined, 'null profile returns undefined');
assert(analyzeRepoPatterns(undefined) === undefined, 'undefined profile returns undefined');

console.log('\n=== TTL cache returns stable instance ===');
clearRepoPatternCache();
const g1 = analyzeRepoPatterns(baseProfile);
const g2 = analyzeRepoPatterns(baseProfile);
assert(g1 === g2, 'same profile fingerprint returns the cached guide instance');

console.log('\n=== Cache isolation: same shape, different content must NOT collide ===');
// Two repos that share framework/language/style AND identical counts
// (1 helper, 1 page object, 1 fixture, 2 preferred locators) but reference
// completely different helper/page-object names + file paths. The old
// count-based fingerprint would have collided and leaked repo A's internals
// into repo B's guide. The content fingerprint must keep them separate.
clearRepoPatternCache();
const tenantA: RepositoryProfile = {
  ...baseProfile,
  helperFunctions: [
    { name: 'loginAsAdmin', filePath: 'utils/admin-auth.ts', params: ['page'], returnType: 'Promise<void>', isExported: true, isAsync: true, lineNumber: 1 } as any,
  ],
  pageObjects: [
    { name: 'AdminDashboardPage', filePath: 'pages/admin-dashboard.page.ts', isExported: true, baseClass: null, methods: [{ name: 'openSettings' } as any], properties: [], category: 'page-object', lineNumber: 1 } as any,
  ],
  fixtures: [{ name: 'adminSession', filePath: 'fixtures/admin.ts' } as any],
} as RepositoryProfile;

const tenantB: RepositoryProfile = {
  ...baseProfile,
  helperFunctions: [
    { name: 'checkoutCart', filePath: 'utils/checkout.ts', params: ['page'], returnType: 'Promise<void>', isExported: true, isAsync: true, lineNumber: 1 } as any,
  ],
  pageObjects: [
    { name: 'StorefrontPage', filePath: 'pages/storefront.page.ts', isExported: true, baseClass: null, methods: [{ name: 'addToCart' } as any], properties: [], category: 'page-object', lineNumber: 1 } as any,
  ],
  fixtures: [{ name: 'guestSession', filePath: 'fixtures/guest.ts' } as any],
} as RepositoryProfile;

const guideA = analyzeRepoPatterns(tenantA);
const guideB = analyzeRepoPatterns(tenantB);
assert(!!guideA && !!guideB, 'both tenant guides produced');
assert(guideA !== guideB, 'different content yields different cached instances (no collision)');
assert(
  guideA!.promptBlock.includes('loginAsAdmin') && guideA!.promptBlock.includes('AdminDashboardPage'),
  "tenant A guide contains ONLY tenant A's helpers/page-objects",
);
assert(
  !guideA!.promptBlock.includes('checkoutCart') && !guideA!.promptBlock.includes('StorefrontPage'),
  "tenant A guide does NOT leak tenant B's repo internals",
);
assert(
  guideB!.promptBlock.includes('checkoutCart') && guideB!.promptBlock.includes('StorefrontPage'),
  "tenant B guide contains ONLY tenant B's helpers/page-objects",
);
assert(
  !guideB!.promptBlock.includes('loginAsAdmin') && !guideB!.promptBlock.includes('AdminDashboardPage'),
  "tenant B guide does NOT leak tenant A's repo internals",
);

/* ------------------------------------------------------------------ */
/*  Summary                                                            */
/* ------------------------------------------------------------------ */

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
