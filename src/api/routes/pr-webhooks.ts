/**
 * PR Status Webhook — GitHub `pull_request` events
 * =================================================
 * POST /api/pr-webhooks/github — Receive GitHub pull_request.closed (merged) events
 *                                 and update pr_automations.status + merged_at automatically.
 *
 * Flow:
 *   PR merged → Webhook fires → Match PR URL → Update pr_automations → Dashboard shows "Merged"
 *
 * This closes the healing lifecycle loop: Execution → Healing → PR Created → PR Merged → Available in Next Run.
 *
 * Signature verification:
 *   Uses GITHUB_WEBHOOK_SECRET (same as CI webhooks). The same webhook endpoint
 *   can be configured in GitHub repo settings for both workflow_run AND pull_request events.
 */

import { Router, type Request, type Response } from 'express';
import * as crypto from 'crypto';
import { logger } from '../../utils/logger';
import {
  getPRByUrl,
  updatePRStatus,
  logWebhookEvent,
  updateWebhookEventStatus,
} from '../../db/postgres';

const MOD = 'pr-webhooks';

export function createPRWebhookRouter(): Router {
  const router = Router();

  /**
   * POST /github — Receive GitHub pull_request events
   * 
   * The webhook fires on multiple PR actions (opened, closed, reopened, etc.).
   * We only care about `closed` with `merged=true`.
   */
  router.post('/github', async (req: Request, res: Response) => {
    const event = req.headers['x-github-event'] as string;
    const deliveryId = req.headers['x-github-delivery'] as string;
    const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
    const payload = req.body;

    logger.info(MOD, 'GitHub PR webhook received', {
      event,
      action: payload?.action,
      deliveryId,
      prNumber: payload?.pull_request?.number,
      prUrl: payload?.pull_request?.html_url,
    });

    // 1. Verify webhook signature (defense-in-depth; GitHub IP allowlist is the primary security layer)
    const secret = process.env['GITHUB_WEBHOOK_SECRET'];
    if (secret && signatureHeader) {
      const rawBody = JSON.stringify(req.body);
      const expectedSig = `sha256=${crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
      if (!crypto.timingSafeEqual(Buffer.from(signatureHeader), Buffer.from(expectedSig))) {
        logger.warn(MOD, 'GitHub PR webhook signature mismatch', { deliveryId });
        res.status(403).json({ error: 'Invalid signature' });
        return;
      }
    }

    // 2. Only handle pull_request events
    if (event !== 'pull_request') {
      logger.debug(MOD, 'Ignoring non-PR event', { event });
      res.status(200).json({ message: 'Ignored (not a pull_request event)' });
      return;
    }

    // 3. Extract PR details
    const action = payload?.action; // opened, closed, reopened, etc.
    const pr = payload?.pull_request;
    if (!pr || !pr.html_url) {
      logger.warn(MOD, 'PR webhook missing pull_request payload', { deliveryId });
      res.status(400).json({ error: 'Missing pull_request in payload' });
      return;
    }

    const prUrl = pr.html_url;
    const prNumber = pr.number;
    const merged = pr.merged === true;
    const mergedAt = pr.merged_at; // ISO 8601 string or null
    const state = pr.state; // open, closed

    // 4. Log webhook event (best-effort, non-critical)
    let eventId: number | null = null;
    try {
      eventId = await logWebhookEvent({
        companyId: 0, // PR webhooks are unauthenticated; company is inferred from pr_automations later
        eventType: 'pull_request',
        action,
        repoUrl: payload?.repository?.html_url,
        payloadSummary: { prNumber, prUrl, merged },
      });
    } catch (logErr) {
      logger.warn(MOD, 'Failed to log webhook event (non-critical)', { error: (logErr as Error).message });
    }

    // 5. Match PR URL to pr_automations
    let prRecord;
    try {
      prRecord = await getPRByUrl(prUrl);
    } catch (dbErr) {
      logger.error(MOD, 'Database error looking up PR', { prUrl, error: (dbErr as Error).message });
      res.status(500).json({ error: 'Internal server error' });
      return;
    }

    if (!prRecord) {
      logger.info(MOD, 'PR not found in pr_automations (may be a non-healing PR)', { prUrl, prNumber });
      if (eventId) {
        await updateWebhookEventStatus(eventId, 'ignored', 'PR not tracked by LevelUp').catch(() => {});
      }
      res.status(200).json({ message: 'PR not tracked (ignored)' });
      return;
    }

    // 6. Determine new status
    let newStatus = prRecord.status || 'open'; // Keep existing status by default
    let newMergedAt: string | undefined = prRecord.merged_at ?? undefined;

    if (action === 'closed' && merged) {
      newStatus = 'merged';
      newMergedAt = mergedAt || new Date().toISOString();
    } else if (action === 'closed' && !merged) {
      newStatus = 'closed';
    } else if (action === 'reopened') {
      newStatus = 'open';
    }
    // For 'opened', 'synchronize', etc., we keep the existing status (usually 'open').

    // 7. Update pr_automations if status changed
    if (newStatus !== prRecord.status || newMergedAt !== prRecord.merged_at) {
      try {
        await updatePRStatus(prRecord.id!, newStatus, newMergedAt);
        logger.info(MOD, 'PR status updated', {
          prId: prRecord.id,
          prUrl,
          prNumber,
          oldStatus: prRecord.status,
          newStatus,
          mergedAt: newMergedAt,
        });

        if (eventId) {
          await updateWebhookEventStatus(
            eventId,
            'processed',
            `PR #${prNumber} status updated: ${prRecord.status} → ${newStatus}`,
          ).catch(() => {});
        }

        res.status(200).json({
          message: 'PR status updated',
          prId: prRecord.id,
          oldStatus: prRecord.status,
          newStatus,
          mergedAt: newMergedAt,
        });
      } catch (updateErr) {
        logger.error(MOD, 'Failed to update PR status', {
          prId: prRecord.id,
          error: (updateErr as Error).message,
        });
        if (eventId) {
          await updateWebhookEventStatus(eventId, 'failed', (updateErr as Error).message).catch(() => {});
        }
        res.status(500).json({ error: 'Failed to update PR status' });
      }
    } else {
      logger.info(MOD, 'PR status unchanged', { prId: prRecord.id, prUrl, status: newStatus });
      if (eventId) {
        await updateWebhookEventStatus(eventId, 'processed', 'PR status unchanged').catch(() => {});
      }
      res.status(200).json({ message: 'PR status unchanged', prId: prRecord.id, status: newStatus });
    }
  });

  return router;
}
