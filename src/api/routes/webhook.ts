/**
 * POST /api/webhook/github — Accept GitHub Actions webhook
 */

import { Router, type Request, type Response } from 'express';
import * as crypto from 'crypto';
import { JobQueue } from '../queue/job-queue';
import { RepoManager } from '../services/repo-manager';
import { logger } from '../../utils/logger';

const MOD = 'webhook';
const router = Router();

export function createWebhookRouter(jobQueue: JobQueue, repoManager: RepoManager): Router {
  router.post('/github', (req: Request, res: Response) => {
    const event = req.headers['x-github-event'] as string;
    const payload = req.body;

    logger.info(MOD, 'GitHub webhook received', {
      event,
      action: payload?.action,
    });

    // Optional: validate GitHub signature
    const secret = process.env['GITHUB_WEBHOOK_SECRET'];
    if (secret) {
      const signature = req.headers['x-hub-signature-256'] as string;
      if (!validateSignature(JSON.stringify(payload), signature, secret)) {
        res.status(403).json({ error: 'Forbidden', message: 'Invalid webhook signature' });
        return;
      }
    }

    // Handle relevant events
    if (event === 'push' || event === 'workflow_run') {
      const repoUrl = payload?.repository?.clone_url || payload?.repository?.html_url;
      const branch = payload?.ref?.replace('refs/heads/', '') || 'main';
      const commit = payload?.after || payload?.head_commit?.id;

      if (!repoUrl) {
        res.status(400).json({ error: 'Bad Request', message: 'Unable to extract repository URL from payload' });
        return;
      }

      // Find configured repo
      const repo = repoManager.findRepo(repoUrl);
      const repoId = repo?.id || repoUrl;

      const job = jobQueue.createJob(repoId, branch, commit, repoUrl);

      logger.info(MOD, 'Healing job created from webhook', {
        jobId: job.id,
        event,
        branch,
        commit: commit?.slice(0, 8),
      });

      res.status(200).json({
        jobId: job.id,
        message: 'Healing job queued from webhook',
        status: job.status,
      });
      return;
    }

    // For other events, just acknowledge
    res.status(200).json({ message: `Event '${event}' acknowledged but no action taken` });
  });

  return router;
}

function validateSignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}
