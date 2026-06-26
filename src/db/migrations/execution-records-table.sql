-- Execution Records — the canonical per-execution record.
--
-- One JSONB document per execution that accumulates, across the lifecycle:
--   artifacts → observations → diagnosis → healing → validation → learning.
-- The dashboard/analytics read THIS table (one record per execution) instead of
-- separate diagnosis / healing / evidence / artifact tables.
--
-- The business model lives in src/core/execution/execution-record.ts.
-- src/db/postgres.ts (save/get/listExecutionRecords) is the only persistence layer.
-- This file mirrors the CREATE TABLE applied in postgres.ts initSchema() for docs.

CREATE TABLE IF NOT EXISTS execution_records (
  execution_id   TEXT PRIMARY KEY,
  company_id     INTEGER REFERENCES companies(id),
  project_id     INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  test_name      TEXT,
  status         TEXT,
  profile        TEXT,
  schema_version INTEGER NOT NULL DEFAULT 1,
  record         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ DEFAULT NOW(),
  updated_at     TIMESTAMPTZ DEFAULT NOW()
);

-- Scope + recency index for the dashboard's "recent executions" view.
CREATE INDEX IF NOT EXISTS idx_execution_records_scope
  ON execution_records (COALESCE(company_id, 0), COALESCE(project_id, 0), created_at DESC);
