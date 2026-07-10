/* eslint-disable no-console */
/**
 * SCRIPT QUALITY BASELINE — "How much would a Senior SDET rewrite today?"
 * =======================================================================
 * NOT a unit test. The Sprint 3 companion to `measure-graph-coverage.ts`:
 * it drives the REAL ScriptGenEngine over a representative corpus and runs the
 * deterministic Script Quality Guard over every generated spec, printing a
 * per-rule baseline. Sprint 3's PRs each drive one rule's count toward zero.
 *
 * Corpus (SauceDemo, the one locally-cloned benchmark):
 *   • one graph-owned scenario (valid login) — the "good" path
 *   • the locked-user variants (valid/invalid/whitespace/special/empty/maxlen)
 *     which fall to LEGACY inference — where the rewrite-worthy output lives
 * mirrors tests/unit/script-gen-scenario-fidelity.test.ts so numbers are honest.
 *
 * Run:   npx ts-node tools/measure-script-quality.ts
 * Exit:  always 0 — this is MEASUREMENT. PR 3.9 turns the guard into a gate.
 */
import { ScriptGenEngine } from '../src/script-gen/script-gen-engine';
import {
  auditScriptQuality,
  type QualityRuleId,
  type QualityViolation,
} from '../src/script-gen/script-quality-guard';

const repoProfile: any = {
  framework: 'playwright', language: 'typescript', testPattern: 'pom',
  helperFunctions: [], fixtures: [], sharedConstants: [], dataFiles: [], dependencies: [],
  pageObjects: [
    { name: 'LoginPage', filePath: 'tests/pages/LoginPage.ts', isExported: true, baseClass: null,
      methods: [
        { name: 'open', filePath: 'tests/pages/LoginPage.ts', isExported: true, isAsync: true, parameters: [], returnType: 'Promise<void>', jsdoc: '', lineNumber: 1, category: 'page-object', complexity: 1 },
        { name: 'login', filePath: 'tests/pages/LoginPage.ts', isExported: true, isAsync: true, parameters: [], returnType: 'Promise<void>', jsdoc: '', lineNumber: 1, category: 'page-object', complexity: 1 },
        { name: 'getError', filePath: 'tests/pages/LoginPage.ts', isExported: true, isAsync: true, parameters: [], returnType: 'Promise<void>', jsdoc: '', lineNumber: 1, category: 'page-object', complexity: 1 },
      ], properties: [] },
  ],
};

const cachedCrawlData: any = {
  url: 'https://www.saucedemo.com', finalUrl: 'https://www.saucedemo.com',
  title: 'Swag Labs', pageType: 'login', pageTypeConfidence: 0.9,
  elements: [
    { tag: 'input', id: 'user-name', name: 'user-name', type: 'text', attributes: { 'data-test': 'username' } },
    { tag: 'input', id: 'password', name: 'password', type: 'password', attributes: { 'data-test': 'password' } },
    { tag: 'input', id: 'login-button', type: 'submit', attributes: { 'data-test': 'login-button' } },
  ],
  forms: [], navigationLinks: [], buttons: [], inputs: [], headings: [],
  htmlSnapshot: '', totalElements: 3, interactiveElements: 3,
};

