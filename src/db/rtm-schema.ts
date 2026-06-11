/**
 * Requirements Traceability Matrix (RTM) — Schema
 * ================================================
 * Single source of truth for the RTM tables, link columns, coverage function
 * and triggers. Used in two places:
 *   1. `initSchema()` in postgres.ts loops `RTM_STATEMENTS` through the same
 *      `safeExec` runner as every other table (so RTM is created on startup in
 *      every environment, idempotently).
 *   2. `runRTMMigration()` runs the same statements programmatically on demand.
 *
 * A mirrored, human-readable copy lives at `src/db/migrations/rtm-schema.sql`
 * for documentation / manual operations. THIS file is the canonical version
 * that actually executes (the .sql file is NOT copied into dist by `tsc`).
 *
 * ── Adaptation notes (why this differs from a naïve RTM template) ──────────
 * This repo already has tables that a generic RTM design would collide with:
 *   • `test_executions`   — ALREADY EXISTS as a SERIAL-PK table referenced by
 *                            healing_actions / rca_analyses foreign keys. We do
 *                            NOT recreate it. The RTM execution log is a new
 *                            table `rtm_test_executions` (UUID PK).
 *   • `test_cases`        — does NOT exist. The real test-case table is
 *                            `generated_test_cases` (SERIAL PK). RTM links to it
 *                            via a new `requirement_id UUID` column.
 *   • `generated_scripts` — SERIAL PK, already has company_id/project_id/
 *                            deleted_at. RTM adds a `test_case_id INTEGER` link.
 * Coverage is computed against these REAL tables.
 *
 * Every statement is idempotent (IF NOT EXISTS / OR REPLACE / guarded DO blocks)
 * and executed through `safeExec`, so a per-environment failure degrades
 * gracefully instead of aborting startup.
 */

import type { Pool, PoolClient } from 'pg';

export interface RtmStatement {
  label: string;
  sql: string;
}

