/**
 * CodeChunkEmbedder — Phase 2 (Repository Intelligence / RAG)
 * -----------------------------------------------------------
 * Generates and persists embeddings for the `code_chunks` rows belonging to a
 * repository context. This is the bridge between the (cheap, text-only)
 * Phase 1 chunk extraction and the (semantic) vector search used for few-shot
 * retrieval during script generation.
 *
 * It operates against the REAL schema (see src/db/postgres.ts):
 *   code_chunks(id SERIAL, repo_context_id INTEGER, content TEXT, ...,
 *               embedding vector(1536), embedding_model, embedded_at, token_count)
 *
 * Everything is gated: if VECTOR_SEARCH is off, or pgvector is unavailable, or
 * the embedding service is disabled, the methods are safe no-ops that report
 * zero work done.
 */

import {
  getUnembeddedChunks,
  updateChunkEmbedding,
  getEmbeddingStats,
  isPgVectorAvailable,
  type UnembeddedChunk,
} from '../db/postgres';
import { getEmbeddingService, EmbeddingService } from './embedding-service';
import { FEATURE_FLAGS } from '../config/features';
import { logger } from '../utils/logger';

const MOD = 'code-chunk-embedder';

export interface EmbedProgress {
  total: number;
  embedded: number;
  pending: number;
  processed: number;
  failed: number;
  skipped: boolean;
  reason?: string;
}

/**
 * Build the text that gets embedded for a chunk. We prepend lightweight
 * structural context (type + name + file) so semantically similar *intent*
 * (e.g. "login test", "auth helper") clusters together, not just raw bodies.
 */
function buildEmbeddingText(chunk: UnembeddedChunk): string {
  const header = `${chunk.chunkType} ${chunk.chunkName} (${chunk.filePath})`;
  return `${header}\n\n${chunk.content}`.slice(0, 8000);
}

export class CodeChunkEmbedder {
  private readonly embeddings: EmbeddingService;
  private readonly batchSize: number;

  constructor(opts?: { embeddings?: EmbeddingService; batchSize?: number }) {
    this.embeddings = opts?.embeddings ?? getEmbeddingService();
    this.batchSize = opts?.batchSize ?? 64;
  }

  /** Are all preconditions for embedding satisfied right now? */
  isEnabled(): boolean {
    return (
      FEATURE_FLAGS.REPO_INTELLIGENCE.VECTOR_SEARCH &&
      isPgVectorAvailable() &&
      this.embeddings.isEnabled()
    );
  }

  /**
   * Embed all not-yet-embedded chunks for a repository context.
   *
   * @param repoContextId the repository_contexts.id to embed
   * @param onProgress    optional progress callback (for worker job updates)
   * @param maxChunks     safety cap on chunks processed in one call
   */
  async embedRepositoryContext(
    repoContextId: number,
    onProgress?: (p: EmbedProgress) => void | Promise<void>,
    maxChunks = 2000,
  ): Promise<EmbedProgress> {
    const baseStats = await getEmbeddingStats(repoContextId).catch(() => ({
      total: 0,
      embedded: 0,
      pending: 0,
    }));

    if (!this.isEnabled()) {
      const reason = !FEATURE_FLAGS.REPO_INTELLIGENCE.VECTOR_SEARCH
        ? 'vector_search_disabled'
        : !isPgVectorAvailable()
          ? 'pgvector_unavailable'
          : 'embeddings_disabled';
      logger.info(MOD, 'Embedding skipped', { repoContextId, reason });
      return { ...baseStats, processed: 0, failed: 0, skipped: true, reason };
    }

    let processed = 0;
    let failed = 0;

    // Loop in pages until no unembedded chunks remain or we hit the cap.
    // getUnembeddedChunks always returns rows with embedding IS NULL, so each
    // successful page shrinks the working set.
    while (processed < maxChunks) {
      const pageLimit = Math.min(this.batchSize, maxChunks - processed);
      const chunks = await getUnembeddedChunks(repoContextId, pageLimit);
      if (chunks.length === 0) break;

      const texts = chunks.map(buildEmbeddingText);
      const results = await this.embeddings.embedBatch(texts);

      if (results.length !== chunks.length) {
        // Batch failed wholesale (returns []). Stop to avoid a hot loop.
        failed += chunks.length;
        logger.warn(MOD, 'Embedding batch returned no/short results — aborting', {
          repoContextId,
          expected: chunks.length,
          got: results.length,
        });
        break;
      }

      for (let i = 0; i < chunks.length; i++) {
        const r = results[i];
        try {
          await updateChunkEmbedding(chunks[i].id, r.embedding, r.model, r.tokenCount);
          processed++;
        } catch (err) {
          failed++;
          logger.warn(MOD, 'Failed to persist embedding', {
            chunkId: chunks[i].id,
            error: (err as Error).message,
          });
        }
      }

      if (onProgress) {
        const stats = await getEmbeddingStats(repoContextId).catch(() => baseStats);
        await onProgress({ ...stats, processed, failed, skipped: false });
      }
    }

    const finalStats = await getEmbeddingStats(repoContextId).catch(() => baseStats);
    logger.info(MOD, 'Embedding complete', {
      repoContextId,
      processed,
      failed,
      embedded: finalStats.embedded,
      total: finalStats.total,
    });
    return { ...finalStats, processed, failed, skipped: false };
  }
}

export function createCodeChunkEmbedder(opts?: {
  embeddings?: EmbeddingService;
  batchSize?: number;
}): CodeChunkEmbedder {
  return new CodeChunkEmbedder(opts);
}
