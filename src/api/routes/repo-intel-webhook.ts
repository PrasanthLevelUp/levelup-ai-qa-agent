/**
 * Repository Intelligence GitHub Webhook — Phase 2
 * ------------------------------------------------
 * POST /api/repo-intel-webhook/github
 *
 * Receives GitHub `push` events and triggers an INCREMENTAL re-scan (and, if
 * RAG is enabled, re-embedding) of repositories we ALREADY track. This keeps a
 * repository's stored intelligence profile and code chunks fresh as code lands
 * on the default/tracked branch, without anyone manually re-running a scan.
 *
 * Safety / design:
 *  - Mounted WITHOUT auth middleware (webhooks are unauthenticated by GitHub),
 *    but only when FEATURE_FLAGS.REPO_INTELLIGENCE.GITHUB_WEBHOOKS is enabled.
 *    With the flag off, the route is never mounted — no new attack surface.
 *  - HMAC-SHA256 signature validation against GITHUB_WEBHOOK_SECRET. If a
 *    secret is configured, an invalid/missing signature is rejected (403).
 *  - It NEVER scans an arbitrary repo from an unsolicited payload: it only
 *    re-scans contexts whose stored repo_id matches a candidate identifier
 *    derived from the push payload (full_name / clone_url / html_url / ssh_url).
 *  - When background workers are enabled it ENQUEUES a rescan job; otherwise it
 *    runs the scan inline in a fire-and-forget manner so the webhook returns
 *    quickly (GitHub expects a fast 2xx).
 */

import { Router, type Request, type Response } from 'express';
import * as crypto from 'crypto';
import { findTrackedReposByCandidates } from '../../db/postgres';
import { enqueueRepoJob } from '../../jobs/repo-jobs';
import { workersEnabled } from '../../jobs/queue-config';
import { scanAndPersistRepo } from '../../services/repo-scan-service';
import { logger } from '../../utils/logger';

const MOD = 'repo-intel-webhook';

/**
 * Constant-time signature comparison that won't throw on length mismatch.
 * GitHub sends `sha256=<hex>` in the x-hub-signature-256 header. We compute the
 * HMAC over the serialised payload (matches the existing webhook convention).
 */
export function validateSignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Build the set of identifiers a stored repo_id might have been saved as. */
export function candidateRepoIds(repository: any): string[] {
  if (!repository) return [];
  const out: string[] = [];
  const push = (v?: string) => { if (v) out.push(v); };
  push(repository.full_name);            // owner/repo
  push(repository.html_url);             // https://github.com/owner/repo
  push(repository.clone_url);            // https://github.com/owner/repo.git
  push(repository.git_url);              // git://github.com/owner/repo.git
  push(repository.ssh_url);              // git@github.com:owner/repo.git
  push(repository.url);                  // api url
  if (repository.html_url) out.push(`${repository.html_url}.git`);
  return out;
}

export function createRepoIntelWebhookRouter(): Router {
  const router = Router();

  router.post('/github', async (req: Request, res: Response) => {
    const event = (req.headers['x-github-event'] as string) || '';
    const payload = req.body || {};

    // Signature validation (only enforced when a secret is configured).
    const secret = process.env['GITHUB_WEBHOOK_SECRET'];
    if (secret) {
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      if (!validateSignature(JSON.stringify(payload), signature, secret)) {
        logger.warn(MOD, 'Rejected webhook — invalid signature', { event });
        return res.status(403).json({ error: 'Forbidden', message: 'Invalid webhook signature' });
      }
    }

    // Only act on push events; ack everything else.
    if (event !== 'push') {
      return res.status(200).json({ message: `Event '${event}' acknowledged; no action taken` });
    }

    const repository = payload.repository;
    const repoUrl: string | undefined = repository?.clone_url || repository?.html_url;
    const branch = (payload.ref || '').replace('refs/heads/', '') || 'main';
    const commit = payload.after || payload.head_commit?.id;
    const defaultBranch = repository?.default_branch || 'main';

    if (!repoUrl) {
      return res.status(400).json({ error: 'Bad Request', message: 'No repository URL in payload' });
    }

    // Only re-scan the default branch by default (avoid churn on feature pushes).
    // Override via REPO_WEBHOOK_BRANCHES (comma-separated) or '*' for any branch.
    const allowed = (process.env.REPO_WEBHOOK_BRANCHES || defaultBranch)
      .split(',').map((s: string) => s.trim()).filter(Boolean);
    if (!allowed.includes('*') && !allowed.includes(branch)) {
      return res.status(200).json({ message: `Push to '${branch}' ignored (not a tracked branch)` });
    }

    // Resolve which tracked contexts this push affects.
    const tracked = await findTrackedReposByCandidates(candidateRepoIds(repository)).catch((err) => {
      logger.warn(MOD, 'Lookup of tracked repos failed', { error: (err as Error).message });
      return [] as Awaited<ReturnType<typeof findTrackedReposByCandidates>>;
    });

    if (tracked.length === 0) {
      logger.info(MOD, 'Push for untracked repo — ignored', {
        repo: repository?.full_name, branch,
      });
      return res.status(202).json({
        message: 'Repository is not tracked; no re-scan triggered.',
        repo: repository?.full_name,
      });
    }

    const triggered: Array<{ repoId: string; mode: 'queued' | 'inline'; jobId?: string }> = [];

    for (const ctx of tracked) {
      const jobData = {
        type: 'rescan' as const,
        repoId: ctx.repoId,
        repoPath: repoUrl,
        branch,
        projectId: ctx.projectId ?? undefined,
        companyId: ctx.companyId ?? undefined,
        source: 'webhook',
      };

      if (workersEnabled()) {
        const enq = await enqueueRepoJob(jobData);
        if (enq) {
          triggered.push({ repoId: ctx.repoId, mode: 'queued', jobId: enq.jobId });
          continue;
        }
        // Fall through to inline if enqueue failed (Redis down).
      }

      // Inline, fire-and-forget: don't block the webhook response.
      void scanAndPersistRepo({
        repoId: ctx.repoId,
        repoPath: repoUrl,
        branch,
        projectId: ctx.projectId ?? undefined,
        companyId: ctx.companyId ?? undefined,
      }).catch((err) => {
        logger.error(MOD, 'Inline webhook re-scan failed', {
          repoId: ctx.repoId, error: err.message,
        });
      });
      triggered.push({ repoId: ctx.repoId, mode: 'inline' });
    }

    logger.info(MOD, 'Webhook triggered re-scan(s)', {
      repo: repository?.full_name,
      branch,
      commit: commit?.slice?.(0, 8),
      count: triggered.length,
    });

    return res.status(202).json({
      message: `Re-scan triggered for ${triggered.length} tracked context(s).`,
      branch,
      triggered,
    });
  });

  return router;
}
