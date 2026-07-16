/**
 * Repository Intelligence Auditor — proven on the REAL SauceDemo output.
 *
 * These tests are the Sprint-A diagnostic-gate evidence. They run the
 * deterministic auditor against the ACTUAL files from the reported bad run (the
 * half-generated SauceDemo specs + the generated parallel data module) and
 * against the repo's OWN hand-written good specs. The auditor must:
 *
 *   • FAIL the right per-asset rows for the broken output (Environment,
 *     Test Data, Completeness), citing concrete Expected vs Actual, and
 *   • PASS those rows for the repo's native specs (getUser + env + logger +
 *     page objects) — no false alarms.
 *
 * There is deliberately NO score and NO gate: the checklist names the exact
 * asset that failed.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { RepositoryProfile } from '../../src/context/types';
import {
  summarizeProfileForDebug,
  auditGeneratedScripts,
  auditPromptInclusion,
  auditRepositoryIntelligence,
  RepositoryIntelligenceAuditor,
  type AuditAsset,
  type AuditStatus,
  type AuditReason,
} from '../../src/script-gen/repo-intelligence-auditor';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'repo-reuse');
const readFixture = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');

/** A profile that mirrors the real SauceDemo scan (only fields the auditor reads). */
function sauceDemoProfile(): RepositoryProfile {
  const fn = (name: string, filePath: string) => ({
    name, filePath, isExported: true, isAsync: false, parameters: [],
    returnType: 'any', jsdoc: '', lineNumber: 1, category: 'helper' as const, complexity: 1,
  });
  const po = (name: string) => ({
    name, filePath: `pages/${name}.ts`, isExported: true,
    baseClass: name === 'BasePage' ? null : 'BasePage',
    methods: [], properties: [], category: 'page-object' as const, lineNumber: 1,
  });
  return {
    framework: 'playwright', language: 'typescript',
    testPattern: 'page-object-model' as any, locatorStrategy: 'test-id' as any,
    folderStructure: {} as any, totalFiles: 30, totalTestFiles: 7, totalHelperFiles: 4, totalLineCount: 1200,
    codingStyle: {
      namingConvention: 'camelCase', testNaming: 'descriptive', stepStyle: 'flat', tagConvention: null,
      indentStyle: 'spaces-2', quoteStyle: 'single', semicolons: true,
      loggingStyle: 'logger', loggingStyles: ['logger'],
      waitStyle: 'web-first-assertions', waitStyles: ['web-first-assertions'], usesFixedTimeouts: false,
    },
    helperFunctions: [fn('getUser', 'utils/testData.ts'), fn('getRecord', 'utils/testData.ts')],
    pageObjects: [po('BasePage'), po('LoginPage'), po('InventoryPage'), po('CartPage'), po('CheckoutPage')],
    fixtures: [fn('baseFixture', 'fixtures/baseFixture.ts')], customCommands: [], sharedConstants: [],
    dataFiles: [{ name: 'testData', path: 'utils/testData.ts', type: 'ts' }],
    environment: {
      envFiles: ['.env.example'], usesDotenv: true, configModule: 'utils/env.ts',
      envVars: ['BASE_URL', 'SAUCE_PASSWORD', 'HEADED'],
    },
    businessFlows: [
      { name: 'Login Flow', steps: [], relatedFiles: [], relatedHelpers: [], entryUrl: null, category: 'auth' },
    ] as any,
    testSuites: [
      { name: 'login', filePath: 'tests/login.spec.ts', testCount: 2, testNames: [], describeName: null, tags: [], category: 'auth' },
    ] as any,
    preferredLocators: [], avoidPatterns: [], dependencies: [], assertionLibrary: 'playwright',
    hasApiLayer: false, hasCustomFixtures: true, hasMocking: false, hasVisualTesting: false, ciIntegration: null,
    testInventory: [],
    coverageSummary: [],
  };
}

const statusOf = (checklist: Array<{ asset: AuditAsset; status: AuditStatus }>, asset: AuditAsset) =>
  checklist.find((c) => c.asset === asset)?.status;

const reasonOf = (
  checklist: Array<{ asset: AuditAsset; reason: AuditReason }>,
  asset: AuditAsset,
) => checklist.find((c) => c.asset === asset)?.reason;

