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

    /** RAG retrieval over code_chunks — Phase 2 (not yet implemented). */
    RAG_ENABLED: envBool('ENABLE_REPO_RAG', false),

    /** Vector/embedding search over code_chunks — Phase 2 (not yet implemented). */
    VECTOR_SEARCH: envBool('ENABLE_REPO_VECTOR_SEARCH', false),
  },
} as const;

export type FeatureFlags = typeof FEATURE_FLAGS;
