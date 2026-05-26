/**
 * Unit tests for repo-analyzer.ts
 *
 * Run with: npx tsx tests/unit/repo-analyzer.test.ts
 */

import { analyzeRepoStructure, type RepoStructureAnalysis } from '../../src/script-gen/repo-analyzer';
import type { RepositoryProfile } from '../../src/context/types';

/* ------------------------------------------------------------------ */
/*  Fixture: Simulated profile for selfhealing_agent_poc               */
/* ------------------------------------------------------------------ */

const flatProfile: RepositoryProfile = {
  framework: 'playwright',
  language: 'typescript',
  testPattern: 'flat-scripts',
  locatorStrategy: 'css-selectors',
  folderStructure: {
    testFolder: 'tests',
    pageObjectFolder: null,
    fixtureFolder: null,
    utilsFolder: null,
    configFiles: ['playwright.config.ts'],
    supportFiles: [],
  },
  totalFiles: 12,
  totalTestFiles: 7,
  totalHelperFiles: 0,
  totalLineCount: 450,
  codingStyle: {
    namingConvention: 'snake_case',
    testNaming: 'NN_description',
    stepStyle: 'flat',
    tagConvention: '@smoke',
    indentStyle: 'spaces-2',
    quoteStyle: 'single',
    semicolons: true,
  },
  helperFunctions: [],
  pageObjects: [],
  fixtures: [],
  customCommands: [],
  sharedConstants: [],
  businessFlows: [],
  testSuites: [
    { name: 'Login Positive', filePath: 'tests/01_login_positive.spec.ts', testCount: 1, testNames: ['should login'], describeName: 'Login', tags: ['@login-positive'], category: 'auth' },
    { name: 'Login Negative', filePath: 'tests/02_login_negative.spec.ts', testCount: 1, testNames: ['should fail'], describeName: 'Login', tags: ['@login-negative'], category: 'auth' },
    { name: 'Dashboard', filePath: 'tests/03_dashboard.spec.ts', testCount: 1, testNames: ['dashboard check'], describeName: 'Dashboard', tags: ['@dashboard'], category: 'navigation' },
    { name: 'Employee CRUD', filePath: 'tests/04_employee_crud.spec.ts', testCount: 2, testNames: ['add', 'edit'], describeName: 'Employee', tags: ['@employee-crud'], category: 'crud' },
    { name: 'Employee Search', filePath: 'tests/05_employee_search.spec.ts', testCount: 1, testNames: ['search'], describeName: 'Employee', tags: ['@employee-search'], category: 'search' },
    { name: 'Recruitment', filePath: 'tests/06_recruitment.spec.ts', testCount: 1, testNames: ['recruit'], describeName: 'Recruitment', tags: ['@recruitment'], category: 'crud' },
    { name: 'Leave Management', filePath: 'tests/07_leave_management.spec.ts', testCount: 1, testNames: ['leave'], describeName: 'Leave', tags: ['@leave'], category: 'crud' },
  ],
  preferredLocators: [],
  avoidPatterns: [],
  dependencies: [{ name: '@playwright/test', version: '^1.40.0', isDev: true }],
  assertionLibrary: '@playwright/test',
  hasApiLayer: false,
  hasCustomFixtures: false,
  hasMocking: false,
  hasVisualTesting: false,
  ciIntegration: 'github-actions',
};

const pomProfile: RepositoryProfile = {
  ...flatProfile,
  testPattern: 'page-object-model',
  folderStructure: {
    ...flatProfile.folderStructure,
    pageObjectFolder: 'pages',
    utilsFolder: 'utils',
  },
  pageObjects: [
    { name: 'LoginPage', filePath: 'pages/login.page.ts', isExported: true, baseClass: null, methods: [], properties: [], category: 'page-object', lineNumber: 1 },
  ],
  testSuites: [
    { name: 'Login', filePath: 'tests/login.spec.ts', testCount: 2, testNames: ['positive', 'negative'], describeName: 'Login', tags: ['@auth'], category: 'auth' },
  ],
};

/* ------------------------------------------------------------------ */
/*  Test runner                                                         */
/* ------------------------------------------------------------------ */

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
/*  Tests                                                               */
/* ------------------------------------------------------------------ */

console.log('\n=== Flat-scripts repo ===');
const flat = analyzeRepoStructure(flatProfile);

assertEqual(flat.mode, 'flat', 'mode should be flat');
assertEqual(flat.naming.usesNumberPrefix, true, 'should detect number prefix');
assertEqual(flat.naming.casing, 'snake_case', 'casing should be snake_case');
assertEqual(flat.naming.extension, '.spec.ts', 'extension should be .spec.ts');
assertEqual(flat.naming.separator, '_', 'separator should be underscore');
assertEqual(flat.nextFileNumber, 8, 'next file number should be 8');
assertEqual(flat.testDir, 'tests', 'testDir should be tests');
assertEqual(flat.hasPlaywrightConfig, true, 'should detect playwright config');
assertEqual(flat.hasCIWorkflow, true, 'should detect CI workflow');
assertEqual(flat.hasFixtures, false, 'should have no fixtures');
assertEqual(flat.hasPageObjects, false, 'should have no page objects');
assertEqual(flat.credentialStyle, 'inline', 'credential style should be inline');
assertEqual(flat.existingTestFiles.length, 7, 'should have 7 existing test files');

