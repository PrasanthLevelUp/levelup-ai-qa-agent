/**
 * Demo Heal Pipeline — the SHORTEST, deterministic end-to-end happy path.
 * ======================================================================
 *
 * This is a deliberately LINEAR healing path for the LevelUpAI_SauceDemo repo
 * (and any Page-Object-Model repo shaped like it). It exists so we have ONE
 * reliable end-to-end flow that fixes a broken login locator, with **all
 * optional routing and heuristics disabled**:
 *
 *   • NO strategy router          (healing-strategy-router.ts)
 *   • NO advisor waterfall         (advisors/*)
 *   • NO AI / OpenAI suggestions   (ai/openai-client.ts)
 *   • NO classifier branching      (failure-classifier framework/scope gates)
 *   • NO learned-pattern / DOM-memory / similarity layers
 *
 * The flow is exactly the seven steps requested:
 *
 *   1. Run the broken test                              → ExecutionEngine
 *   2. Parse the Playwright failure                     → ArtifactCollector + FailureAnalyzer
 *   3. Resolve the Page Object using Repo Intelligence  → classifyFailureFile + resolvePageObjectLocator
 *   4. Get grounded selectors from the App Profile      → live crawl → buildGroundedCandidates
 *   5. Replace the locator                              → surgical source edit (with backup)
 *   6. Re-run the test                                  → ExecutionEngine (grep by test name)
 *   7. Report success or failure                        → DemoHealResult
 *
 * Each step is explicit, logged, and SHORT-CIRCUITS on the first thing that does
 * not hold. There are no silent fallbacks: if a step cannot produce what the
 * next step needs, the pipeline stops and reports exactly where and why. That is
 * the point — a single, debuggable happy path we can optimize edge cases around
 * later.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import { ExecutionEngine } from './execution-engine';
import { ArtifactCollector, type ArtifactCollection } from './artifact-collector';
import { FailureAnalyzer, type FailureDetails } from './failure-analyzer';
import { resolvePageObjectLocator, type PageObjectResolution } from './page-object-resolver';
import { classifyFailureFile, type PageObjectClassification } from '../services/repo-intelligence-healing';
import {
  collectElements,
  bestElementMatch,
  buildGroundedCandidates,
  deriveElementDescription,
  type AppProfileCandidate,
} from '../services/app-profile-healing';
import { PageCrawler } from '../script-gen/page-crawler';

const MOD = 'demo-heal-pipeline';

/** Per-test rerun timeout for the demo path (kept tight; deterministic app). */
const DEMO_RUN_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DemoHealOptions {
  /** Absolute path to the cloned repo under test (e.g. the SauceDemo repo). */
  repoPath: string;
  /**
   * The application's base URL — the page the App Profile step crawls to ground
   * selectors against real DOM. For SauceDemo: `https://www.saucedemo.com`.
   * Defaults to `process.env.BASE_URL` when omitted.
   */
  baseUrl?: string;
  /**
   * Optional single spec file to run for step 1 (repo-relative or absolute).
   * When omitted, the whole `testDir` is run and the FIRST failing test is healed.
   */
  testFile?: string;
  /** Optional rerun timeout override (ms). */
  timeoutMs?: number;
}

export type StepStatus = 'ok' | 'failed' | 'skipped';

export interface StepResult {
  step: number;
  name: string;
  status: StepStatus;
  detail: string;
  data?: Record<string, unknown>;
}

