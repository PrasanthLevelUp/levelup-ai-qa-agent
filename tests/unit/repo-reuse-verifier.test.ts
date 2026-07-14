/**
 * Repository Reuse Verifier — proven on the REAL SauceDemo output.
 *
 * These tests are the Sprint-A "gate" evidence. They run the deterministic
 * verifier against the ACTUAL files from the reported bad run (the half-generated
 * SauceDemo specs + the generated parallel data module) and against the repo's
 * OWN hand-written good specs. The verifier must:
 *
 *   • FAIL the broken login spec, citing the concrete violations we observed
 *     (half-generated throw, hardcoded URL, import from the generated parallel
 *     data module, hard sleeps), and
 *   • PASS the repo's native specs (getUser + env + waits + logger + page
 *     objects), so the gate does not raise false alarms on good code.
 *
 * The profile below mirrors the live RepositoryContextEngine.scan() of the
 * SauceDemo repo (framework=playwright, utils/env.ts config, getUser/getRecord
 * helpers in utils/testData.ts, logger logging, web-first waits, 5 page objects).
 */
import * as fs from 'fs';
import * as path from 'path';
import type { RepositoryProfile } from '../../src/context/types';
import {
  summarizeProfileForDebug,
  verifyRepoReuse,
  DEFAULT_REUSE_THRESHOLD,
} from '../../src/script-gen/repo-reuse-verifier';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'repo-reuse');
const readFixture = (name: string) =>
  fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** A profile that mirrors the real SauceDemo scan (only fields the verifier reads). */
function sauceDemoProfile(): RepositoryProfile {
  const fn = (name: string, filePath: string) => ({
    name,
    filePath,
    isExported: true,
    isAsync: false,
    parameters: [],
    returnType: 'any',
    jsdoc: '',
    lineNumber: 1,
    category: 'helper' as const,
    complexity: 1,
  });
  const po = (name: string) => ({
    name,
    filePath: `pages/${name}.ts`,
    isExported: true,
    baseClass: name === 'BasePage' ? null : 'BasePage',
    methods: [],
    properties: [],
    category: 'page-object' as const,
    lineNumber: 1,
  });
  return {
    framework: 'playwright',
    language: 'typescript',
    testPattern: 'page-object-model' as any,
    locatorStrategy: 'test-id' as any,
    folderStructure: {} as any,
    totalFiles: 30,
    totalTestFiles: 7,
    totalHelperFiles: 4,
    totalLineCount: 1200,
    codingStyle: {
      namingConvention: 'camelCase',
      testNaming: 'descriptive',
      stepStyle: 'flat',
      tagConvention: null,
      indentStyle: 'spaces-2',
      quoteStyle: 'single',
      semicolons: true,
      loggingStyle: 'logger',
      loggingStyles: ['logger'],
      waitStyle: 'web-first-assertions',
      waitStyles: ['web-first-assertions'],
      usesFixedTimeouts: false,
    },
    helperFunctions: [
      fn('getUser', 'utils/testData.ts'),
      fn('getRecord', 'utils/testData.ts'),
    ],
    pageObjects: [
      po('BasePage'),
      po('LoginPage'),
      po('InventoryPage'),
      po('CartPage'),
      po('CheckoutPage'),
    ],
    fixtures: [fn('baseFixture', 'fixtures/baseFixture.ts')],
    customCommands: [],
    sharedConstants: [],
    dataFiles: [
      { name: 'testData', path: 'utils/testData.ts', type: 'ts' },
    ],
    environment: {
      envFiles: ['.env.example'],
      usesDotenv: true,
      configModule: 'utils/env.ts',
      envVars: ['BASE_URL', 'SAUCE_PASSWORD', 'HEADED'],
    },
    businessFlows: [
      { name: 'Login Flow', steps: [], relatedFiles: [], relatedHelpers: [], entryUrl: null, category: 'auth' },
    ] as any,
    testSuites: [
      { name: 'login', filePath: 'tests/login.spec.ts', testCount: 2, testNames: [], describeName: null, tags: [], category: 'auth' },
    ] as any,
    preferredLocators: [],
    avoidPatterns: [],
    dependencies: [],
    assertionLibrary: 'playwright',
    hasApiLayer: false,
    hasCustomFixtures: true,
    hasMocking: false,
    hasVisualTesting: false,
    ciIntegration: null,
  };
}

