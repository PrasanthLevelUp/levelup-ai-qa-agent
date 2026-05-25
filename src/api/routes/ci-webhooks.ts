/**
 * CI Webhooks — Autonomous Healing Pipeline
 *
 * POST /api/ci-webhooks/github       — Receive GitHub Actions workflow_run events
 * GET  /api/ci-webhooks/events        — List recent webhook events
 *
 * Flow:
 *   GitHub Action fails → Webhook fires → Parse failure → Queue healing job → Auto-PR
 *
 * Signature verification:
 *   Uses per-project webhook secret (stored in webhook_configs)
 *   OR global GITHUB_WEBHOOK_SECRET env variable as fallback.
 */

import { Router, type Request, type Response } from 'express';
import * as crypto from 'crypto';
import { logger } from '../../utils/logger';
import { JobQueue } from '../queue/job-queue';
import {
  findWebhookConfigByRepoUrl,
  getWebhookConfigBySecret,
  incrementWebhookEventCount,
  logWebhookEvent,
  updateWebhookEventStatus,
  getWebhookEvents,
} from '../../db/postgres';

const MOD = 'ci-webhooks';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

interface ParsedCIFailure {
  repoUrl: string;
  repoFullName: string;
  branch: string;
  commitSha: string;
  workflowName: string;
  workflowConclusion: string;
  runId: number;
  runUrl: string;
  action: string;
  sender: string;
}

/* -------------------------------------------------------------------------- */
/*  Router                                                                    */
/* -------------------------------------------------------------------------- */

export function createCIWebhookRouter(jobQueue: JobQueue): Router {
  const router = Router();

  /* ── POST /github — Main GitHub webhook receiver ────────────────── */
  router.post('/github', async (req: Request, res: Response) => {
    const event = req.headers['x-github-event'] as string;
    const deliveryId = req.headers['x-github-delivery'] as string;
    const signatureHeader = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = JSON.stringify(req.body);
    const payload = req.body;

    logger.info(MOD, 'GitHub CI webhook received', {
      event,
      action: payload?.action,
      deliveryId,
    });

    // 1. Try to identify the repo from payload
    const repoUrl = payload?.repository?.clone_url
      || payload?.repository?.html_url
      || payload?.repository?.url
      || '';
    const repoFullName = payload?.repository?.full_name || '';

    // 2. Look up webhook config by repo URL to get secret + company
    let webhookConfig = repoUrl ? await findWebhookConfigByRepoUrl(repoUrl) : null;

    // 3. Verify webhook signature
    const configSecret = webhookConfig?.webhook_secret;
    const globalSecret = process.env['GITHUB_WEBHOOK_SECRET'];
    const secretToVerify = configSecret || globalSecret;

    if (secretToVerify) {
      if (!verifySignature(rawBody, signatureHeader, secretToVerify)) {
        logger.warn(MOD, 'Invalid webhook signature', { deliveryId, repoUrl });
        return res.status(403).json({
          error: 'Forbidden',
          message: 'Invalid webhook signature',
        });
      }
    }

    // 4. Determine company ID (from webhook config, or default to 1)
    const companyId = webhookConfig?.company_id || 1;

    // 5. Log the raw webhook event
    const eventId = await logWebhookEvent({
      webhookConfigId: webhookConfig?.id,
      companyId,
      eventType: event,
      action: payload?.action,
      repoUrl,
      branch: extractBranch(payload),
      commitSha: extractCommitSha(payload),
      workflowName: payload?.workflow_run?.name || payload?.workflow?.name || null,
      workflowConclusion: payload?.workflow_run?.conclusion || null,
      payloadSummary: {
        deliveryId,
        sender: payload?.sender?.login,
        repoFullName,
      },
      status: 'received',
    });

    // 6. Increment event counter on webhook config
    if (webhookConfig?.id) {
      await incrementWebhookEventCount(webhookConfig.id).catch(() => {});
    }

    // 7. Route based on event type
    if (event === 'workflow_run' && payload?.action === 'completed') {
      return handleWorkflowRun(req, res, payload, jobQueue, webhookConfig, companyId, eventId);
    }

    if (event === 'check_suite' && payload?.action === 'completed') {
      return handleCheckSuite(req, res, payload, jobQueue, webhookConfig, companyId, eventId);
    }

    // For push events — queue healing proactively
    if (event === 'push') {
      return handlePush(req, res, payload, jobQueue, webhookConfig, companyId, eventId);
    }

    // Acknowledge other events without action
    await updateWebhookEventStatus(eventId, 'ignored');

    return res.status(200).json({
      message: `Event '${event}' acknowledged — no action required`,
      eventId,
    });
  });

  /* ── GET /events — List recent webhook events ───────────────────── */
  router.get('/events', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId || 1;
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const events = await getWebhookEvents(companyId, limit);
      return res.json({ success: true, events });
    } catch (err: any) {
      logger.error(MOD, 'Failed to fetch webhook events', { error: err.message });
      return res.status(500).json({ error: 'Failed to fetch events' });
    }
  });

  /* ── GET /health — Verify webhook endpoint is alive ─────────────── */
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      service: 'LevelUp AI CI Webhook Receiver',
      timestamp: new Date().toISOString(),
      capabilities: ['workflow_run', 'check_suite', 'push'],
    });
  });

  return router;
}

/* -------------------------------------------------------------------------- */
/*  Event Handlers                                                            */
/* -------------------------------------------------------------------------- */

