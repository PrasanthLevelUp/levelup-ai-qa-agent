/**
 * Healing Analytics Service — Priority 1 (Healing Analytics Dashboard).
 *
 * Read-only analytics over the self-healing learning loop. Sprint B gave us two
 * persisted artefacts (see src/db/postgres.ts):
 *   • `healing_outcomes`            — immutable event log, one row per heal+result.
 *   • `healing_confidence_scores`   — learned aggregate per (company, project,
 *                                     element, locator_type).
 * This service turns those into the handful of metrics a dashboard needs:
 * success rate (with time windows + trend), the elements that heal most, the
 * elements that fail most (need manual attention), and the spread of learned
 * confidence.
 *
 * IMPORTANT — schema reality:
 *   The dashboard spec referenced columns that DO NOT exist in this codebase
 *   (`applied_at`, `total_applications`, `successful_applications`,
 *   `failed_applications`, `success_rate`, `confidence_score`). The actual
 *   columns are:
 *     healing_outcomes:          created_at, result ('pass' | …)
 *     healing_confidence_scores: confidence (0–100), success_count,
 *                                failure_count, total_count
 *   All SQL below uses the real columns and DERIVES success/failure rates, so
 *   the queries actually run. We expose camelCase aliases on the way out so the
 *   frontend contract stays clean.
 *
 * DESIGN PRINCIPLES (carried from the rest of the codebase):
 *   • Multi-tenant isolation is non-negotiable — every query is scoped by
 *     company + project using COALESCE(...,0) so NULL ids bucket together
 *     consistently (mirrors getHealingLearningStats / the rest of postgres.ts).
 *   • Read-only and defensive — analytics must never throw into a request
 *     handler in a way that takes down the page; numeric coercion is centralised
 *     in small pure helpers that are unit-tested in isolation.
 */

import { getPool } from '../db/postgres';
import { logger } from '../utils/logger';

const MOD = 'HealingAnalyticsService';

export type AnalyticsTimeRange = 'today' | 'week' | 'month' | 'all';

export interface SuccessRateResult {
  totalHeals: number;
  successfulHeals: number;
  failedHeals: number;
  successRate: number; // 0–100, one decimal
}

export interface TopHealedElement {
  elementId: string;
  locatorType: string;
  totalApplications: number;
  successfulApplications: number;
  successRate: number; // 0–100, one decimal
  confidenceScore: number; // 0–100
}

export interface TopFailedElement {
  elementId: string;
  locatorType: string;
  totalApplications: number;
  failedApplications: number;
  failureRate: number; // 0–100, one decimal
  confidenceScore: number; // 0–100
}

export interface ConfidenceDistribution {
  low: number; // 0–25
  medium: number; // 25–50
  high: number; // 50–75
  veryHigh: number; // 75–100
}

export interface HealingTrendPoint {
  date: string; // YYYY-MM-DD
  totalHeals: number;
  successfulHeals: number;
  successRate: number; // 0–100, one decimal
}

export interface DashboardData {
  successRate: SuccessRateResult;
  topHealed: TopHealedElement[];
  topFailed: TopFailedElement[];
  confidenceDistribution: ConfidenceDistribution;
  trend: HealingTrendPoint[];
  generatedAt: string;
}

export class HealingAnalyticsService {
  /* ── Pure helpers (no DB — unit-testable in isolation) ──────────────── */

  /**
   * Build the time-window SQL fragment for `healing_outcomes`. Uses the real
   * `created_at` column (the spec's `applied_at` does not exist). Returns an
   * empty string for 'all' (no time bound). The fragment uses only literal
   * intervals, so it is safe to interpolate.
   */
  static buildTimeFilter(timeRange: AnalyticsTimeRange | string): string {
    switch (timeRange) {
      case 'today':
        return "AND created_at >= CURRENT_DATE";
      case 'week':
        return "AND created_at >= CURRENT_DATE - INTERVAL '7 days'";
      case 'month':
        return "AND created_at >= CURRENT_DATE - INTERVAL '30 days'";
      case 'all':
      default:
        return '';
    }
  }

  /** Coerce a possibly-string/NULL DB numeric to a finite number (default 0). */
  static num(v: unknown): number {
    const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
    return Number.isFinite(n) ? n : 0;
  }

  /** Percentage of `part` out of `total`, 0–100 with one decimal; 0 when total=0. */
  static rate(part: number, total: number): number {
    if (!total || total <= 0) return 0;
    return Math.round((part / total) * 1000) / 10;
  }

