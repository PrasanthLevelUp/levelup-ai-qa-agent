/* eslint-disable no-console */
/**
 * Local proof harness — runs the FIXED ScriptGenEngine (deterministic
 * test-case path) against the 10 real SauceDemo login/auth test cases
 * (requirement #66) using a real SauceDemo login-page crawl snapshot.
 *
 * Generates one grounded Playwright spec per test case → /home/ubuntu/fixed_scripts/.
 * No OpenAI key needed (the test-case path is deterministic).
 */
import * as fs from 'fs';
import * as path from 'path';
import { ScriptGenEngine } from '../src/script-gen/script-gen-engine';

const OUT_DIR = '/home/ubuntu/fixed_scripts';
const TC_JSON = '/home/ubuntu/tc66.json';

// ── Real SauceDemo login-page DOM snapshot (verified selectors) ──
function el(p: any) {
  return {
    tag: p.tag,
    type: p.type,
    id: p.id,
    name: p.name,
    className: p.className,
    placeholder: p.placeholder,
    ariaLabel: p.ariaLabel,
    dataTestId: p.dataTestId,
    textContent: p.textContent || '',
    visible: true,
    attributes: p.attributes || {},
  };
}

const saucedemoCrawl = {
  url: 'https://www.saucedemo.com/',
  finalUrl: 'https://www.saucedemo.com/',
  title: 'Swag Labs',
  pageType: 'login',
  pageTypeConfidence: 0.95,
  elements: [
    el({ tag: 'input', type: 'text', id: 'user-name', name: 'user-name', placeholder: 'Username', className: 'input_error form_input', attributes: { id: 'user-name', name: 'user-name', 'data-test': 'username', placeholder: 'Username' } }),
    el({ tag: 'input', type: 'password', id: 'password', name: 'password', placeholder: 'Password', className: 'input_error form_input', attributes: { id: 'password', name: 'password', 'data-test': 'password', placeholder: 'Password' } }),
    el({ tag: 'input', type: 'submit', id: 'login-button', name: 'login-button', value: 'Login', className: 'submit-button btn_action', attributes: { id: 'login-button', name: 'login-button', 'data-test': 'login-button', value: 'Login' } }),
    el({ tag: 'h3', textContent: '', className: 'error-message-container', attributes: { 'data-test': 'error', class: 'error-message-container' } }),
  ],
  forms: [],
  navigationLinks: [],
  buttons: [],
  inputs: [],
  headings: [],
  htmlSnapshot: '',
  totalElements: 4,
  interactiveElements: 3,
  crawlTimeMs: 0,
  errors: [],
};

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const cases = JSON.parse(fs.readFileSync(TC_JSON, 'utf8'));
  const engine = new ScriptGenEngine(); // no key needed for deterministic path

  const summary: any[] = [];
  for (const c of cases) {
    const testCase = {
      id: Number(c['#']),
      title: String(c['Title']),
      steps: String(c['Steps']),
      expected_result: String(c['Expected Result']),
      test_data: String(c['Test Data'] ?? ''),
      priority: String(c['Priority'] ?? ''),
      scenario: String(c['Coverage Type'] ?? ''),
      coverage_type: String(c['Coverage Type'] ?? ''),
    };

    const result = await engine.generate({
      url: 'https://www.saucedemo.com/',
      testCase,
      includeNegativeTests: false,
      cachedCrawlData: saucedemoCrawl,
    });

    const file = result.generatedFiles.find(f => f.type === 'test') || result.generatedFiles[0];
    if (!file) { console.error(`TC${testCase.id}: NO FILE`); continue; }
    const outName = `${String(testCase.id).padStart(2, '0')}_${slug(testCase.title)}.spec.ts`;
    fs.writeFileSync(path.join(OUT_DIR, outName), file.content, 'utf8');
    summary.push({
      id: testCase.id,
      title: testCase.title,
      file: outName,
      model: result.stats.model,
      assertions: result.stats.totalAssertions,
    });
    console.log(`TC${testCase.id} → ${outName} (model=${result.stats.model}, assertions=${result.stats.totalAssertions})`);
  }

  fs.writeFileSync(path.join(OUT_DIR, '_generation_summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\nGenerated ${summary.length} scripts → ${OUT_DIR}`);
}

main().catch(e => { console.error(e); process.exit(1); });
