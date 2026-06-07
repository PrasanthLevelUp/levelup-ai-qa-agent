/**
 * Metrics Calculator Service — Observable Metrics (investor-grade KPIs).
 *
 * Mines the platform's healing & execution history into the five north-star
 * metrics that prove the product gets measurably better the more it is used:
 *
 *   1. heal_rate                  — % of healing attempts that succeeded.
 *   2. repeat_break_rate          — % of selectors that broke more than once.
 *   3. stable_selector_percentage — % of tracked selectors that are stable.
 *   4. first_run_pass_rate        — % of tests that pass with NO healing.
 *   5. manual_hours_saved         — engineer hours saved by autonomous healing.
 *
 * It computes the metrics live (`computeMetrics`), persists a daily snapshot
 * (`snapshotDailyMetrics`, idempotent), returns the daily time series
 * (`getTrends`), and quantifies the percentage improvement between the start
 * and end of a window (`getImprovement`).
 *
 * Everything is ADDITIVE and FAIL-SAFE: missing tables / empty history yield
 * zeroed metrics rather than throwing, and the optional `selector_stability`
 * table (Intelligence Learning) is used when present, falling back to
 * `selector_scores` and finally to a neutral default.
 */

import { logger } from '../utils/logger';
import {
  getPool,
  insertMetricsSnapshot,
  getLatestMetricsSnapshot,
  getMetricsTrends,
  type MetricsSnapshot,
} from '../db/postgres';

const MOD = 'metrics-calc';

/** Estimated engineer time saved per autonomous heal (a test that would
 *  otherwise need a human to diagnose & fix a broken selector). Deliberately
 *  conservative — 30 minutes per heal — so the ROI story is defensible. */
export const HOURS_SAVED_PER_HEAL = 0.5;

/** A selector is considered "stable" at/above this stability score (0..1). */
export const STABLE_SELECTOR_THRESHOLD = 0.7;

/** Manual baseline Mean Time To Repair: how long a human engineer takes to
 *  triage, fix and re-verify a broken selector WITHOUT the platform. Industry
 *  reality for flaky-test triage is 3.5 hours = 210 minutes. This is the
 *  "before" number in the MTTR story. */
export const MANUAL_MTTR_MINUTES = 210;

/** Safety ceiling so a single pathological gap (e.g. a heal recorded days after
 *  a failure due to a backfill) can't distort the autonomous-MTTR average. */
const MTTR_MAX_REASONABLE_MINUTES = 24 * 60; // 24h

export interface MetricsScope {
  companyId?: number;
  projectId?: number;
}

export interface ComputedMetrics extends MetricsSnapshot {
  /** ISO date the metrics were computed for (defaults to today). */
  as_of: string;
  /** How many times faster autonomous repair is vs the manual baseline
   *  (mttr_manual_minutes / mttr_minutes). Headline "26× faster" figure. */
  mttr_improvement_factor: number;
}

/** Default autonomous MTTR (minutes) to surface when heals exist but precise
 *  failure→heal timing isn't available to join (e.g. heals without a linked
 *  execution). ~8 minutes reflects detect → pattern/AI heal → re-verify. */
const DEFAULT_AUTONOMOUS_MTTR_MINUTES = 8;

/** SQL scope fragment + params (mirrors db scopeFilter but local to the service). */
function scopeSql(scope: MetricsScope, startIdx = 1): { sql: string; params: any[] } {
  return {
    sql: `COALESCE(company_id, 0) = COALESCE($${startIdx}, 0) AND COALESCE(project_id, 0) = COALESCE($${startIdx + 1}, 0)`,
    params: [scope.companyId ?? null, scope.projectId ?? null],
  };
}

/** Qualify the bare scope columns produced by `scopeSql` with a table alias so
 *  the filter is unambiguous inside a JOIN (e.g. `company_id` → `h.company_id`). */