console.log('\n=== POM repo ===');
const pom = analyzeRepoStructure(pomProfile);

assertEqual(pom.mode, 'pom', 'mode should be pom');
assertEqual(pom.hasPageObjects, true, 'should detect page objects');

/* ------------------------------------------------------------------ */
/*  Test adaptive-codegen integration                                   */
/* ------------------------------------------------------------------ */

import { adaptiveGenerateFiles } from '../../src/script-gen/adaptive-codegen';
import type { TestPlan, GenerationConfig } from '../../src/script-gen/script-gen-engine';

const mockTestPlan: TestPlan = {
  name: 'Test Plan',
  description: 'Test plan for OrangeHRM',
  baseUrl: 'https://demo.orangehrm.com',
  pageType: 'login',
  flows: [
    {
      name: 'Login Positive Flow',
      description: 'should login with valid credentials',
      flowType: 'authentication',
      priority: 1,
      steps: [
        { action: 'navigate', target: 'https://demo.orangehrm.com', description: 'Go to login page' },
        { action: 'fill', target: 'username input', selector: "page.getByLabel('Username')", value: '{{USERNAME}}', description: 'Enter username' },
        { action: 'fill', target: 'password input', selector: "page.getByLabel('Password')", value: '{{PASSWORD}}', description: 'Enter password' },
        { action: 'click', target: 'Login button', selector: "page.getByRole('button', { name: 'Login' })", description: 'Click login' },
      ],
      tags: ['smoke', 'auth'],
    },
    {
      name: 'Dashboard Navigation',
      description: 'should navigate dashboard after login',
      flowType: 'navigation',
      priority: 2,
      steps: [
        { action: 'navigate', target: 'https://demo.orangehrm.com', description: 'Go to app' },
        { action: 'click', target: 'Dashboard link', selector: "page.getByRole('link', { name: 'Dashboard' })", description: 'Click Dashboard' },
      ],
      tags: ['smoke', 'navigation'],
    },
  ],
  fixtures: [],
  pageObjects: [],
  metadata: {
    generatedAt: new Date().toISOString(),
    crawlTimeMs: 3000,
    totalElements: 50,
    selectorQuality: 0.85,
    model: 'gpt-4o-mini',
    tokensUsed: 1000,
  },
};

const mockConfig: GenerationConfig = {
  url: 'https://demo.orangehrm.com',
  credentials: { username: 'Admin', password: 'admin123' },
  includeNegativeTests: true,
};

console.log('\n=== Adaptive codegen: flat mode ===');
const flatFiles = adaptiveGenerateFiles(mockTestPlan, mockConfig, flat);
assert(flatFiles !== null, 'should produce files for flat mode');
if (flatFiles) {
  assertEqual(flatFiles.filter(f => f.type === 'test').length, 2, 'should generate 2 test files');

  const testFile0 = flatFiles.find(f => f.path.includes('08_'));
  assert(!!testFile0, 'first file should have 08_ prefix');
  assert(testFile0?.path.endsWith('.spec.ts') ?? false, 'file should end with .spec.ts');
  assert(testFile0?.path.includes('tests/') ?? false, 'file should be in tests/ dir');

  const testFile1 = flatFiles.find(f => f.path.includes('09_'));
  assert(!!testFile1, 'second file should have 09_ prefix');

  // No page objects or config should be generated (repo already has them)
  const configFiles = flatFiles.filter(f => f.type === 'config');
  assertEqual(configFiles.length, 0, 'should NOT generate config (repo already has one)');

  const pageObjectFiles = flatFiles.filter(f => f.type === 'page-object');
  assertEqual(pageObjectFiles.length, 0, 'should NOT generate page objects in flat mode');

  // Check content of first file
  if (testFile0) {
    assert(testFile0.content.includes("import { test, expect }"), 'should have playwright import');
    assert(testFile0.content.includes('Admin'), 'should inline credentials (not process.env)');
    assert(!testFile0.content.includes('process.env'), 'flat mode should NOT use process.env');
    assert(testFile0.content.includes("tag:"), 'should include tags');
  }

  console.log('\n--- Sample generated file ---');
  console.log(`Path: ${testFile0?.path}`);
  console.log(testFile0?.content?.substring(0, 600) + '...\n');
}

console.log('\n=== Adaptive codegen: POM mode ===');
const pomFiles = adaptiveGenerateFiles(mockTestPlan, mockConfig, pom);
assertEqual(pomFiles, null, 'should return null for POM mode (delegate to default)');

/* ------------------------------------------------------------------ */
/*  Summary                                                             */
/* ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log('All tests passed! ✅\n');