async function handleWorkflowRun(
  _req: Request,
  res: Response,
  payload: any,
  jobQueue: JobQueue,
  webhookConfig: any,
  companyId: number,
  eventId: number,
): Promise<any> {
  const run = payload.workflow_run;
  const conclusion = run?.conclusion; // success, failure, cancelled, timed_out

  const parsed: ParsedCIFailure = {
    repoUrl: payload.repository?.clone_url || payload.repository?.html_url || '',
    repoFullName: payload.repository?.full_name || '',
    branch: run?.head_branch || 'main',
    commitSha: run?.head_sha || '',
    workflowName: run?.name || 'unknown',
    workflowConclusion: conclusion || 'unknown',
    runId: run?.id || 0,
    runUrl: run?.html_url || '',
    action: payload.action || '',
    sender: payload.sender?.login || '',
  };

  logger.info(MOD, 'Workflow run completed', {
    workflow: parsed.workflowName,
    conclusion,
    branch: parsed.branch,
    repo: parsed.repoFullName,
  });

  // Only trigger healing on failure or timed_out
  if (conclusion !== 'failure' && conclusion !== 'timed_out') {
    await updateWebhookEventStatus(eventId, 'skipped_success');
    return res.status(200).json({
      message: `Workflow '${parsed.workflowName}' ${conclusion} — no healing needed`,
      eventId,
      conclusion,
    });
  }

  // Queue healing job
  const job = jobQueue.createJob(
    parsed.repoFullName || parsed.repoUrl,
    parsed.branch,
    parsed.commitSha,
    parsed.repoUrl,
    companyId,
  );

  await updateWebhookEventStatus(eventId, 'healing_triggered', job.id);

  // Update event with workflow details
  await logWebhookEvent({
    webhookConfigId: webhookConfig?.id,
    companyId,
    eventType: 'workflow_run_failure',
    action: 'healing_triggered',
    repoUrl: parsed.repoUrl,
    branch: parsed.branch,
    commitSha: parsed.commitSha,
    workflowName: parsed.workflowName,
    workflowConclusion: conclusion,
    healingJobId: job.id,
    payloadSummary: {
      runId: parsed.runId,
      runUrl: parsed.runUrl,
      sender: parsed.sender,
    },
    status: 'healing_triggered',
  });

  logger.info(MOD, '🤖 Autonomous healing triggered from CI failure!', {
    jobId: job.id,
    workflow: parsed.workflowName,
    branch: parsed.branch,
    repo: parsed.repoFullName,
    conclusion,
  });

  return res.status(200).json({
    message: '🤖 Healing pipeline triggered automatically!',
    jobId: job.id,
    eventId,
    workflow: parsed.workflowName,
    conclusion,
    branch: parsed.branch,
    repo: parsed.repoFullName,
  });
}

async function handleCheckSuite(
  _req: Request,
  res: Response,
  payload: any,
  jobQueue: JobQueue,
  webhookConfig: any,
  companyId: number,
  eventId: number,
): Promise<any> {
  const suite = payload.check_suite;
  const conclusion = suite?.conclusion;

  if (conclusion !== 'failure' && conclusion !== 'timed_out') {
    await updateWebhookEventStatus(eventId, 'skipped_success');
    return res.status(200).json({
      message: `Check suite ${conclusion} — no healing needed`,
      eventId,
    });
  }

  const repoUrl = payload.repository?.clone_url || payload.repository?.html_url || '';
  const branch = suite?.head_branch || 'main';
  const commitSha = suite?.head_sha || '';

  const job = jobQueue.createJob(
    payload.repository?.full_name || repoUrl,
    branch,
    commitSha,
    repoUrl,
    companyId,
  );

  await updateWebhookEventStatus(eventId, 'healing_triggered', job.id);

  logger.info(MOD, '🤖 Healing triggered from check_suite failure', {
    jobId: job.id,
    branch,
    conclusion,
  });

  return res.status(200).json({
    message: '🤖 Healing triggered from check suite failure!',
    jobId: job.id,
    eventId,
    conclusion,
    branch,
  });
}

async function handlePush(
  _req: Request,
  res: Response,
  payload: any,
  _jobQueue: JobQueue,
  _webhookConfig: any,
  companyId: number,
  eventId: number,
): Promise<any> {
  // For push events, just log — healing is triggered by workflow failures, not pushes
  const branch = (payload.ref || '').replace('refs/heads/', '');
  const commitSha = payload.after || payload.head_commit?.id || '';
  const repoUrl = payload.repository?.clone_url || payload.repository?.html_url || '';

  await updateWebhookEventStatus(eventId, 'push_logged');

  logger.info(MOD, 'Push event logged', {
    branch,
    commitSha: commitSha.slice(0, 8),
    repo: payload.repository?.full_name,
    commits: payload.commits?.length || 0,
  });

  return res.status(200).json({
    message: 'Push event logged — healing will trigger when CI workflow fails',
    eventId,
    branch,
    commit: commitSha.slice(0, 8),
  });
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function extractBranch(payload: any): string {
  return payload?.workflow_run?.head_branch
    || payload?.check_suite?.head_branch
    || (payload?.ref || '').replace('refs/heads/', '')
    || 'main';
}

function extractCommitSha(payload: any): string {
  return payload?.workflow_run?.head_sha
    || payload?.check_suite?.head_sha
    || payload?.after
    || payload?.head_commit?.id
    || '';
}

/**
 * Verify GitHub webhook HMAC-SHA256 signature.
 * Uses timing-safe comparison to prevent timing attacks.
 */
function verifySignature(body: string, signature: string | undefined, secret: string): boolean {
  if (!signature) return false;
  try {
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (signature.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}
