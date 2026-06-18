/**
 * Unit tests for Framework Auditor (src/script-gen/framework-auditor.ts).
 *
 * Regression tests for Phase 1: Framework Impact Analysis + Quality Report.
 *
 * Run with:  npx tsx tests/unit/framework-auditor.test.ts
 */
import { auditFramework, type GenerationContext } from '../../src/script-gen/framework-auditor';
import type { RepositoryProfile } from '../../src/context/types';

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

console.log('framework-auditor: inventory extraction');

// Mock greenfield repo (no existing assets)
const greenfieldRepo: RepositoryProfile = {
  framework: 'playwright',
  language: 'typescript',
  testPattern: 'spec',
  locatorStrategy: 'role-based',
  folderStructure: { tests: [], pageObjectFolder: null, fixtureFolder: null, helperFolder: null },
  totalFiles: 0,
  totalTestFiles: 0,
  totalHelperFiles: 0,
  totalLineCount: 0,
  codingStyle: { indentation: 'spaces-2', quoteStyle: 'single', semicolons: true },
  helperFunctions: [],
  pageObjects: [],
  fixtures: [],
  customCommands: [],
  sharedConstants: [],
  businessFlows: [],
  testSuites: [],
  preferredLocators: [],
  avoidPatterns: [],
  dependencies: [],
  assertionLibrary: 'expect',
  hasApiLayer: false,
  hasCustomFixtures: false,
  hasMocking: false,
  hasVisualTesting: false,
  ciIntegration: null,
  files: [],
  classes: [],
  testPatterns: [],
};

const greenfieldContext: GenerationContext = {
  testCases: [
    { id: 'TC1', title: 'Login test', steps: ['Navigate to login', 'Enter credentials', 'Click submit'] },
  ],
  baseUrl: 'https://example.com',
  isGreenfield: true,
  framework: 'playwright',
};

const scope = { companyId: 1, projectId: 1, repositoryId: 1 };

