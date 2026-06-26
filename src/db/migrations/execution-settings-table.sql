-- =====================================================================
-- Execution Settings — Project-level execution configuration
-- (DOCUMENTATION MIRROR)
-- =====================================================================
-- Human-readable mirror of the canonical, executable statements that run
-- at startup inside `src/db/postgres.ts` (initSchema → execution_settings
-- table creation). `tsc` does NOT copy .sql files into dist/, so this
-- file is for manual operations / review only.
-- Keep it in sync with src/db/postgres.ts.
--
-- Goal: Store project-level execution configuration separate from healing
--   settings. Execution is used by multiple consumers (validation, healing,
--   regression, smoke, nightly, GitHub Actions, BrowserStack, LambdaTest),
--   not just healing. This separation follows proper architecture: healing
--   is ONE consumer of execution, not the owner.
--
-- ExecutionSettings controls:
--   - executionProfile: 'fast' | 'standard' | 'healing' | 'debug'
--   - collectHealingArtifacts: explicit opt-in for trace/video during healing
--
-- Authorization layer enforces which profiles are available per subscription.
--
-- Backward compatible: additive + idempotent. Legacy behavior uses defaults
--   (standard profile, collectHealingArtifacts=true).
-- =====================================================================

-- 1) Create the table (guarded — safe to re-run)
CREATE TABLE IF NOT EXISTS execution_settings (
  id SERIAL PRIMARY KEY,
  company_id INTEGER REFERENCES companies(id),
  project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
  settings JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2) Unique constraint for scoped settings (company + project combination)
CREATE UNIQUE INDEX IF NOT EXISTS idx_execution_settings_scope
  ON execution_settings(COALESCE(company_id, 0), COALESCE(project_id, 0));

-- 3) Documentation comment
COMMENT ON TABLE execution_settings IS
  'Project-level execution configuration (artifact profiles, healing behavior). Separate from healing_settings because execution serves multiple consumers.';