export interface DemoHealResult {
  /** True only when the fix was applied AND the rerun passed (step 6 green). */
  healed: boolean;
  /** The seven-step trail, in order. */
  steps: StepResult[];
  /** Convenience summary fields (present once known). */
  testName?: string;
  pageObjectFile?: string;
  specFile?: string;
  brokenLocator?: string;
  groundedLocator?: string;
  /** Final human-readable outcome line. */
  summary: string;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run the deterministic seven-step demo heal. Never throws — any unexpected
 * error is captured as a failed step so the caller always gets a structured
 * trail back.
 */
export async function runDemoHealPipeline(opts: DemoHealOptions): Promise<DemoHealResult> {
  const steps: StepResult[] = [];
  const push = (s: StepResult): StepResult => {
    steps.push(s);
    const line = `[step ${s.step}/${s.name}] ${s.status.toUpperCase()} — ${s.detail}`;
    if (s.status === 'failed') logger.warn(MOD, line, s.data ?? {});
    else logger.info(MOD, line, s.data ?? {});
    return s;
  };
  const stop = (summary: string): DemoHealResult => ({ healed: false, steps, summary });

  const repoPath = path.resolve(opts.repoPath);
  const baseUrl = opts.baseUrl ?? process.env['BASE_URL'] ?? '';
  const timeoutMs = opts.timeoutMs ?? DEMO_RUN_TIMEOUT_MS;

  if (!fs.existsSync(repoPath)) {
    push({ step: 0, name: 'preflight', status: 'failed', detail: `repoPath does not exist: ${repoPath}` });
    return stop(`Repo path not found: ${repoPath}`);
  }

  // ── STEP 1 — Run the broken test ─────────────────────────────────────────
  let run1;
  try {
    run1 = await ExecutionEngine.runAsync(
      repoPath,
      opts.testFile,
      undefined,        // no grep — run the spec/dir as-is
      timeoutMs,
      'standard',
      true,             // collect healing artifacts (trace) so URL/locator are grounded
      false,
    );
  } catch (err: any) {
    push({ step: 1, name: 'run-broken-test', status: 'failed', detail: `runner threw: ${err?.message}` });
    return stop('Could not execute the test runner.');
  }
  push({
    step: 1,
    name: 'run-broken-test',
    status: run1.exitCode === 0 ? 'failed' : 'ok',
    detail:
      run1.exitCode === 0
        ? 'Test passed on first run — nothing to heal (expected a failing locator).'
        : `Test failed as expected (exit ${run1.exitCode}, ${run1.durationMs}ms).`,
    data: { exitCode: run1.exitCode, resultsFile: run1.resultsFile },
  });
  if (run1.exitCode === 0) {
    return stop('Nothing to heal — the test already passes.');
  }

  // ── STEP 2 — Parse the Playwright failure ────────────────────────────────
  let failure: FailureDetails;
  try {
    const artifacts: ArtifactCollection[] = new ArtifactCollector().collect(run1.resultsFile, repoPath);
    if (!artifacts.length) {
      push({ step: 2, name: 'parse-failure', status: 'failed', detail: 'No failure artifacts parsed from test-results.json.' });
      return stop('Could not parse any failure from the Playwright report.');
    }
    failure = new FailureAnalyzer().analyze(artifacts[0]);
  } catch (err: any) {
    push({ step: 2, name: 'parse-failure', status: 'failed', detail: `parse threw: ${err?.message}` });
    return stop('Failed to parse the Playwright failure.');
  }
  const absFailFile = path.isAbsolute(failure.filePath) ? failure.filePath : path.join(repoPath, failure.filePath);
  push({
    step: 2,
    name: 'parse-failure',
    status: failure.filePath && failure.failedLineCode ? 'ok' : 'failed',
    detail: `${failure.testName} → ${failure.filePath}:${failure.lineNumber} | line: ${truncate(failure.failedLineCode, 80)}`,
    data: {
      testName: failure.testName,
      failureType: failure.failureType,
      filePath: failure.filePath,
      lineNumber: failure.lineNumber,
      failedLineCode: failure.failedLineCode,
      specFilePath: failure.specFilePath ?? null,
      url: failure.url,
    },
  });
  if (!failure.filePath || !failure.failedLineCode) {
    return stop('Parsed failure is missing the source file or failing line — cannot resolve a Page Object.');
  }

  // ── STEP 3 — Resolve the Page Object using Repo Intelligence ─────────────
  // (a) Confirm the failing file IS a Page Object (Repo Intelligence classifier).
  // (b) Resolve the concrete locator the failing field points at.
  let classification: PageObjectClassification;
  try {
    classification = await classifyFailureFile({
      filePath: failure.filePath,
      brokenLocator: failure.failedLineCode,
      absolutePath: absFailFile,
    });
  } catch (err: any) {
    push({ step: 3, name: 'resolve-page-object', status: 'failed', detail: `classifier threw: ${err?.message}` });
    return stop('Repo Intelligence classification failed.');
  }
  if (!classification.isPageObject) {
    push({
      step: 3,
      name: 'resolve-page-object',
      status: 'failed',
      detail: `Failing file is not a Page Object (source=${classification.source}). Demo path only heals POM locator failures.`,
    });
    return stop('Failing file is not a Page Object — outside the demo happy path.');
  }

  let poSource: string;
  try {
    poSource = fs.readFileSync(absFailFile, 'utf-8');
  } catch (err: any) {
    push({ step: 3, name: 'resolve-page-object', status: 'failed', detail: `cannot read Page Object source: ${err?.message}` });
    return stop('Could not read the Page Object source file.');
  }
  const resolution: PageObjectResolution | null = resolvePageObjectLocator(failure.failedLineCode, poSource);
  if (!resolution) {
    push({
      step: 3,
      name: 'resolve-page-object',
      status: 'failed',
      detail: `Could not resolve a field→locator on the failing line inside ${classification.className ?? 'the Page Object'}.`,
    });
    return stop('Page Object field reference could not be resolved to a concrete locator.');
  }
  push({
    step: 3,
    name: 'resolve-page-object',
    status: 'ok',
    detail:
      `Repo Intelligence: ${classification.reasoning}. ` +
      `Field "${resolution.fieldName}" → ${resolution.locatorExpression} (current locator: ${resolution.resolvedLocator}).`,
    data: {
      className: classification.className,
      classifierSource: classification.source,
      fieldName: resolution.fieldName,
      builder: resolution.builder,
      currentLocator: resolution.resolvedLocator,
      locatorExpression: resolution.locatorExpression,
    },
  });

  // The concrete broken locator drives the App Profile description match.
  failure.failedLocator = resolution.resolvedLocator;

  // ── STEP 4 — Get grounded selectors from the App Profile ─────────────────
  // The App Profile is a crawl of the real app. For a self-contained, reliable
  // demo we crawl the live baseUrl now and ground candidates against that real
  // DOM (same primitives the stored App Profile uses). No invented selectors.
  if (!baseUrl) {
    push({ step: 4, name: 'app-profile-grounding', status: 'failed', detail: 'No baseUrl/BASE_URL to crawl for grounded selectors.' });
    return stop('App Profile step needs a baseUrl (set opts.baseUrl or BASE_URL).');
  }
  let grounded: AppProfileCandidate | null = null;
  let description = '';
  let elementsScanned = 0;
  try {
    const crawler = new PageCrawler({ url: baseUrl, maxDepth: 1, captureScreenshot: false, followLinks: false });
    const crawl = await crawler.crawl();
    const elements = collectElements(crawl as unknown as Record<string, unknown>);
    elementsScanned = elements.length;
    description = deriveElementDescription(failure);
    const match = bestElementMatch(elements, description);
    if (match) {
      const candidates = buildGroundedCandidates(match.el, description);
      grounded = candidates[0] ?? null;
    }
  } catch (err: any) {
    push({ step: 4, name: 'app-profile-grounding', status: 'failed', detail: `crawl/grounding threw: ${err?.message}` });
    return stop('App Profile grounding failed during crawl.');
  }
  if (!grounded) {
    push({
      step: 4,
      name: 'app-profile-grounding',
      status: 'failed',
      detail: `No grounded selector found for "${description}" (scanned ${elementsScanned} crawled elements).`,
    });
    return stop('App Profile produced no grounded selector for the failing element.');
  }
  push({
    step: 4,
    name: 'app-profile-grounding',
    status: 'ok',
    detail: `Grounded "${description}" → ${grounded.locator} (conf ${grounded.confidence.toFixed(2)}). ${grounded.reasoning}`,
    data: { description, elementsScanned, groundedLocator: grounded.locator, confidence: grounded.confidence },
  });

  // ── STEP 5 — Replace the locator ─────────────────────────────────────────
  // Swap ONLY the builder expression on the field's assignment line, preserving
  // its receiver (`this.page.` / `page.`). Grounded candidates are always
  // `page.<builder>(...)`; strip the leading `page.` to get the builder call.
  const newBuilderCall = grounded.locator.replace(/^\s*page\s*\.\s*/, '');
  const oldBuilderCall = resolution.locatorExpression; // e.g. locator('#username')
  if (!poSource.includes(oldBuilderCall)) {
    push({
      step: 5,
      name: 'replace-locator',
      status: 'failed',
      detail: `Could not locate the exact expression "${oldBuilderCall}" in the Page Object source to replace.`,
    });
    return stop('Locator replacement target not found in source (no edit made).');
  }
  const backupPath = `${absFailFile}.demoheal.bak`;
  let updatedSource: string;
  try {
    fs.writeFileSync(backupPath, poSource, 'utf-8'); // backup for safe revert
    updatedSource = replaceFirst(poSource, oldBuilderCall, newBuilderCall);
    fs.writeFileSync(absFailFile, updatedSource, 'utf-8');
  } catch (err: any) {
    push({ step: 5, name: 'replace-locator', status: 'failed', detail: `write failed: ${err?.message}` });
    return stop('Failed to write the locator fix to disk.');
  }
  push({
    step: 5,
    name: 'replace-locator',
    status: 'ok',
    detail: `${path.basename(absFailFile)}: ${oldBuilderCall} → ${newBuilderCall} (field "${resolution.fieldName}").`,
    data: { file: absFailFile, from: oldBuilderCall, to: newBuilderCall, backupPath },
  });

  // ── STEP 6 — Re-run the test (isolated by test name) ─────────────────────
  let run2;
  try {
    run2 = await ExecutionEngine.runAsync(
      repoPath,
      opts.testFile,
      failure.testName,   // grep — rerun ONLY this test
      timeoutMs,
      'standard',
      false,
      true,               // healing run
    );
  } catch (err: any) {
    revert(absFailFile, backupPath);
    push({ step: 6, name: 'rerun-test', status: 'failed', detail: `rerun threw (fix reverted): ${err?.message}` });
    return stop('Rerun could not be executed; fix reverted.');
  }
  const passed = run2.exitCode === 0;
  push({
    step: 6,
    name: 'rerun-test',
    status: passed ? 'ok' : 'failed',
    detail: passed
      ? `Rerun PASSED (exit 0, ${run2.durationMs}ms) — locator fix holds.`
      : `Rerun still failing (exit ${run2.exitCode}, ${run2.durationMs}ms).`,
    data: { exitCode: run2.exitCode },
  });

  // ── STEP 7 — Report success or failure ───────────────────────────────────
  if (!passed) {
    revert(absFailFile, backupPath);
    push({ step: 7, name: 'report', status: 'failed', detail: 'Fix did not make the test pass — reverted to keep the repo clean.' });
    return {
      healed: false,
      steps,
      testName: failure.testName,
      pageObjectFile: failure.filePath,
      specFile: failure.specFilePath ?? opts.testFile,
      brokenLocator: resolution.resolvedLocator,
      groundedLocator: grounded.locator,
      summary: `❌ Could not heal "${failure.testName}". Grounded ${grounded.locator} did not pass; reverted.`,
    };
  }
  // Success — keep the fix, drop the backup.
  try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
  push({ step: 7, name: 'report', status: 'ok', detail: 'Locator healed and verified green. Fix kept.' });
  return {
    healed: true,
    steps,
    testName: failure.testName,
    pageObjectFile: failure.filePath,
    specFile: failure.specFilePath ?? opts.testFile,
    brokenLocator: resolution.resolvedLocator,
    groundedLocator: grounded.locator,
    summary:
      `✅ Healed "${failure.testName}": ${resolution.fieldName} ` +
      `${oldBuilderCall} → ${newBuilderCall} (grounded from App Profile crawl) and rerun passed.`,
  };
}

// ---------------------------------------------------------------------------
// Small helpers (local, dependency-free)
// ---------------------------------------------------------------------------

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const i = haystack.indexOf(needle);
  if (i < 0) return haystack;
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
}

function revert(file: string, backupPath: string): void {
  try {
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, file);
      fs.unlinkSync(backupPath);
    }
  } catch (err: any) {
    logger.warn(MOD, 'revert failed', { file, error: err?.message });
  }
}

function truncate(s: string | null | undefined, n: number): string {
  const v = (s ?? '').trim();
  return v.length > n ? `${v.slice(0, n)}…` : v;
}
