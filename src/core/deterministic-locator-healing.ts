/**
 * Deterministic Locator Healing
 * =============================
 * The FIRST, grounded, zero-AI strategy inside LevelUp's single healing system.
 *
 * Product promise this implements:
 *
 *   "If Repo Intelligence understands your code and the Application Profile
 *    understands your app, LevelUp AI can DETERMINISTICALLY heal a broken
 *    locator — before falling back to more advanced intelligence."
 *
 * It is NOT a second healing engine. It is a reusable strategy with two layers:
 *
 *   1. `resolveDeterministicLocator()` — the pure STRATEGY CORE (no test runs).
 *      Given a parsed failure + an Application Profile, it:
 *        • confirms the failing file is a Page Object (Repo Intelligence), and
 *        • resolves the field reference on the failing line to its concrete
 *          locator expression, and
 *        • picks the best GROUNDED selector from the Application Profile.
 *      Returns a ready-to-apply replacement, or an explicit reason it cannot
 *      (so the caller can fall back to the intelligent pipeline).
 *      The healing worker calls THIS as its first strategy.
 *
 *   2. `DeterministicLocatorHealingPipeline` — a thin, self-contained runner
 *      (run → parse → resolve → replace → rerun → report) used by the CLI and
 *      tests to exercise the core end-to-end on a repo.
 *
 * TWO HARD ARCHITECTURAL RULES (by design):
 *   • PROFILE-ONLY. This module NEVER crawls during healing. It consumes an
 *     EXISTING Application Profile (crawl_data). If none exists, it STOPS and
 *     says "crawl this application first" — it does not silently crawl, because
 *     production apps may have auth/MFA/staging/rate-limits.
 *   • ONE SYSTEM. The core is the front strategy of the existing worker; when it
 *     cannot resolve, control falls through to the existing intelligent pipeline.
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
} from '../services/app-profile-healing';

const MOD = 'deterministic-locator-healing';

const DEFAULT_RUN_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------
// Strategy-core types
// ---------------------------------------------------------------------------

/**
 * The Application Profile evidence the strategy consumes. This is a STRUCTURAL
 * subset of `AppProfileHealingInput` (what the worker already builds from the
 * DB via `buildAppProfileHealingInput`), so the worker can pass its existing
 * object straight in — no live crawl, no new lookup.
 */
export interface AppProfileEvidence {
  /** Whether an Application Profile actually exists for this app/page. */
  profileFound: boolean;
  /** Grounded candidate locators built from real crawled DOM (best first). */
  candidates: Array<{ locator: string; confidence: number; reasoning: string }>;
  /** Human-readable reason when there are no candidates (observability). */
  reason?: string;
  /** Element description the profile matched against (observability). */
  description?: string;
}

/** Why the deterministic strategy could not produce a fix (for fall-through). */
export type DeterministicSkipStage =
  | 'not_page_object'   // Repo Intelligence: failing file is not a Page Object
  | 'unresolved_field'  // could not resolve the field → concrete locator
  | 'no_profile'        // no Application Profile exists → CRAWL FIRST
  | 'no_grounded_selector'; // profile exists but no grounded match for this element

export type DeterministicResolution =
  | {
      ok: true;
      /** Page Object class name, when known. */
      pageObjectClass: string | null;
      /** The field whose locator is being replaced, e.g. `username`. */
      fieldName: string;
      /** The current (broken) locator string, e.g. `#username`. */
      currentLocator: string;
      /** The exact builder expression to replace, e.g. `locator('#username')`. */
      oldExpression: string;
      /** The grounded builder call to write in, e.g. `locator('[data-test="username"]')`. */
      newExpression: string;
      /** Full grounded locator as the App Profile expressed it, e.g. `page.locator('[data-test="username"]')`. */
      groundedLocator: string;
      /** Grounded candidate confidence (0..1). */
      confidence: number;
      /** Human-readable explanation (Repo Intelligence + App Profile). */
      reasoning: string;
    }
  | {
      ok: false;
      stage: DeterministicSkipStage;
      reason: string;
      /** True only for `no_profile` — signals the app must be crawled first. */
      needsCrawl?: boolean;
    };

// ---------------------------------------------------------------------------
// Strategy core (pure resolution — NO test execution, NO crawl)
// ---------------------------------------------------------------------------

