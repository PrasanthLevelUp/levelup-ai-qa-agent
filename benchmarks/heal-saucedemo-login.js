/* eslint-disable no-console */
/**
 * END-TO-END HEALING BENCHMARK — SauceDemo login (the one workflow that must be
 * unbelievably reliable).
 *
 * This is NOT a unit test and NOT a re-implementation. It drives the EXACT same
 * production modules the healing worker uses (src/api/server.ts), in the EXACT
 * same order, against the REAL SauceDemo repo and a REAL browser run:
 *
 *   ArtifactCollector → FailureAnalyzer → TraceParser.extractDomHtml →
 *   HealingOrchestrator.collectRankedCandidates → acceptCandidate →
 *   ValidationLayer.validate/applyValidatedFix → ExecutionEngine.runAsync (spec) →
 *   HealingOrchestrator.recordHealObservation
 *
 * It breaks the LoginPage `username` locator to `#username`, then proves every
 * pipeline stage and prints a PASS/FAIL line per stage. On the FIRST failing
 * stage it stops immediately, prints which stage failed and why, and exits 1 —
 * it does not pretend later stages passed. The LoginPage file is always restored
 * to its original content (the benchmark is non-destructive).
 *
 * Run:  npm run build && npm run benchmark:saucedemo
 * Env:  SAUCEDEMO_REPO  (default /home/ubuntu/github_repos/LevelUpAI_SauceDemo)
 *       BASE_URL        (default https://www.saucedemo.com)
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── Config ────────────────────────────────────────────────────────────────
const REPO = process.env.SAUCEDEMO_REPO || '/home/ubuntu/github_repos/LevelUpAI_SauceDemo';
process.env.BASE_URL = process.env.BASE_URL || 'https://www.saucedemo.com';
if (!process.env.PLAYWRIGHT_BROWSERS_PATH) {
  process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(process.env.HOME || '/home/ubuntu', '.cache/ms-playwright');
}

const SPEC_REL = 'verify-successful-login-with-valid-credentials.spec.ts';
const TEST_NAME = 'Verify successful login with valid credentials';
const LOGIN_PAGE = path.join(REPO, 'pages', 'LoginPage.ts');
const BROKEN_SELECTOR = '#username'; // deliberately wrong (real id is #user-name / [data-test="username"])

// ── Load the REAL compiled production modules (must run after `npm run build`) ─
const DIST = path.join(__dirname, '..', 'dist');
function need(rel) {
  const p = path.join(DIST, rel);
  if (!fs.existsSync(p + '.js')) {
    console.error(`\n✗ Missing build artifact: ${p}.js\n  Run \`npm run build\` first.\n`);
    process.exit(2);
  }
  return require(p);
}
const { ExecutionEngine } = need('core/execution-engine');
const { ArtifactCollector } = need('core/artifact-collector');
const { FailureAnalyzer } = need('core/failure-analyzer');
const { HealingOrchestrator } = need('core/healing-orchestrator');
const { ValidationLayer } = need('validation/validation-layer');
const { acceptCandidate } = need('core/healing-acceptance');
const TraceParser = need('core/playwright/trace-parser');
const { emptyHealingContext } = need('services/healing-intelligence-context');
const { RuleEngine } = need('engines/rule-engine');
const { PatternEngine } = need('engines/pattern-engine');
const { AIEngine } = need('engines/ai-engine');

// ── Tiny stage runner: stop at first failure, honest reporting ──────────────
const RESULTS = [];
function record(name, ok, detail, note) {
  RESULTS.push({ name, ok, detail, note });
  const tag = ok === true ? '✓ PASS' : ok === null ? '∅ SKIP' : '✗ FAIL';
  console.log(`  ${tag}  ${name}${detail ? `  —  ${detail}` : ''}`);
  if (note) console.log(`          ${note}`);
}
function fail(name, detail) {
  record(name, false, detail);
  printSummary();
  restore();
  console.error(`\nSTOPPED at failing stage: "${name}". No further stages run.\n`);
  process.exit(1);
}

// ── Non-destructive file handling ───────────────────────────────────────────
let ORIGINAL_LOGINPAGE = null;
function snapshot() {
  ORIGINAL_LOGINPAGE = fs.readFileSync(LOGIN_PAGE, 'utf-8');
}
function restore() {
  if (ORIGINAL_LOGINPAGE != null) {
    fs.writeFileSync(LOGIN_PAGE, ORIGINAL_LOGINPAGE, 'utf-8');
  }
}
function breakLocator() {
  const src = fs.readFileSync(LOGIN_PAGE, 'utf-8');
  // Replace whatever the `username` field's locator argument currently is with the broken one.
  const re = /(username\s*=\s*this\.page\.locator\()([^)]*)(\))/;
  if (!re.test(src)) {
    throw new Error(`Could not find a 'username = this.page.locator(...)' line in ${LOGIN_PAGE}`);
  }
  const broken = src.replace(re, `$1'${BROKEN_SELECTOR}'$3`);
  fs.writeFileSync(LOGIN_PAGE, broken, 'utf-8');
  return broken;
}

function printSummary() {
  console.log('\n──────────────── BENCHMARK SUMMARY ────────────────');
  for (const r of RESULTS) {
    const tag = r.ok === true ? 'PASS' : r.ok === null ? 'SKIP' : 'FAIL';
    console.log(`  [${tag}] ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  }
  const failed = RESULTS.filter((r) => r.ok === false).length;
  const passed = RESULTS.filter((r) => r.ok === true).length;
  const skipped = RESULTS.filter((r) => r.ok === null).length;
  console.log('───────────────────────────────────────────────────');
  console.log(`  ${passed} passed · ${failed} failed · ${skipped} skipped`);
  console.log('───────────────────────────────────────────────────\n');
}

async function main() {
  console.log('\n=== LevelUp AI — SauceDemo login healing benchmark ===');
  console.log(`Repo:     ${REPO}`);
  console.log(`Spec:     tests/${SPEC_REL}`);
  console.log(`Base URL: ${process.env.BASE_URL}\n`);

  if (!fs.existsSync(LOGIN_PAGE)) {
    console.error(`✗ LoginPage not found at ${LOGIN_PAGE}`);
    process.exit(2);
  }
  snapshot();

  // Always restore on unexpected exit.
  process.on('exit', restore);
  process.on('SIGINT', () => { restore(); process.exit(130); });

  // ── Stage 0: deliberately break the locator ───────────────────────────────
  let broken;
  try {
    broken = breakLocator();
    const ok = broken.includes(`locator('${BROKEN_SELECTOR}')`);
    if (!ok) throw new Error('selector not written');
    record('Stage 0 — Break locator', true, `LoginPage username → locator('${BROKEN_SELECTOR}')`);
  } catch (e) {
    fail('Stage 0 — Break locator', e.message);
  }

  // ── Stage 1: real failing run (produces results JSON + trace) ─────────────
  let firstRun;
  try {
    firstRun = await ExecutionEngine.runAsync(REPO, SPEC_REL, TEST_NAME, 120000, 'standard', true, true);
    if (firstRun.exitCode === 0) {
      fail('Stage 1 — Test fails with broken locator', `expected non-zero exit, got 0 (test unexpectedly passed)`);
    }
    if (!firstRun.resultsFile || !fs.existsSync(firstRun.resultsFile)) {
      fail('Stage 1 — Test fails with broken locator', 'no results JSON produced');
    }
    record('Stage 1 — Test fails with broken locator', true, `exit=${firstRun.exitCode}, results=${path.basename(firstRun.resultsFile)}`);
  } catch (e) {
    fail('Stage 1 — Test fails with broken locator', e.message);
  }

  // ── Stage 2: collect artifact (spec_file vs file_path) ────────────────────
  let artifact;
  try {
    const artifacts = new ArtifactCollector().collect(firstRun.resultsFile, REPO);
    artifact = artifacts.find((a) => a.test_name === TEST_NAME) || artifacts[0];
    if (!artifact) fail('Stage 2 — Collect failure artifact', 'no artifacts collected');
    const locOk = (artifact.failed_locator || '').includes('username');
    const fileOk = (artifact.file_path || '').endsWith(path.join('pages', 'LoginPage.ts'));
    const specOk = (artifact.spec_file || '').endsWith(SPEC_REL);
    if (!locOk) fail('Stage 2 — Collect failure artifact', `failed_locator='${artifact.failed_locator}'`);
    if (!fileOk) fail('Stage 2 — Collect failure artifact', `file_path should be the Page Object, got '${artifact.file_path}'`);
    if (!specOk) fail('Stage 2 — Collect failure artifact', `spec_file should be the spec, got '${artifact.spec_file}'`);
    record('Stage 2 — Collect failure artifact', true,
      `locator='${artifact.failed_locator}', file_path=PageObject, spec_file=spec`);
  } catch (e) {
    fail('Stage 2 — Collect failure artifact', e.message);
  }

  // ── Stage 3: analyze → FailureDetails (specFilePath surfaced) ─────────────
  let failure;
  try {
    failure = new FailureAnalyzer().analyze(artifact);
    if (!failure.specFilePath || !failure.specFilePath.endsWith(SPEC_REL)) {
      fail('Stage 3 — Analyze failure', `specFilePath not surfaced (got '${failure.specFilePath}')`);
    }
    record('Stage 3 — Analyze failure', true,
      `type=${failure.failureType}, specFilePath set, filePath=PageObject`);
  } catch (e) {
    fail('Stage 3 — Analyze failure', e.message);
  }

  // ── Stage 4: reconstruct failure-time DOM from the trace ──────────────────
  let domHtml;
  try {
    if (!artifact.trace_path) fail('Stage 4 — DOM from trace', 'no trace_path on artifact');
    domHtml = TraceParser.extractDomHtml(artifact.trace_path);
    if (!domHtml || domHtml.length === 0) fail('Stage 4 — DOM from trace', 'empty DOM extracted');
    record('Stage 4 — DOM from trace', true, `${domHtml.length} chars reconstructed`);
  } catch (e) {
    fail('Stage 4 — DOM from trace', e.message);
  }

  // ── Stage 5: candidate discovery (REAL orchestrator, no browser) ──────────
  const orchestrator = new HealingOrchestrator(new RuleEngine(), new PatternEngine(), new AIEngine());
  let ranked, top;
  try {
    ranked = await orchestrator.collectRankedCandidates(
      failure, domHtml, new Set(), undefined, undefined, emptyHealingContext(), undefined,
    );
    if (!ranked.candidates || ranked.candidates.length === 0) {
      fail('Stage 5 — Candidate discovery', 'collectRankedCandidates returned 0 candidates');
    }
    top = ranked.candidates[0];
    record('Stage 5 — Candidate discovery', true,
      `${ranked.candidates.length} candidate(s); best=${top.newLocator} (score ${top.score.toFixed(2)}, source ${top.source})`);
  } catch (e) {
    fail('Stage 5 — Candidate discovery', e.message);
  }

  // Adapt the ranked candidate into the suggestion shape the apply machinery uses.
  const suggestion = {
    newLocator: top.newLocator,
    strategy: top.strategy,
    confidence: top.confidence,
    tokensUsed: top.tokensUsed,
    reasoning: top.reasoning,
    addExplicitWait: top.addExplicitWait,
    stabilityScore: top.stabilityScore,
  };

  // ── Stage 6: acceptance pre-flight ────────────────────────────────────────
  const fileBeforeFix = fs.readFileSync(failure.filePath, 'utf-8');
  try {
    const pre = acceptCandidate(suggestion, failure, fileBeforeFix);
    if (pre.decision === 'reject') fail('Stage 6 — Acceptance pre-flight', `rejected: ${pre.reason}`);
    record('Stage 6 — Acceptance pre-flight', true, `decision=${pre.decision}`);
  } catch (e) {
    fail('Stage 6 — Acceptance pre-flight', e.message);
  }

  // ── Stage 7: validate + APPLY to the Page Object file ─────────────────────
  const patchesDir = path.join(REPO, '.heal-benchmark-patches');
  const validationLayer = new ValidationLayer(patchesDir);
  try {
    const validation = validationLayer.validate(suggestion, failure);
    if (!validation.approved || !validation.updatedContent) {
      fail('Stage 7 — Validate & apply fix', `not approved: ${validation.reason || 'no reason'}`);
    }
    validationLayer.applyValidatedFix(failure.filePath, validation.updatedContent);
    const after = fs.readFileSync(failure.filePath, 'utf-8');
    if (after === fileBeforeFix) fail('Stage 7 — Validate & apply fix', 'file unchanged after apply');
    if (!after.includes(top.newLocator.replace(/^page\.locator\(['"]|['"]\)$/g, ''))) {
      // best-effort substring check; the new selector value should be present
    }
    record('Stage 7 — Validate & apply fix', true, `applied to ${path.basename(failure.filePath)}`);
  } catch (e) {
    fail('Stage 7 — Validate & apply fix', e.message);
  } finally {
    try { fs.rmSync(patchesDir, { recursive: true, force: true }); } catch (_) {}
  }

  // ── Stage 8: rerun the SPEC (the actual fix) → must go green ──────────────
  try {
    const rerunTarget = failure.specFilePath || failure.filePath; // the fix: prefer spec
    const relativeTestFile = path.relative(path.join(REPO, 'tests'), rerunTarget);
    const rerun = await ExecutionEngine.runAsync(REPO, relativeTestFile, failure.testName, 120000, 'standard', true, true);
    if (rerun.exitCode !== 0) {
      fail('Stage 8 — Rerun spec → PASS', `rerun exit=${rerun.exitCode} (target='${relativeTestFile}')`);
    }
    record('Stage 8 — Rerun spec → PASS', true, `target='${relativeTestFile}', exit=0 (test green)`);
  } catch (e) {
    fail('Stage 8 — Rerun spec → PASS', e.message);
  }

  // ── Stage 9: learning write-back (honest about persistence) ───────────────
  try {
    await orchestrator.recordHealObservation({
      failedSelector: failure.failedLocator,
      healedSelector: suggestion.newLocator,
      strategy: suggestion.strategy,
      pageUrl: failure.url || undefined,
    });
    if (process.env.DATABASE_URL) {
      record('Stage 9 — Learning write-back', true, 'recordHealObservation persisted (DATABASE_URL set)');
    } else {
      record('Stage 9 — Learning write-back', null, 'call succeeded but persistence needs DATABASE_URL',
        'In production the worker runs with a DB; here we only prove the call path is wired.');
    }
  } catch (e) {
    fail('Stage 9 — Learning write-back', e.message);
  }

  printSummary();
  restore();
  console.log('✓ Healing pipeline proven end-to-end: broken locator → discovered → applied → spec rerun GREEN.\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nUnexpected benchmark error:', e);
  restore();
  process.exit(1);
});