describe('summarizeProfileForDebug (Step 1 / Step 2)', () => {
  it('surfaces the critical reusable assets for the debug panel', () => {
    const s = summarizeProfileForDebug(sauceDemoProfile(), {
      repositoryId: 42,
      profileVersion: 3,
      scannedAt: '2026-07-14T00:00:00Z',
    });
    expect(s.repositoryId).toBe(42);
    expect(s.framework).toBe('playwright');
    expect(s.pageObjects).toEqual(
      expect.arrayContaining(['LoginPage', 'InventoryPage', 'CartPage', 'CheckoutPage']),
    );
    expect(s.utilities).toEqual(expect.arrayContaining(['getUser', 'getRecord']));
    expect(s.testDataHelpers).toEqual(expect.arrayContaining(['getUser', 'getRecord']));
    expect(s.envConfigModule).toBe('utils/env.ts');
    expect(s.envVars).toContain('BASE_URL');
    expect(s.codingStyle.loggingStyle).toBe('logger');
    expect(s.businessFlows).toBe(1);
    expect(s.testSuites).toBe(1);
    expect(s.looksComplete).toBe(true);
  });
});

describe('verifyRepoReuse — REAL broken SauceDemo output FAILS', () => {
  const profile = sauceDemoProfile();

  it('broken login spec fails with the observed violations', () => {
    const report = verifyRepoReuse(profile, [
      { path: 'tests/login.spec.ts', content: readFixture('broken-login.spec.ts.txt') },
      { path: 'data/test-data.ts', content: readFixture('broken-test-data.ts.txt') },
    ]);

    expect(report.passed).toBe(false);
    expect(report.score).toBeLessThan(DEFAULT_REUSE_THRESHOLD);

    const ids = report.violations.map((v) => v.ruleId);
    // Half-generated spec — the critical, ship-blocking failure.
    expect(ids).toContain('half-generated-throw');
    // Hardcoded https://www.saucedemo.com/ despite utils/env.ts.
    expect(ids).toContain('hardcoded-url');
    // Spec imports getRecord from the generated data/test-data parallel module.
    expect(ids).toContain('test-data-helper-bypassed');
    // The generated data/test-data.ts is a parallel duplicate of utils/testData.
    expect(ids).toContain('parallel-test-data-module');

    // A critical violation must force a fail regardless of score.
    expect(report.violations.some((v) => v.severity === 'critical')).toBe(true);
  });

  it('broken cart spec is also flagged', () => {
    const report = verifyRepoReuse(profile, [
      { path: 'tests/cart.spec.ts', content: readFixture('broken-cart.spec.ts.txt') },
    ]);
    expect(report.passed).toBe(false);
    expect(report.violations.length).toBeGreaterThan(0);
  });

  it('every violation cites concrete evidence (no fabricated intelligence)', () => {
    const report = verifyRepoReuse(profile, [
      { path: 'tests/login.spec.ts', content: readFixture('broken-login.spec.ts.txt') },
    ]);
    for (const v of report.violations) {
      expect(typeof v.message).toBe('string');
      expect(v.message.length).toBeGreaterThan(10);
      expect(v.occurrences).toBeGreaterThan(0);
    }
  });
});

describe('verifyRepoReuse — repo-native good specs PASS (no false alarms)', () => {
  const profile = sauceDemoProfile();

  it('good login spec passes with a high score', () => {
    const report = verifyRepoReuse(profile, [
      { path: 'tests/verify-successful-login.spec.ts', content: readFixture('good-login.spec.ts.txt') },
    ]);
    expect(report.passed).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(DEFAULT_REUSE_THRESHOLD);
    expect(report.violations.filter((v) => v.severity !== 'warning')).toHaveLength(0);
  });

  it('good locked-user spec passes', () => {
    const report = verifyRepoReuse(profile, [
      { path: 'tests/verify-locked-user.spec.ts', content: readFixture('good-locked-user.spec.ts.txt') },
    ]);
    expect(report.passed).toBe(true);
  });
});
