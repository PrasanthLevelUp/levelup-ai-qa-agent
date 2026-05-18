/**
 * ROI / Maintenance Cost Dashboard API Routes
 *
 * GET /api/roi/report?days=30   — Full ROI report with metrics, trend, breakdown
 * GET /api/roi/trend?days=30    — Daily ROI trend data
 * GET /api/roi/summary?days=30  — Quick summary metrics only
 */

import { Router, type Request, type Response } from 'express';
import { getROIData, getROIDailyTrend } from '../../db/postgres';
import { calculateROI } from '../../engines/roi-engine';
import { logger } from '../../utils/logger';

const MOD = 'roi-routes';

export function createROIRouter(): Router {
  const router = Router();

  /**
   * GET /report?days=30
   * Full ROI report with all metrics, trend, and category breakdown.
   */
  router.get('/report', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const days = parseInt(req.query.days as string, 10) || 30;

      const [roiData, dailyTrend] = await Promise.all([
        getROIData(days, cid),
        getROIDailyTrend(days, cid),
      ]);

      const report = calculateROI({
        ...roiData,
        windowDays: days,
        dailyTrend,
      });

      res.json(report);
    } catch (err) {
      logger.error(MOD, 'Failed to generate ROI report', { error: err });
      res.status(500).json({ error: 'Failed to generate ROI report' });
    }
  });

  /**
   * GET /trend?days=30
   * Daily ROI trend data for charting.
   */
  router.get('/trend', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const days = parseInt(req.query.days as string, 10) || 30;
      const trend = await getROIDailyTrend(days, cid);
      res.json({ success: true, data: trend });
    } catch (err) {
      logger.error(MOD, 'Failed to get ROI trend', { error: err });
      res.status(500).json({ error: 'Failed to get ROI trend' });
    }
  });

  /**
   * GET /summary?days=30
   * Quick summary: total savings, hours, ROI percentage.
   */
  router.get('/summary', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const days = parseInt(req.query.days as string, 10) || 30;

      const [roiData, dailyTrend] = await Promise.all([
        getROIData(days, cid),
        getROIDailyTrend(days, cid),
      ]);

      const report = calculateROI({
        ...roiData,
        windowDays: days,
        dailyTrend,
      });

      res.json({
        totalHoursSaved: report.metrics.totalHoursSaved,
        totalCostSaved: report.metrics.totalCostSaved,
        roiPercentage: report.metrics.roiPercentage,
        monthlyProjection: report.metrics.monthlyMaintenanceSaved,
        yearlyProjection: report.metrics.yearlyMaintenanceSaved,
        successRate: report.metrics.successRate,
        costReductionPercent: report.metrics.costReductionPercent,
      });
    } catch (err) {
      logger.error(MOD, 'Failed to get ROI summary', { error: err });
      res.status(500).json({ error: 'Failed to get ROI summary' });
    }
  });

  return router;
}
