/**
 * RAGService — Phase 2 (Repository Intelligence / RAG + Few-Shot Learning)
 * ------------------------------------------------------------------------
 * Retrieval-Augmented Generation over a repository's embedded `code_chunks`.
 * Given a natural-language query (e.g. a test requirement / feature
 * description) it embeds the query and finds the most semantically similar
 * code and test chunks within a single repository context, then formats them
 * as few-shot example blocks that the script-generation prompt can include.
 *
 * Gating & safety:
 *  - All retrieval is a no-op (returns [] / '') unless RAG retrieval is enabled
 *    (RAG_ENABLED && VECTOR_SEARCH) AND pgvector is available AND the embedding
 *    service is usable. So with flags off, generation behaviour is identical to
 *    Phase 1.
 *  - Every DB / embedding error is caught and degrades to "no examples", never
 *    breaking generation.
 *
 * Real-schema note: chunk types come from the Phase 1 extractor. Test chunks
 * are identified heuristically (chunk_type contains 'test' OR file path looks
 * like a test/spec file) because the extractor does not emit a dedicated
 * "test" chunk_type for every language.
 */

import {
  searchSimilarChunks,
  isPgVectorAvailable,
  type SimilarChunk,
} from '../db/postgres';
import { getEmbeddingService, EmbeddingService } from './embedding-service';
import { FEATURE_FLAGS, isRagRetrievalEnabled } from '../config/features';
import { logger } from '../utils/logger';

const MOD = 'rag-service';

export interface RagExample {
  filePath: string;
  chunkType: string;
  chunkName: string;
  content: string;
  similarity: number;
}

export interface RetrieveOptions {
  /** Max examples to return (default 5). */
  limit?: number;
  /** Minimum cosine similarity to include (default 0.3). */
  minSimilarity?: number;
  /** Restrict to a specific chunk_type. */
  type?: string;
  /** Max characters of each example body to include in formatted context. */
  maxCharsPerExample?: number;
}

/** Heuristic: does this hit look like an existing test/spec? */
function looksLikeTest(hit: SimilarChunk): boolean {
  const t = (hit.chunkType || '').toLowerCase();
  const f = (hit.filePath || '').toLowerCase();
  return (
    t.includes('test') ||
    t.includes('spec') ||
    /\.(test|spec)\.[tj]sx?$/.test(f) ||
    /(^|\/)(tests?|__tests__|specs?|e2e|cypress)(\/|$)/.test(f) ||
    /_test\.(py|go|rb|java)$/.test(f) ||
    /test_.*\.py$/.test(f)
  );
}

export class RAGService {
  private readonly embeddings: EmbeddingService;

  constructor(opts?: { embeddings?: EmbeddingService }) {
    this.embeddings = opts?.embeddings ?? getEmbeddingService();
  }

  /** Is RAG retrieval usable right now (flags + infra + embeddings)? */
  isEnabled(): boolean {
    return isRagRetrievalEnabled() && isPgVectorAvailable() && this.embeddings.isEnabled();
  }

  /**
   * Core retrieval: embed the query and return the most similar chunks within
   * the given repository context. Returns [] if RAG is unavailable.
   */
  async retrieve(
    repoContextId: number,
    query: string,
    opts: RetrieveOptions = {},
  ): Promise<RagExample[]> {
    if (!this.isEnabled() || !query?.trim()) return [];

    try {
      const embedded = await this.embeddings.embed(query);
      if (!embedded) return [];

      const hits = await searchSimilarChunks(repoContextId, embedded.embedding, {
        limit: opts.limit ?? 5,
        type: opts.type,
        minSimilarity: opts.minSimilarity ?? 0.3,
      });

      return hits.map((h) => ({
        filePath: h.filePath,
        chunkType: h.chunkType,
        chunkName: h.chunkName,
        content: h.content,
        similarity: h.similarity,
      }));
    } catch (err) {
      logger.warn(MOD, 'retrieve() failed — returning no examples', {
        repoContextId,
        error: (err as Error).message,
      });
      return [];
    }
  }

