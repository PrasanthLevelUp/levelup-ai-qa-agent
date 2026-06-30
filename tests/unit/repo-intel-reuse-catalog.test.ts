/**
 * Unit tests for the Repository Intelligence "reuse-first" catalog.
 *
 * Verifies that analyzeRepoPatterns() learns the repo's REUSABLE assets beyond
 * logging/wait detection and buckets helper functions by purpose so generation
 * can prefer existing project methods over new raw Playwright code:
 *   - Page Object methods
 *   - assertion helpers
 *   - wait / synchronization helpers
 *   - logger implementation
 *   - fixtures
 *   - utilities
 *   - test-data access patterns
 *
 * Also asserts the prompt block carries a strong "REUSE FIRST" instruction.
 *
 * Run with: npx tsx tests/unit/repo-intel-reuse-catalog.test.ts
 */

import {
  analyzeRepoPatterns,
  clearRepoPatternCache,
} from '../../src/script-gen/repo-pattern-analyzer';
import type { RepositoryProfile, FunctionSignature } from '../../src/context/types';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const fn = (name: string, filePath: string, jsdoc = ''): FunctionSignature => ({
  name, filePath, isExported: true, isAsync: true,
  parameters: [{ name: 'page', type: 'Page' }], returnType: 'Promise<void>',
  jsdoc, lineNumber: 1, category: 'helper', complexity: 1,
});

const profile: RepositoryProfile = {
  framework: 'playwright',
  language: 'typescript',
  testPattern: 'page-object-model',
  locatorStrategy: 'data-testid',
  folderStructure: {
    testFolder: 'tests', pageObjectFolder: 'tests/pages', fixtureFolder: 'tests/fixtures',
    utilsFolder: 'tests/utils', testDataFolder: 'tests/data', apiFolder: null,
    configFiles: ['playwright.config.ts'], supportFiles: [],
  } as any,
  totalFiles: 40, totalTestFiles: 15, totalHelperFiles: 6, totalLineCount: 3000,
  codingStyle: {
    namingConvention: 'camelCase', testNaming: 'descriptive', stepStyle: 'arrange_act_assert',
    tagConvention: '@smoke', indentStyle: 'spaces-2', quoteStyle: 'single', semicolons: true,
    loggingStyle: 'logger', loggingStyles: ['logger'],
    waitStyle: 'web-first-assertions', waitStyles: ['web-first-assertions'], usesFixedTimeouts: false,
  } as any,
  helperFunctions: [
    // assertion helpers
    fn('expectErrorVisible', 'tests/utils/assertions.ts', 'Assert the error banner is visible'),
    fn('verifyOnInventory', 'tests/utils/assertions.ts'),
    // wait / sync helpers
    fn('waitForSpinnerGone', 'tests/utils/wait.ts', 'Wait until the loading spinner disappears'),
    fn('untilNetworkIdle', 'tests/utils/wait.ts'),
    // logger
    fn('logger', 'tests/utils/logger.ts', 'Structured test logger'),
    // test-data access
    fn('getRecord', 'tests/data/test-data.ts', 'Resolve a dataset record by name'),
    fn('loadFixtureData', 'tests/data/loader.ts'),
    // generic utility
    fn('formatCurrency', 'tests/utils/format.ts', 'Format a number as USD'),
  ],
  pageObjects: [
    { name: 'LoginPage', filePath: 'tests/pages/LoginPage.ts', isExported: true, baseClass: null,
      methods: [{ name: 'login' } as any, { name: 'assertError' } as any], properties: [], category: 'page-object', lineNumber: 1 } as any,
  ],
  fixtures: [{ name: 'authedPage', filePath: 'tests/fixtures/authed.ts' } as any],
  customCommands: [], sharedConstants: [],
  dataFiles: [{ name: 'valid_users', path: 'tests/data/users.json', type: 'json', recordCount: 3 }],
  environment: { envFiles: ['.env'], usesDotenv: true, configModule: 'tests/utils/env.ts', envVars: ['BASE_URL'] },
  businessFlows: [], testSuites: [],
  preferredLocators: [{ pattern: 'getByTestId', count: 20, example: "getByTestId('username')" } as any],
  avoidPatterns: ['xpath'],
  dependencies: [{ name: '@playwright/test', version: '^1.40.0', isDev: true }],
  assertionLibrary: '@playwright/test', hasApiLayer: false, hasCustomFixtures: true,
  hasMocking: false, hasVisualTesting: false, ciIntegration: 'github-actions',
} as RepositoryProfile;

