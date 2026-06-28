/**
 * Execution Trust Assessment (the "INCONCLUSIVE" primitive)
 * --------------------------------------------------------
 * Core principle:
 *
 *   "Absence of a passing result is NOT the same as a failing test."
 *
 * The historical pipeline collapsed two very different facts into one:
 *   1. "the locator is still broken"          → a real healing signal, and
 *   2. "the run never produced a trustworthy result" → an environment fact.
 *
 * When Playwright crashes, the browser closes, the runner is OOM-killed, the
 * container restarts, xauth is missing, or the run simply times out before any
 * test reports, the engine produced NO verdict. Labelling that as `framework`
 * (and then `report_only`) — or worse, as a "locator that could not be healed" —
 * is dishonest. It deserves its own state: **INCONCLUSIVE** ("I don't know").
 *
 * This module is pure, deterministic and browser-free. It inspects the raw run
 * facts (exit code, whether a results file exists, whether any failure artifact
 * was parsed, whether spec-load errors were recorded) and decides whether the
 * run can be trusted to carry a test verdict. The worker uses this to:
 *   - retry an untrustworthy run ONCE, and
 *   - if still untrustworthy, finalize the outcome as `inconclusive` instead of
 *     `fail` / `framework`.
 */

/** Why a run could not be trusted to carry a test verdict. */
export type RunTrustSignal =
  | 'ok'                 // run is trustworthy (real pass or real failure artifact)
  | 'command_not_found'  // exit 127 — playwright/binary missing (e.g. xauth, bad PATH)
  | 'timeout_no_evidence'// exit 124 — killed at wall-clock with no per-test evidence
  | 'no_results_file'    // the reporter never wrote test-results.json
  | 'crashed_before_tests' // non-zero exit, no results / no artifacts — runner died early
  | 'spec_load_error'    // spec import / global-setup failed before any test ran
  | 'framework_crash_no_evidence'; // a Playwright/framework crash that never reached a verdict

export interface RunTrustInput {
  /** Process exit code of the run (0 = clean). */
  exitCode: number;
  /** True when at least one parseable FAILURE artifact was produced. */
  hasFailureArtifacts: boolean;
  /** True when the test-results.json reporter file exists on disk. */
  resultsFileExists: boolean;
  /**
   * Number of top-level spec-load / global-setup errors recorded by Playwright
   * (errors[] with an empty suites[]). These mean the test never ran.
   */
  loadErrorCount?: number;
  /**
   * True when the run's ONLY failure signal is a Playwright/framework-level
   * crash (browser launch failure, "target page/context/browser has been
   * closed/crashed", protocol error) that never reached a real element — i.e.
   * there is no failed locator and the run finished far faster than a single
   * element action timeout could elapse. Such a "crash artifact" is an
   * environment hiccup, NOT a test verdict: classifying it as a confident
   * `framework → report only` dead-end hides the genuine (locator) failure the
   * test would surface on a clean rerun. When true, the run is treated as
   * INCONCLUSIVE so the worker retries it once before deciding.
   */
  frameworkCrashWithoutVerdict?: boolean;
}

export interface RunTrustAssessment {
  /** True when the run can be trusted to carry a test verdict (pass OR fail). */
  trustworthy: boolean;
  /** Machine label for WHY the run is (un)trustworthy. */
  signal: RunTrustSignal;
  /** Human-readable explanation for the trail / UI. */
  reason: string;
  /**
   * True when the honest finalized outcome for this run is `inconclusive`
   * (untrustworthy AND no failure artifact to heal). Convenience for callers.
   */
  inconclusive: boolean;
}

/**
 * Assess whether a run produced a trustworthy verdict.
 *
 * A run is trustworthy when EITHER:
 *   - it exited cleanly (exit 0 → everything passed), OR
 *   - it produced at least one parseable failure artifact (a real, evidence-
 *     backed test failure we can diagnose and heal).
 *
 * Everything else is "no trustworthy result" → a candidate for INCONCLUSIVE.
 */
export function assessRunTrust(input: RunTrustInput): RunTrustAssessment {
  const { exitCode, hasFailureArtifacts, resultsFileExists } = input;
  const loadErrorCount = input.loadErrorCount ?? 0;

  // A framework-level crash that never reached a verdict is NOT trustworthy even
  // though it left a (crash) artifact behind. "Target closed/crashed", a launch
  // failure or a protocol error that aborts in ~1s is an environment hiccup, not
  // a test result — treating it as a confident `framework → report only`
  // dead-end hides the genuine (e.g. locator) failure the test surfaces once the
  // browser comes up cleanly. Checked BEFORE hasFailureArtifacts so the crash
  // artifact does not mask it. The worker retries such a run once.
  if (input.frameworkCrashWithoutVerdict) {
    return inconclusiveResult(
      'framework_crash_no_evidence',
      'The run aborted with a Playwright/framework-level crash (browser launch ' +
        'failure, target page/context/browser closed/crashed, or protocol error) ' +
        'before it could reach a real element — far faster than a single action ' +
        'timeout. That is an environment hiccup, not a test verdict, so the run is ' +
        'inconclusive and must be retried once before being reported.',
    );
  }

  // A real, evidence-backed failure is always trustworthy — we have something
  // concrete to diagnose and (potentially) heal. This is the common case and is
  // checked first so a non-zero exit with artifacts is never mislabelled.
  if (hasFailureArtifacts) {
    return ok();
  }

  // A clean exit with no failure artifacts means everything passed.
  if (exitCode === 0) {
    return ok();
  }

  // From here on: non-zero exit AND no failure artifact → we have no verdict.
  if (exitCode === 127) {
    return inconclusiveResult(
      'command_not_found',
      'The runner exited 127 (command not found) — Playwright/a required binary ' +
        'is missing or not on PATH (e.g. xauth, browser executable). The test never ran, ' +
        'so there is no verdict to report. This is environment uncertainty, not a test failure.',
    );
  }

  if (exitCode === 124) {
    return inconclusiveResult(
      'timeout_no_evidence',
      'The run was killed at the wall-clock timeout (exit 124) without producing ' +
        'any per-test evidence. A timeout with no results cannot be read as a test ' +
        'verdict — the run is inconclusive, not a failed/unhealable locator.',
    );
  }

  if (loadErrorCount > 0) {
    return inconclusiveResult(
      'spec_load_error',
      `${loadErrorCount} spec file(s)/global-setup failed to load before any test ran ` +
        '(missing env var, bad import, or config error). The test never produced a ' +
        'verdict, so this is inconclusive — fix the environment/spec and rerun.',
    );
  }

  if (!resultsFileExists) {
    return inconclusiveResult(
      'no_results_file',
      'The run exited non-zero and the reporter never wrote a results file. ' +
        'No test verdict was produced (browser crash, OOM, container restart, or ' +
        'early process death), so the run is inconclusive.',
    );
  }

  // Non-zero exit, results file present, but zero failure artifacts parsed — the
  // runner died after writing a (partial/empty) report. Still no verdict.
  return inconclusiveResult(
    'crashed_before_tests',
    'The run exited non-zero but produced no parseable failure artifact. The ' +
      'runner appears to have crashed before/while reporting, so no trustworthy ' +
      'verdict exists — the run is inconclusive.',
  );
}

function ok(): RunTrustAssessment {
  return { trustworthy: true, signal: 'ok', reason: 'Run produced a trustworthy verdict.', inconclusive: false };
}

function inconclusiveResult(signal: RunTrustSignal, reason: string): RunTrustAssessment {
  return { trustworthy: false, signal, reason, inconclusive: true };
}