/**
 * The deterministic strategy: can we heal this failure from Repo Intelligence +
 * the EXISTING Application Profile alone? Pure and side-effect-free except for
 * reading the Page Object source from disk. Never throws.
 *
 * @param failure   Parsed failure (filePath = the Page Object, failedLineCode = the failing line).
 * @param repoPath  Absolute repo root (to resolve a repo-relative failure.filePath).
 * @param profile   EXISTING Application Profile evidence (already built; never crawled here).
 */
export async function resolveDeterministicLocator(
  failure: Pick<FailureDetails, 'filePath' | 'failedLineCode' | 'failedLocator'>,
  repoPath: string,
  profile: AppProfileEvidence,
): Promise<DeterministicResolution> {
  // Guard: we need a profile to ground against. NEVER crawl here — say so.
  if (!profile || !profile.profileFound) {
    return {
      ok: false,
      stage: 'no_profile',
      needsCrawl: true,
      reason:
        'No Application Profile exists for this app — crawl it first. ' +
        'Deterministic healing consumes an existing profile and never crawls during healing.',
    };
  }

  const absFile = path.isAbsolute(failure.filePath)
    ? failure.filePath
    : path.join(repoPath, failure.filePath);

  // (1) Repo Intelligence — is the failing file a Page Object?
  let classification: PageObjectClassification;
  try {
    classification = await classifyFailureFile({
      filePath: failure.filePath,
      brokenLocator: failure.failedLineCode ?? undefined,
      absolutePath: absFile,
    });
  } catch (err: any) {
    return { ok: false, stage: 'not_page_object', reason: `Repo Intelligence classification failed: ${err?.message}` };
  }
  if (!classification.isPageObject) {
    return {
      ok: false,
      stage: 'not_page_object',
      reason: `Repo Intelligence: failing file is not a Page Object (source=${classification.source}).`,
    };
  }

  // (2) Resolve the field reference on the failing line → concrete locator.
  let poSource: string;
  try {
    poSource = fs.readFileSync(absFile, 'utf-8');
  } catch (err: any) {
    return { ok: false, stage: 'unresolved_field', reason: `Cannot read Page Object source: ${err?.message}` };
  }
  const resolution: PageObjectResolution | null = resolvePageObjectLocator(failure.failedLineCode ?? '', poSource);
  if (!resolution) {
    return {
      ok: false,
      stage: 'unresolved_field',
      reason: `Could not resolve a field→locator on the failing line inside ${classification.className ?? 'the Page Object'}.`,
    };
  }

  // (3) Pick the best GROUNDED selector from the existing Application Profile.
  const top = profile.candidates?.[0];
  if (!top) {
    return {
      ok: false,
      stage: 'no_grounded_selector',
      reason:
        profile.reason ??
        `Application Profile exists but produced no grounded selector for "${profile.description ?? resolution.resolvedLocator}".`,
    };
  }

  // The grounded candidate is always `page.<builder>(...)`. Replace ONLY the
  // builder expression on the field's assignment line, preserving its receiver
  // (`this.page.` / `page.`), so we never disturb surrounding code.
  const newExpression = top.locator.replace(/^\s*page\s*\.\s*/, '');

  return {
    ok: true,
    pageObjectClass: classification.className ?? null,
    fieldName: resolution.fieldName,
    currentLocator: resolution.resolvedLocator,
    oldExpression: resolution.locatorExpression,
    newExpression,
    groundedLocator: top.locator,
    confidence: top.confidence,
    reasoning:
      `Repo Intelligence: ${classification.reasoning}. ` +
      `App Profile grounded "${resolution.fieldName}" → ${top.locator}. ${top.reasoning}`,
  };
}

/**
 * Ground a failure against an EXISTING Application Profile's `crawl_data`
 * (the stored crawl, NOT a live crawl). Pure. Used by the standalone pipeline /
 * CLI / tests to build `AppProfileEvidence` from a saved profile file, using the
 * exact same primitives the DB-backed profile path uses.
 */
export function groundFromProfileData(
  crawlData: unknown,
  failure: Pick<FailureDetails, 'failedLocator' | 'failedLineCode'>,
): AppProfileEvidence {
  const elements = collectElements(crawlData as Record<string, unknown>);
  const description = deriveElementDescription(failure);
  if (!elements.length) {
    return { profileFound: true, candidates: [], description, reason: 'Profile has no usable elements.' };
  }
  const match = bestElementMatch(elements, description);
  if (!match) {
    return {
      profileFound: true,
      candidates: [],
      description,
      reason: `No crawled element matched "${description}" (scanned ${elements.length}).`,
    };
  }
  const candidates = buildGroundedCandidates(match.el, description).map((c) => ({
    locator: c.locator,
    confidence: c.confidence,
    reasoning: c.reasoning,
  }));
  return { profileFound: true, candidates, description };
}

