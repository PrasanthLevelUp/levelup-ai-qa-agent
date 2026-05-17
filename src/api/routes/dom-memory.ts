/**
 * DOM Memory API Routes
 *
 * GET /api/dom/stats            — Overall DOM memory statistics
 * GET /api/dom/snapshots        — Recent DOM snapshots
 * GET /api/dom/selectors        — Selector health scores
 * GET /api/dom/selectors/distribution — Score distribution breakdown
 * GET /api/dom/locators         — Locator evolution (failed → healed)
 * GET /api/dom/trend            — Page/element trend over time
 */

import { Router, type Request, type Response } from 'express';
import {
  getDomMemoryStats,
  getDomSnapshots,
  getSelectorHealth,
  getLocatorEvolution,
  getPageElementTrend,
  getSelectorScoreDistribution,
} from '../../db/postgres';

export function createDomMemoryRouter(): Router {
  const router = Router();

  /* ── Stats ──────────────────────────────────────────────────── */
  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await getDomMemoryStats();
      res.json({ success: true, data: stats });
    } catch (err: any) {
      console.error('[DOM] stats error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Snapshots ──────────────────────────────────────────────── */
  router.get('/snapshots', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit || '50')) || 50;
      const snapshots = await getDomSnapshots(limit);
      res.json({ success: true, data: snapshots, count: snapshots.length });
    } catch (err: any) {
      console.error('[DOM] snapshots error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Selector Health ────────────────────────────────────────── */
  router.get('/selectors', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit || '100')) || 100;
      const selectors = await getSelectorHealth(limit);
      res.json({ success: true, data: selectors, count: selectors.length });
    } catch (err: any) {
      console.error('[DOM] selectors error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Selector Score Distribution ────────────────────────────── */
  router.get('/selectors/distribution', async (_req: Request, res: Response) => {
    try {
      const distribution = await getSelectorScoreDistribution();
      res.json({ success: true, data: distribution });
    } catch (err: any) {
      console.error('[DOM] selector distribution error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Locator Evolution ──────────────────────────────────────── */
  router.get('/locators', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(String(req.query.limit || '50')) || 50;
      const locators = await getLocatorEvolution(limit);
      res.json({ success: true, data: locators, count: locators.length });
    } catch (err: any) {
      console.error('[DOM] locators error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Page Element Trend ─────────────────────────────────────── */
  router.get('/trend', async (req: Request, res: Response) => {
    try {
      const days = parseInt(String(req.query.days || '30')) || 30;
      const trend = await getPageElementTrend(days);
      res.json({ success: true, data: trend });
    } catch (err: any) {
      console.error('[DOM] trend error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
