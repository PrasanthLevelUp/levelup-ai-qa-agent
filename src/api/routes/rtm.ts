/**
 * API Routes — Requirements Traceability Matrix (RTM), Sprint 2
 * =============================================================
 * Read/analytics endpoints layered over the RTM schema:
 *   • GET /matrix            full traceability matrix (requirements + linked
 *                            test cases / scripts / latest execution + rollups)
 *   • GET /gaps              gap analysis (uncovered / failing / high-priority
 *                            incomplete requirements, categorized)
 *   • GET /traceability/:id  per-requirement drill-down chain + timeline + stats
 *   • GET /statistics        coverage rollups by category / priority + trends
 *
 * Scope (companyId / projectId) is injected by the auth / company / project-
 * context middleware chain applied at registration time in server.ts — this
 * router only reads `(req as any).companyId` etc.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import { RTMService } from '../../services/rtm-service';

const MOD = 'rtm-routes';

export function createRtmRouter(): Router {
  const router = Router();
  const service = new RTMService();

  /* ─── Full traceability matrix ───────────────────────────────────── */
  router.get('/matrix', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId ?? null;
      const { category, priority, status } = req.query;

      const matrix = await service.getMatrix({
        companyId,
        projectId,
        category: category ? String(category) : undefined,
        priority: priority ? String(priority) : undefined,
        status: status ? String(status) : undefined,
      });

      res.json({ success: true, data: matrix });
    } catch (error: any) {
      logger.error(MOD, 'Failed to get RTM matrix', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to get RTM matrix' });
    }
  });

  /* ─── Gap analysis ───────────────────────────────────────────────── */
  router.get('/gaps', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId ?? null;

      const gaps = await service.getGaps(companyId, projectId);
      res.json({ success: true, data: gaps });
    } catch (error: any) {
      logger.error(MOD, 'Failed to get gap analysis', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to get gap analysis' });
    }
  });

  /* ─── Coverage statistics (STATIC — must precede /:id-style routes) ─ */
  router.get('/statistics', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId ?? null;

      const stats = await service.getStatistics(companyId, projectId);
      res.json({ success: true, data: stats });
    } catch (error: any) {
      logger.error(MOD, 'Failed to get RTM statistics', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to get RTM statistics' });
    }
  });

  /* ─── Per-requirement traceability drill-down ────────────────────── */
  router.get('/traceability/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const traceability = await service.getTraceability(String(req.params.id), companyId);

      if (!traceability) {
        return res.status(404).json({ success: false, error: 'Requirement not found' });
      }
      res.json({ success: true, data: traceability });
    } catch (error: any) {
      logger.error(MOD, 'Failed to get traceability', { error: error?.message });
      res.status(500).json({ success: false, error: 'Failed to get traceability' });
    }
  });

  return router;
}
