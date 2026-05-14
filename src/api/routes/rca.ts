/**
 * RCA (Root Cause Analysis) API Routes
 *
 * GET  /api/rca/stats           — Aggregate RCA statistics
 * GET  /api/rca/job/:jobId       — All RCAs for a healing job
 * GET  /api/rca/:executionId     — Single RCA by test execution ID
 * POST /api/rca/analyze          — Manually trigger RCA for a failure
 */

import { Router, type Request, type Response } from 'express';
import { getRCA, getRCAsForJob, getRCAStats } from '../../db/postgres';
import { RCAEngine } from '../../engines/rca-engine';
import type { FailureDetails } from '../../core/failure-analyzer';

export function createRCARouter(): Router {
  const router = Router();

  /* ── Stats ──────────────────────────────────────────────────── */
  router.get('/stats', async (_req: Request, res: Response) => {
    try {
      const stats = await getRCAStats();
      res.json({ success: true, data: stats });
    } catch (err: any) {
      console.error('[RCA] stats error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── All RCAs for a job ─────────────────────────────────────── */
  router.get('/job/:jobId', async (req: Request, res: Response) => {
    try {
      const jobId = req.params.jobId as string;
      const rcas = await getRCAsForJob(jobId);
      res.json({ success: true, data: rcas, count: rcas.length });
    } catch (err: any) {
      console.error('[RCA] job RCAs error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Single RCA by execution ID ────────────────────────────── */
  router.get('/:executionId', async (req: Request, res: Response) => {
    try {
      const executionId = req.params.executionId as string;
      const rca = await getRCA(executionId);
      if (!rca) {
        res.status(404).json({ success: false, error: 'RCA not found' });
        return;
      }
      res.json({ success: true, data: rca });
    } catch (err: any) {
      console.error('[RCA] get error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Manual RCA analysis ────────────────────────────────────── */
  router.post('/analyze', async (req: Request, res: Response) => {
    try {
      const { failure, jobId, healingOutcome } = req.body as {
        failure: FailureDetails;
        jobId?: string;
        healingOutcome?: {
          attempted: boolean;
          succeeded: boolean;
          healedLocator?: string;
          strategy?: string;
        };
      };

      if (!failure || !failure.testName) {
        res.status(400).json({
          success: false,
          error: 'Missing required field: failure (with testName)',
        });
        return;
      }

      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        res.status(500).json({ success: false, error: 'OPENAI_API_KEY not configured' });
        return;
      }

      const engine = new RCAEngine({ apiKey });
      const result = await engine.analyze({
        failure,
        jobId: jobId ?? 'manual',
        healingAttempted: healingOutcome?.attempted ?? false,
        healingSucceeded: healingOutcome?.succeeded ?? false,
        healedLocator: healingOutcome?.healedLocator,
        healingStrategy: healingOutcome?.strategy,
      });

      res.json({ success: true, data: result });
    } catch (err: any) {
      console.error('[RCA] analyze error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