describe('summarizeProfileForDebug (Q1 evidence)', () => {
  it('surfaces the critical reusable assets for the debug panel', () => {
    const s = summarizeProfileForDebug(sauceDemoProfile(), {
      repositoryId: 42, profileVersion: 3, scannedAt: '2026-07-14T00:00:00Z',
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
    expect(s.looksComplete).toBe(true);
  });
});

describe('auditPromptInclusion (Q3)', () => {
  it('detects the asset categories inside the injected repo prompt block', () => {
    const block = [
      '--- REPO PATTERN GUIDE ---',
      'Framework: playwright | Language: typescript',
      'PAGE OBJECTS (instantiate & call): LoginPage [login]',
      'SYNCHRONIZATION — the repo waits via web-first-assertions',
      'STEP LOGGING — the repo reports progress via logger',
      'DATA ACCESS HELPERS: getUser(key) from utils/testData.ts',
    ].join('\n');
    const q3 = auditPromptInclusion(block);
    expect(q3.included).toBe(true);
    expect(q3.promptSection).toContain('REPO PATTERN GUIDE');
    expect(q3.detectedSections).toEqual(
      expect.arrayContaining(['Framework', 'Page Objects', 'Wait Strategy', 'Logger', 'Test Data']),
    );
  });

  it('reports NOT included when no repo block was built', () => {
    const q3 = auditPromptInclusion(null);
    expect(q3.included).toBe(false);
    expect(q3.promptSection).toBeNull();
  });
});

describe('auditGeneratedScripts — REAL broken SauceDemo output (Q4)', () => {
  const profile = sauceDemoProfile();

  it('flags the exact assets the bad run ignored', () => {
    const { checklist } = auditGeneratedScripts(profile, [
      { path: 'tests/login.spec.ts', content: readFixture('broken-login.spec.ts.txt') },
      { path: 'data/test-data.ts', content: readFixture('broken-test-data.ts.txt') },
    ]);

    // Ignored → FAIL
    expect(statusOf(checklist, 'Environment')).toBe('FAIL');   // hardcoded https URL
    expect(statusOf(checklist, 'Test Data')).toBe('FAIL');     // parallel data/test-data
    expect(statusOf(checklist, 'Completeness')).toBe('FAIL');  // "Unsupported step" throws

    // Honoured even in the bad run → PASS (evidence, not blanket condemnation)
    expect(statusOf(checklist, 'Framework')).toBe('PASS');
    expect(statusOf(checklist, 'Page Objects')).toBe('PASS');  // it did use LoginPage

    // Every FAIL row cites concrete evidence.
    for (const c of checklist) {
      if (c.status === 'FAIL') {
        expect(c.evidence.length).toBeGreaterThan(0);
        expect(c.expected.length).toBeGreaterThan(0);
        expect(c.actual.length).toBeGreaterThan(0);
      }
    }
  });

  it('Environment FAIL names the hardcoded URL', () => {
    const { checklist } = auditGeneratedScripts(profile, [
      { path: 'tests/login.spec.ts', content: readFixture('broken-login.spec.ts.txt') },
    ]);
    const env = checklist.find((c) => c.asset === 'Environment')!;
    expect(env.expected).toContain('utils/env.ts');
    expect(env.actual).toContain('saucedemo.com');
  });
});

describe('auditGeneratedScripts — repo-native good specs (no false alarms)', () => {
  const profile = sauceDemoProfile();

  it('good login spec passes every applicable asset', () => {
    const { checklist } = auditGeneratedScripts(profile, [
      { path: 'tests/verify-successful-login.spec.ts', content: readFixture('good-login.spec.ts.txt') },
    ]);
    const failed = checklist.filter((c) => c.status === 'FAIL');
    expect(failed).toHaveLength(0);
    expect(statusOf(checklist, 'Environment')).toBe('PASS');
    expect(statusOf(checklist, 'Logger')).toBe('PASS');
    expect(statusOf(checklist, 'Test Data')).toBe('PASS');
    expect(statusOf(checklist, 'Page Objects')).toBe('PASS');
    expect(statusOf(checklist, 'Completeness')).toBe('PASS');
  });

  it('good locked-user spec has no failures', () => {
    const { checklist } = auditGeneratedScripts(profile, [
      { path: 'tests/verify-locked-user.spec.ts', content: readFixture('good-locked-user.spec.ts.txt') },
    ]);
    expect(checklist.filter((c) => c.status === 'FAIL')).toHaveLength(0);
  });
});

describe('auditRepositoryIntelligence — full Q1–Q4 assembly', () => {
  it('greenfield (no profile) reports profileLoaded=false and no checklist', () => {
    const audit = auditRepositoryIntelligence({ profile: null, files: [] });
    expect(audit.profileLoaded).toBe(false);
    expect(audit.checklist).toHaveLength(0);
  });

  it('ties prompt inclusion + checklist together for the bad run', () => {
    const audit = auditRepositoryIntelligence({
      profile: sauceDemoProfile(),
      files: [{ path: 'tests/login.spec.ts', content: readFixture('broken-login.spec.ts.txt') }],
      promptSection: 'Framework: playwright\nPAGE OBJECTS: LoginPage',
      reachedPromptBuilder: true,
    });
    expect(audit.profileLoaded).toBe(true);
    expect(audit.reachedPromptBuilder).toBe(true);
    expect(audit.promptInclusion.included).toBe(true);
    expect(audit.checklist.length).toBeGreaterThan(0);
    expect(audit.flow).toBe('script-gen');
  });
});

describe('Generation Decision Report — the deterministic Reason (no AI)', () => {
  // A prompt that DID carry Test Data + Page Objects guidance, but NOT any
  // environment/base-URL guidance. This lets the auditor separate "the prompt
  // never told the LLM" (Environment) from "the LLM ignored it" (Test Data).
  const promptWithDataButNoEnv = [
    '--- REPO PATTERN GUIDE ---',
    'Framework: playwright | Language: typescript',
    'PAGE OBJECTS (instantiate & call): LoginPage [login]',
    'TEST DATA ACCESS: getUser(key) from utils/testData.ts',
    'STEP LOGGING — the repo reports progress via logger',
  ].join('\n');

  it('attributes each FAIL to the correct mechanism', () => {
    const audit = auditRepositoryIntelligence({
      profile: sauceDemoProfile(),
      files: [
        { path: 'tests/login.spec.ts', content: readFixture('broken-login.spec.ts.txt') },
        { path: 'data/test-data.ts', content: readFixture('broken-test-data.ts.txt') },
      ],
      promptSection: promptWithDataButNoEnv,
      reachedPromptBuilder: true,
    });

    // Environment guidance was NOT in the prompt → the Prompt Builder is the bug.
    expect(statusOf(audit.checklist, 'Environment')).toBe('FAIL');
    expect(reasonOf(audit.checklist, 'Environment')).toBe('MISSING_FROM_PROMPT');

    // Test Data guidance WAS in the prompt, yet the output built a parallel
    // module → the LLM ignored guidance.
    expect(statusOf(audit.checklist, 'Test Data')).toBe('FAIL');
    expect(reasonOf(audit.checklist, 'Test Data')).toBe('IN_PROMPT_IGNORED');

    // Completeness is a generation defect, not a repo-guidance issue.
    expect(statusOf(audit.checklist, 'Completeness')).toBe('FAIL');
    expect(reasonOf(audit.checklist, 'Completeness')).toBe('INCOMPLETE_GENERATION');

    // Honoured rows read FOLLOWED.
    expect(reasonOf(audit.checklist, 'Page Objects')).toBe('FOLLOWED');
  });

  it('marks assets the repo does not have as NO_MATCHING_ASSET', () => {
    // Strip page objects + env + data helpers → those rows become N/A.
    const bare = sauceDemoProfile();
    bare.pageObjects = [];
    bare.environment = { envFiles: [], usesDotenv: false, configModule: null, envVars: [] } as any;
    bare.helperFunctions = [];
    const audit = auditRepositoryIntelligence({
      profile: bare,
      files: [{ path: 'tests/login.spec.ts', content: readFixture('good-login.spec.ts.txt') }],
      promptSection: 'Framework: playwright',
      reachedPromptBuilder: true,
    });
    expect(statusOf(audit.checklist, 'Page Objects')).toBe('NOT_APPLICABLE');
    expect(reasonOf(audit.checklist, 'Page Objects')).toBe('NO_MATCHING_ASSET');
  });
});

describe('RepositoryIntelligenceAuditor — platform-wide facade', () => {
  it('exposes flow-tagged entry points that reuse the same primitives', () => {
    const profile = sauceDemoProfile();
    const files = [
      { path: 'tests/login.spec.ts', content: readFixture('broken-login.spec.ts.txt') },
    ];
    const healing = RepositoryIntelligenceAuditor.auditHealing({ profile, files });
    const migration = RepositoryIntelligenceAuditor.auditMigration({ profile, files });
    expect(healing.flow).toBe('healing');
    expect(migration.flow).toBe('migration');
    // Same underlying audit → same findings, just a different flow label.
    expect(statusOf(healing.checklist, 'Environment')).toBe('FAIL');
    expect(statusOf(migration.checklist, 'Environment')).toBe('FAIL');
    // Q3-only + Q4-only primitives are reachable from the facade too.
    expect(RepositoryIntelligenceAuditor.auditPrompt('Framework: playwright').included).toBe(true);
    expect(
      RepositoryIntelligenceAuditor.auditGeneration(profile, files).checklist.length,
    ).toBeGreaterThan(0);
  });
});
