-- =====================================================================
-- Repository Intelligence — Phase 2: pgvector / RAG (DOCUMENTATION MIRROR)
-- =====================================================================
-- Human-readable mirror of the canonical, executable statements that run at
-- startup inside `src/db/postgres.ts` (initDb → migratePgVector). `tsc` does
-- NOT copy .sql files into dist/, so this file is for manual operations /
-- review only. Keep it in sync with src/db/postgres.ts.
--
-- Gating: every statement below only runs when the feature flag
--   FEATURE_FLAGS.REPO_INTELLIGENCE.VECTOR_SEARCH (env ENABLE_REPO_VECTOR_SEARCH=true)
--   is enabled. With the flag off, the migration is skipped entirely so a
--   database without the `vector` extension is never touched.
--
-- IMPORTANT schema-adaptation notes (why this differs from the design spec):
--   * The illustrative design spec assumed a UUID primary key, a
--     `chunk_content` column, and a `repository_context_id` FK. The REAL
--     schema in this repo is:
--         code_chunks(
--           id              SERIAL PRIMARY KEY,        -- INTEGER, not UUID
--           repo_context_id INTEGER REFERENCES repository_contexts(id),
--           content         TEXT NOT NULL,             -- not "chunk_content"
--           ...
--         )
--     All statements below target those real column names.
--   * Embedding dimensionality 1536 matches OpenAI `text-embedding-3-small`
--     (the default embeddingModel in src/ai/openai-client.ts). If you switch
--     to a model with a different dimensionality you MUST drop & recreate the
--     column + index.
--
-- Backward compatible: additive + idempotent + non-fatal. If `CREATE EXTENSION
--   vector` fails (extension not installed on the server, or insufficient
--   privileges) the application logs a warning, disables vector search at
--   runtime, and continues — RAG retrieval simply returns no results.
-- =====================================================================

-- 1) Extension (requires pgvector to be available on the Postgres server).
CREATE EXTENSION IF NOT EXISTS vector;

-- 2) Embedding column + bookkeeping columns on the existing code_chunks table.
--    Runs as an idempotent DO-block in postgres.ts; shown here expanded.
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS embedding       vector(1536);
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS embedding_model VARCHAR(100);
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS embedded_at     TIMESTAMPTZ;
ALTER TABLE code_chunks ADD COLUMN IF NOT EXISTS token_count     INTEGER;

-- 3) Approximate-nearest-neighbour index for cosine similarity search.
--    ivfflat with lists=100 is a reasonable default for up to ~1M rows.
--    (Re-run ANALYZE / tune `lists` as the table grows.)
CREATE INDEX IF NOT EXISTS idx_code_chunks_embedding
  ON code_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- 4) Partial index to quickly find not-yet-embedded chunks during batch jobs.
CREATE INDEX IF NOT EXISTS idx_code_chunks_unembedded
  ON code_chunks(repo_context_id) WHERE embedding IS NULL;

-- ---------------------------------------------------------------------
-- Reference query: semantic nearest-neighbour search within one repo
-- context (cosine distance operator `<=>`; similarity = 1 - distance):
--
--   SELECT id, file_path, chunk_type, chunk_name, content,
--          1 - (embedding <=> $1::vector) AS similarity
--     FROM code_chunks
--    WHERE repo_context_id = $2
--      AND embedding IS NOT NULL
--    ORDER BY embedding <=> $1::vector
--    LIMIT 5;
-- ---------------------------------------------------------------------