  /** Clamp the requested trend window to a sane, safe integer range of days. */
  static clampDays(days: number): number {
    const n = Math.floor(HealingAnalyticsService.num(days));
    if (n < 1) return 1;
    if (n > 365) return 365;
    return n;
  }

  /** Clamp a top-N limit to a sane integer (1–100). */
  static clampLimit(limit: number): number {
    const n = Math.floor(HealingAnalyticsService.num(limit));
    if (n < 1) return 1;
    if (n > 100) return 100;
    return n;
  }

  /* ── Queries ─────────────────────────────────────────────────────────── */

  /** Overall healing success rate within an optional time window. */
  async getSuccessRate(
    companyId: number | null | undefined,
    projectId: number | null | undefined,
    timeRange: AnalyticsTimeRange = 'all',
  ): Promise<SuccessRateResult> {
    const timeFilter = HealingAnalyticsService.buildTimeFilter(timeRange);
    const result = await getPool().query(
      `SELECT
         COUNT(*)::int AS total_heals,
         COUNT(*) FILTER (WHERE result = 'pass')::int AS successful_heals,
         COUNT(*) FILTER (WHERE result <> 'pass')::int AS failed_heals
       FROM healing_outcomes
       WHERE COALESCE(company_id, 0) = COALESCE($1, 0)
         AND COALESCE(project_id, 0) = COALESCE($2, 0)
         ${timeFilter}`,
      [companyId ?? null, projectId ?? null],
    );
    const row = result.rows[0] ?? {};
    const total = HealingAnalyticsService.num(row.total_heals);
    const successful = HealingAnalyticsService.num(row.successful_heals);
    const failed = HealingAnalyticsService.num(row.failed_heals);
    return {
      totalHeals: total,
      successfulHeals: successful,
      failedHeals: failed,
      successRate: HealingAnalyticsService.rate(successful, total),
    };
  }

  /** Elements healed most often (by total applications), with success rate. */
  async getTopHealedElements(
    companyId: number | null | undefined,
    projectId: number | null | undefined,
    limit = 10,
  ): Promise<TopHealedElement[]> {
    const lim = HealingAnalyticsService.clampLimit(limit);
    const result = await getPool().query(
      `SELECT element_id, locator_type, total_count, success_count, confidence
       FROM healing_confidence_scores
       WHERE COALESCE(company_id, 0) = COALESCE($1, 0)
         AND COALESCE(project_id, 0) = COALESCE($2, 0)
       ORDER BY total_count DESC, confidence DESC
       LIMIT $3`,
      [companyId ?? null, projectId ?? null, lim],
    );
    return (result.rows || []).map((r: any) => {
      const total = HealingAnalyticsService.num(r.total_count);
      const success = HealingAnalyticsService.num(r.success_count);
      return {
        elementId: r.element_id,
        locatorType: r.locator_type ?? '',
        totalApplications: total,
        successfulApplications: success,
        successRate: HealingAnalyticsService.rate(success, total),
        confidenceScore: HealingAnalyticsService.num(r.confidence),
      };
    });
  }

  /** Elements with the worst failure rate — these need manual attention. */
  async getTopFailedElements(
    companyId: number | null | undefined,
    projectId: number | null | undefined,
    limit = 10,
  ): Promise<TopFailedElement[]> {
    const lim = HealingAnalyticsService.clampLimit(limit);
    const result = await getPool().query(
      `SELECT element_id, locator_type, total_count, failure_count, confidence
       FROM healing_confidence_scores
       WHERE COALESCE(company_id, 0) = COALESCE($1, 0)
         AND COALESCE(project_id, 0) = COALESCE($2, 0)
         AND failure_count > 0
       ORDER BY (failure_count::decimal / NULLIF(total_count, 0)) DESC, total_count DESC
       LIMIT $3`,
      [companyId ?? null, projectId ?? null, lim],
    );
    return (result.rows || []).map((r: any) => {
      const total = HealingAnalyticsService.num(r.total_count);
      const failed = HealingAnalyticsService.num(r.failure_count);
      return {
        elementId: r.element_id,
        locatorType: r.locator_type ?? '',
        totalApplications: total,
        failedApplications: failed,
        failureRate: HealingAnalyticsService.rate(failed, total),
        confidenceScore: HealingAnalyticsService.num(r.confidence),
      };
    });
  }

