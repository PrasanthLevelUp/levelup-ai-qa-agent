/**
 * rerun-budget — pure helpers governing the VALIDATION rerun time budget.
 *
 * Why this exists (root cause proven in docs/raw-playwright-output-divergence.md):
 * a broken locator does NOT fail immediately — Playwright's `fill()/click()` WAIT
 * the repo's action/test timeout (30s by default) and only then emit the
 * locator-rich, *located* error (e.g. `waiting for locator('#username')` with a
 * source location) plus a trace. That located error is the ONLY evidence the
 * entire healing pipeline (failed_locator extraction, Repo Intelligence, App
 * Profile, AI, validation) depends on.
 *
 * The old rerun timeout was `max(15s, min(120s, remainingJobBudget))`. Its 15s
 * floor is BELOW the 30s repo action timeout, so any rerun starting with < 30s of
 * job budget was killed (SIGTERM→SIGKILL, exit 124) BEFORE Playwright could emit
 * its diagnostics — producing the evidence-destroying "no location / no trace"
 * shape and, downstream, hallucinated locators.
 *
 * Rule enforced here: a validation rerun must answer ONE question ("did the
 * candidate fix the test?") and is only trustworthy if it is allowed to run at
 * least `repoActionTimeout + buffer`. So:
 *   1. We never START a rerun unless that much budget remains (canStartTrustworthyRerun).
 *   2. When a rerun does run, its timeout is >= repoActionTimeout + buffer (rerunTimeoutMs).
 * An incomplete rerun yields almost no useful information, so not running is
 * strictly better than running a doomed one.
 */

/** Inputs that define the trustworthy-rerun window. All values in milliseconds. */
export interface RerunBudgetConfig {
  /** The test repo's per-action/per-test timeout (Playwright default 30000). */
  repoActionTimeoutMs: number;
  /** Headroom for browser launch, navigation, reporter flush, trace write. */
  bufferMs: number;
  /** Hard ceiling on any single rerun (so one rerun can't dominate the job). */
  ceilingMs: number;
}

export const DEFAULT_RERUN_BUDGET_CONFIG: RerunBudgetConfig = {
  repoActionTimeoutMs: 30_000,
  bufferMs: 15_000,
  ceilingMs: 120_000,
};

/**
 * Minimum budget a rerun needs to produce a TRUSTWORTHY Playwright result:
 * the repo's action timeout (so the located error can fire) plus buffer.
 */
export function minTrustworthyRerunMs(cfg: RerunBudgetConfig): number {
  return cfg.repoActionTimeoutMs + cfg.bufferMs;
}

/**
 * True only when enough job budget remains to run a trustworthy validation
 * rerun. Callers MUST stop (not start a rerun) when this is false.
 */
export function canStartTrustworthyRerun(remainingJobBudgetMs: number, cfg: RerunBudgetConfig): boolean {
  return remainingJobBudgetMs >= minTrustworthyRerunMs(cfg);
}

/**
 * Effective per-rerun timeout.
 *
 * INVARIANT: the returned value is ALWAYS >= minTrustworthyRerunMs(cfg)
 * (= repoActionTimeout + buffer) and <= cfg.ceilingMs. This guarantees a rerun is
 * never killed before Playwright can emit its locator-rich diagnostics. Pair with
 * canStartTrustworthyRerun() so a rerun is only started when the budget can
 * actually honor this timeout.
 */
export function rerunTimeoutMs(remainingJobBudgetMs: number, cfg: RerunBudgetConfig): number {
  const floor = minTrustworthyRerunMs(cfg);
  return Math.max(floor, Math.min(cfg.ceilingMs, remainingJobBudgetMs));
}
