/**
 * Unit tests for Reuse Intelligence (project-convention-profile.ts).
 *
 * Proves the Repo-Intelligence-owned reuse catalogue:
 *   • Greenfield (null profile) → empty catalogue (zero regression: nothing to reuse)
 *   • Connected repo → catalogue populated from the scanned RepositoryProfile
 *   • "Ask Repo Intelligence" query APIs resolve by normalized name intent
 *   • apis/components derived honestly from names; testData from data files
 *
 * Run with: npx tsx tests/unit/reuse-intelligence.test.ts
 */

import {
  buildConventionProfile,
  buildReuseCatalogue,
  findReusablePageObject,
  findReusableHelper,
  findReusableFixture,
  findReusableTestData,
  findReusableApi,
  findReusableComponent,
  hasReusableAssets,
  EMPTY_REUSE_CATALOGUE,
} from '../../src/intelligence/project-convention-profile';
import type { RepositoryProfile } from '../../src/context/types';

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    passed++;
    console.log(`  ✅ ${msg}`);
  } else {
    failed++;
    console.error(`  ❌ ${msg}`);
  }
}

function assertEqual(actual: any, expected: any, msg: string) {
  const ok = actual === expected;
  if (!ok) console.error(`     actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`);
  assert(ok, msg);
}

/* ------------------------------------------------------------------ */
/*  1. Greenfield — empty catalogue, nothing to reuse                  */
/* ------------------------------------------------------------------ */

console.log('\n=== Greenfield (null profile) — empty catalogue ===');
const green = buildConventionProfile(null);
assertEqual(green.reuse.pageObjects.length, 0, 'greenfield: no page objects');
assertEqual(green.reuse.helpers.length, 0, 'greenfield: no helpers');
assertEqual(green.reuse.fixtures.length, 0, 'greenfield: no fixtures');
assertEqual(green.reuse.apis.length, 0, 'greenfield: no apis');
assertEqual(green.reuse.components.length, 0, 'greenfield: no components');
assertEqual(green.reuse.testData.length, 0, 'greenfield: no test data');
assertEqual(hasReusableAssets(green), false, 'greenfield: hasReusableAssets false');
assert(green.reuse === EMPTY_REUSE_CATALOGUE, 'greenfield: shares the EMPTY_REUSE_CATALOGUE singleton');
// Query APIs return null on greenfield → generation proceeds unchanged.
assertEqual(findReusablePageObject(green, 'LoginPage'), null, 'greenfield: no LoginPage to reuse');
assertEqual(findReusableHelper(green, 'AuthHelper'), null, 'greenfield: no AuthHelper to reuse');
assertEqual(buildReuseCatalogue(undefined), EMPTY_REUSE_CATALOGUE, 'undefined profile → empty catalogue');

/* ------------------------------------------------------------------ */
/*  2. Connected repo — catalogue populated                            */
/* ------------------------------------------------------------------ */

console.log('\n=== Connected repo — populated catalogue ===');
const repo = {
  framework: 'playwright',
  language: 'typescript',
  testPattern: 'page-object-model',
  folderStructure: {
    testFolder: 'tests', pageObjectFolder: 'pages', fixtureFolder: 'fixtures',
    utilsFolder: 'utils', testDataFolder: 'tests/data', apiFolder: 'api',
    configFiles: [], supportFiles: [],
  },
  pageObjects: [
    {
      name: 'LoginPage', filePath: 'pages/LoginPage.ts', isExported: true, baseClass: 'BasePage',
      methods: [
        { name: 'login', filePath: 'pages/LoginPage.ts', isExported: true, isAsync: true, parameters: [], returnType: 'Promise<void>', jsdoc: '', lineNumber: 10, category: 'page-object', complexity: 1 },
        { name: 'logout', filePath: 'pages/LoginPage.ts', isExported: true, isAsync: true, parameters: [], returnType: 'Promise<void>', jsdoc: '', lineNumber: 20, category: 'page-object', complexity: 1 },
      ],
      properties: [
        { name: 'username', type: 'Locator', isReadonly: true, selector: '#user-name', locatorType: 'css' },
        { name: 'password', type: 'Locator', isReadonly: true, selector: '#password', locatorType: 'css' },
      ],
      category: 'page-object', lineNumber: 1,
    },
    {
      name: 'CheckoutPage', filePath: 'pages/CheckoutPage.ts', isExported: true, baseClass: null,
      methods: [], properties: [{ name: 'firstName', type: 'Locator', isReadonly: true, selector: '#first-name', locatorType: 'css' }],
      category: 'page-object', lineNumber: 1,
    },
  ],
  helperFunctions: [
    { name: 'login', filePath: 'utils/AuthHelper.ts', isExported: true, isAsync: true, parameters: [], returnType: 'Promise<void>', jsdoc: '', lineNumber: 5, category: 'helper', complexity: 1 },
    { name: 'logout', filePath: 'utils/AuthHelper.ts', isExported: true, isAsync: true, parameters: [], returnType: 'Promise<void>', jsdoc: '', lineNumber: 15, category: 'helper', complexity: 1 },
    { name: 'getUser', filePath: 'api/UserApi.ts', isExported: true, isAsync: true, parameters: [], returnType: 'Promise<any>', jsdoc: '', lineNumber: 3, category: 'helper', complexity: 1 },
  ],
  fixtures: [
    { name: 'baseFixture', filePath: 'fixtures/baseFixture.ts', isExported: true, isAsync: false, parameters: [], returnType: 'void', jsdoc: '', lineNumber: 1, category: 'fixture', complexity: 1 },
  ],
  dataFiles: [
    { name: 'users.json', path: 'tests/data/users.json', type: 'json', recordCount: 4 },
    { name: 'checkout_data.json', path: 'tests/data/checkout_data.json', type: 'json', recordCount: 2 },
  ],
  codingStyle: { namingConvention: 'PascalCase' },
  dependencies: [{ name: '@playwright/test', version: '^1.40.0', isDev: true }],
} as unknown as RepositoryProfile;