export const RTM_STATEMENTS: RtmStatement[] = [
  /* ─── 1. Requirements ─────────────────────────────────────────────── */
  {
    label: 'requirements',
    sql: `CREATE TABLE IF NOT EXISTS requirements (
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
    )`,
  },
  // NOTE: a table-level UNIQUE constraint cannot use an expression like
  // COALESCE(...), so uniqueness is enforced via a unique partial index.
  {
    label: 'uq_requirements_reqid',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_requirements_reqid
      ON requirements (requirement_id, company_id, (COALESCE(project_id, 0)))
      WHERE deleted_at IS NULL`,
  },
  {
    label: 'idx_requirements_company_project',
    sql: `CREATE INDEX IF NOT EXISTS idx_requirements_company_project
      ON requirements(company_id, project_id) WHERE deleted_at IS NULL`,
  },
  {
    label: 'idx_requirements_status',
    sql: `CREATE INDEX IF NOT EXISTS idx_requirements_status
      ON requirements(status) WHERE deleted_at IS NULL`,
  },
  {
    label: 'idx_requirements_priority',
    sql: `CREATE INDEX IF NOT EXISTS idx_requirements_priority
      ON requirements(priority) WHERE deleted_at IS NULL`,
  },
  {
    label: 'idx_requirements_category',
    sql: `CREATE INDEX IF NOT EXISTS idx_requirements_category
      ON requirements(category) WHERE deleted_at IS NULL`,
  },
  {
    label: 'idx_requirements_tags',
    sql: `CREATE INDEX IF NOT EXISTS idx_requirements_tags
      ON requirements USING GIN(tags)`,
  },
  {
    label: 'idx_requirements_created_at',
    sql: `CREATE INDEX IF NOT EXISTS idx_requirements_created_at
      ON requirements(created_at DESC)`,
  },

  /* ─── 2. Traceability Links ───────────────────────────────────────── */
  {
    label: 'traceability_links',
    sql: `CREATE TABLE IF NOT EXISTS traceability_links (
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
    )`,
  },
  {
    label: 'idx_traceability_requirement',
    sql: `CREATE INDEX IF NOT EXISTS idx_traceability_requirement ON traceability_links(requirement_id)`,
  },
  {
    label: 'idx_traceability_testcase',
    sql: `CREATE INDEX IF NOT EXISTS idx_traceability_testcase ON traceability_links(test_case_id)`,
  },
  {
    label: 'idx_traceability_script',
    sql: `CREATE INDEX IF NOT EXISTS idx_traceability_script ON traceability_links(script_id)`,
  },
  {
    label: 'idx_traceability_execution',
    sql: `CREATE INDEX IF NOT EXISTS idx_traceability_execution ON traceability_links(execution_id)`,
  },
  {
    label: 'idx_traceability_company_project',
    sql: `CREATE INDEX IF NOT EXISTS idx_traceability_company_project ON traceability_links(company_id, project_id)`,
  },

  /* ─── 3. RTM Test Executions (new table — NOT the legacy test_executions) ── */
  {
    label: 'rtm_test_executions',
    sql: `CREATE TABLE IF NOT EXISTS rtm_test_executions (
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
    )`,
  },
  {
    label: 'idx_rtm_exec_script',
    sql: `CREATE INDEX IF NOT EXISTS idx_rtm_exec_script ON rtm_test_executions(script_id)`,
  },
  {
    label: 'idx_rtm_exec_testcase',
    sql: `CREATE INDEX IF NOT EXISTS idx_rtm_exec_testcase ON rtm_test_executions(test_case_id)`,
  },
  {
    label: 'idx_rtm_exec_requirement',
    sql: `CREATE INDEX IF NOT EXISTS idx_rtm_exec_requirement ON rtm_test_executions(requirement_id)`,
  },
  {
    label: 'idx_rtm_exec_status',
    sql: `CREATE INDEX IF NOT EXISTS idx_rtm_exec_status ON rtm_test_executions(status)`,
  },
  {
    label: 'idx_rtm_exec_date',
    sql: `CREATE INDEX IF NOT EXISTS idx_rtm_exec_date ON rtm_test_executions(executed_at DESC)`,
  },
  {
    label: 'idx_rtm_exec_company_project',
    sql: `CREATE INDEX IF NOT EXISTS idx_rtm_exec_company_project ON rtm_test_executions(company_id, project_id)`,
  },

  /* ─── 4. Link columns on existing real tables (guarded) ───────────── */
  {
    label: 'gtc_requirement_id',
    sql: `DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'generated_test_cases' AND column_name = 'requirement_id'
      ) THEN
        ALTER TABLE generated_test_cases
          ADD COLUMN requirement_id UUID REFERENCES requirements(id) ON DELETE SET NULL;
      END IF;
    END $$`,
  },
  {
    label: 'idx_gtc_requirement',
    sql: `CREATE INDEX IF NOT EXISTS idx_gtc_requirement ON generated_test_cases(requirement_id)`,
  },

  /* ─── Sprint 4B: Automation tracking on generated_test_cases ──────────
   * Boolean-flag model (is_automated) plus a pointer to the script that
   * automated the case and a timestamp. Additive + backward compatible:
   * legacy rows default to is_automated=false. A backfill statement below
   * flips existing test cases that already have a generated script. */
  {
    label: 'gtc_is_automated',
    sql: `DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'generated_test_cases' AND column_name = 'is_automated'
      ) THEN
        ALTER TABLE generated_test_cases ADD COLUMN is_automated BOOLEAN DEFAULT false;
      END IF;
    END $$`,
  },
  {
    label: 'gtc_last_automated_script_id',
    sql: `DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'generated_test_cases' AND column_name = 'last_automated_script_id'
      ) THEN
        ALTER TABLE generated_test_cases ADD COLUMN last_automated_script_id INTEGER;
      END IF;
    END $$`,
  },
  {
    label: 'gtc_last_automated_at',
    sql: `DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'generated_test_cases' AND column_name = 'last_automated_at'
      ) THEN
        ALTER TABLE generated_test_cases ADD COLUMN last_automated_at TIMESTAMPTZ;
      END IF;
    END $$`,
  },
  {
    label: 'idx_gtc_is_automated',
    sql: `CREATE INDEX IF NOT EXISTS idx_gtc_is_automated
      ON generated_test_cases(is_automated) WHERE is_automated = true`,
  },
  {
    // Backfill: any test case that already has a (non-deleted) generated script
    // is, by definition, automated. Pick the most recent script per test case
    // (DISTINCT ON) so last_automated_script_id / _at are unambiguous. Only
    // touches rows still marked not-automated, so it is safe to re-run.
    label: 'backfill_gtc_automation',
    sql: `UPDATE generated_test_cases tc
      SET is_automated = true,
          last_automated_script_id = sub.script_id,
          last_automated_at = sub.created_at
      FROM (
        SELECT DISTINCT ON (gs.test_case_id)
               gs.test_case_id,
               gs.id          AS script_id,
               gs.created_at  AS created_at
        FROM generated_scripts gs
        WHERE gs.test_case_id IS NOT NULL AND gs.deleted_at IS NULL
        ORDER BY gs.test_case_id, gs.created_at DESC, gs.id DESC
      ) sub
      WHERE tc.id = sub.test_case_id
        AND COALESCE(tc.is_automated, false) = false`,
  },
  {
    label: 'gs_test_case_id',
    sql: `DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'generated_scripts' AND column_name = 'test_case_id'
      ) THEN
        ALTER TABLE generated_scripts ADD COLUMN test_case_id INTEGER;
      END IF;
    END $$`,
  },
  {
    label: 'idx_gs_testcase',
    sql: `CREATE INDEX IF NOT EXISTS idx_gs_testcase ON generated_scripts(test_case_id)`,
  },

  /* ─── 5. Requirement ID sequence (optional helper) ────────────────── */
  {
    label: 'requirement_id_seq',
    sql: `CREATE SEQUENCE IF NOT EXISTS requirement_id_seq START 1`,
  },

  /* ─── 6. Coverage auto-update function (against REAL tables) ───────── */
  {
    label: 'fn_update_rtm_requirement_coverage',
    sql: `CREATE OR REPLACE FUNCTION update_rtm_requirement_coverage()
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

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`,
  },

  /* ─── 7. Triggers (only fire when a requirement is linked) ────────── */
  {
    label: 'trg_coverage_on_testcase_drop',
    sql: `DROP TRIGGER IF EXISTS trigger_rtm_coverage_on_testcase ON generated_test_cases`,
  },
  {
    label: 'trg_coverage_on_testcase',
    sql: `CREATE TRIGGER trigger_rtm_coverage_on_testcase
      AFTER INSERT OR UPDATE ON generated_test_cases
      FOR EACH ROW
      WHEN (NEW.requirement_id IS NOT NULL)
      EXECUTE FUNCTION update_rtm_requirement_coverage()`,
  },
  {
    label: 'trg_coverage_on_execution_drop',
    sql: `DROP TRIGGER IF EXISTS trigger_rtm_coverage_on_execution ON rtm_test_executions`,
  },
  {
    label: 'trg_coverage_on_execution',
    sql: `CREATE TRIGGER trigger_rtm_coverage_on_execution
      AFTER INSERT OR UPDATE ON rtm_test_executions
      FOR EACH ROW
      WHEN (NEW.requirement_id IS NOT NULL)
      EXECUTE FUNCTION update_rtm_requirement_coverage()`,
  },

  /* ─── 7b. Direct requirement link on scripts ──────────────────────────
   * Must be added BEFORE the section-8 script coverage trigger, whose WHEN
   * clause references NEW.requirement_id (validated at trigger-create time).
   * Idempotent. */
  {
    label: 'gs_requirement_id_s4',
    sql: `DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'generated_scripts' AND column_name = 'requirement_id'
      ) THEN
        ALTER TABLE generated_scripts
          ADD COLUMN requirement_id UUID REFERENCES requirements(id) ON DELETE SET NULL;
      END IF;
    END $$`,
  },
  {
    label: 'idx_gs_requirement_s4',
    sql: `CREATE INDEX IF NOT EXISTS idx_gs_requirement ON generated_scripts(requirement_id)`,
  },

  /* ─── 8. Script coverage trigger ──────────────────────────────────────
   * A generated_script links to a requirement either directly (its own
   * requirement_id column) or indirectly through generated_test_cases. When a
   * script is created/updated we must recompute the owning requirement's
   * coverage (a script bumps coverage to 66% / status "In Progress"). This
   * function resolves the requirement from the direct link first, then falls
   * back to the test case, and reuses the exact same coverage maths as
   * update_rtm_requirement_coverage. */
  {
    label: 'fn_update_rtm_coverage_from_script',
    sql: `CREATE OR REPLACE FUNCTION update_rtm_coverage_from_script()
    RETURNS TRIGGER AS $$
    DECLARE
      v_req UUID;
    BEGIN
      -- Resolve the owning requirement. A script may link to a requirement
      -- directly (NEW.requirement_id) and/or indirectly through its test case
      -- (generated_test_cases.requirement_id). Prefer the direct link, then
      -- fall back to the test case. If neither resolves, nothing to do.
      v_req := NEW.requirement_id;

      IF v_req IS NULL AND NEW.test_case_id IS NOT NULL THEN
        SELECT requirement_id INTO v_req
        FROM generated_test_cases
        WHERE id = NEW.test_case_id;
      END IF;

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

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql`,
  },
  {
    label: 'trg_coverage_on_script_drop',
    sql: `DROP TRIGGER IF EXISTS trigger_rtm_coverage_on_script ON generated_scripts`,
  },
  {
    label: 'trg_coverage_on_script',
    sql: `CREATE TRIGGER trigger_rtm_coverage_on_script
      AFTER INSERT OR UPDATE ON generated_scripts
      FOR EACH ROW
      WHEN (NEW.test_case_id IS NOT NULL OR NEW.requirement_id IS NOT NULL)
      EXECUTE FUNCTION update_rtm_coverage_from_script()`,
  },

  /* ─── 9. Sprint 4 — Enterprise Script Generation Enhancement ───────────
   * Adds three convenience/quality columns to generated_scripts:
   *   • requirement_id    — direct requirement reference (faster lookups; the
   *                         linkage is still resolvable via the test case, but a
   *                         direct FK avoids a JOIN on the hot RTM path).
   *   • generation_source — distinguishes how a script was created
   *                         ('url_based' | 'test_case_linked' | 'api_direct').
   *   • locator_report     — JSONB summary of locator quality / sourcing so the
   *                         dashboard can show "9/12 locators verified against
   *                         the real DOM" without re-parsing the script body.
   * All guarded / idempotent so re-running startup never errors.
   * NOTE: the requirement_id column itself is created earlier (before the
   * section-8 script coverage trigger) because that trigger's WHEN clause
   * references NEW.requirement_id and would fail to create otherwise. */
  {
    label: 'gs_generation_source_s4',
    sql: `DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'generated_scripts' AND column_name = 'generation_source'
      ) THEN
        ALTER TABLE generated_scripts
          ADD COLUMN generation_source VARCHAR(50) DEFAULT 'url_based';
      END IF;
    END $$`,
  },
  {
    label: 'gs_locator_report_s4',
    sql: `DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'generated_scripts' AND column_name = 'locator_report'
      ) THEN
        ALTER TABLE generated_scripts
          ADD COLUMN locator_report JSONB DEFAULT '{}'::jsonb;
      END IF;
    END $$`,
  },

  /* ─── 10. DELETE coverage triggers ─────────────────────────────────────
   * BUG FIX: the original section-6/7/8 triggers only fired AFTER INSERT OR
   * UPDATE, so deleting test cases / scripts / executions left the STORED
   * requirements.coverage_percentage (and status) stale — e.g. a requirement
   * stayed at 33% "covered" with zero test cases. These AFTER DELETE triggers
   * recompute the owning requirement from the *live* rows that remain (the
   * deleted row is already gone in an AFTER trigger), so coverage correctly
   * falls back to 66 / 33 / 0 and status to "Not Tested" when the last
   * artefact is removed. They reuse the exact same coverage maths as the
   * insert/update path. All resolve the requirement from OLD.* and are
   * idempotent (DROP TRIGGER IF EXISTS before CREATE). */
  {
    label: 'fn_update_rtm_coverage_on_delete',
    sql: `CREATE OR REPLACE FUNCTION update_rtm_coverage_on_delete()
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
    $$ LANGUAGE plpgsql`,
  },
  {
    label: 'trg_coverage_on_testcase_delete_drop',
    sql: `DROP TRIGGER IF EXISTS trigger_rtm_coverage_on_testcase_delete ON generated_test_cases`,
  },
  {
    label: 'trg_coverage_on_testcase_delete',
    sql: `CREATE TRIGGER trigger_rtm_coverage_on_testcase_delete
      AFTER DELETE ON generated_test_cases
      FOR EACH ROW
      WHEN (OLD.requirement_id IS NOT NULL)
      EXECUTE FUNCTION update_rtm_coverage_on_delete()`,
  },
  {
    label: 'trg_coverage_on_execution_delete_drop',
    sql: `DROP TRIGGER IF EXISTS trigger_rtm_coverage_on_execution_delete ON rtm_test_executions`,
  },
  {
    label: 'trg_coverage_on_execution_delete',
    sql: `CREATE TRIGGER trigger_rtm_coverage_on_execution_delete
      AFTER DELETE ON rtm_test_executions
      FOR EACH ROW
      WHEN (OLD.requirement_id IS NOT NULL)
      EXECUTE FUNCTION update_rtm_coverage_on_delete()`,
  },

  /* Script deletes need to resolve the requirement from OLD: directly via
   * OLD.requirement_id, else via the (possibly still-present) test case. If a
   * test case was deleted first, its own AFTER DELETE trigger already handled
   * the requirement, so a NULL resolution here is harmless. */
  {
    label: 'fn_update_rtm_coverage_on_script_delete',
    sql: `CREATE OR REPLACE FUNCTION update_rtm_coverage_on_script_delete()
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
    $$ LANGUAGE plpgsql`,
  },
  {
    label: 'trg_coverage_on_script_delete_drop',
    sql: `DROP TRIGGER IF EXISTS trigger_rtm_coverage_on_script_delete ON generated_scripts`,
  },
  {
    label: 'trg_coverage_on_script_delete',
    sql: `CREATE TRIGGER trigger_rtm_coverage_on_script_delete
      AFTER DELETE ON generated_scripts
      FOR EACH ROW
      WHEN (OLD.test_case_id IS NOT NULL OR OLD.requirement_id IS NOT NULL)
      EXECUTE FUNCTION update_rtm_coverage_on_script_delete()`,
  },

  /* ─── 11. One-time backfill of stale coverage ──────────────────────────
   * Repairs requirements whose STORED coverage_percentage / status drifted
   * from the live state because deletes happened before the AFTER DELETE
   * triggers above existed (the original demo bug: a requirement showing 33%
   * with zero test cases). Recomputes every non-deleted requirement from the
   * live joins using the canonical coverage maths, and only writes rows that
   * actually changed (IS DISTINCT FROM) so it is cheap and fully idempotent —
   * safe to run on every startup. */
  {
    label: 'backfill_rtm_requirement_coverage',
    sql: `UPDATE requirements r
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
      )`,
  },
];

/** Table names RTM adds — surfaced to verifySchema / health checks. */
export const RTM_TABLES = ['requirements', 'traceability_links', 'rtm_test_executions'];

/**
 * Apply the RTM schema using a caller-supplied executor. The executor mirrors
 * postgres.ts `safeExec` — it must isolate failures (never throw) so one bad
 * statement cannot abort schema initialization.
 */
export async function applyRtmStatements(
  exec: (label: string, sql: string) => Promise<boolean>,
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (const stmt of RTM_STATEMENTS) {
    (await exec(stmt.label, stmt.sql)) ? ok++ : fail++;
  }
  return { ok, fail };
}

/**
 * Run the RTM schema programmatically against a Pool/PoolClient (used by
 * `runRTMMigration`). Each statement runs independently; failures are logged
 * via the provided onError callback and do not abort the run.
 */
export async function applyRtmSchema(
  db: Pool | PoolClient,
  onError?: (label: string, err: Error) => void,
): Promise<{ ok: number; fail: number }> {
  return applyRtmStatements(async (label, sql) => {
    try {
      await db.query(sql);
      return true;
    } catch (err) {
      onError?.(label, err as Error);
      return false;
    }
  });
}