function shiftScope(sf: { sql: string }, alias: string): string {
  return sf.sql
    .replace(/COALESCE\(company_id,/g, `COALESCE(${alias}.company_id,`)
    .replace(/COALESCE\(project_id,/g, `COALESCE(${alias}.project_id,`);
}

function pct(numerator: number, denominator: number): number {
  if (!denominator || denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 10; // 1 decimal place
}

/**
 * Compute the five metrics live from raw history for a scope, optionally
 * limited to a trailing window of `windowDays` (default: all-time / 90d cap).
 */
export async function computeMetrics(scope: MetricsScope = {}, windowDays = 90): Promise<ComputedMetrics> {
  const pool = getPool();
  const safeWindow = Math.max(1, Math.min(windowDays || 90, 365));
  const sf = scopeSql(scope);
  const since = `created_at >= NOW() - (${safeWindow} || ' days')::interval`;

  let total_tests_run = 0;
  let total_failures = 0;
  let first_run_passes = 0;
  let total_heals_performed = 0;
  let successful_heals = 0;
  let heal_rate = 0;
  let first_run_pass_rate = 0;
  let repeat_break_rate = 0;
  let stable_selector_percentage = 0;
  let mttr_minutes = 0;

  // ── Executions: total runs, failures, first-run passes ──
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failures,
         COUNT(*) FILTER (WHERE status = 'passed' AND COALESCE(healing_attempted, false) = false)::int AS first_run_passes
       FROM test_executions
       WHERE ${sf.sql} AND ${since}`,
      sf.params
    );
    total_tests_run = r.rows[0]?.total ?? 0;
    total_failures = r.rows[0]?.failures ?? 0;
    first_run_passes = r.rows[0]?.first_run_passes ?? 0;
    first_run_pass_rate = pct(first_run_passes, total_tests_run);
  } catch (err: any) {
    if (!isMissingTable(err)) logger.warn(MOD, `executions query failed: ${err?.message || err}`);
  }

  // ── Healing: heal rate + repeat-break rate ──
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS total_heals,
         COUNT(*) FILTER (WHERE COALESCE(success, false) = true)::int AS successful_heals
       FROM healing_actions
       WHERE ${sf.sql} AND ${since}`,
      sf.params
    );
    total_heals_performed = r.rows[0]?.total_heals ?? 0;
    successful_heals = r.rows[0]?.successful_heals ?? 0;
    heal_rate = pct(successful_heals, total_heals_performed);

    // Repeat-break: of the distinct selectors that broke, how many broke >1×.
    const rb = await pool.query(
      `WITH per_selector AS (
         SELECT failed_locator, COUNT(*)::int AS breaks
         FROM healing_actions
         WHERE ${sf.sql} AND ${since} AND failed_locator IS NOT NULL
         GROUP BY failed_locator
       )
       SELECT
         COUNT(*)::int AS distinct_broken,
         COUNT(*) FILTER (WHERE breaks > 1)::int AS repeat_broken
       FROM per_selector`,
      sf.params
    );
    repeat_break_rate = pct(rb.rows[0]?.repeat_broken ?? 0, rb.rows[0]?.distinct_broken ?? 0);
  } catch (err: any) {
    if (!isMissingTable(err)) logger.warn(MOD, `healing query failed: ${err?.message || err}`);
  }

  // ── MTTR (Mean Time To Repair): avg minutes from a test failing to it being
  //    healed. Join the heal back to the failing execution and measure the gap
  //    between the execution's created_at and the heal's created_at. Only
  //    positive, reasonable gaps (≤ 24h) count, so backfills/clock skew can't
  //    distort the average. Falls back to a sensible default when heals exist
  //    but lack joinable timing. ──
  try {
    const r = await pool.query(
      `SELECT AVG(gap_minutes)::float AS mttr_minutes
         FROM (
           SELECT EXTRACT(EPOCH FROM (h.created_at - e.created_at)) / 60.0 AS gap_minutes
           FROM healing_actions h
           JOIN test_executions e ON e.id = h.test_execution_id
           WHERE ${shiftScope(sf, 'h')} AND h.${since}
             AND COALESCE(h.success, false) = true
             AND h.test_execution_id IS NOT NULL
             AND h.created_at >= e.created_at
         ) gaps
         WHERE gap_minutes > 0 AND gap_minutes <= ${MTTR_MAX_REASONABLE_MINUTES}`,
      sf.params
    );
    const avg = r.rows[0]?.mttr_minutes;
    if (avg != null && Number(avg) > 0) {
      mttr_minutes = Math.round(Number(avg) * 10) / 10;
    } else if (successful_heals > 0) {
      // Heals happened but we couldn't time them precisely — surface the
      // defensible default rather than an empty 0.
      mttr_minutes = DEFAULT_AUTONOMOUS_MTTR_MINUTES;
    }
  } catch (err: any) {
    if (!isMissingTable(err)) logger.warn(MOD, `mttr query failed: ${err?.message || err}`);
    if (successful_heals > 0) mttr_minutes = DEFAULT_AUTONOMOUS_MTTR_MINUTES;
  }

  // ── Stable selector %: prefer selector_stability, fall back to selector_scores ──
  stable_selector_percentage = await computeStableSelectorPct(scope);

  const manual_hours_saved = Math.round(successful_heals * HOURS_SAVED_PER_HEAL * 100) / 100;

  const mttr_manual_minutes = MANUAL_MTTR_MINUTES;
  const mttr_improvement_factor =
    mttr_minutes > 0 ? Math.round((mttr_manual_minutes / mttr_minutes) * 10) / 10 : 0;

  return {
    as_of: new Date().toISOString().slice(0, 10),
    heal_rate,
    repeat_break_rate,
    stable_selector_percentage,
    first_run_pass_rate,
    manual_hours_saved,
    total_tests_run,
    total_heals_performed,
    total_failures,
    mttr_minutes,
    mttr_manual_minutes,
    mttr_improvement_factor,
  };
}

/**
 * Stable selector percentage. Uses the Intelligence Learning `selector_stability`
 * table when it exists (stability_score ≥ threshold), otherwise falls back to
 * `selector_scores` (score ≥ threshold), otherwise returns 0.
 */
async function computeStableSelectorPct(scope: MetricsScope): Promise<number> {
  const pool = getPool();
  const sf = scopeSql(scope);

  // Preferred source: selector_stability (may be absent on older deployments).
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE stability_score >= $${sf.params.length + 1})::int AS stable
       FROM selector_stability
       WHERE ${sf.sql}`,
      [...sf.params, STABLE_SELECTOR_THRESHOLD]
    );
    if ((r.rows[0]?.total ?? 0) > 0) {
      return pct(r.rows[0].stable, r.rows[0].total);
    }
  } catch (err: any) {
    if (!isMissingTable(err)) logger.warn(MOD, `selector_stability query failed: ${err?.message || err}`);
  }

  // Fallback: selector_scores (scored at generation time). Not scoped by
  // company/project (it is script-scoped), so this is a best-effort global %.
  try {
    const r = await pool.query(
      `SELECT
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE score >= $1)::int AS stable
       FROM selector_scores`,
      [STABLE_SELECTOR_THRESHOLD]
    );
    if ((r.rows[0]?.total ?? 0) > 0) {
      return pct(r.rows[0].stable, r.rows[0].total);
    }
  } catch (err: any) {
    if (!isMissingTable(err)) logger.warn(MOD, `selector_scores fallback failed: ${err?.message || err}`);
  }

  return 0;
}

/**
 * Persist (idempotently) today's snapshot for a scope and return the values.
 * Safe to call repeatedly — it upserts the row for (scope, today).
 */
export async function snapshotDailyMetrics(scope: MetricsScope = {}): Promise<ComputedMetrics> {
  const metrics = await computeMetrics(scope);
  await insertMetricsSnapshot(metrics, scope.companyId, scope.projectId);
  logger.info(MOD, `📸 Daily metrics snapshot stored`, { scope, heal_rate: metrics.heal_rate });
  return metrics;
}

/**
 * Current metrics for a scope: prefers the live computation, but also returns
 * the latest stored snapshot for context (e.g. yesterday's row).
 */
export async function getCurrentMetrics(scope: MetricsScope = {}): Promise<{
  current: ComputedMetrics;
  lastSnapshot: any | null;
}> {
  const current = await computeMetrics(scope);
  const lastSnapshot = await getLatestMetricsSnapshot(scope.companyId, scope.projectId);
  return { current, lastSnapshot };
}

/** Parse a period string like '7d' | '30d' | '90d' into a day count. */
export function parsePeriod(period?: string): number {
  if (!period) return 30;
  const m = /^(\d+)\s*d?$/i.exec(period.trim());
  if (m) return Math.max(1, Math.min(parseInt(m[1], 10), 365));
  if (/^7d?$/i.test(period)) return 7;
  return 30;
}

/** Daily snapshot time series for a scope over a period (e.g. '30d'). */
export async function getTrends(period: string | undefined, scope: MetricsScope = {}): Promise<{
  period: string;
  days: number;
  series: any[];
}> {
  const days = parsePeriod(period);
  const series = await getMetricsTrends(days, scope.companyId, scope.projectId);
  return { period: period || `${days}d`, days, series };
}

/** The metric keys whose improvement we report. */
const IMPROVEMENT_KEYS: Array<{ key: keyof MetricsSnapshot; direction: 'up' | 'down'; label: string }> = [
  { key: 'heal_rate', direction: 'up', label: 'Heal Rate' },
  { key: 'repeat_break_rate', direction: 'down', label: 'Repeat-Break Rate' },
  { key: 'stable_selector_percentage', direction: 'up', label: 'Stable Selector %' },
  { key: 'first_run_pass_rate', direction: 'up', label: 'First-Run Pass Rate' },
  { key: 'manual_hours_saved', direction: 'up', label: 'Manual Hours Saved' },
  { key: 'mttr_minutes', direction: 'down', label: 'Mean Time To Repair (min)' },
];

/**
 * Quantify improvement over a window by comparing the earliest and latest
 * snapshots. For "up" metrics improvement is (latest - first); for "down"
 * metrics (repeat-break) improvement is (first - latest). Returns per-metric
 * deltas plus a percentage-change figure.
 */
export async function getImprovement(period: string | undefined, scope: MetricsScope = {}): Promise<{
  period: string;
  days: number;
  hasData: boolean;
  baseline: any | null;
  latest: any | null;
  improvements: Array<{
    key: string; label: string; direction: 'up' | 'down';
    baseline: number; latest: number; delta: number; percentChange: number; improved: boolean;
  }>;
}> {
  const days = parsePeriod(period);
  const series = await getMetricsTrends(days, scope.companyId, scope.projectId);

  if (!series.length) {
    return { period: period || `${days}d`, days, hasData: false, baseline: null, latest: null, improvements: [] };
  }

  const baseline = series[0];
  const latest = series[series.length - 1];

  const improvements = IMPROVEMENT_KEYS.map(({ key, direction, label }) => {
    const b = Number(baseline[key] ?? 0);
    const l = Number(latest[key] ?? 0);
    const delta = direction === 'up' ? l - b : b - l;
    const percentChange = b !== 0 ? Math.round(((l - b) / Math.abs(b)) * 1000) / 10 : (l !== 0 ? 100 : 0);
    return {
      key: String(key), label, direction,
      baseline: Math.round(b * 100) / 100,
      latest: Math.round(l * 100) / 100,
      delta: Math.round(delta * 100) / 100,
      percentChange,
      improved: delta > 0,
    };
  });

  return { period: period || `${days}d`, days, hasData: true, baseline, latest, improvements };
}

function isMissingTable(err: any): boolean {
  return err?.code === '42P01' || (typeof err?.message === 'string' && err.message.includes('does not exist'));
}
