/**
 * Release Risk Engine — API Routes
 *
 * GET /api/release-risk/assess?days=30    — Full risk assessment with score, signals, risk areas
 * GET /api/release-risk/trend?days=30     — Daily risk trend over time
 * GET /api/release-risk/signals           — Individual risk signal details
 * GET /api/release-risk/modules           — Module-level risk breakdown
 */

import { Router, type Request, type Response } from 'express';
import { getReleaseRiskData, getRiskTrend } from '../../db/postgres';
import { computeReleaseRisk, type ReleaseRiskResult } from '../../engines/release-risk-engine';
import { logger } from '../../utils/logger';

const MOD = 'release-risk-routes';

export function createReleaseRiskRouter(): Router {
  const router = Router();

  /**
   * GET /assess?days=30
   * Full release risk assessment.
   */
  router.get('/assess', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const days = parseInt(req.query.days as string, 10) || 30;
      const data = await getReleaseRiskData(days, cid);
      const result = computeReleaseRisk(data);
      res.json(result);
    } catch (err) {
      logger.error(MOD, 'Failed to assess release risk', { error: err });
      res.status(500).json({ error: 'Failed to assess release risk' });
    }
  });

  /**
   * GET /trend?days=30
   * Daily risk trend.
   */
  router.get('/trend', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const days = parseInt(req.query.days as string, 10) || 30;
      const trend = await getRiskTrend(days, cid);
      res.json(trend);
    } catch (err) {
      logger.error(MOD, 'Failed to get risk trend', { error: err });
      res.status(500).json({ error: 'Failed to get risk trend' });
    }
  });

  /**
   * GET /signals
   * Just the individual risk signals (subset of assess).
   */
  router.get('/signals', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const days = parseInt(req.query.days as string, 10) || 30;
      const data = await getReleaseRiskData(days, cid);
      const result = computeReleaseRisk(data);
      res.json(result.signals);
    } catch (err) {
      logger.error(MOD, 'Failed to get risk signals', { error: err });
      res.status(500).json({ error: 'Failed to get risk signals' });
    }
  });

  /**
   * GET /modules
   * Module-level risk breakdown.
   */
  router.get('/modules', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const days = parseInt(req.query.days as string, 10) || 30;
      const data = await getReleaseRiskData(days, cid);
      const result = computeReleaseRisk(data);
      res.json(result.riskAreas);
    } catch (err) {
      logger.error(MOD, 'Failed to get module risks', { error: err });
      res.status(500).json({ error: 'Failed to get module risks' });
    }
  });

  return router;
}
