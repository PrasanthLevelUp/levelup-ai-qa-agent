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

  /* ─── 8. Script coverage trigger ──────────────────────────────────────
   * generated_scripts has no requirement_id of its own — it links to a
   * requirement indirectly through generated_test_cases.test_case_id. When a
   * script is created/updated for a linked test case we must recompute the
   * owning requirement's coverage (a script bumps coverage to 66% / status
   * "In Progress"). This function resolves the requirement via the test case
   * then reuses the exact same coverage maths as update_rtm_requirement_coverage. */
  {
    label: 'fn_update_rtm_coverage_from_script',
    sql: `CREATE OR REPLACE FUNCTION update_rtm_coverage_from_script()
    RETURNS TRIGGER AS $$
    DECLARE
      v_req UUID;
    BEGIN
      IF NEW.test_case_id IS NULL THEN
        RETURN NEW;
      END IF;

      SELECT requirement_id INTO v_req
      FROM generated_test_cases
      WHERE id = NEW.test_case_id;

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
      WHEN (NEW.test_case_id IS NOT NULL)
      EXECUTE FUNCTION update_rtm_coverage_from_script()`,
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
