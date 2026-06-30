/**
 * Unit tests for buildAIPromptContext (context/prompt-builder.ts) — the PRODUCTION
 * prompt path used when a scanned repoId is supplied to script generation.
 *
 * Verifies the freeform context carries the same Repository-Intelligence
 * "reuse-first" catalog as the distilled guide: helpers bucketed by purpose
 * (assertion / wait / logger / data / utility), the repo logger implementation,
 * Page Object methods, fixtures, and an explicit REUSE-FIRST instruction.
 *
 * Run with: npx tsx tests/unit/prompt-builder-reuse.test.ts
 */

import { buildAIPromptContext } from '../../src/context/prompt-builder';
import type { RepositoryProfile, FunctionSignature } from '../../src/context/types';

let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const fn = (name: string, filePath: string, jsdoc = ''): FunctionSignature => ({
  name, filePath, isExported: true, isAsync: true,
  parameters: [{ name: 'page', type: 'Page' }], returnType: 'Promise<void>',
  jsdoc, lineNumber: 1, category: 'helper', complexity: 1,
});

const profile: RepositoryProfile = {
  framework: 'playwright', language: 'typescript', testPattern: 'page-object-model',
  locatorStrategy: 'data-testid',
  folderStructure: { testFolder: 'tests', pageObjectFolder: 'tests/pages', fixtureFolder: 'tests/fixtures', utilsFolder: 'tests/utils', testDataFolder: 'tests/data', apiFolder: null, configFiles: [], supportFiles: [] } as any,
  totalFiles: 40, totalTestFiles: 15, totalHelperFiles: 6, totalLineCount: 3000,
  codingStyle: { namingConvention: 'camelCase', testNaming: 'descriptive', stepStyle: 'arrange_act_assert', tagConvention: '@smoke', indentStyle: 'spaces-2', quoteStyle: 'single', semicolons: true, loggingStyle: 'logger', loggingStyles: ['logger'], waitStyle: 'web-first-assertions', waitStyles: ['web-first-assertions'], usesFixedTimeouts: false } as any,
  helperFunctions: [
    fn('expectErrorVisible', 'tests/utils/assertions.ts', 'Assert the error banner is visible'),
    fn('waitForSpinnerGone', 'tests/utils/wait.ts', 'Wait until the spinner disappears'),
    fn('logger', 'tests/utils/logger.ts', 'Structured logger'),
    fn('getRecord', 'tests/data/test-data.ts', 'Resolve a dataset record'),
    fn('formatCurrency', 'tests/utils/format.ts', 'Format USD'),
  ],
  pageObjects: [
    { name: 'LoginPage', filePath: 'tests/pages/LoginPage.ts', isExported: true, baseClass: null, methods: [{ name: 'login' } as any, { name: 'assertError' } as any], properties: [], category: 'page-object', lineNumber: 1 } as any,
  ],
  fixtures: [{ name: 'authedPage', filePath: 'tests/fixtures/authed.ts' } as any],
  customCommands: [], sharedConstants: [],
  dataFiles: [{ name: 'valid_users', path: 'tests/data/users.json', type: 'json', recordCount: 3 }],
  environment: { envFiles: ['.env'], usesDotenv: true, configModule: null, envVars: [] },
  businessFlows: [], testSuites: [],
  preferredLocators: [{ pattern: 'getByTestId', count: 10, example: '' } as any],
  avoidPatterns: [], dependencies: [], assertionLibrary: '@playwright/test',
  hasApiLayer: false, hasCustomFixtures: true, hasMocking: false, hasVisualTesting: false, ciIntegration: null,
} as RepositoryProfile;

const ctx = buildAIPromptContext(profile);

console.log('\n=== Production prompt carries the reuse-first catalog ===');
assert(/=== REUSE EXISTING PROJECT CODE \(HIGHEST PRIORITY\) ===/.test(ctx), 'has REUSE-FIRST header');
assert(/PAGE OBJECTS .*do NOT inline raw/.test(ctx) && /LoginPage.*\[login, assertError\]/.test(ctx), 'lists Page Object methods');
assert(/ASSERTION HELPERS/.test(ctx) && /expectErrorVisible/.test(ctx), 'lists assertion helpers');
assert(/WAIT \/ SYNCHRONIZATION HELPERS/.test(ctx) && /waitForSpinnerGone/.test(ctx), 'lists wait/sync helpers');
assert(/LOGGER \(use the repo logger/.test(ctx) && /logger.*tests\/utils\/logger\.ts/.test(ctx), 'instructs reusing the repo logger');
assert(/TEST DATA ACCESS/.test(ctx) && /getRecord/.test(ctx), 'lists test-data access helpers');
assert(/FIXTURES \(consume these/.test(ctx) && /authedPage/.test(ctx), 'lists fixtures');
assert(/UTILITY HELPERS/.test(ctx) && /formatCurrency/.test(ctx), 'lists utility helpers');

console.log('\n=== No [object Object] leakage in helper params ===');
assert(!/\[object Object\]/.test(ctx), 'helper params render as names, not [object Object]');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
