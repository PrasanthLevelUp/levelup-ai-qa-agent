/**
 * EmbeddingService — Phase 2 (Repository Intelligence / RAG)
 * ----------------------------------------------------------
 * A thin, lazily-initialised wrapper around the existing `OpenAIClient`
 * embedding helpers (src/ai/openai-client.ts). It exists so the RAG pipeline
 * (CodeChunkEmbedder, RAGService) has a single, mockable seam for turning text
 * into vectors without each call site having to construct an OpenAI client or
 * know the model name.
 *
 * Design constraints honoured here:
 *  - **Gated**: every public method is a no-op (returns null / []) unless
 *    FEATURE_FLAGS.REPO_INTELLIGENCE.VECTOR_SEARCH is enabled. This guarantees
 *    that with the flag off we never touch the OpenAI API or require a key.
 *  - **Lazy**: the underlying OpenAIClient is only constructed on first use, so
 *    merely importing this module never throws when OPENAI_API_KEY is absent.
 *  - **Resilient**: a missing key or an API error degrades gracefully (logged,
 *    returns null/empty) rather than crashing the caller. RAG is an
 *    enhancement, never a hard dependency.
 */

import { OpenAIClient } from '../ai/openai-client';
import { FEATURE_FLAGS } from '../config/features';
import { logger } from '../utils/logger';

const MOD = 'embedding-service';

/** Rough token estimate (≈4 chars/token) for bookkeeping/cost tracking. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface EmbeddingResult {
  embedding: number[];
  model: string;
  tokenCount: number;
}

export class EmbeddingService {
  private client: OpenAIClient | null = null;
  private clientInitFailed = false;
  private readonly model: string;

  constructor(opts?: { model?: string }) {
    this.model =
      opts?.model || process.env['OPENAI_EMBEDDING_MODEL'] || 'text-embedding-3-small';
  }

  /** Whether embeddings are enabled (feature flag on AND a key is available). */
  isEnabled(): boolean {
    if (!FEATURE_FLAGS.REPO_INTELLIGENCE.VECTOR_SEARCH) return false;
    if (this.clientInitFailed) return false;
    return Boolean(process.env['OPENAI_API_KEY']);
  }

  /** Lazily construct the OpenAI client; returns null if unavailable. */
  private getClient(): OpenAIClient | null {
    if (this.client) return this.client;
    if (this.clientInitFailed) return null;
    try {
      this.client = new OpenAIClient({ embeddingModel: this.model });
      return this.client;
    } catch (err) {
      this.clientInitFailed = true;
      logger.warn(MOD, 'OpenAI client init failed — embeddings disabled', {
        error: (err as Error).message,
      });
      return null;
    }
  }

  /**
   * Embed a single piece of text. Returns null when disabled or on error.
   */
  async embed(text: string): Promise<EmbeddingResult | null> {
    if (!this.isEnabled()) return null;
    const client = this.getClient();
    if (!client) return null;
    try {
      const embedding = await client.generateEmbedding(text);
      return { embedding, model: this.model, tokenCount: estimateTokens(text) };
    } catch (err) {
      logger.warn(MOD, 'embed() failed', { error: (err as Error).message });
      return null;
    }
  }

  /**
   * Embed many texts in batch. Returns an array aligned to the input order;
   * returns [] when disabled or on error (callers should treat [] as "skip").
   */
  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    if (!this.isEnabled() || texts.length === 0) return [];
    const client = this.getClient();
    if (!client) return [];
    try {
      const vectors = await client.batchGenerateEmbeddings(texts);
      return vectors.map((embedding, i) => ({
        embedding,
        model: this.model,
        tokenCount: estimateTokens(texts[i] ?? ''),
      }));
    } catch (err) {
      logger.warn(MOD, 'embedBatch() failed', { error: (err as Error).message });
      return [];
    }
  }

  /** Expose the model name for bookkeeping (e.g. persisting embedding_model). */
  getModel(): string {
    return this.model;
  }
}

/** Shared singleton — cheap to construct, lazy underneath. */
let _instance: EmbeddingService | null = null;
export function getEmbeddingService(): EmbeddingService {
  if (!_instance) _instance = new EmbeddingService();
  return _instance;
}
