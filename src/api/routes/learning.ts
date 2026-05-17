/**
 * Learning Engine API Routes
 *
 * GET /api/learning/stats        — Aggregate learning statistics
 * GET /api/learning/patterns     — Full patterns list
 * GET /api/learning/top           — Top patterns by usage
 * GET /api/learning/strategies   — Strategy effectiveness breakdown
 * GET /api/learning/velocity     — Learning velocity over time
 */

import { Router, type Request, type Response } from 'express';
import {
  getLearningStats,
  getPatternsList,
  getStrategyEffectiveness,
  getLearningVelocity,
  getTopPatterns,
} from '../../db/postgres';

export function createLearningRouter(): Router {
  const router = Router();

  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await getLearningStats();
      res.json({ success: true, data: stats });
    } catch (err: any) {
      console.error('[Learning] stats error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/patterns', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit || '100')) || 100;
      const patterns = await getPatternsList(limit);
      res.json({ success: true, data: patterns, count: patterns.length });
    } catch (err: any) {
      console.error('[Learning] patterns error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/top', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit || '10')) || 10;
      const top = await getTopPatterns(limit);
      res.json({ success: true, data: top });
    } catch (err: any) {
      console.error('[Learning] top patterns error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/strategies', async (_req: Request, res: Response) => {
    try {
      const strategies = await getStrategyEffectiveness();
      res.json({ success: true, data: strategies });
    } catch (err: any) {
      console.error('[Learning] strategies error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/velocity', async (req: Request, res: Response) => {
    try {
      const days = parseInt(String(req.query.days || '30')) || 30;
      const velocity = await getLearningVelocity(days);
      res.json({ success: true, data: velocity });
    } catch (err: any) {
      console.error('[Learning] velocity error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