// ---------------------------------------------------------------------------
// Standalone pipeline (CLI/tests) — run → parse → resolve → replace → rerun → report
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  /** Absolute path to the repo under test. */
  repoPath: string;
  /**
   * Resolver for the EXISTING Application Profile evidence for a parsed failure.
   * Injected so the runner never crawls. The CLI builds one from a saved profile
   * file; the worker uses its DB-backed `buildAppProfileHealingInput` directly
   * (and calls `resolveDeterministicLocator`, not this runner).
   */
  appProfile: (failure: FailureDetails) => Promise<AppProfileEvidence>;
  /** Optional single spec to run; omit to run the whole suite. */
  testFile?: string;
  /** Optional per-run timeout (ms). */
  timeoutMs?: number;
}

export type StepStatus = 'ok' | 'failed' | 'skipped';

export interface StepResult {
  step: number;
  name: string;
  status: StepStatus;
  detail: string;
}

export interface PipelineResult {
  healed: boolean;
  steps: StepResult[];
  testName?: string;
  pageObjectFile?: string;
  brokenLocator?: string;
  groundedLocator?: string;
  /** Set when the run stopped because no Application Profile exists. */
  needsCrawl?: boolean;
  summary: string;
}

export class DeterministicLocatorHealingPipeline {
  async run(opts: PipelineOptions): Promise<PipelineResult> {
    const steps: StepResult[] = [];
    const push = (s: StepResult): StepResult => {
      steps.push(s);
      const line = `[step ${s.step}/${s.name}] ${s.status.toUpperCase()} — ${s.detail}`;
      if (s.status === 'failed') logger.warn(MOD, line);
      else logger.info(MOD, line);
      return s;
    };
    const stop = (summary: string, extra?: Partial<PipelineResult>): PipelineResult => ({
      healed: false,
      steps,
      summary,
      ...extra,
    });

    const repoPath = path.resolve(opts.repoPath);
    const timeoutMs = opts.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
    if (!fs.existsSync(repoPath)) {
      push({ step: 0, name: 'preflight', status: 'failed', detail: `repoPath does not exist: ${repoPath}` });
      return stop(`Repo path not found: ${repoPath}`);
    }

    // ── STEP 1 — Run the broken test ──────────────────────────────────────
    let run1;
    try {
      run1 = await ExecutionEngine.runAsync(repoPath, opts.testFile, undefined, timeoutMs, 'standard', true, false);
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
          ? 'Test passed on first run — nothing to heal.'
          : `Test failed as expected (exit ${run1.exitCode}, ${run1.durationMs}ms).`,
    });
    if (run1.exitCode === 0) return stop('Nothing to heal — the test already passes.');

    // ── STEP 2 — Parse the Playwright failure ─────────────────────────────
    let failure: FailureDetails;
    try {
      const artifacts: ArtifactCollection[] = new ArtifactCollector().collect(run1.resultsFile, repoPath);
      if (!artifacts.length) {
        push({ step: 2, name: 'parse-failure', status: 'failed', detail: 'No failure artifacts in test-results.json.' });
        return stop('Could not parse any failure from the Playwright report.');
      }
      failure = new FailureAnalyzer().analyze(artifacts[0]);
    } catch (err: any) {
      push({ step: 2, name: 'parse-failure', status: 'failed', detail: `parse threw: ${err?.message}` });
      return stop('Failed to parse the Playwright failure.');
    }
    push({
      step: 2,
      name: 'parse-failure',
      status: failure.filePath && failure.failedLineCode ? 'ok' : 'failed',
      detail: `${failure.testName} → ${failure.filePath}:${failure.lineNumber} | ${truncate(failure.failedLineCode, 70)}`,
    });
    if (!failure.filePath || !failure.failedLineCode) {
      return stop('Parsed failure is missing the source file or failing line.');
    }

    // ── STEP 3 — Application Profile (EXISTING; never crawled here) ────────
    let profile: AppProfileEvidence;
    try {
      profile = await opts.appProfile(failure);
    } catch (err: any) {
      push({ step: 3, name: 'app-profile', status: 'failed', detail: `profile resolver threw: ${err?.message}` });
      return stop('Application Profile lookup failed.');
    }
    if (!profile.profileFound) {
      push({
        step: 3,
        name: 'app-profile',
        status: 'failed',
        detail: 'No Application Profile for this app. Crawl it first — healing never crawls automatically.',
      });
      return stop('No Application Profile exists — please crawl this application first, then heal.', { needsCrawl: true });
    }
    push({ step: 3, name: 'app-profile', status: 'ok', detail: `Using existing profile (${profile.candidates.length} grounded candidate(s)).` });

