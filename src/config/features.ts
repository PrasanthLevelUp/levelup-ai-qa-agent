/**
 * Centralized feature flags.
 *
 * Phase 1 of the Repository Intelligence improvements introduces gated
 * behaviour so we can ship incremental fixes without dead/expensive code
 * paths running in production. Flags are read from the environment once at
 * module load; defaults are conservative (off) for not-yet-ready features.
 */

function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw.trim());
}

export const FEATURE_FLAGS = {
  REPO_INTELLIGENCE: {
    /**
     * Persist extracted `code_chunks` rows during a repository scan.
     *
     * Disabled by default: chunks are currently only read by the read-only
     * `/chunks` API and are NOT used in generation, healing, or RCA (see Repo
     * Intelligence Audit, Finding F1). Skipping extraction + storage removes a
     * large block of per-scan CPU and ~50% of the DB writes per scan. Re-enable
     * once the RAG / vector-search retrieval path (Phase 2) consumes them.
     *
     * Enable with: ENABLE_CODE_CHUNKS=true
     */
    CODE_CHUNKS_STORAGE: envBool('ENABLE_CODE_CHUNKS', false),

    /**
     * RAG retrieval over code_chunks — Phase 2.
     *
     * When enabled, the script-generation prompt is augmented with semantically
     * similar code/test snippets retrieved from the repository's embedded
     * `code_chunks` (few-shot learning). Requires VECTOR_SEARCH + a configured
     * OpenAI embedding model + pgvector. Default off so generation behaviour is
     * unchanged when the embedding/vector infra is absent.
     *
     * Enable with: ENABLE_REPO_RAG=true
     */
    RAG_ENABLED: envBool('ENABLE_REPO_RAG', false),

    /**
     * Vector/embedding search over code_chunks — Phase 2.
     *
     * Gates the pgvector migration (embedding column + ivfflat index), the
     * embedding-generation pipeline, and the cosine-distance similarity search
     * helpers. Default off: when disabled the DB migration is skipped and no
     * embeddings are generated, so a database without the `vector` extension is
     * never touched.
     *
     * Enable with: ENABLE_REPO_VECTOR_SEARCH=true
     */
    VECTOR_SEARCH: envBool('ENABLE_REPO_VECTOR_SEARCH', false),

    /**
     * Background workers (BullMQ + Redis) for asynchronous repository
     * scanning and embedding generation — Phase 2.
     *
     * When enabled, POST /api/repo-intelligence/scan enqueues a job instead of
     * blocking the request, and progress can be polled via the job-status
     * endpoint. Requires a reachable Redis (REDIS_URL). Default off: the
     * synchronous scan path is preserved and no Redis connection is opened at
     * startup when this is disabled.
     *
     * Enable with: ENABLE_REPO_WORKERS=true
     */
    BACKGROUND_WORKERS: envBool('ENABLE_REPO_WORKERS', false),

    /**
     * GitHub push webhook for incremental repository re-scans — Phase 2.
     *
     * When enabled, mounts an unauthenticated, signature-validated webhook
     * endpoint that re-scans (and, if workers are on, re-embeds) a repository
     * when it receives a push event for a tracked branch. Default off: the
     * route is not mounted, so no unauthenticated surface is exposed unless
     * explicitly turned on with a configured GITHUB_WEBHOOK_SECRET.
     *
     * Enable with: ENABLE_REPO_WEBHOOKS=true
     */
    GITHUB_WEBHOOKS: envBool('ENABLE_REPO_WEBHOOKS', false),
  },
} as const;

export type FeatureFlags = typeof FEATURE_FLAGS;

/**
 * Convenience: RAG retrieval is only meaningful when both the RAG flag and the
 * underlying vector-search flag are enabled. Centralised here so every call
 * site agrees on the precondition.
 */
export function isRagRetrievalEnabled(): boolean {
  return (
    FEATURE_FLAGS.REPO_INTELLIGENCE.RAG_ENABLED &&
    FEATURE_FLAGS.REPO_INTELLIGENCE.VECTOR_SEARCH
  );
}