clearRepoPatternCache();

console.log('\n=== Reusable assets are bucketed by purpose ===');
const guide = analyzeRepoPatterns(profile);
assert(!!guide, 'guide produced for a rich profile');
const s = guide!.summary;

assert(s.assertionHelpers.some(h => h.name === 'expectErrorVisible') &&
       s.assertionHelpers.some(h => h.name === 'verifyOnInventory'),
  'assertion helpers detected (expectErrorVisible, verifyOnInventory)');
assert(s.waitHelpers.some(h => h.name === 'waitForSpinnerGone') &&
       s.waitHelpers.some(h => h.name === 'untilNetworkIdle'),
  'wait/sync helpers detected (waitForSpinnerGone, untilNetworkIdle)');
assert(s.loggerHelpers.some(h => h.name === 'logger'), 'logger helper detected');
assert(!!s.loggerImpl && s.loggerImpl.name === 'logger' && /logger\.ts$/.test(s.loggerImpl.filePath),
  'logger implementation resolved to logger @ tests/utils/logger.ts');
assert(s.dataAccessHelpers.some(h => h.name === 'getRecord') &&
       s.dataAccessHelpers.some(h => h.name === 'loadFixtureData'),
  'test-data access helpers detected (getRecord, loadFixtureData)');
assert(s.utilityHelpers.some(h => h.name === 'formatCurrency'),
  'generic utility helper detected (formatCurrency)');

console.log('\n=== Each helper lands in exactly one bucket ===');
const allBuckets = [...s.assertionHelpers, ...s.waitHelpers, ...s.loggerHelpers, ...s.dataAccessHelpers, ...s.utilityHelpers];
const names = allBuckets.map(h => h.name);
assert(new Set(names).size === names.length, 'no helper appears in two buckets');
assert(names.length === (profile.helperFunctions || []).length, 'every helper is classified');

console.log('\n=== Page Object methods are captured for reuse ===');
assert(s.pageObjects.some(p => p.name === 'LoginPage' && p.methods.includes('login') && p.methods.includes('assertError')),
  'LoginPage methods [login, assertError] captured');

console.log('\n=== Prompt block carries strong REUSE-FIRST guidance ===');
const pb = guide!.promptBlock;
assert(/REUSE EXISTING PROJECT CODE \(HIGHEST PRIORITY\)/.test(pb), 'prompt block has the REUSE-FIRST header');
assert(/ASSERTION HELPERS/.test(pb), 'prompt block lists assertion helpers section');
assert(/WAIT \/ SYNCHRONIZATION HELPERS/.test(pb), 'prompt block lists wait/sync helpers section');
assert(/LOGGER \(use the repo logger/.test(pb) && /logger.*tests\/utils\/logger\.ts/.test(pb), 'prompt block instructs reusing the repo logger');
assert(/TEST DATA ACCESS/.test(pb) && /getRecord/.test(pb), 'prompt block lists test-data access helpers');
assert(/FIXTURES \(consume these/.test(pb) && /authedPage/.test(pb), 'prompt block lists fixtures');
assert(/UTILITY HELPERS/.test(pb) && /formatCurrency/.test(pb), 'prompt block lists utility helpers');
assert(/REUSE FIRST —/.test(pb), 'prompt block RULES lead with REUSE FIRST');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
