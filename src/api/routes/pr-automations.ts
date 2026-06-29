/**
 * PR Automations Management — Dashboard sync and status reconciliation
 * ====================================================================
 * GET /api/pr-automations/:id/sync — Fetch live GitHub PR status and reconcile DB
 *
 * This is the backstop for missed/dropped webhooks. The dashboard calls this on
 * page load (or on user action) to ensure the status displayed is always correct.
 *
 * Flow:
 *   Dashboard loads PR details → calls /sync → fetch GitHub API → update DB if stale
 */

import { Router, type Request, type Response } from 'express';
import axios from 'axios';
import { logger } from '../../utils/logger';
import { getPRForJob, updatePRStatus, type PRRecord } from '../../db/postgres';

const MOD = 'pr-automations';

export function createPRAutomationsRouter(): Router {
  const router = Router();

  /**
   * GET /:id/sync — Fetch live GitHub PR status and reconcile DB
   * 
   * The PR record (pr_automations) contains repo_owner, repo_name, pr_number.
   * We call GitHub API to get the current state/merged status, then update our DB
   * if it differs.
   * 
   * Auth: This route is behind authMiddleware + companyMiddleware (via server.ts).
   */
  router.get('/:id/sync', async (req: Request, res: Response) => {
    const idParam = req.params['id'];
    const prId = parseInt(Array.isArray(idParam) ? idParam[0] : idParam, 10);
    if (!prId || isNaN(prId)) {
      res.status(400).json({ error: 'Bad Request', message: 'Invalid PR ID' });
      return;
    }

    // 1. Fetch PR record from DB
    let prRecord: PRRecord | null = null;
    try {
      const result = await (req as any).db.query(
        `SELECT * FROM pr_automations WHERE id = $1`,
        [prId],
      );
      prRecord = result.rows[0] ?? null;
    } catch (dbErr) {
      logger.error(MOD, 'Database error fetching PR', { prId, error: (dbErr as Error).message });
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    if (!prRecord) {
      res.status(404).json({ error: 'Not Found', message: `PR automation record not found: ${prId}` });
      return;
    }

    const { repo_owner, repo_name, pr_number } = prRecord;

    // 2. Fetch live PR status from GitHub API
    const githubToken = process.env['GITHUB_TOKEN'];
    if (!githubToken) {
      logger.warn(MOD, 'GITHUB_TOKEN not configured, cannot sync PR status', { prId });
      res.status(503).json({ error: 'Service unavailable', message: 'GitHub integration not configured' });
      return;
    }

    let githubPR: any;
    try {
      const url = `https://api.github.com/repos/${repo_owner}/${repo_name}/pulls/${pr_number}`;
      const response = await axios.get(url, {
        headers: {
          Authorization: `token ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
        },
        timeout: 10000,
      });
      githubPR = response.data;
    } catch (apiErr: any) {
      logger.error(MOD, 'GitHub API error fetching PR', {
        prId,
        owner: repo_owner,
        repo: repo_name,
        prNumber: pr_number,
        error: apiErr.message,
        status: apiErr.response?.status,
      });
      res.status(502).json({ error: 'Bad Gateway', message: 'Failed to fetch PR from GitHub' });
      return;
    }

    // 3. Determine live status
    const state = githubPR.state; // 'open' or 'closed'
    const merged = githubPR.merged === true;
    const mergedAt = githubPR.merged_at; // ISO 8601 string or null

    let liveStatus = 'open';
    if (state === 'closed' && merged) {
      liveStatus = 'merged';
    } else if (state === 'closed' && !merged) {
      liveStatus = 'closed';
    }

    // 4. Update DB if status differs
    const dbStatus = prRecord.status || 'open';
    if (liveStatus !== dbStatus || (liveStatus === 'merged' && !prRecord.merged_at && mergedAt)) {
      try {
        await updatePRStatus(prId, liveStatus, mergedAt || undefined);
        logger.info(MOD, 'PR status synced from GitHub', {
          prId,
          owner: repo_owner,
          repo: repo_name,
          prNumber: pr_number,
          oldStatus: dbStatus,
          newStatus: liveStatus,
          mergedAt,
        });

        res.status(200).json({
          message: 'PR status synced',
          prId,
          oldStatus: dbStatus,
          newStatus: liveStatus,
          mergedAt: mergedAt || prRecord.merged_at,
          synced: true,
        });
      } catch (updateErr) {
        logger.error(MOD, 'Failed to update PR status during sync', {
          prId,
          error: (updateErr as Error).message,
        });
        res.status(500).json({ error: 'Failed to update PR status' });
      }
    } else {
      logger.debug(MOD, 'PR status already up-to-date', { prId, status: dbStatus });
      res.status(200).json({
        message: 'PR status already up-to-date',
        prId,
        status: dbStatus,
        mergedAt: prRecord.merged_at,
        synced: false,
      });
    }
  });

  return router;
}