  /** Count of tracked elements in each learned-confidence bucket. */
  async getConfidenceDistribution(
    companyId: number | null | undefined,
    projectId: number | null | undefined,
  ): Promise<ConfidenceDistribution> {
    const result = await getPool().query(
      `SELECT
         COUNT(*) FILTER (WHERE confidence >= 0  AND confidence < 25)::int  AS low,
         COUNT(*) FILTER (WHERE confidence >= 25 AND confidence < 50)::int  AS medium,
         COUNT(*) FILTER (WHERE confidence >= 50 AND confidence < 75)::int  AS high,
         COUNT(*) FILTER (WHERE confidence >= 75)::int                       AS very_high
       FROM healing_confidence_scores
       WHERE COALESCE(company_id, 0) = COALESCE($1, 0)
         AND COALESCE(project_id, 0) = COALESCE($2, 0)`,
      [companyId ?? null, projectId ?? null],
    );
    const row = result.rows[0] ?? {};
    return {
      low: HealingAnalyticsService.num(row.low),
      medium: HealingAnalyticsService.num(row.medium),
      high: HealingAnalyticsService.num(row.high),
      veryHigh: HealingAnalyticsService.num(row.very_high),
    };
  }

  /** Daily healing volume + success rate over the last `days` days. */
  async getHealingTrend(
    companyId: number | null | undefined,
    projectId: number | null | undefined,
    days = 30,
  ): Promise<HealingTrendPoint[]> {
    const window = HealingAnalyticsService.clampDays(days);
    const result = await getPool().query(
      `SELECT
         TO_CHAR(DATE(created_at), 'YYYY-MM-DD') AS date,
         COUNT(*)::int AS total_heals,
         COUNT(*) FILTER (WHERE result = 'pass')::int AS successful_heals
       FROM healing_outcomes
       WHERE COALESCE(company_id, 0) = COALESCE($1, 0)
         AND COALESCE(project_id, 0) = COALESCE($2, 0)
         AND created_at >= NOW() - ($3 * INTERVAL '1 day')
       GROUP BY DATE(created_at)
       ORDER BY DATE(created_at) ASC`,
      [companyId ?? null, projectId ?? null, window],
    );
    return (result.rows || []).map((r: any) => {
      const total = HealingAnalyticsService.num(r.total_heals);
      const success = HealingAnalyticsService.num(r.successful_heals);
      return {
        date: r.date,
        totalHeals: total,
        successfulHeals: success,
        successRate: HealingAnalyticsService.rate(success, total),
      };
    });
  }

  /**
   * Single-call aggregator for the dashboard. Runs the independent queries in
   * parallel. Best-effort: if any one query fails it is logged and that section
   * degrades to an empty/zero value rather than failing the whole dashboard.
   */
  async getDashboardData(
    companyId: number | null | undefined,
    projectId: number | null | undefined,
  ): Promise<DashboardData> {
    const safe = async <T>(label: string, p: Promise<T>, fallback: T): Promise<T> => {
      try {
        return await p;
      } catch (err: any) {
        logger.warn(MOD, `${label} failed: ${err?.message || err}`);
        return fallback;
      }
    };

    const [successRate, topHealed, topFailed, confidenceDistribution, trend] = await Promise.all([
      safe('getSuccessRate', this.getSuccessRate(companyId, projectId, 'all'), {
        totalHeals: 0, successfulHeals: 0, failedHeals: 0, successRate: 0,
      } as SuccessRateResult),
      safe('getTopHealedElements', this.getTopHealedElements(companyId, projectId, 10), [] as TopHealedElement[]),
      safe('getTopFailedElements', this.getTopFailedElements(companyId, projectId, 10), [] as TopFailedElement[]),
      safe('getConfidenceDistribution', this.getConfidenceDistribution(companyId, projectId), {
        low: 0, medium: 0, high: 0, veryHigh: 0,
      } as ConfidenceDistribution),
      safe('getHealingTrend', this.getHealingTrend(companyId, projectId, 30), [] as HealingTrendPoint[]),
    ]);

    return {
      successRate,
      topHealed,
      topFailed,
      confidenceDistribution,
      trend,
      generatedAt: new Date().toISOString(),
    };
  }
}

/** Process-wide singleton (mirrors healingOutcomeService / healingVerificationService). */
export const healingAnalyticsService = new HealingAnalyticsService();