  /** Find code chunks similar to the query (non-test). */
  async findSimilarCode(
    repoContextId: number,
    query: string,
    opts: RetrieveOptions = {},
  ): Promise<RagExample[]> {
    const examples = await this.retrieve(repoContextId, query, {
      ...opts,
      limit: (opts.limit ?? 5) * 2, // over-fetch then filter out tests
    });
    const codeOnly = examples.filter(
      (e) => !looksLikeTest({ ...e, repoContextId, id: 0, lineStart: null, lineEnd: null, metadata: {} } as unknown as SimilarChunk),
    );
    return codeOnly.slice(0, opts.limit ?? 5);
  }

  /**
   * Find existing tests similar to the query — the heart of few-shot learning.
   * Over-fetches, then keeps only test-like hits.
   */
  async findSimilarTests(
    repoContextId: number,
    query: string,
    opts: RetrieveOptions = {},
  ): Promise<RagExample[]> {
    const limit = opts.limit ?? 3;
    const examples = await this.retrieve(repoContextId, query, {
      ...opts,
      limit: Math.max(limit * 3, 10), // over-fetch; tests may be sparse
    });
    const testsOnly = examples.filter((e) =>
      looksLikeTest({
        ...e,
        repoContextId,
        id: 0,
        lineStart: null,
        lineEnd: null,
        metadata: {},
      } as unknown as SimilarChunk),
    );
    return testsOnly.slice(0, limit);
  }

  /**
   * Build a prompt-ready few-shot context block from example tests. Returns an
   * empty string if there are no examples (caller can concatenate
   * unconditionally). Each example is trimmed to keep token usage bounded.
   */
  buildExamplesContext(examples: RagExample[], opts: { maxCharsPerExample?: number } = {}): string {
    if (!examples || examples.length === 0) return '';
    const maxChars = opts.maxCharsPerExample ?? 1200;

    const blocks = examples.map((ex, i) => {
      const body = ex.content.length > maxChars ? `${ex.content.slice(0, maxChars)}\n// …(truncated)` : ex.content;
      const sim = (ex.similarity * 100).toFixed(0);
      return [
        `### Example ${i + 1}: ${ex.chunkName} (${ex.filePath}) — ${sim}% similar`,
        '```',
        body.trim(),
        '```',
      ].join('\n');
    });

    return [
      'Here are existing tests from THIS repository that are most similar to the',
      'requirement. Mirror their structure, imports, assertions, naming, and',
      'framework conventions. Do NOT copy them verbatim — adapt to the new requirement.',
      '',
      ...blocks,
    ].join('\n');
  }

  /**
   * One-shot convenience used by script generation: find similar tests for a
   * requirement and return the formatted few-shot block (or '' if unavailable).
   */
  async buildFewShotBlock(
    repoContextId: number,
    requirement: string,
    opts: RetrieveOptions = {},
  ): Promise<{ block: string; examples: RagExample[] }> {
    if (!this.isEnabled()) return { block: '', examples: [] };
    const examples = await this.findSimilarTests(repoContextId, requirement, opts);
    if (examples.length === 0) return { block: '', examples: [] };
    return {
      block: this.buildExamplesContext(examples, { maxCharsPerExample: opts.maxCharsPerExample }),
      examples,
    };
  }
}

let _instance: RAGService | null = null;
export function getRAGService(): RAGService {
  if (!_instance) _instance = new RAGService();
  return _instance;
}

/** Re-export flag helper so callers can cheaply pre-check without infra. */
export function ragFlagsEnabled(): boolean {
  return FEATURE_FLAGS.REPO_INTELLIGENCE.RAG_ENABLED && FEATURE_FLAGS.REPO_INTELLIGENCE.VECTOR_SEARCH;
}
