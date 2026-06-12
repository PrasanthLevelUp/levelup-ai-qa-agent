-- =====================================================================
-- Repository Intelligence — Phase 1: project_id on repository_contexts
-- (DOCUMENTATION MIRROR)
-- =====================================================================
-- Human-readable mirror of the canonical, executable statements that run
-- at startup inside `src/db/postgres.ts` (initSchema → column-migration
-- DO-block, and the index-migration list). `tsc` does NOT copy .sql files
-- into dist/, so this file is for manual operations / review only.
-- Keep it in sync with src/db/postgres.ts.
--
-- Goal: link a repository intelligence profile to a specific project so the
--   intelligence-fusion service can scope `repository_contexts` lookups by
--   (company_id, project_id). Before this fix the fusion query referenced a
--   `project_id` column that did not exist, so the query threw and the error
--   was silently swallowed (see Repo Intelligence Audit, Finding F3).
--
-- Type note: `projects.id` is SERIAL (INTEGER) in this schema, so project_id
--   is INTEGER (NOT UUID). FK uses ON DELETE SET NULL so deleting a project
--   does not destroy the (still company-scoped) intelligence profile.
--
-- Backward compatible: additive + idempotent. Legacy rows keep project_id
--   NULL and remain resolvable via the company-scoped fallback in
--   intelligence-fusion-service.loadRepositoryIntelligence().
-- =====================================================================

-- 1) Add the column (guarded — safe to re-run)
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'repository_contexts' AND column_name = 'project_id'
  ) THEN
    ALTER TABLE repository_contexts
      ADD COLUMN project_id INTEGER REFERENCES projects(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 2) Index for project-scoped lookups
CREATE INDEX IF NOT EXISTS idx_repo_ctx_project
  ON repository_contexts(project_id);

-- 3) Documentation comment
COMMENT ON COLUMN repository_contexts.project_id IS
  'Links repository intelligence to a specific project for scoped access (Phase 1). NULL = company-wide.';