    // ── STEP 4 — Resolve deterministically (Repo Intelligence + Profile) ──
    const resolution = await resolveDeterministicLocator(failure, repoPath, profile);
    if (!resolution.ok) {
      push({ step: 4, name: 'resolve', status: 'failed', detail: resolution.reason });
      return stop(`Deterministic strategy cannot heal: ${resolution.reason}`, { needsCrawl: resolution.needsCrawl });
    }
    push({
      step: 4,
      name: 'resolve',
      status: 'ok',
      detail: `${resolution.pageObjectClass ?? 'PageObject'}.${resolution.fieldName}: ${resolution.currentLocator} → ${resolution.groundedLocator} (conf ${resolution.confidence.toFixed(2)})`,
    });

    // ── STEP 5 — Replace the locator (surgical, with backup) ──────────────
    const absFile = path.isAbsolute(failure.filePath) ? failure.filePath : path.join(repoPath, failure.filePath);
    const backupPath = `${absFile}.dethealing.bak`;
    let poSource: string;
    try {
      poSource = fs.readFileSync(absFile, 'utf-8');
    } catch (err: any) {
      push({ step: 5, name: 'replace-locator', status: 'failed', detail: `cannot read source: ${err?.message}` });
      return stop('Could not read the Page Object source.');
    }
    if (!poSource.includes(resolution.oldExpression)) {
      push({ step: 5, name: 'replace-locator', status: 'failed', detail: `expression "${resolution.oldExpression}" not found.` });
      return stop('Locator replacement target not found in source (no edit made).');
    }
    try {
      fs.writeFileSync(backupPath, poSource, 'utf-8');
      fs.writeFileSync(absFile, replaceFirst(poSource, resolution.oldExpression, resolution.newExpression), 'utf-8');
    } catch (err: any) {
      push({ step: 5, name: 'replace-locator', status: 'failed', detail: `write failed: ${err?.message}` });
      return stop('Failed to write the locator fix.');
    }
    push({
      step: 5,
      name: 'replace-locator',
      status: 'ok',
      detail: `${path.basename(absFile)}: ${resolution.oldExpression} → ${resolution.newExpression}`,
    });

    // ── STEP 6 — Re-run the test (isolated by test name) ──────────────────
    let run2;
    try {
      run2 = await ExecutionEngine.runAsync(repoPath, opts.testFile, failure.testName, timeoutMs, 'standard', false, true);
    } catch (err: any) {
      revert(absFile, backupPath);
      push({ step: 6, name: 'rerun-test', status: 'failed', detail: `rerun threw (reverted): ${err?.message}` });
      return stop('Rerun could not be executed; fix reverted.');
    }
    const passed = run2.exitCode === 0;
    push({
      step: 6,
      name: 'rerun-test',
      status: passed ? 'ok' : 'failed',
      detail: passed ? `Rerun PASSED (exit 0, ${run2.durationMs}ms).` : `Rerun still failing (exit ${run2.exitCode}).`,
    });

    // ── STEP 7 — Report ───────────────────────────────────────────────────
    if (!passed) {
      revert(absFile, backupPath);
      push({ step: 7, name: 'report', status: 'failed', detail: 'Fix did not pass — reverted to keep the repo clean.' });
      return {
        healed: false,
        steps,
        testName: failure.testName,
        pageObjectFile: failure.filePath,
        brokenLocator: resolution.currentLocator,
        groundedLocator: resolution.groundedLocator,
        summary: `❌ Could not heal "${failure.testName}" deterministically; reverted (fall back to intelligent pipeline).`,
      };
    }
    try { fs.unlinkSync(backupPath); } catch { /* ignore */ }
    push({ step: 7, name: 'report', status: 'ok', detail: 'Healed and verified green. Fix kept.' });
    return {
      healed: true,
      steps,
      testName: failure.testName,
      pageObjectFile: failure.filePath,
      brokenLocator: resolution.currentLocator,
      groundedLocator: resolution.groundedLocator,
      summary: `✅ Deterministically healed "${failure.testName}": ${resolution.fieldName} ${resolution.oldExpression} → ${resolution.newExpression}.`,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
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