const conv = buildConventionProfile(repo);

assertEqual(conv.reuse.pageObjects.length, 2, 'catalogue: 2 page objects');
assertEqual(hasReusableAssets(conv), true, 'hasReusableAssets true');

const loginPO = conv.reuse.pageObjects.find((p) => p.name === 'LoginPage')!;
assertEqual(loginPO.path, 'pages/LoginPage.ts', 'LoginPage path captured');
assertEqual(loginPO.methods.join(','), 'login,logout', 'LoginPage methods captured');
assertEqual(loginPO.locators.join(','), 'username,password', 'LoginPage locators captured');
assertEqual(loginPO.baseClass, 'BasePage', 'LoginPage baseClass captured');
assert(!!loginPO.raw && loginPO.raw.properties.length === 2, 'LoginPage carries raw ClassInfo for matcher');

/* Helpers grouped into modules by file. */
assertEqual(conv.reuse.helpers.length, 2, 'catalogue: 2 helper modules (AuthHelper, UserApi)');
const authHelper = conv.reuse.helpers.find((h) => h.name === 'AuthHelper')!;
assertEqual(authHelper.path, 'utils/AuthHelper.ts', 'AuthHelper path captured');
assertEqual(authHelper.functions.join(','), 'login,logout', 'AuthHelper functions grouped');

/* Fixtures. */
assertEqual(conv.reuse.fixtures.length, 1, 'catalogue: 1 fixture');
assertEqual(conv.reuse.fixtures[0].name, 'baseFixture', 'baseFixture captured');

/* APIs derived honestly (UserApi from helper module name). */
assertEqual(conv.reuse.apis.length, 1, 'catalogue: 1 api (UserApi)');
assertEqual(conv.reuse.apis[0].name, 'UserApi', 'UserApi derived from name');

/* Components — none here. */
assertEqual(conv.reuse.components.length, 0, 'catalogue: no components in this repo');

/* Test data. */
assertEqual(conv.reuse.testData.length, 2, 'catalogue: 2 test-data files');

/* ------------------------------------------------------------------ */
/*  3. "Ask Repo Intelligence" query APIs                              */
/* ------------------------------------------------------------------ */

console.log('\n=== Query APIs ("does X already exist?") ===');
// Page object: name-intent matching (LoginPage ≈ Login ≈ login screen).
assert(!!findReusablePageObject(conv, 'LoginPage'), 'finds LoginPage by exact name');
assert(!!findReusablePageObject(conv, 'Login'), 'finds LoginPage by intent (Login)');
assert(!!findReusablePageObject(conv, 'CheckoutPage'), 'finds CheckoutPage');
assertEqual(findReusablePageObject(conv, 'InventoryPage'), null, 'InventoryPage absent → null (must generate)');

// Helper by module name OR by function name.
assert(!!findReusableHelper(conv, 'AuthHelper'), 'finds AuthHelper by module name');
assert(!!findReusableHelper(conv, 'login'), 'finds AuthHelper by function name (login)');
assertEqual(findReusableHelper(conv, 'CartHelper'), null, 'CartHelper absent → null');

// Fixture.
assert(!!findReusableFixture(conv, 'baseFixture'), 'finds baseFixture');
assertEqual(findReusableFixture(conv, 'apiFixture'), null, 'apiFixture absent → null');

// Test data by file name (with/without extension).
assert(!!findReusableTestData(conv, 'checkout_data.json'), 'finds checkout_data.json');
assert(!!findReusableTestData(conv, 'users'), 'finds users.json by base name');
assertEqual(findReusableTestData(conv, 'orders.json'), null, 'orders.json absent → null');

// API / component.
assert(!!findReusableApi(conv, 'UserApi'), 'finds UserApi');
assertEqual(findReusableComponent(conv, 'HeaderComponent'), null, 'HeaderComponent absent → null');

/* ------------------------------------------------------------------ */
/*  4. Component derivation                                            */
/* ------------------------------------------------------------------ */

console.log('\n=== Component derivation ===');
const compRepo = {
  framework: 'playwright',
  pageObjects: [
    { name: 'HeaderComponent', filePath: 'components/HeaderComponent.ts', isExported: true, baseClass: null, methods: [], properties: [], category: 'page-object', lineNumber: 1 },
  ],
  helperFunctions: [],
  fixtures: [],
  dataFiles: [],
} as unknown as RepositoryProfile;
const compConv = buildConventionProfile(compRepo);
assertEqual(compConv.reuse.components.length, 1, 'HeaderComponent derived into components');
assertEqual(compConv.reuse.components[0].name, 'HeaderComponent', 'component name correct');

/* ------------------------------------------------------------------ */
/*  Summary                                                             */
/* ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All tests passed! ✅\n');
