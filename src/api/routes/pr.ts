/**
 * PR Automation API Routes
 *
 * GET  /api/pr/recent        — Recent PRs
 * GET  /api/pr/job/:jobId     — PR for a specific job
 * PATCH /api/pr/:id/status    — Update PR status (merged/closed)
 */

import { Router, type Request, type Response } from 'express';
import { getPRForJob, getRecentPRs, updatePRStatus } from '../../db/postgres';

export function createPRRouter(): Router {
  const router = Router();

  /* ── Recent PRs ──────────────────────────────────────────────── */
  router.get('/recent', async (req: Request, res: Response) => {
    try {
      const limit = parseInt(req.query.limit as string) || 20;
      const prs = await getRecentPRs(limit);
      res.json({ success: true, data: prs, count: prs.length });
    } catch (err: any) {
      console.error('[PR] recent error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── PR for a job ───────────────────────────────────────────── */
  router.get('/job/:jobId', async (req: Request, res: Response) => {
    try {
      const jobId = req.params.jobId as string;
      const pr = await getPRForJob(jobId);
      if (!pr) {
        res.status(404).json({ success: false, error: 'No PR found for this job' });
        return;
      }
      res.json({ success: true, data: pr });
    } catch (err: any) {
      console.error('[PR] job PR error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Update PR status ──────────────────────────────────────── */
  router.patch('/:id/status', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string);
      const { status, mergedAt } = req.body as { status: string; mergedAt?: string };

      if (!status) {
        res.status(400).json({ success: false, error: 'Missing required field: status' });
        return;
      }

      await updatePRStatus(id, status, mergedAt);
      res.json({ success: true, message: `PR ${id} status updated to ${status}` });
    } catch (err: any) {
      console.error('[PR] update status error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
