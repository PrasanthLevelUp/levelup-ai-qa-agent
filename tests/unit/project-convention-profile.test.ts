/**
 * Unit tests for project-convention-profile.ts
 *
 * Proves the Repo-Intelligence-owned convention profile:
 *   • Greenfield (null profile) → historical hardcoded defaults (zero regression)
 *   • Connected repo with a different layout → conventions routed to that layout
 *   • Resolvers produce repo-root-relative paths + correct relative imports
 *
 * Run with: npx tsx tests/unit/project-convention-profile.test.ts
 */

import {
  buildConventionProfile,
  resolveTestDataModulePath,
  resolveFixturePath,
  resolveHelperPath,
  resolveImportSpecifier,
  DEFAULT_CONVENTIONS,
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
  if (!ok) {
    console.error(`     actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`);
  }
  assert(ok, msg);
}

/* ------------------------------------------------------------------ */
/*  1. Greenfield (null) — must equal historical hardcoded defaults    */
/* ------------------------------------------------------------------ */

console.log('\n=== Greenfield (null profile) — zero regression ===');
const green = buildConventionProfile(null);

assertEqual(green.fromProfile, false, 'fromProfile is false for greenfield');
assertEqual(green.testFolder, 'tests', 'testFolder defaults to tests');
assertEqual(green.pageObjectFolder, 'pages', 'pageObjectFolder defaults to pages');
assertEqual(green.fixtureFolder, 'fixtures', 'fixtureFolder defaults to fixtures');
assertEqual(green.testDataFolder, 'tests/data', 'testDataFolder defaults to tests/data');
assertEqual(green.helperFolder, 'utils', 'helperFolder defaults to utils');
assertEqual(green.apiFolder, 'api', 'apiFolder defaults to api');
assertEqual(green.importStyle, 'relative', 'importStyle defaults to relative');
assertEqual(green.namingConvention, 'PascalCase', 'namingConvention defaults to PascalCase');
assertEqual(green.testDataPattern, 'ts', 'testDataPattern defaults to ts');

// Resolvers reproduce the exact historical hardcoded paths.
assertEqual(resolveTestDataModulePath(green), 'tests/data/test-data.ts', 'greenfield data module path unchanged');
assertEqual(resolveFixturePath(green, 'test-fixtures.ts'), 'fixtures/test-fixtures.ts', 'greenfield fixture path unchanged');
assertEqual(resolveFixturePath(green, 'auth.ts'), 'fixtures/auth.ts', 'greenfield auth fixture path unchanged');
assertEqual(resolveHelperPath(green, 'test-helpers.ts'), 'utils/test-helpers.ts', 'greenfield helper path unchanged');
// The spec in tests/ importing the data module at tests/data/test-data
assertEqual(
  resolveImportSpecifier(green, 'tests', 'tests/data/test-data'),
  './data/test-data',
  'greenfield spec→data relative import is ./data/test-data',
);

/* ------------------------------------------------------------------ */
/*  2. Undefined profile behaves like null                             */
/* ------------------------------------------------------------------ */

console.log('\n=== Undefined profile ===');
const greenU = buildConventionProfile(undefined);
assertEqual(greenU.fromProfile, false, 'undefined → fromProfile false');
assertEqual(greenU.testDataFolder, 'tests/data', 'undefined → testDataFolder default');

/* ------------------------------------------------------------------ */
/*  3. Connected repo with a DIFFERENT layout (root data/, support/)   */
/* ------------------------------------------------------------------ */

console.log('\n=== Connected repo with non-default layout ===');
const customProfile = {
  framework: 'playwright',
  language: 'typescript',
  testPattern: 'page-object-model',
  folderStructure: {
    testFolder: 'e2e',
    pageObjectFolder: 'page-objects',
    fixtureFolder: 'support',
    utilsFolder: 'helpers',
    testDataFolder: 'data',
    apiFolder: 'src/api',
    configFiles: ['playwright.config.ts'],
    supportFiles: [],
  },
  codingStyle: { namingConvention: 'camelCase' },
  pageObjects: [{ name: 'LoginPage' }],
  dependencies: [{ name: '@playwright/test', version: '^1.40.0', isDev: true }],
  dataFiles: [{ path: 'data/users.json', type: 'json' }],
} as unknown as RepositoryProfile;

