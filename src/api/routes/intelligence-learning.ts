/**
 * Intelligence Learning System routes — the cross-system learning flywheel.
 * --------------------------------------------------------------------------
 *   GET  /api/intelligence-learning/metrics       — flywheel KPIs (getting smarter)
 *   GET  /api/intelligence-learning/overview       — single-call dashboard payload
 *   GET  /api/intelligence-learning/trend          — daily healing-success-rate series
 *   GET  /api/intelligence-learning/stability      — per-strategy stability rollup
 *   GET  /api/intelligence-learning/selectors      — most-fragile tracked selectors
 *   GET  /api/intelligence-learning/patterns        — learned maintenance pattern library
 *   GET  /api/intelligence-learning/insights       — learned insights ledger (L2–L5)
 *   POST /api/intelligence-learning/analyze         — mine healing history → stability
 *
 * Surfaces Loop L1 (Healing → Script Generation selector priority) plus the
 * L2/L3 insight ledger. All endpoints are company/project scoped via the
 * standard middleware chain. Purely additive — no existing behaviour changes.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import {
  getSelectorStability,
  getStrategyStability,
  getInsights,
  getStabilitySummary,
  getHealingSuccessTrend,
} from '../../db/postgres';
import {
  getLearningMetrics,
  analyzeHealingHistory,
  inferStrategyFromSelector,
} from '../../services/intelligence-learning-service';
import { listMaintenancePatterns } from '../../services/maintenance-pattern-service';

const MOD = 'IntelLearning';

/**
 * Recommend a more robust selector strategy for a fragile one. Pure heuristic
 * mirroring the SelectorQualityEngine preference order — used to give the
 * dashboard an actionable "suggested fix" per fragile selector.
 */
function suggestStrategy(strategy: string): string {
  switch (strategy) {
    case 'id':
    case 'css-class':
    case 'css-combined':
    case 'xpath':
      return 'data-testid';
    case 'name-attr':
    case 'placeholder':
    case 'text':
      return 'role';
    default:
      return 'data-testid';
  }
}

