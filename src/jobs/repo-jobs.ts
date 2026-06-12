/**
 * Repo job helpers — Phase 2 (Background Workers)
 * -----------------------------------------------
 * Thin convenience layer for enqueuing repository-intelligence jobs and
 * reading their status. Returns null when workers are disabled so callers can
 * cleanly fall back to the synchronous path.
 */

import { getRepoQueue, type RepoJobData } from './queue-config';
import { logger } from '../utils/logger';

const MOD = 'repo-jobs';

export interface EnqueuedJob {
  jobId: string;
  queued: true;
}

/**
 * Enqueue a repo scan/rescan/embed job. Returns null if the queue is
 * unavailable (workers disabled or Redis unreachable at enqueue time).
 */
export async function enqueueRepoJob(data: RepoJobData): Promise<EnqueuedJob | null> {
  const queue = getRepoQueue();
  if (!queue) return null;
  try {
    const job = await queue.add(data.type, data, {
      // Dedupe rapid duplicate scans of the same repo+branch within a short
      // window using a deterministic jobId is risky (blocks legitimate
      // re-scans), so we let BullMQ assign ids and rely on idempotent upserts.
      jobId: undefined,
    });
    logger.info(MOD, 'Enqueued repo job', { jobId: job.id, type: data.type, repoId: data.repoId });
    return { jobId: String(job.id), queued: true };
  } catch (err) {
    logger.warn(MOD, 'Failed to enqueue repo job — caller should fall back', {
      error: (err as Error).message,
    });
    return null;
  }
}

export interface RepoJobStatus {
  jobId: string;
  state: string; // waiting | active | completed | failed | delayed | unknown
  progress: unknown;
  result?: unknown;
  failedReason?: string;
  attemptsMade?: number;
  timestamp?: number;
}

/** Fetch the status of a previously-enqueued job, or null if not found. */
export async function getRepoJobStatus(jobId: string): Promise<RepoJobStatus | null> {
  const queue = getRepoQueue();
  if (!queue) return null;
  try {
    const job = await queue.getJob(jobId);
    if (!job) return null;
    const state = await job.getState().catch(() => 'unknown');
    return {
      jobId: String(job.id),
      state,
      progress: job.progress,
      result: job.returnvalue,
      failedReason: job.failedReason,
      attemptsMade: job.attemptsMade,
      timestamp: job.timestamp,
    };
  } catch (err) {
    logger.warn(MOD, 'Failed to fetch job status', { jobId, error: (err as Error).message });
    return null;
  }
}
