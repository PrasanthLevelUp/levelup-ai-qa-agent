-- =====================================================================
-- Requirements Traceability Matrix (RTM) — Schema (DOCUMENTATION MIRROR)
-- =====================================================================
-- This file is a human-readable mirror of the canonical, executable schema
-- defined in `src/db/rtm-schema.ts` (RTM_STATEMENTS). The TypeScript module
-- is what actually runs at startup (via initSchema -> safeExec) and on demand
-- (runRTMMigration). `tsc` does NOT copy .sql files into dist/, so this file
-- is for manual operations / review only. Keep it in sync with rtm-schema.ts.
--
-- Adaptation notes (why this differs from a naive RTM template):
--   * `test_executions` ALREADY EXISTS in this repo as a SERIAL-PK table
--     referenced by healing_actions / rca_analyses FKs. We do NOT recreate it.
--     The RTM execution log is a new table `rtm_test_executions` (UUID PK).
--   * `test_cases` does NOT exist. The real test-case table is
--     `generated_test_cases` (SERIAL PK). RTM links to it via a new
--     `requirement_id UUID` column.
--   * `generated_scripts` (SERIAL PK) already has company_id/project_id/
--     deleted_at. RTM adds a `test_case_id INTEGER` link column.
--
-- Every statement is idempotent (IF NOT EXISTS / OR REPLACE / guarded DO blocks).
-- =====================================================================

-- ─── 1. Requirements ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id INTEGER NOT NULL,
  project_id INTEGER,
  requirement_id VARCHAR(50) NOT NULL,            -- REQ-001, REQ-002, ...
  title TEXT NOT NULL,
  description TEXT,
  category VARCHAR(100),                          -- Authentication, Payment, UI, API, ...
  priority VARCHAR(20) DEFAULT 'Medium',          -- Critical, High, Medium, Low
  acceptance_criteria TEXT,
  status VARCHAR(50) DEFAULT 'Not Tested',        -- Not Tested, In Progress, Passed, Failed
  tags TEXT[],
  created_by INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}'::jsonb,
  coverage_percentage INTEGER DEFAULT 0
);

