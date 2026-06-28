/* eslint-disable no-console */
/**
 * Benchmark 001 (end-to-end) — SauceDemo #username healing benchmark.
 * -------------------------------------------------------------------
 * Drives the REAL LevelUp execution + diagnosis path against the live
 * SauceDemo repo and asserts the full success chain the product must always
 * satisfy:
 *
 *     #username  (broken locator in pages/LoginPage.ts)
 *        ↓  Execution (ExecutionEngine.runAsync — same call the worker makes)
 *     located Playwright error: waiting for locator('#username')   ← NOT a crash
 *        ↓  ArtifactCollector
 *     failed_locator = "#username"
 *        ↓  FailureAnalyzer
 *     failureType = locator_timeout, diagnosis.category = locator
 *        ↓  DOMCandidateExtractor
 *     candidate: page.locator('[data-test="username"]')
 *        ↓  Validation (apply candidate, rerun)
 *     PASS (exit 0)
 *
 * The regression this guards against: an invalid `--screenshot`/`--video` CLI
 * flag makes Playwright exit in ~0.5s with "unknown option" and NO results, so
 * the located error never appears and the pipeline degrades to framework /
 * report-only. See tests/unit/playwright-artifact-flags.test.ts for the pure
 * unit guard that locks in the flag fix (commit 3588e46).
 *
 * Requires: the SauceDemo repo checked out + Playwright browsers installed.
 * Skips cleanly (exit 0) when the repo is absent so CI without the repo is green.
 *
 * Run: npx tsx scripts/benchmark-001-e2e.ts
 */
import * as fs from 'fs';
import * as path from 'path';
import { ExecutionEngine } from '../src/core/execution-engine';
import { ArtifactCollector } from '../src/core/artifact-collector';
import { FailureAnalyzer } from '../src/core/failure-analyzer';
import { DOMCandidateExtractor } from '../src/engines/dom-candidate-extractor';

const REPO = process.env['SAUCEDEMO_REPO'] || '/home/ubuntu/github_repos/LevelUpAI_SauceDemo';
const SPEC = 'tests/verify-successful-login-with-valid-credentials.spec.ts';
const LOGIN_PAGE = path.join(REPO, 'pages/LoginPage.ts');

let failed = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) console.log(`  ✅ ${name}`);
  else { failed++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}

function locatedErrorOf(resultsFile: string): string {
  if (!fs.existsSync(resultsFile)) return '';
  const d = JSON.parse(fs.readFileSync(resultsFile, 'utf-8'));
  let found = '';
  const walk = (suites: any[]) => {
    for (const s of suites ?? []) {
      for (const spec of s.specs ?? []) {
        for (const t of spec.tests ?? []) {
          for (const r of t.results ?? []) {
            for (const e of r.errors ?? []) {
              if (typeof e.message === 'string' && e.message.includes('username')) found = e.message;
            }
          }
        }
      }
      walk(s.suites ?? []);
    }
  };
  walk(d.suites ?? []);
  return found;
}

(async () => {
  if (!fs.existsSync(LOGIN_PAGE)) {
    console.log(`\n⏭️  SKIP Benchmark 001 e2e — SauceDemo repo not found at ${REPO}`);
    process.exit(0);
  }

  console.log('\n=== Benchmark 001 (e2e): execution → located error ===');
  const run = await ExecutionEngine.runAsync(REPO, SPEC, undefined, 120_000, 'standard', true, false);
  check('execution did NOT crash with "unknown option" (invalid CLI flag)',
    !/unknown option/.test(run.stderr || '') && !/unknown option/.test(run.stdout || ''),
    (run.stderr || run.stdout || '').slice(0, 120));
  check('test-results.json was produced', fs.existsSync(run.resultsFile));
  const located = locatedErrorOf(run.resultsFile);
  check("located Playwright error contains waiting for locator('#username')",
    located.includes("#username"), located.slice(0, 120));

  console.log('\n=== Benchmark 001 (e2e): ArtifactCollector → FailureAnalyzer ===');
  const artifacts = new ArtifactCollector().collect(run.resultsFile, REPO);
  const art = artifacts[0];
  check('artifacts.length >= 1', artifacts.length >= 1, String(artifacts.length));
  check('failed_locator === "#username"', art?.failed_locator === '#username',
    JSON.stringify(art?.failed_locator));
  const details = new FailureAnalyzer().analyze(art);
  check('failureType is locator-ish (not framework/unknown)',
    details.failureType === 'locator_timeout' || details.diagnosis?.category === 'locator',
    `${details.failureType} / ${details.diagnosis?.category}`);

  console.log('\n=== Benchmark 001 (e2e): candidate generation ===');
  const loginDom = fs.readFileSync(LOGIN_PAGE, 'utf-8'); // not the live DOM, but we use a known snapshot
  void loginDom;
  const dom = `<form>
    <input type="text" data-test="username" id="user-name" name="user-name" placeholder="Username">
    <input type="password" data-test="password" id="password" name="password">
    <input type="submit" data-test="login-button" id="login-button" value="Login">
  </form>`;
  const res = new DOMCandidateExtractor().extractFromHTML(dom, details.failedLocator, art?.failed_line_code || '');
  const hasDataTest = res.candidates.some((c) => c.selector === `page.locator('[data-test="username"]')`);
  check('candidate [data-test="username"] generated', hasDataTest,
    res.candidates.map((c) => c.selector).join(', '));

  console.log('\n=== Benchmark 001 (e2e): validation (apply candidate → rerun → PASS) ===');
  const original = fs.readFileSync(LOGIN_PAGE, 'utf-8');
  try {
    const healed = original.replace("this.page.locator('#username')", `this.page.locator('[data-test="username"]')`);
    fs.writeFileSync(LOGIN_PAGE, healed);
    const validate = await ExecutionEngine.runAsync(REPO, SPEC, undefined, 120_000, 'standard', true, true);
    check('validation rerun PASSES (exit 0) with the candidate applied', validate.exitCode === 0,
      `exit=${validate.exitCode}`);
  } finally {
    fs.writeFileSync(LOGIN_PAGE, original); // ALWAYS restore the broken locator
  }

  console.log(`\n=== Benchmark 001 e2e: ${failed === 0 ? 'PASSED ✅' : `FAILED ❌ (${failed})`} ===\n`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
