/**
 * Intelligence Learning System routes — the cross-system learning flywheel.
 * --------------------------------------------------------------------------
 *   GET  /api/intelligence-learning/metrics       — flywheel KPIs (getting smarter)
 *   GET  /api/intelligence-learning/stability      — per-strategy stability rollup
 *   GET  /api/intelligence-learning/selectors      — most-fragile tracked selectors
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
} from '../../db/postgres';
import {
  getLearningMetrics,
  analyzeHealingHistory,
} from '../../services/intelligence-learning-service';

const MOD = 'IntelLearning';

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
        .slice(0, limit);
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