(async () => {
  const greenfieldAudit = await auditFramework(greenfieldRepo, greenfieldContext, scope);
  check('greenfield: no page objects', greenfieldAudit.inventory.pageObjects.length === 0);
  check('greenfield: no fixtures', greenfieldAudit.inventory.fixtures.length === 0);
  check('greenfield: no utils', greenfieldAudit.inventory.utilities.length === 0);
  check('greenfield: no data files', greenfieldAudit.inventory.dataFiles.length === 0);
  check('greenfield: risk is LOW (no files modified)', greenfieldAudit.impactAnalysis.risk.level === 'LOW');
  check('greenfield: quality is NO REUSE (nothing to reuse)', greenfieldAudit.qualityReport.overallAssessment === 'NO REUSE');

  console.log('framework-auditor: inventory with existing assets');

  // Mock established repo with page objects, fixtures, utils, data
  const establishedRepo: RepositoryProfile = {
    ...greenfieldRepo,
    totalFiles: 6,
    totalTestFiles: 0,
    totalHelperFiles: 2,
    pageObjects: [
      {
        name: 'LoginPage',
        filePath: 'pages/LoginPage.ts',
        isExported: true,
        baseClass: null,
        methods: [
          { name: 'login', signature: 'login(username, password)', filePath: 'pages/LoginPage.ts', lineNumber: 10 },
          { name: 'clickSubmit', signature: 'clickSubmit()', filePath: 'pages/LoginPage.ts', lineNumber: 20 },
        ],
        properties: [],
      },
      {
        name: 'DashboardPage',
        filePath: 'pages/DashboardPage.ts',
        isExported: true,
        baseClass: null,
        methods: [{ name: 'navigate', signature: 'navigate()', filePath: 'pages/DashboardPage.ts', lineNumber: 5 }],
        properties: [],
      },
    ],
    fixtures: [
      { name: 'baseFixture', signature: 'baseFixture()', filePath: 'fixtures/baseFixture.ts', lineNumber: 1 },
    ],
    helperFunctions: [
      { name: 'waitForElement', signature: 'waitForElement(selector)', filePath: 'utils/waitUtils.ts', lineNumber: 1 },
    ],
  };

  const establishedAudit = await auditFramework(establishedRepo, greenfieldContext, scope);
  check('established: 2 page objects found', establishedAudit.inventory.pageObjects.length === 2);
  check('established: LoginPage has 2 methods', establishedAudit.inventory.pageObjects.find(p => p.name === 'LoginPage')?.methodCount === 2);
  check('established: 1 fixture found', establishedAudit.inventory.fixtures.length >= 1);
  check('established: baseFixture purpose is base', establishedAudit.inventory.fixtures.some(f => f.name.includes('baseFixture') && f.purpose === 'base'));
  // Note: utilities, data files, env files, config files are TODO (repo intelligence doesn't capture these yet)
  // For now, we only verify the core page object + fixture extraction works

  console.log('framework-auditor: impact analysis');

  check('established: existing assets list includes LoginPage', establishedAudit.impactAnalysis.existingAssets.some(a => a.includes('LoginPage')));
  check('established: files to create includes spec', establishedAudit.impactAnalysis.filesToCreate.some(f => f.path.includes('.spec.ts')));
  check('established: files to reuse includes LoginPage', establishedAudit.impactAnalysis.filesToReuse.some(f => f.path.includes('LoginPage')));
  check('established: suggested tags is @smoke (short 3-step flow)', establishedAudit.impactAnalysis.suggestedTags.includes('@smoke'));
  // This established repo has no suite files/tags, so the recommendation must be
  // a clearly-flagged suggestion (not pretend it exists).
  check('established: suggested suite is smoke', establishedAudit.impactAnalysis.suggestedSuite === 'smoke');
  check('established: suggested suite flagged as not existing', establishedAudit.impactAnalysis.suggestedSuiteExists === false);
  check('established: no existing suites detected', establishedAudit.impactAnalysis.existingSuites.length === 0);

  console.log('framework-auditor: assets catalog');

  check('catalog: 2 page objects counted', establishedAudit.catalog.pageObjects === 2);
  check('catalog: 1 fixture counted', establishedAudit.catalog.fixtures === 1);
  check('catalog: suites count is a number', typeof establishedAudit.catalog.suites === 'number');
  check('catalog: tags count is a number', typeof establishedAudit.catalog.tags === 'number');

  console.log('framework-auditor: risk assessment');

  check('established: risk is LOW (no updates)', establishedAudit.impactAnalysis.risk.level === 'LOW');
  check('established: risk reason mentions no modifications', establishedAudit.impactAnalysis.risk.reasons.some(r => r.toLowerCase().includes('no existing files modified')));

  console.log('framework-auditor: reuse opportunity (qualitative — no fabricated LOC)');

  const reuse = establishedAudit.impactAnalysis.reuseOpportunity;
  check('reuse opportunity: level is HIGH/MEDIUM/LOW (assets reused)', ['HIGH', 'MEDIUM', 'LOW'].includes(reuse.level));
  check('reuse opportunity: assetsReused includes LoginPage', reuse.assetsReused.some(a => a.includes('LoginPage')));
  check('reuse opportunity: summary is a non-empty string', typeof reuse.summary === 'string' && reuse.summary.length > 0);
  check('reuse opportunity: no fabricated LOC fields', !('withoutReuseLOC' in (reuse as any)) && !('codeReductionPercent' in (reuse as any)));

  console.log('framework-auditor: quality report');

  const quality = establishedAudit.qualityReport;
  check('quality: overall assessment is HIGH/MEDIUM/LOW REUSE', ['HIGH REUSE', 'MEDIUM REUSE', 'LOW REUSE'].includes(quality.overallAssessment));
  check('quality: page object reuse is GOOD or EXCELLENT', ['GOOD', 'EXCELLENT'].includes(quality.pageObjectReuse.score));
  check('quality: fixture reuse is EXCELLENT', quality.fixtureReuse.score === 'EXCELLENT');
  // Data reuse is FAIR (no data files extracted yet)
  check('quality: tag recommendation is EXCELLENT', quality.tagRecommendation.score === 'EXCELLENT');

  console.log('framework-auditor: multi-step regression flow');

  const regressionContext: GenerationContext = {
    testCases: [
      {
        id: 'TC2',
        title: 'Create user',
        steps: [
          'Login as admin',
          'Navigate to users',
          'Click create',
          'Fill form',
          'Submit',
          'Verify success',
        ],
      },
    ],
    baseUrl: 'https://example.com',
    isGreenfield: false,
    framework: 'playwright',
  };

  const regressionAudit = await auditFramework(establishedRepo, regressionContext, scope);
  check('regression: suggested tags is @regression (6-step flow)', regressionAudit.impactAnalysis.suggestedTags.includes('@regression'));
  // No suites exist in this repo → fall back to a flagged 'regression' suggestion.
  check('regression: suggested suite is regression (derived fallback)', regressionAudit.impactAnalysis.suggestedSuite === 'regression');
  check('regression: suggested suite flagged as not existing', regressionAudit.impactAnalysis.suggestedSuiteExists === false);

  console.log('framework-auditor: suite recommendation derived from repo intelligence');

  // Repo that actually has suites/tags — recommendation must come from these,
  // never a hardcoded assumption.
  const repoWithSuites: RepositoryProfile = {
    ...establishedRepo,
    testSuites: [
      { name: 'auth.spec.ts', filePath: 'tests/auth.spec.ts', testCount: 3, testNames: [], describeName: 'Auth', tags: ['@smoke', '@regression'], category: 'auth' },
      { name: 'checkout.spec.ts', filePath: 'tests/checkout.spec.ts', testCount: 5, testNames: [], describeName: 'Checkout', tags: ['@regression'], category: 'crud' },
    ] as any,
  };

  // Short flow → @smoke tag → must map to the repo's real 'smoke' suite.
  const suitesAudit = await auditFramework(repoWithSuites, greenfieldContext, scope);
  check('derived suite: existingSuites contains smoke', suitesAudit.impactAnalysis.existingSuites.map(s => s.toLowerCase()).includes('smoke'));
  check('derived suite: existingSuites contains regression', suitesAudit.impactAnalysis.existingSuites.map(s => s.toLowerCase()).includes('regression'));
  check('derived suite: recommended is smoke (tag maps to existing suite)', suitesAudit.impactAnalysis.suggestedSuite.toLowerCase() === 'smoke');
  check('derived suite: recommended suite exists in repo', suitesAudit.impactAnalysis.suggestedSuiteExists === true);
  check('derived suite: catalog tags count > 0', suitesAudit.catalog.tags > 0);

  // Multi-step flow → @regression tag → must map to the repo's real 'regression' suite.
  const suitesRegressionAudit = await auditFramework(repoWithSuites, regressionContext, scope);
  check('derived suite (regression): recommended is regression', suitesRegressionAudit.impactAnalysis.suggestedSuite.toLowerCase() === 'regression');
  check('derived suite (regression): recommended suite exists', suitesRegressionAudit.impactAnalysis.suggestedSuiteExists === true);

  console.log('framework-auditor: last repository scan in catalog');

  const scopedWithScan = { ...scope, lastScannedAt: new Date() };
  const scanAudit = await auditFramework(repoWithSuites, greenfieldContext, scopedWithScan);
  check('catalog: lastRepositoryScan populated when provided', scanAudit.catalog.lastRepositoryScan === 'today');
  check('catalog: lastRepositoryScan omitted when not provided', suitesAudit.catalog.lastRepositoryScan === undefined);

  console.log('framework-auditor: project scoping');

  check('scope: companyId matches input', greenfieldAudit.scope.companyId === scope.companyId);
  check('scope: projectId matches input', greenfieldAudit.scope.projectId === scope.projectId);
  check('scope: repositoryId matches input', greenfieldAudit.scope.repositoryId === scope.repositoryId);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
