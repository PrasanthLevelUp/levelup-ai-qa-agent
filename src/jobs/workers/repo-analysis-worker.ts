/**
 * Repo Analysis Worker — Phase 2 (Background Workers)
 * ---------------------------------------------------
 * Processes repository-intelligence jobs off the BullMQ queue:
 *   - 'scan' / 'rescan' → clone (if remote), scan, persist profile + chunks,
 *                         and (if RAG enabled) generate embeddings.
 *   - 'embed'           → (re)embed an already-scanned repository context.
 *
 * The processor reuses the SAME scanAndPersistRepo pipeline as the synchronous
 * HTTP route, so async and sync scans are behaviourally identical. Progress is
 * reported via BullMQ's job.updateProgress() so clients can poll status.
 *
 * Bootstrapping is lazy + gated: startRepoWorker() is a no-op unless the
 * BACKGROUND_WORKERS flag is on, so nothing connects to Redis by default.
 */

import type { Job, Worker } from 'bullmq';
import { createRepoWorker, type RepoJobData, type RepoJobResult } from '../queue-config';
import { scanAndPersistRepo } from '../../services/repo-scan-service';
import { createCodeChunkEmbedder } from '../../services/code-chunk-embedder';
import { UnsupportedLanguageError } from '../../context/repository-context-engine';
import { logger } from '../../utils/logger';

const MOD = 'repo-analysis-worker';

/** Process a single repo-intelligence job. Exported for unit testing. */
export async function processRepoJob(job: Job<RepoJobData, RepoJobResult>): Promise<RepoJobResult> {
  const data = job.data;
  logger.info(MOD, `Processing ${data.type} job`, { jobId: job.id, repoId: data.repoId });

  const report = async (stage: string, detail?: Record<string, any>) => {
    try {
      await job.updateProgress({ stage, ...detail });
    } catch { /* progress is best-effort */ }
  };

  try {
    if (data.type === 'embed') {
      if (!data.repoContextId) {
        return { ok: false, error: 'repoContextId required for embed job' };
      }
      await report('embedding', { repoContextId: data.repoContextId });
      const embedder = createCodeChunkEmbedder();
      const progress = await embedder.embedRepositoryContext(data.repoContextId, async (p) => {
        await report('embedding', { processed: p.processed, total: p.total });
      });
      await report('done');
      return { ok: true, contextId: data.repoContextId, embedded: progress.embedded };
    }

    // scan / rescan
    const result = await scanAndPersistRepo({
      repoId: data.repoId,
      repoPath: data.repoPath,
      branch: data.branch,
      projectId: data.projectId,
      companyId: data.companyId,
      onProgress: report,
    });

    return {
      ok: true,
      contextId: result.contextId,
      chunksInserted: result.chunksInserted,
      embedded: result.embed?.embedded,
      scanDurationMs: result.scanDurationMs,
    };
  } catch (err: any) {
    // Unsupported language is a permanent failure — do not let BullMQ retry it
    // 3×. We mark it failed with a clear, non-retryable message.
    if (err instanceof UnsupportedLanguageError) {
      logger.warn(MOD, 'Job rejected — unsupported language', {
        jobId: job.id,
        detected: err.detectedLanguage,
      });
      return { ok: false, error: `UNSUPPORTED_LANGUAGE: ${err.detectedLanguage}` };
    }
    logger.error(MOD, 'Repo job failed', { jobId: job.id, error: err.message });
    throw err; // allow retry/backoff for transient errors (network, clone, db)
  }
}

let _worker: Worker<RepoJobData, RepoJobResult> | null = null;

/**
 * Start the repo-analysis worker. No-op (returns null) when workers are
 * disabled. Safe to call once during server bootstrap.
 */
export function startRepoWorker(): Worker<RepoJobData, RepoJobResult> | null {
  if (_worker) return _worker;
  _worker = createRepoWorker(processRepoJob);
  if (_worker) {
    logger.info(MOD, 'Repo-analysis worker started');
  }
  return _worker;
}

/** Stop the worker (used on shutdown / in tests). */
export async function stopRepoWorker(): Promise<void> {
  if (_worker) {
    try { await _worker.close(); } catch { /* ignore */ }
    _worker = null;
  }
}