const testCases: any[] = [
  { id: 7003, title: 'Valid credentials log in successfully', priority: 'P0',
    preconditions: 'User is on the login page', test_data: 'standard_user',
    expected_result: 'User is redirected to the products/inventory page.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter username standard_user', 'Enter password secret_sauce', 'Click the login button'] },
  { id: 1392, title: 'Locked user login attempt with valid credentials', priority: 'P0',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'Login should fail and an error message is displayed indicating the account is locked out.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter username from locked_users: locked_out_user', 'Enter valid password', 'Click the login button'] },
  { id: 1393, title: 'Locked user login attempt with invalid credentials', priority: 'P0',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'Login should fail and an error message is displayed.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter an invalid username', 'Enter an invalid password', 'Click the login button'] },
  { id: 1396, title: 'Locked user login attempt with leading/trailing whitespace', priority: 'P1',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'Login should fail and an error message is displayed.',
    steps: ['Navigate to https://www.saucedemo.com', "Enter ' locked_user ' with whitespace", 'Enter valid password', 'Click the login button'] },
  { id: 1397, title: 'Locked user login attempt with special characters', priority: 'P1',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'Login should fail and an error message is displayed.',
    steps: ['Navigate to https://www.saucedemo.com', "Enter '@locked_user' username", 'Enter valid password', 'Click the login button'] },
  { id: 1398, title: 'Locked user login attempt with empty fields', priority: 'P1',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'Login should fail and a required-field error is displayed.',
    steps: ['Navigate to https://www.saucedemo.com', 'Leave username and password empty', 'Click the login button'] },
  { id: 1399, title: 'Locked user login attempt with maximum length username', priority: 'P1',
    preconditions: 'User is on the login page', test_data: 'locked_user',
    expected_result: 'Login should fail and an error message is displayed.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter a maximum length username of 256 characters', 'Enter valid password', 'Click the login button'] },
];

const RULE_TO_PR: Record<QualityRuleId, string> = {
  'no-wait-for-timeout': '3.6',
  'no-networkidle': '3.6',
  'no-manual-text-content': '3.6',
  'no-todo-marker': '3.5',
  'no-weak-assertion': '3.4',
  'no-weak-locator': '3.4/3.6',
  'no-unused-variable': '3.5',
  'no-duplicate-variable': '3.5',
  'no-dead-import': '3.5',
};

async function main(): Promise<void> {
  const engine = new ScriptGenEngine();
  const result = await engine.generate({ url: 'https://www.saucedemo.com', cachedCrawlData, repoProfile, testCases } as any);
  const files: Array<{ path: string; content: string }> = result.generatedFiles.filter(
    (f: any) => f.type === 'test' || /\.spec\.ts$/.test(f.path),
  );

  console.log('SCRIPT QUALITY BASELINE — SauceDemo corpus\n' + '='.repeat(72));
  console.log(`Generated ${files.length} spec file(s) from ${testCases.length} test cases.\n`);

  const totalByRule: Partial<Record<QualityRuleId, number>> = {};
  const examples: Partial<Record<QualityRuleId, QualityViolation & { file: string }>> = {};
  let totalErrors = 0;
  let totalWarns = 0;
  let cleanFiles = 0;

  for (const f of files) {
    const report = auditScriptQuality(f.content);
    if (report.clean && report.warnCount === 0) cleanFiles++;
    totalErrors += report.errorCount;
    totalWarns += report.warnCount;
    for (const v of report.violations) {
      totalByRule[v.rule] = (totalByRule[v.rule] ?? 0) + 1;
      if (!examples[v.rule]) examples[v.rule] = { ...v, file: f.path.split('/').pop() || f.path };
    }
  }

  console.log('rule'.padEnd(24) + 'PR'.padEnd(9) + 'count'.padStart(6) + '   first example');
  console.log('-'.repeat(72));
  (Object.keys(RULE_TO_PR) as QualityRuleId[])
    .sort((a, b) => (totalByRule[b] ?? 0) - (totalByRule[a] ?? 0))
    .forEach((rule) => {
      const n = totalByRule[rule] ?? 0;
      const ex = examples[rule];
      const exStr = ex ? `${ex.file}:${ex.line}  ${ex.snippet.slice(0, 28)}` : '—';
      console.log(rule.padEnd(24) + RULE_TO_PR[rule].padEnd(9) + String(n).padStart(6) + '   ' + exStr);
    });

  console.log('-'.repeat(72));
  console.log(`TOTAL   ${totalErrors} error / ${totalWarns} warn across ${files.length} files ` +
    `(${cleanFiles} fully clean).`);
  console.log('\nMEASUREMENT ONLY — not blocking. PR 3.9 flips the guard into a gate.');
}

main().catch((e) => { console.error(e); process.exit(1); });
