/**
 * API Routes — Traceability Links (RTM), Sprint 3
 * ================================================
 * Manage the explicit links that connect Requirements → Test Cases → Scripts
 * → Executions. Scope (companyId / projectId / userId) is injected by the
 * auth / company / project-context middleware chain applied at registration
 * time in server.ts — this router only reads `(req as any).companyId` etc.
 *
 * Endpoints:
 *   POST   /link              link a test case to a requirement
 *   DELETE /link/:id          remove a traceability link
 *   GET    /requirement/:id   list all links for a requirement
 *
 * Route ordering note: static paths are declared before parametric `/:id`
 * routes so Express does not match them as an id.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import {
  linkTestCaseToRequirement,
  deleteTraceabilityLink,
  getTraceabilityForRequirement,
} from '../../db/postgres';

const MOD = 'traceability-routes';

export function createTraceabilityRouter(): Router {
  const router = Router();

  /* ─── Link a test case to a requirement ──────────────────────────── */
  router.post('/link', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId ?? null;
      const userId = (req as any).userId ?? null;

      // Accept both camelCase and snake_case for friendliness with clients.
      const requirementId: string | undefined =
        req.body?.requirementId ?? req.body?.requirement_id;
      const rawTestCaseId = req.body?.testCaseId ?? req.body?.test_case_id;

      if (!requirementId || typeof requirementId !== 'string') {
        return res.status(400).json({ success: false, error: 'requirementId is required' });
      }
      const testCaseId = Number(rawTestCaseId);
      if (!rawTestCaseId || !Number.isInteger(testCaseId) || testCaseId <= 0) {
        return res
          .status(400)
          .json({ success: false, error: 'A valid testCaseId (integer) is required' });
      }

      const result = await linkTestCaseToRequirement({
        testCaseId,
        requirementId,
        companyId,
        projectId,
        userId,
      });

      if (result.status === 'requirement_not_found') {
        return res.status(404).json({ success: false, error: 'Requirement not found' });
      }
      if (result.status === 'test_case_not_found') {
        return res.status(404).json({ success: false, error: 'Test case not found' });
      }

      logger.info(MOD, 'Linked test case to requirement', { requirementId, testCaseId });
      return res.status(201).json({ success: true, data: result.link });
    } catch (error: any) {
      logger.error(MOD, 'Failed to create traceability link', { error: error?.message });
      return res.status(500).json({ success: false, error: 'Failed to create traceability link' });
    }
  });

  /* ─── Delete a traceability link ─────────────────────────────────── */
  router.delete('/link/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const id = String(req.params.id);

      const deleted = await deleteTraceabilityLink(id, companyId);
      if (!deleted) {
        return res.status(404).json({ success: false, error: 'Traceability link not found' });
      }

      logger.info(MOD, 'Deleted traceability link', { id });
      return res.json({ success: true, data: deleted });
    } catch (error: any) {
      logger.error(MOD, 'Failed to delete traceability link', { error: error?.message });
      return res.status(500).json({ success: false, error: 'Failed to delete traceability link' });
    }
  });

  /* ─── Get all links for a requirement ────────────────────────────── */
  router.get('/requirement/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const id = String(req.params.id);

      const result = await getTraceabilityForRequirement(id, companyId);
      if (!result) {
        return res.status(404).json({ success: false, error: 'Requirement not found' });
      }

      return res.json({ success: true, data: result });
    } catch (error: any) {
      logger.error(MOD, 'Failed to get traceability for requirement', { error: error?.message });
      return res
        .status(500)
        .json({ success: false, error: 'Failed to get traceability for requirement' });
    }
  });

  return router;
}
