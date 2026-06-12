/**
 * BullMQ queue configuration — Phase 2 (Background Workers)
 * ---------------------------------------------------------
 * Central, LAZY accessor for the repository-analysis job queue and its Redis
 * connection. The single most important property of this module: importing it
 * must NEVER open a Redis connection or throw. A connection is only created on
 * the first call to `getRepoQueue()` / `createRepoWorker()`, and only when the
 * BACKGROUND_WORKERS feature flag is enabled.
 *
 * With the flag off (the default), every accessor returns null, so:
 *   - the API falls back to the synchronous scan path, and
 *   - a deployment without Redis starts cleanly with zero Redis traffic.
 */

import type { Queue, Worker, Processor, ConnectionOptions } from 'bullmq';
import { FEATURE_FLAGS } from '../config/features';
import { logger } from '../utils/logger';

const MOD = 'queue-config';

/** Canonical queue name for repository analysis / embedding jobs. */
export const REPO_QUEUE_NAME = 'repo-intelligence';

/** Job type discriminator carried in the job payload. */
export type RepoJobType = 'scan' | 'rescan' | 'embed';

export interface RepoJobData {
  type: RepoJobType;
  repoId: string;
  repoPath: string;
  branch?: string;
  projectId?: number;
  companyId?: number;
  /** For 'embed' jobs that target an already-scanned context. */
  repoContextId?: number;
  /** Free-form origin marker, e.g. 'api', 'webhook'. */
  source?: string;
}

export interface RepoJobResult {
  ok: boolean;
  contextId?: number;
  chunksInserted?: number;
  embedded?: number;
  scanDurationMs?: number;
  error?: string;
}

/**
 * Build ioredis connection options from REDIS_URL (or host/port fallbacks).
 * `maxRetriesPerRequest: null` is REQUIRED by BullMQ workers.
 */
function buildConnection(): ConnectionOptions {
  const url = process.env.REDIS_URL || process.env.REDIS_CONNECTION_STRING;
  if (url) {
    // BullMQ accepts a connection string via the `url`-like options object.
    return { url } as unknown as ConnectionOptions;
  }
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
  } as ConnectionOptions;
}

/** Is the background-worker subsystem enabled by configuration? */
export function workersEnabled(): boolean {
  return FEATURE_FLAGS.REPO_INTELLIGENCE.BACKGROUND_WORKERS;
}

let _queue: Queue<RepoJobData, RepoJobResult> | null = null;
let _queueInitFailed = false;

/**
 * Get (lazily creating) the shared repo-intelligence Queue. Returns null when
 * workers are disabled or the BullMQ/Redis modules cannot be loaded.
 */
export function getRepoQueue(): Queue<RepoJobData, RepoJobResult> | null {
  if (!workersEnabled() || _queueInitFailed) return null;
  if (_queue) return _queue;
  try {
    // Require lazily so a flag-off deployment never loads bullmq at all.
    const { Queue } = require('bullmq') as typeof import('bullmq');
    _queue = new Queue<RepoJobData, RepoJobResult>(REPO_QUEUE_NAME, {
      connection: buildConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { age: 24 * 3600, count: 200 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
    _queue.on('error', (err) => {
      // Surface connection errors without crashing the process.
      logger.warn(MOD, 'Repo queue error (Redis reachable?)', { error: err.message });
    });
    logger.info(MOD, 'Repo-intelligence queue initialised');
    return _queue;
  } catch (err) {
    _queueInitFailed = true;
    logger.warn(MOD, 'Failed to initialise repo queue — async scans disabled', {
      error: (err as Error).message,
    });
    return null;
  }
}

/**
 * Create a BullMQ Worker for the repo queue. Returns null when workers are
 * disabled or BullMQ cannot be loaded. The caller supplies the processor.
 */
export function createRepoWorker(
  processor: Processor<RepoJobData, RepoJobResult>,
): Worker<RepoJobData, RepoJobResult> | null {
  if (!workersEnabled()) return null;
  try {
    const { Worker } = require('bullmq') as typeof import('bullmq');
    const worker = new Worker<RepoJobData, RepoJobResult>(REPO_QUEUE_NAME, processor, {
      connection: buildConnection(),
      concurrency: Number(process.env.REPO_WORKER_CONCURRENCY || 2),
    });
    worker.on('failed', (job, err) => {
      logger.warn(MOD, 'Repo job failed', { jobId: job?.id, error: err?.message });
    });
    worker.on('error', (err) => {
      logger.warn(MOD, 'Repo worker error (Redis reachable?)', { error: err.message });
    });
    return worker;
  } catch (err) {
    logger.warn(MOD, 'Failed to create repo worker', { error: (err as Error).message });
    return null;
  }
}

/** Gracefully close the queue (used on shutdown / in tests). */
export async function closeRepoQueue(): Promise<void> {
  if (_queue) {
    try { await _queue.close(); } catch { /* ignore */ }
    _queue = null;
  }
}
