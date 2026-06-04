/**
 * Enhanced RCA + Environment Intelligence API Routes
 *
 * GET /api/rca-intelligence/report?days=30     — Full environment intelligence report
 * GET /api/rca-intelligence/trend?days=30      — Classification trend over time
 * GET /api/rca-intelligence/heatmap?days=30    — Component × classification heatmap
 * GET /api/rca-intelligence/recent?limit=20    — Recent RCA analyses list
 */

import { Router, type Request, type Response } from 'express';
import {
  getClassificationStats,
  getComponentClassificationStats,
  getClassificationTrend,
  getDomainTrendComparison,
  getRecentRCAAnalyses,
} from '../../db/postgres';
import { generateEnvironmentIntelligence } from '../../engines/environment-intelligence-engine';
import { logger } from '../../utils/logger';

const MOD = 'rca-intelligence-routes';

/**
 * Read an optional sprint date window (WHEN) from the query string.
 * Returns {} when not both present / invalid so callers fall back to the
 * trailing `days` window (backward-compatible).
 */
function readWindow(req: Request): { startDate?: string; endDate?: string } {
  const startDate = req.query.startDate as string | undefined;
  const endDate = req.query.endDate as string | undefined;
  if (!startDate || !endDate) return {};
  const s = new Date(startDate);
  const e = new Date(endDate);
  if (isNaN(s.getTime()) || isNaN(e.getTime()) || e.getTime() <= s.getTime()) return {};
  return { startDate, endDate };
}

export function createRCAIntelligenceRouter(): Router {
  const router = Router();

  /**
   * GET /report?days=30
   * Full environment intelligence report with insights.
   */
  router.get('/report', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const days = parseInt(req.query.days as string, 10) || 30;
      const { startDate, endDate } = readWindow(req);

      const [classificationStats, componentStats, classificationTrend, domainTrend] = await Promise.all([
        getClassificationStats(days, cid, startDate, endDate),
        getComponentClassificationStats(days, cid, startDate, endDate),
        getClassificationTrend(days, cid, startDate, endDate),
        getDomainTrendComparison(days, cid, startDate, endDate),
      ]);

      const totalAnalyses = classificationStats.reduce((s, c) => s + c.count, 0);

      const report = generateEnvironmentIntelligence({
        classificationStats,
        componentStats,
        classificationTrend,
        domainTrend,
        totalAnalyses,
        windowDays: days,
      });

      res.json(report);
    } catch (err) {
      logger.error(MOD, 'Failed to generate intelligence report', { error: err });
      res.status(500).json({ error: 'Failed to generate intelligence report' });
    }
  });

  /**
   * GET /trend?days=30
   * Classification trend over time.
   */
  router.get('/trend', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const days = parseInt(req.query.days as string, 10) || 30;
      const { startDate, endDate } = readWindow(req);
      const trend = await getClassificationTrend(days, cid, startDate, endDate);
      res.json({ success: true, data: trend });
    } catch (err) {
      logger.error(MOD, 'Failed to get classification trend', { error: err });
      res.status(500).json({ error: 'Failed to get classification trend' });
    }
  });

  /**
   * GET /heatmap?days=30
   * Component × classification heatmap data.
   */
  router.get('/heatmap', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const days = parseInt(req.query.days as string, 10) || 30;
      const { startDate, endDate } = readWindow(req);
      const data = await getComponentClassificationStats(days, cid, startDate, endDate);
      res.json({ success: true, data });
    } catch (err) {
      logger.error(MOD, 'Failed to get component heatmap', { error: err });
      res.status(500).json({ error: 'Failed to get component heatmap' });
    }
  });

  /**
   * GET /recent?limit=20
   * Recent RCA analyses.
   */
  router.get('/recent', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const data = await getRecentRCAAnalyses(Math.min(limit, 100), cid);
      res.json({ success: true, data, count: data.length });
    } catch (err) {
      logger.error(MOD, 'Failed to get recent RCAs', { error: err });
      res.status(500).json({ error: 'Failed to get recent analyses' });
    }
  });

  return router;
}
