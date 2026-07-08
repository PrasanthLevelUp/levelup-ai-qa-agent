/**
 * Evidence harness for Sprint 4 "Generation Quality" — comment discipline.
 *
 * Regenerates a representative SauceDemo login batch (positive + two distinct
 * negatives) through the PUBLIC generate() path and reports, per spec file:
 *   • total lines
 *   • comment lines
 *   • comment density (comments / total)
 *   • a breakdown of which comment FORMS survive (only // @tc: and // TODO:
 *     are permitted after this sprint)
 *
 * This is an honest, reproducible measurement (SauceDemo only — the same page we
 * used to reproduce the four reported defects). It is NOT a vanity score: the
 * goal is "spec files are code, not prose", which comment density makes visible.
 *
 * Run:  npx ts-node tools/measure-comment-density.ts
 */
import { ScriptGenEngine } from '../src/script-gen/script-gen-engine';

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
  { id: 1841, title: 'Valid credentials log in successfully', priority: 'P0',
    preconditions: 'On login page', test_data: '',
    expected_result: 'The user is redirected to the inventory page.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter a valid username', 'Enter a valid password', 'Click the login button'] },
  { id: 2001, title: 'Invalid password', priority: 'P1',
    preconditions: 'On login page', test_data: '',
    expected_result: 'An error message is displayed indicating credentials do not match.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter a valid username', 'Enter an invalid password', 'Click the login button'] },
  { id: 2002, title: 'Unknown user', priority: 'P1',
    preconditions: 'On login page', test_data: '',
    expected_result: 'An error message is displayed indicating credentials do not match.',
    steps: ['Navigate to https://www.saucedemo.com', 'Enter an unknown username', 'Enter a password', 'Click the login button'] },
];

(async () => {
  const engine = new ScriptGenEngine();
  const result = await engine.generate({ url: 'https://www.saucedemo.com', cachedCrawlData, testCases } as any);
  const specs = result.generatedFiles.filter(f => f.type === 'test');

  let totLines = 0, totComments = 0;
  const forms = new Map<string, number>();
  console.log('\n── Comment-density evidence (SauceDemo login batch) ──\n');
  for (const f of specs) {
    const lines = f.content.split('\n');
    const comments = lines.map(l => l.trim()).filter(l => l.startsWith('//') || l.startsWith('/*') || l.startsWith('*'));
    totLines += lines.length;
    totComments += comments.length;
    for (const c of comments) {
      const form = /^\/\/ @tc:/.test(c) ? '// @tc:<id>'
        : /^\/\/ TODO:/.test(c) ? '// TODO:…'
        : 'OTHER (should be 0)';
      forms.set(form, (forms.get(form) || 0) + 1);
    }
    const density = ((comments.length / lines.length) * 100).toFixed(1);
    console.log(`  ${f.path}`);
    console.log(`    lines=${lines.length}  comments=${comments.length}  density=${density}%`);
  }
  console.log('\n  Comment forms across all specs:');
  for (const [form, n] of forms) console.log(`    ${form.padEnd(22)} ${n}`);
  const overall = ((totComments / totLines) * 100).toFixed(1);
  console.log(`\n  OVERALL: ${totComments} comment lines / ${totLines} total = ${overall}% density`);
  console.log('  Coverage metadata now surfaced as structured result (result.coverage):');
  for (const c of result.coverage || []) {
    console.log(`    TC${c.testCaseId} "${c.title}" → categories=[${c.categories}] assets=[${c.assets}]`);
  }
  console.log('');
})();
