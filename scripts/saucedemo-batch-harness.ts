/**
 * Requirement-batch harness — exercises the NEW config.testCases path.
 *
 * Simulates the REQ-001 (10 test cases) flow: ONE engine.generate() call with
 * a `testCases` array (as the script-gen route now passes for requirement-based
 * generation) must produce 10 grounded, deterministic specs — no LLM, no
 * project-context credential contamination.
 *
 * Run: node_modules/.bin/ts-node --transpile-only scripts/saucedemo-batch-harness.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ScriptGenEngine } from '../src/script-gen/script-gen-engine';

const OUT_DIR = '/home/ubuntu/fixed_scripts_batch';
const TC_JSON = '/home/ubuntu/tc66.json';

function el(p: any) {
  return {
    tag: p.tag, type: p.type, id: p.id, name: p.name, className: p.className,
    placeholder: p.placeholder, ariaLabel: p.ariaLabel, dataTestId: p.dataTestId,
    textContent: p.textContent || '', visible: true, attributes: p.attributes || {},
  };
}

const saucedemoCrawl = {
  url: 'https://www.saucedemo.com/', finalUrl: 'https://www.saucedemo.com/',
  title: 'Swag Labs', pageType: 'login', pageTypeConfidence: 0.95,
  elements: [
    el({ tag: 'input', type: 'text', id: 'user-name', name: 'user-name', placeholder: 'Username', className: 'input_error form_input', attributes: { id: 'user-name', name: 'user-name', 'data-test': 'username', placeholder: 'Username' } }),
    el({ tag: 'input', type: 'password', id: 'password', name: 'password', placeholder: 'Password', className: 'input_error form_input', attributes: { id: 'password', name: 'password', 'data-test': 'password', placeholder: 'Password' } }),
    el({ tag: 'input', type: 'submit', id: 'login-button', name: 'login-button', value: 'Login', className: 'submit-button btn_action', attributes: { id: 'login-button', name: 'login-button', 'data-test': 'login-button', value: 'Login' } }),
    el({ tag: 'h3', textContent: '', className: 'error-message-container', attributes: { 'data-test': 'error', class: 'error-message-container' } }),
  ],
  forms: [], navigationLinks: [], buttons: [], inputs: [], headings: [],
  htmlSnapshot: '', totalElements: 4, interactiveElements: 3, crawlTimeMs: 0, errors: [],
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const cases = JSON.parse(fs.readFileSync(TC_JSON, 'utf8'));

  // Build the testCases ARRAY exactly as the route now does for requirements.
  const testCases = cases.map((c: any) => ({
    id: Number(c['#']),
    title: String(c['Title']),
    steps: String(c['Steps']),
    expected_result: String(c['Expected Result']),
    test_data: String(c['Test Data'] ?? ''),
    priority: String(c['Priority'] ?? ''),
    scenario: String(c['Coverage Type'] ?? ''),
    coverage_type: String(c['Coverage Type'] ?? ''),
    requirement_id: 'REQ-001',
  }));

  const engine = new ScriptGenEngine();

  // SINGLE batch call — the requirement-based path.
  const result = await engine.generate({
    url: 'https://www.saucedemo.com/',
    testCases,                 // ← NEW batch field
    includeNegativeTests: false,
    cachedCrawlData: saucedemoCrawl,
  });

  console.log(`\nBatch model: ${result.stats.model}`);
  console.log(`Files generated: ${result.generatedFiles.length}`);
  console.log(`Total tests: ${result.stats.totalTests}, total assertions: ${result.stats.totalAssertions}`);
  if (result.errors.length) console.log('Errors:', result.errors);

  // Write each file (re-name to NN_slug for readability/ordering).
  let i = 0;
  for (const f of result.generatedFiles) {
    i++;
    const m = f.content.match(/Test Case ID:\s*(\d+)/);
    const id = m ? m[1] : String(i);
    const titleM = f.content.match(/test\.describe\('([^']+)'/);
    const title = titleM ? titleM[1] : `case-${id}`;
    const outName = `${String(id).padStart(2, '0')}_${slug(title)}.spec.ts`;
    fs.writeFileSync(path.join(OUT_DIR, outName), f.content, 'utf8');
    console.log(`  → ${outName}`);
  }

  fs.writeFileSync(path.join(OUT_DIR, '_batch_summary.json'), JSON.stringify({
    model: result.stats.model,
    files: result.generatedFiles.length,
    totalTests: result.stats.totalTests,
    totalAssertions: result.stats.totalAssertions,
    errors: result.errors,
  }, null, 2));
  console.log(`\nBatch generated ${result.generatedFiles.length} scripts → ${OUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