const custom = buildConventionProfile(customProfile);
assertEqual(custom.fromProfile, true, 'fromProfile true for connected repo');
assertEqual(custom.testFolder, 'e2e', 'testFolder from profile');
assertEqual(custom.pageObjectFolder, 'page-objects', 'pageObjectFolder from profile');
assertEqual(custom.fixtureFolder, 'support', 'fixtureFolder from profile');
assertEqual(custom.testDataFolder, 'data', 'testDataFolder from profile (root data/)');
assertEqual(custom.helperFolder, 'helpers', 'helperFolder from profile');
assertEqual(custom.apiFolder, 'src/api', 'apiFolder from profile');
assertEqual(custom.namingConvention, 'camelCase', 'namingConvention from profile');
assertEqual(custom.testDataPattern, 'json', 'testDataPattern detected json from data files');
assertEqual(custom.pageObjectPattern, 'class', 'pageObjectPattern class (POM + page objects present)');

// Resolvers route artifacts into the repo's real folders.
assertEqual(resolveTestDataModulePath(custom), 'data/test-data.ts', 'data module routed to data/');
assertEqual(resolveFixturePath(custom, 'auth.ts'), 'support/auth.ts', 'auth fixture routed to support/');
assertEqual(resolveHelperPath(custom, 'test-helpers.ts'), 'helpers/test-helpers.ts', 'helper routed to helpers/');
// A spec in e2e/ importing the data module at data/test-data → ../data/test-data
assertEqual(
  resolveImportSpecifier(custom, 'e2e', 'data/test-data'),
  '../data/test-data',
  'spec(e2e)→data(root) relative import is ../data/test-data',
);

/* ------------------------------------------------------------------ */
/*  4. Partial profile — undetected fields fall back to defaults       */
/* ------------------------------------------------------------------ */

console.log('\n=== Partial profile — missing folders fall back ===');
const partialProfile = {
  framework: 'playwright',
  testPattern: 'flat-scripts',
  folderStructure: {
    testFolder: 'tests',
    pageObjectFolder: null,
    fixtureFolder: null,
    utilsFolder: null,
    testDataFolder: null,
    apiFolder: null,
    configFiles: [],
    supportFiles: [],
  },
} as unknown as RepositoryProfile;

const partial = buildConventionProfile(partialProfile);
assertEqual(partial.fromProfile, true, 'fromProfile true even when folders are null');
assertEqual(partial.testDataFolder, 'tests/data', 'null testDataFolder falls back to default');
assertEqual(partial.fixtureFolder, 'fixtures', 'null fixtureFolder falls back to default');
assertEqual(partial.helperFolder, 'utils', 'null utilsFolder falls back to default');
assertEqual(partial.apiFolder, 'api', 'null apiFolder falls back to default');

/* ------------------------------------------------------------------ */
/*  5. Alias import style (module-alias / tsconfig-paths dependency)   */
/* ------------------------------------------------------------------ */

console.log('\n=== Alias import detection ===');
const aliasProfile = {
  framework: 'playwright',
  testPattern: 'page-object-model',
  folderStructure: {
    testFolder: 'tests',
    pageObjectFolder: 'pages',
    fixtureFolder: 'fixtures',
    utilsFolder: 'utils',
    testDataFolder: 'tests/data',
    apiFolder: null,
    configFiles: [],
    supportFiles: [],
  },
  dependencies: [{ name: 'tsconfig-paths', version: '^4.0.0', isDev: true }],
} as unknown as RepositoryProfile;

const alias = buildConventionProfile(aliasProfile);
assertEqual(alias.importStyle, 'alias', 'importStyle detected as alias');
assertEqual(alias.importAlias, '@', 'importAlias is @');
assertEqual(
  resolveImportSpecifier(alias, 'tests', 'tests/data/test-data'),
  '@/tests/data/test-data',
  'alias import specifier uses @/ prefix',
);

/* ------------------------------------------------------------------ */
/*  6. DEFAULT_CONVENTIONS sanity                                      */
/* ------------------------------------------------------------------ */

console.log('\n=== DEFAULT_CONVENTIONS consistency ===');
assertEqual(DEFAULT_CONVENTIONS.testDataFolder, 'tests/data', 'DEFAULT_CONVENTIONS.testDataFolder is tests/data');
assertEqual(DEFAULT_CONVENTIONS.fixtureFolder, 'fixtures', 'DEFAULT_CONVENTIONS.fixtureFolder is fixtures');
assertEqual(DEFAULT_CONVENTIONS.helperFolder, 'utils', 'DEFAULT_CONVENTIONS.helperFolder is utils');

/* ------------------------------------------------------------------ */
/*  Summary                                                             */
/* ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All tests passed! ✅\n');