-- A table-level UNIQUE constraint cannot use an expression like COALESCE(...),
-- so per-(company, project) uniqueness of requirement_id is enforced via a
-- unique partial index (NULL project_id collapses to 0).
CREATE UNIQUE INDEX IF NOT EXISTS uq_requirements_reqid
  ON requirements (requirement_id, company_id, (COALESCE(project_id, 0)))
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_requirements_company_project
  ON requirements(company_id, project_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_requirements_status
  ON requirements(status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_requirements_priority
  ON requirements(priority) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_requirements_category
  ON requirements(category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_requirements_tags
  ON requirements USING GIN(tags);
CREATE INDEX IF NOT EXISTS idx_requirements_created_at
  ON requirements(created_at DESC);

-- ─── 2. Traceability Links ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS traceability_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id INTEGER NOT NULL,
  project_id INTEGER,
  requirement_id UUID REFERENCES requirements(id) ON DELETE CASCADE,
  test_case_id INTEGER,
  script_id INTEGER,
  execution_id UUID,
  link_type VARCHAR(50) NOT NULL,                 -- requirement_to_testcase, testcase_to_script, script_to_execution
  created_at TIMESTAMPTZ DEFAULT NOW(),
  created_by INTEGER,
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_traceability_requirement ON traceability_links(requirement_id);
CREATE INDEX IF NOT EXISTS idx_traceability_testcase ON traceability_links(test_case_id);
CREATE INDEX IF NOT EXISTS idx_traceability_script ON traceability_links(script_id);
CREATE INDEX IF NOT EXISTS idx_traceability_execution ON traceability_links(execution_id);
CREATE INDEX IF NOT EXISTS idx_traceability_company_project ON traceability_links(company_id, project_id);

-- ─── 3. RTM Test Executions (new table — NOT the legacy test_executions) ──
CREATE TABLE IF NOT EXISTS rtm_test_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id INTEGER NOT NULL,
  project_id INTEGER,
  script_id INTEGER,
  test_case_id INTEGER,
  requirement_id UUID REFERENCES requirements(id) ON DELETE SET NULL,
  status VARCHAR(20) NOT NULL,                    -- running, passed, failed, skipped
  result JSONB DEFAULT '{}'::jsonb,
  execution_time_ms INTEGER,
  error_message TEXT,
  stack_trace TEXT,
  screenshots JSONB DEFAULT '[]'::jsonb,
  healing_applied BOOLEAN DEFAULT false,
  healing_job_id UUID,
  executed_by INTEGER,
  executed_at TIMESTAMPTZ DEFAULT NOW(),
  environment VARCHAR(50) DEFAULT 'test',         -- dev, test, staging, production
  ci_cd_run_id VARCHAR(255),
  metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_rtm_exec_script ON rtm_test_executions(script_id);
CREATE INDEX IF NOT EXISTS idx_rtm_exec_testcase ON rtm_test_executions(test_case_id);
CREATE INDEX IF NOT EXISTS idx_rtm_exec_requirement ON rtm_test_executions(requirement_id);
CREATE INDEX IF NOT EXISTS idx_rtm_exec_status ON rtm_test_executions(status);
CREATE INDEX IF NOT EXISTS idx_rtm_exec_date ON rtm_test_executions(executed_at DESC);
CREATE INDEX IF NOT EXISTS idx_rtm_exec_company_project ON rtm_test_executions(company_id, project_id);

-- ─── 4. Link columns on existing real tables (guarded) ───────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'generated_test_cases' AND column_name = 'requirement_id'
  ) THEN
    ALTER TABLE generated_test_cases
      ADD COLUMN requirement_id UUID REFERENCES requirements(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gtc_requirement ON generated_test_cases(requirement_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'generated_scripts' AND column_name = 'test_case_id'
  ) THEN
    ALTER TABLE generated_scripts ADD COLUMN test_case_id INTEGER;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_gs_testcase ON generated_scripts(test_case_id);

-- ─── 5. Requirement ID sequence (optional helper) ────────────────────
CREATE SEQUENCE IF NOT EXISTS requirement_id_seq START 1;

-- ─── 6. Coverage auto-update function (against REAL tables) ──────────
CREATE OR REPLACE FUNCTION update_rtm_requirement_coverage()
RETURNS TRIGGER AS $$
DECLARE
  v_req UUID := NEW.requirement_id;
BEGIN
  IF v_req IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE requirements r
  SET
    coverage_percentage = (
      SELECT
        CASE
          WHEN COUNT(DISTINCT te.id) > 0 THEN 100
          WHEN COUNT(DISTINCT gs.id) > 0 THEN 66
          WHEN COUNT(DISTINCT tc.id) > 0 THEN 33
          ELSE 0
        END
      FROM requirements req
      LEFT JOIN generated_test_cases tc ON tc.requirement_id = req.id
      LEFT JOIN generated_scripts gs ON gs.test_case_id = tc.id AND gs.deleted_at IS NULL
      LEFT JOIN rtm_test_executions te ON te.requirement_id = req.id
      WHERE req.id = v_req
    ),
    status = (
      SELECT
        CASE
          WHEN COUNT(DISTINCT te.id) FILTER (WHERE te.status = 'passed') > 0 THEN 'Passed'
          WHEN COUNT(DISTINCT te.id) FILTER (WHERE te.status = 'failed') > 0 THEN 'Failed'
          WHEN COUNT(DISTINCT gs.id) > 0 THEN 'In Progress'
          ELSE 'Not Tested'
        END
      FROM requirements req
      LEFT JOIN generated_test_cases tc ON tc.requirement_id = req.id
      LEFT JOIN generated_scripts gs ON gs.test_case_id = tc.id AND gs.deleted_at IS NULL
      LEFT JOIN rtm_test_executions te ON te.requirement_id = req.id
      WHERE req.id = v_req
    ),
    updated_at = NOW()
  WHERE r.id = v_req;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 7. Triggers (only fire when a requirement is linked) ────────────
DROP TRIGGER IF EXISTS trigger_rtm_coverage_on_testcase ON generated_test_cases;
CREATE TRIGGER trigger_rtm_coverage_on_testcase
  AFTER INSERT OR UPDATE ON generated_test_cases
  FOR EACH ROW
  WHEN (NEW.requirement_id IS NOT NULL)
  EXECUTE FUNCTION update_rtm_requirement_coverage();

DROP TRIGGER IF EXISTS trigger_rtm_coverage_on_execution ON rtm_test_executions;
CREATE TRIGGER trigger_rtm_coverage_on_execution
  AFTER INSERT OR UPDATE ON rtm_test_executions
  FOR EACH ROW
  WHEN (NEW.requirement_id IS NOT NULL)
  EXECUTE FUNCTION update_rtm_requirement_coverage();

-- ─── 10. DELETE coverage triggers (BUG FIX) ──────────────────────────
-- The insert/update triggers above never fired on DELETE, leaving the
-- stored requirements.coverage_percentage / status stale after test cases,
-- scripts or executions were removed (e.g. a requirement stuck at 33% with
-- zero test cases). These AFTER DELETE triggers recompute the owning
-- requirement from the live rows that remain, using the same coverage maths.
-- NOTE: rtm-schema.ts (RTM_STATEMENTS) is the runtime source of truth applied
-- on startup; this file is the reference mirror.
CREATE OR REPLACE FUNCTION update_rtm_coverage_on_delete()
RETURNS TRIGGER AS $$
DECLARE
  v_req UUID := OLD.requirement_id;
BEGIN
  IF v_req IS NULL THEN
    RETURN OLD;
  END IF;

  UPDATE requirements r
  SET
    coverage_percentage = (
      SELECT
        CASE
          WHEN COUNT(DISTINCT te.id) > 0 THEN 100
          WHEN COUNT(DISTINCT gs.id) > 0 THEN 66
          WHEN COUNT(DISTINCT tc.id) > 0 THEN 33
          ELSE 0
        END
      FROM requirements req
      LEFT JOIN generated_test_cases tc ON tc.requirement_id = req.id
      LEFT JOIN generated_scripts gs ON (gs.test_case_id = tc.id OR gs.requirement_id = req.id) AND gs.deleted_at IS NULL
      LEFT JOIN rtm_test_executions te ON te.requirement_id = req.id
      WHERE req.id = v_req
    ),
    status = (
      SELECT
        CASE
          WHEN COUNT(DISTINCT te.id) FILTER (WHERE te.status = 'passed') > 0 THEN 'Passed'
          WHEN COUNT(DISTINCT te.id) FILTER (WHERE te.status = 'failed') > 0 THEN 'Failed'
          WHEN COUNT(DISTINCT gs.id) > 0 THEN 'In Progress'
          ELSE 'Not Tested'
        END
      FROM requirements req
      LEFT JOIN generated_test_cases tc ON tc.requirement_id = req.id
      LEFT JOIN generated_scripts gs ON (gs.test_case_id = tc.id OR gs.requirement_id = req.id) AND gs.deleted_at IS NULL
      LEFT JOIN rtm_test_executions te ON te.requirement_id = req.id
      WHERE req.id = v_req
    ),
    updated_at = NOW()
  WHERE r.id = v_req;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_rtm_coverage_on_testcase_delete ON generated_test_cases;
CREATE TRIGGER trigger_rtm_coverage_on_testcase_delete
  AFTER DELETE ON generated_test_cases
  FOR EACH ROW
  WHEN (OLD.requirement_id IS NOT NULL)
  EXECUTE FUNCTION update_rtm_coverage_on_delete();

DROP TRIGGER IF EXISTS trigger_rtm_coverage_on_execution_delete ON rtm_test_executions;
CREATE TRIGGER trigger_rtm_coverage_on_execution_delete
  AFTER DELETE ON rtm_test_executions
  FOR EACH ROW
  WHEN (OLD.requirement_id IS NOT NULL)
  EXECUTE FUNCTION update_rtm_coverage_on_delete();

CREATE OR REPLACE FUNCTION update_rtm_coverage_on_script_delete()
RETURNS TRIGGER AS $$
DECLARE
  v_req UUID;
BEGIN
  v_req := OLD.requirement_id;

  IF v_req IS NULL AND OLD.test_case_id IS NOT NULL THEN
    SELECT requirement_id INTO v_req
    FROM generated_test_cases
    WHERE id = OLD.test_case_id;
  END IF;

  IF v_req IS NULL THEN
    RETURN OLD;
  END IF;

  UPDATE requirements r
  SET
    coverage_percentage = (
      SELECT
        CASE
          WHEN COUNT(DISTINCT te.id) > 0 THEN 100
          WHEN COUNT(DISTINCT gs.id) > 0 THEN 66
          WHEN COUNT(DISTINCT tc.id) > 0 THEN 33
          ELSE 0
        END
      FROM requirements req
      LEFT JOIN generated_test_cases tc ON tc.requirement_id = req.id
      LEFT JOIN generated_scripts gs ON (gs.test_case_id = tc.id OR gs.requirement_id = req.id) AND gs.deleted_at IS NULL
      LEFT JOIN rtm_test_executions te ON te.requirement_id = req.id
      WHERE req.id = v_req
    ),
    status = (
      SELECT
        CASE
          WHEN COUNT(DISTINCT te.id) FILTER (WHERE te.status = 'passed') > 0 THEN 'Passed'
          WHEN COUNT(DISTINCT te.id) FILTER (WHERE te.status = 'failed') > 0 THEN 'Failed'
          WHEN COUNT(DISTINCT gs.id) > 0 THEN 'In Progress'
          ELSE 'Not Tested'
        END
      FROM requirements req
      LEFT JOIN generated_test_cases tc ON tc.requirement_id = req.id
      LEFT JOIN generated_scripts gs ON (gs.test_case_id = tc.id OR gs.requirement_id = req.id) AND gs.deleted_at IS NULL
      LEFT JOIN rtm_test_executions te ON te.requirement_id = req.id
      WHERE req.id = v_req
    ),
    updated_at = NOW()
  WHERE r.id = v_req;

  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_rtm_coverage_on_script_delete ON generated_scripts;
CREATE TRIGGER trigger_rtm_coverage_on_script_delete
  AFTER DELETE ON generated_scripts
  FOR EACH ROW
  WHEN (OLD.test_case_id IS NOT NULL OR OLD.requirement_id IS NOT NULL)
  EXECUTE FUNCTION update_rtm_coverage_on_script_delete();

-- ─── 11. One-time backfill of stale coverage (idempotent) ─────────────
UPDATE requirements r
SET
  coverage_percentage = sub.cov,
  status = sub.stat,
  updated_at = NOW()
FROM (
  SELECT
    req.id AS rid,
    CASE
      WHEN COUNT(DISTINCT te.id) > 0 THEN 100
      WHEN COUNT(DISTINCT gs.id) > 0 THEN 66
      WHEN COUNT(DISTINCT tc.id) > 0 THEN 33
      ELSE 0
    END AS cov,
    CASE
      WHEN COUNT(DISTINCT te.id) FILTER (WHERE te.status = 'passed') > 0 THEN 'Passed'
      WHEN COUNT(DISTINCT te.id) FILTER (WHERE te.status = 'failed') > 0 THEN 'Failed'
      WHEN COUNT(DISTINCT gs.id) > 0 THEN 'In Progress'
      ELSE 'Not Tested'
    END AS stat
  FROM requirements req
  LEFT JOIN generated_test_cases tc ON tc.requirement_id = req.id
  LEFT JOIN generated_scripts gs ON (gs.test_case_id = tc.id OR gs.requirement_id = req.id) AND gs.deleted_at IS NULL
  LEFT JOIN rtm_test_executions te ON te.requirement_id = req.id
  WHERE req.deleted_at IS NULL
  GROUP BY req.id
) sub
WHERE r.id = sub.rid
  AND (
    r.coverage_percentage IS DISTINCT FROM sub.cov
    OR r.status IS DISTINCT FROM sub.stat
  );