export function createIntelligenceLearningRouter(): Router {
  const router = Router();

  /** Flywheel KPIs: stability ↑, heal rate ↓, insights ↑. */
  router.get('/metrics', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const metrics = await getLearningMetrics({ companyId: companyId ?? null, projectId: projectId ?? null });
      res.json({ success: true, data: metrics });
    } catch (err: any) {
      logger.error(MOD, 'metrics error', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** Per-strategy stability rollup (which strategies break most). */
  router.get('/stability', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const strategies = await getStrategyStability({ companyId: companyId ?? null, projectId: projectId ?? null });
      res.json({ success: true, data: strategies });
    } catch (err: any) {
      logger.error(MOD, 'stability error', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** Most-fragile tracked selectors (lowest stability first). */
  router.get('/selectors', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const limit = Math.min(parseInt(String(req.query.limit || '50'), 10) || 50, 500);
      const rows = await getSelectorStability({ companyId: companyId ?? null, projectId: projectId ?? null });
      const fragile = rows
        .filter(r => r.times_broken > 0)
        .sort((a, b) => a.stability_score - b.stability_score)
        .slice(0, limit)
        .map(r => {
          // Derive a strategy (rows may not carry one explicitly) + a severity
          // bucket + an actionable suggested fix for the dashboard.
          const strategy = (r as any).strategy || inferStrategyFromSelector(r.selector);
          const severity = r.stability_score < 0.3 ? 'critical' : r.stability_score < 0.5 ? 'high' : 'medium';
          return {
            ...r,
            strategy,
            severity,
            stabilityPct: Math.round(r.stability_score * 100),
            suggestedStrategy: suggestStrategy(strategy),
          };
        });
      res.json({ success: true, data: fragile, count: fragile.length, totalTracked: rows.length });
    } catch (err: any) {
      logger.error(MOD, 'selectors error', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** Learned insight ledger (Loops L2–L5). Optional ?type= filter. */
  router.get('/insights', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const insightType = req.query.type ? String(req.query.type) : undefined;
      const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500);
      const insights = await getInsights({
        companyId: companyId ?? null,
        projectId: projectId ?? null,
        ...(insightType ? { insightType } : {}),
        limit,
      });
      res.json({ success: true, data: insights, count: insights.length });
    } catch (err: any) {
      logger.error(MOD, 'insights error', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Daily healing-success-rate trend (the "getting smarter" line chart).
   * ?days=30|90|... — returns the per-day series plus a summary that contrasts
   * the start vs end of the window (e.g. 82% → 89%, +7pts).
   */
  router.get('/trend', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const days = Math.min(Math.max(parseInt(String(req.query.days || '30'), 10) || 30, 1), 365);
      const points = await getHealingSuccessTrend({ companyId: companyId ?? null, projectId: projectId ?? null }, days);

      const withData = points.filter(p => p.attempts > 0);
      const startRate = withData.length ? withData[0].rate : 0;
      const endRate = withData.length ? withData[withData.length - 1].rate : 0;
      const totalAttempts = points.reduce((a, p) => a + p.attempts, 0);
      const totalHealed = points.reduce((a, p) => a + p.healed, 0);
      const avgRate = totalAttempts > 0 ? parseFloat(((totalHealed / totalAttempts) * 100).toFixed(1)) : 0;

      res.json({
        success: true,
        data: {
          points,
          summary: {
            days,
            startRate,
            endRate,
            deltaRate: parseFloat((endRate - startRate).toFixed(1)),
            avgRate,
            totalAttempts,
            totalHealed,
            improving: endRate >= startRate,
          },
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'trend error', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Learned maintenance pattern library (Loop 3) — confident old→new selector
   * rewrites observed during Script Sync / Migration. Each row carries the
   * frequency, confidence, and a derived success rate for the dashboard.
   */
  router.get('/patterns', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const limit = Math.min(parseInt(String(req.query.limit || '20'), 10) || 20, 200);
      const rows = await listMaintenancePatterns({ companyId: companyId ?? undefined, projectId: projectId ?? undefined }, limit);
      const patterns = rows.map(p => {
        const outcomes = (p.success_count || 0) + (p.failure_count || 0);
        return {
          id: p.id,
          oldSelector: p.old_selector,
          newSelector: p.new_selector,
          source: p.source,
          timesApplied: p.frequency || 0,
          successCount: p.success_count || 0,
          failureCount: p.failure_count || 0,
          confidence: Math.round((p.confidence_score || 0) * 100),
          successRate: outcomes > 0 ? Math.round(((p.success_count || 0) / outcomes) * 100) : null,
          lastSeenAt: p.last_seen_at,
        };
      });
      res.json({ success: true, data: patterns, count: patterns.length });
    } catch (err: any) {
      logger.error(MOD, 'patterns error', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Single-call dashboard payload: overview cards + flywheel KPIs + trend +
   * top fragile selectors + top patterns + recent insights. Convenience
   * aggregator so the frontend can render the whole dashboard from one request
   * (each underlying source is still individually available above).
   */
  router.get('/overview', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const scope = { companyId: companyId ?? null, projectId: projectId ?? null };
      const days = Math.min(Math.max(parseInt(String(req.query.days || '30'), 10) || 30, 1), 365);

      const [metrics, summary, trendPoints, fragileRows, patternRows, insights] = await Promise.all([
        getLearningMetrics(scope),
        getStabilitySummary(scope),
        getHealingSuccessTrend(scope, days),
        getSelectorStability(scope),
        listMaintenancePatterns({ companyId: companyId ?? undefined, projectId: projectId ?? undefined }, 5),
        getInsights({ ...scope, limit: 8 }),
      ]);

      const withData = trendPoints.filter(p => p.attempts > 0);
      const startRate = withData.length ? withData[0].rate : 0;
      const endRate = withData.length ? withData[withData.length - 1].rate : 0;
      const totalAttempts = trendPoints.reduce((a, p) => a + p.attempts, 0);
      const totalHealed = trendPoints.reduce((a, p) => a + p.healed, 0);

      const fragile = fragileRows
        .filter(r => r.times_broken > 0)
        .sort((a, b) => a.stability_score - b.stability_score)
        .slice(0, 5)
        .map(r => {
          const strategy = (r as any).strategy || inferStrategyFromSelector(r.selector);
          return {
            selector: r.selector,
            strategy,
            timesBroken: r.times_broken,
            timesUsed: r.times_used,
            stabilityPct: Math.round(r.stability_score * 100),
            severity: r.stability_score < 0.3 ? 'critical' : r.stability_score < 0.5 ? 'high' : 'medium',
            suggestedStrategy: suggestStrategy(strategy),
          };
        });

      const patterns = patternRows.map(p => {
        const outcomes = (p.success_count || 0) + (p.failure_count || 0);
        return {
          oldSelector: p.old_selector,
          newSelector: p.new_selector,
          timesApplied: p.frequency || 0,
          confidence: Math.round((p.confidence_score || 0) * 100),
          successRate: outcomes > 0 ? Math.round(((p.success_count || 0) / outcomes) * 100) : null,
        };
      });

      const totalInsights = Object.values(metrics.insightCounts).reduce((a, b) => a + b, 0);

      res.json({
        success: true,
        data: {
          cards: {
            trackedSelectors: summary.trackedSelectors,
            stableSelectors: summary.stableSelectors,
            stablePct: summary.stablePct,
            fragileSelectors: summary.flakySelectors,
            avgStabilityPct: Math.round(summary.avgStability * 100),
            totalBreaks: summary.totalBreaks,
            insightsGenerated: totalInsights,
            maintenancePatterns: patternRows.length,
            healRate: metrics.healRate.rate,
            flywheelHealth: metrics.flywheelHealth,
          },
          healingTrend: {
            points: trendPoints,
            summary: {
              days,
              startRate,
              endRate,
              deltaRate: parseFloat((endRate - startRate).toFixed(1)),
              avgRate: totalAttempts > 0 ? parseFloat(((totalHealed / totalAttempts) * 100).toFixed(1)) : 0,
              totalAttempts,
              totalHealed,
              improving: endRate >= startRate,
            },
          },
          strategyStability: metrics.strategyStability,
          insightCounts: metrics.insightCounts,
          topFragileSelectors: fragile,
          topPatterns: patterns,
          recentInsights: insights,
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'overview error', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /** Mine healing history into stability signal + insights (idempotent). */
  router.post('/analyze', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number | undefined;
      const projectId = (req as any).projectId as number | undefined;
      const sinceDays = req.body?.sinceDays ? parseInt(String(req.body.sinceDays), 10) : undefined;
      const result = await analyzeHealingHistory(
        { companyId: companyId ?? null, projectId: projectId ?? null },
        sinceDays ? { sinceDays } : {},
      );
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error(MOD, 'analyze error', { error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
