/**
 * Vector Similarity Engine — API Routes
 * Provides analytics on the semantic similarity engine's performance,
 * confidence distributions, locator pair analysis, and trend data.
 *
 * GET /api/similarity/stats           — Overall similarity engine statistics
 * GET /api/similarity/distribution    — Confidence score distribution buckets
 * GET /api/similarity/trend?days=30   — Similarity/confidence trends over time
 * GET /api/similarity/top-matches     — Top similarity matches ranked by confidence
 * GET /api/similarity/pairs           — Recurring failed→healed locator pairs
 * GET /api/similarity/locator-types   — Locator type breakdown
 * POST /api/similarity/compare        — Live comparison between two values
 */

import { Router, type Request, type Response } from 'express';
import {
  getSimilarityStats,
  getConfidenceDistribution,
  getSimilarityTrend,
  getTopSimilarityMatches,
  getLocatorPairAnalysis,
  getSemanticGroupStats,
} from '../../db/postgres';
import { SemanticSimilarityEngine } from '../../engines/semantic-similarity-engine';
import { logger } from '../../utils/logger';

const MOD = 'similarity-routes';

// Singleton for on-demand comparisons
const engine = new SemanticSimilarityEngine();

export function createSimilarityRouter(): Router {
  const router = Router();

  /**
   * GET /stats
   * Overall similarity engine statistics.
   */
  router.get('/stats', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const pid = (req as any).projectId;
      const stats = await getSimilarityStats(cid, pid);
      res.json(stats);
    } catch (err) {
      logger.error(MOD, 'Failed to get similarity stats', { error: err });
      res.status(500).json({ error: 'Failed to get similarity stats' });
    }
  });

  /**
   * GET /distribution
   * Confidence score distribution buckets.
   */
  router.get('/distribution', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const pid = (req as any).projectId;
      const distribution = await getConfidenceDistribution(cid, pid);
      res.json(distribution);
    } catch (err) {
      logger.error(MOD, 'Failed to get confidence distribution', { error: err });
      res.status(500).json({ error: 'Failed to get confidence distribution' });
    }
  });

  /**
   * GET /trend?days=30
   * Similarity/confidence trends over time.
   */
  router.get('/trend', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const pid = (req as any).projectId;
      const days = parseInt(req.query.days as string, 10) || 30;
      const trend = await getSimilarityTrend(days, cid, pid);
      res.json(trend);
    } catch (err) {
      logger.error(MOD, 'Failed to get similarity trend', { error: err });
      res.status(500).json({ error: 'Failed to get similarity trend' });
    }
  });

  /**
   * GET /top-matches?limit=20
   * Top similarity matches ranked by confidence.
   */
  router.get('/top-matches', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const pid = (req as any).projectId;
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const matches = await getTopSimilarityMatches(limit, cid, pid);
      res.json(matches);
    } catch (err) {
      logger.error(MOD, 'Failed to get top matches', { error: err });
      res.status(500).json({ error: 'Failed to get top matches' });
    }
  });

  /**
   * GET /pairs?limit=20
   * Locator pair analysis — recurring failed→healed pairs.
   */
  router.get('/pairs', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const pid = (req as any).projectId;
      const limit = parseInt(req.query.limit as string, 10) || 20;
      const pairs = await getLocatorPairAnalysis(limit, cid, pid);
      res.json(pairs);
    } catch (err) {
      logger.error(MOD, 'Failed to get locator pairs', { error: err });
      res.status(500).json({ error: 'Failed to get locator pairs' });
    }
  });

  /**
   * GET /locator-types
   * Semantic group / locator type breakdown.
   */
  router.get('/locator-types', async (req: Request, res: Response) => {
    try {
      const cid = (req as any).companyId;
      const pid = (req as any).projectId;
      const stats = await getSemanticGroupStats(cid, pid);
      res.json(stats);
    } catch (err) {
      logger.error(MOD, 'Failed to get locator type stats', { error: err });
      res.status(500).json({ error: 'Failed to get locator type stats' });
    }
  });

  /**
   * POST /compare
   * Live comparison between two values using the similarity engine.
   * Body: { failedValue: string, candidateValue: string, context?: { sameTag?, sameAttributeType? } }
   */
  router.post('/compare', async (req: Request, res: Response) => {
    try {
      const { failedValue, candidateValue, context } = req.body;
      if (!failedValue || !candidateValue) {
        return res.status(400).json({ error: 'failedValue and candidateValue are required' });
      }
      const result = engine.compare(failedValue, candidateValue, context);
      res.json(result);
    } catch (err) {
      logger.error(MOD, 'Failed to compare values', { error: err });
      res.status(500).json({ error: 'Failed to compare values' });
    }
  });

  return router;
}
