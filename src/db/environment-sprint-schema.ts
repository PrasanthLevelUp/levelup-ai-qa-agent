/**
 * Environment & Sprint Management — Schema (Phase 1 Foundation)
 * ============================================================
 * Single source of truth for the environment / sprint / user-context tables,
 * the link columns added to existing domain tables, the supporting indexes and
 * the triggers that keep "current sprint" / "default environment" consistent
 * and auto-stamp new rows.
 *
 * Mirrors the RTM schema module (`src/db/rtm-schema.ts`) and is wired into
 * `initSchema()` in postgres.ts the same way:
 *   1. `ENV_SPRINT_STATEMENTS` is looped through the shared `safeExec` runner
 *      on startup (idempotent, per-statement error isolation).
 *   2. `runEnvSprintMigration()` runs the same statements on demand.
 *
 * ── Adaptation notes ───────────────────────────────────────────────────────
 * This repo already has the real tables `test_executions`, `healing_actions`,
 * `rca_analyses`, `generated_scripts` (all SERIAL PK, project_id added during
 * `migrateDefaultCompany`) and `requirements` (UUID PK, from RTM). We do NOT
 * recreate any of them — we only ALTER ADD COLUMN `environment_id` / `sprint_id`
 * (guarded, idempotent) and index them.
 *
 * The ENV_SPRINT loop runs AFTER the RTM loop in initSchema, so that the
 * `requirements` table and all `project_id` columns exist before we add the
 * link columns / triggers that reference them.
 *
 * Every statement is idempotent (IF NOT EXISTS / OR REPLACE / guarded DO blocks
 * / DROP TRIGGER IF EXISTS before CREATE TRIGGER) and executed through the same
 * error-isolating runner, so a per-environment failure degrades gracefully
 * instead of aborting startup.
 */

import type { Pool, PoolClient } from 'pg';

export interface EnvSprintStatement {
  label: string;
  sql: string;
}

/** Tables that get the environment_id / sprint_id link columns + indexes. */
const LINKED_TABLES = [
  'healing_actions',
  'test_executions',
  'generated_scripts',
  'rca_analyses',
  'requirements',
];

/**
 * Build the guarded ALTER ADD COLUMN statement for a link column on an existing
 * table. Wrapped in a DO block that swallows duplicate_column / undefined_table
 * so re-runs and missing-table environments are both safe.
 */
function addLinkColumn(table: string, column: string): EnvSprintStatement {
  return {
    label: `${table}.${column}`,
    sql: `DO $$ BEGIN
      ALTER TABLE ${table} ADD COLUMN ${column} INTEGER;
    EXCEPTION
      WHEN duplicate_column THEN NULL;
      WHEN undefined_table THEN NULL;
    END $$;`,
  };
}

/** Build a guarded CREATE INDEX for a link column. */
function linkIndex(table: string, column: string): EnvSprintStatement {
  return {
    label: `idx_${table}_${column}`,
    sql: `CREATE INDEX IF NOT EXISTS idx_${table}_${column} ON ${table}(${column})`,
  };
}

export const ENV_SPRINT_STATEMENTS: EnvSprintStatement[] = [
  /* ─── 1. project_environments ─────────────────────────────────────── */
  {
    label: 'project_environments',
    sql: `CREATE TABLE IF NOT EXISTS project_environments (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      project_id INTEGER NOT NULL,
      name VARCHAR(100) NOT NULL,
      base_url TEXT,
      description TEXT,
      environment_type VARCHAR(50) DEFAULT 'custom',  -- development, staging, production, qa, custom
      is_default BOOLEAN DEFAULT false,
      is_active BOOLEAN DEFAULT true,
      health_status VARCHAR(20),                       -- healthy, unhealthy, unknown
      last_health_check_at TIMESTAMPTZ,
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      metadata JSONB DEFAULT '{}'::jsonb
    )`,
  },
  {
    label: 'idx_project_environments_project',
    sql: `CREATE INDEX IF NOT EXISTS idx_project_environments_project
            ON project_environments(project_id) WHERE is_active = true`,
  },
  {
    // Unique active environment name per project (case-insensitive).
    label: 'uq_project_environments_name',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_project_environments_name
            ON project_environments(project_id, lower(name)) WHERE is_active = true`,
  },
  {
    // At most one default environment per project.
    label: 'uq_project_environments_default',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_project_environments_default
            ON project_environments(project_id) WHERE is_default = true AND is_active = true`,
  },

  /* ─── 2. project_sprints ──────────────────────────────────────────── */
  {
    label: 'project_sprints',
    sql: `CREATE TABLE IF NOT EXISTS project_sprints (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      project_id INTEGER NOT NULL,
      name VARCHAR(150) NOT NULL,
      sprint_type VARCHAR(50) DEFAULT 'standard',      -- standard, hotfix, release, custom
      start_date DATE,
      end_date DATE,
      status VARCHAR(30) DEFAULT 'planned',            -- planned, active, completed, cancelled
      is_current BOOLEAN DEFAULT false,
      goals TEXT,
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      metadata JSONB DEFAULT '{}'::jsonb
    )`,
  },
  {
    label: 'idx_project_sprints_project',
    sql: `CREATE INDEX IF NOT EXISTS idx_project_sprints_project
            ON project_sprints(project_id, status)`,
  },
  {
    label: 'idx_project_sprints_dates',
    sql: `CREATE INDEX IF NOT EXISTS idx_project_sprints_dates
            ON project_sprints(project_id, start_date, end_date)`,
  },
  {
    // At most one current sprint per project.
    label: 'uq_project_sprints_current',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_project_sprints_current
            ON project_sprints(project_id) WHERE is_current = true`,
  },

  /* ─── 3. user_project_context ─────────────────────────────────────── */
  {
    label: 'user_project_context',
    sql: `CREATE TABLE IF NOT EXISTS user_project_context (
      id SERIAL PRIMARY KEY,
      company_id INTEGER,
      user_id INTEGER NOT NULL,
      project_id INTEGER NOT NULL,
      environment_id INTEGER,
      sprint_id INTEGER,
      time_range VARCHAR(50),                          -- sprint, last_7_days, last_30_days, custom, ...
      time_range_start DATE,
      time_range_end DATE,
      preferences JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  },
  {
    label: 'uq_user_project_context',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_user_project_context
            ON user_project_context(user_id, project_id)`,
  },

  /* ─── 4. Project-level sprint settings (on projects table) ────────── */
  {
    label: 'projects.sprint_settings',
    sql: `DO $$ BEGIN
      ALTER TABLE projects ADD COLUMN sprint_duration_weeks INTEGER DEFAULT 2;
    EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;`,
  },
  {
    label: 'projects.auto_create_sprints',
    sql: `DO $$ BEGIN
      ALTER TABLE projects ADD COLUMN auto_create_sprints BOOLEAN DEFAULT false;
    EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;`,
  },
  {
    label: 'projects.sprint_naming_pattern',
    sql: `DO $$ BEGIN
      ALTER TABLE projects ADD COLUMN sprint_naming_pattern VARCHAR(100) DEFAULT 'Sprint {n}';
    EXCEPTION WHEN duplicate_column THEN NULL; WHEN undefined_table THEN NULL; END $$;`,
  },

  /* ─── 5. Link columns on existing domain tables ───────────────────── */
  ...LINKED_TABLES.flatMap((t) => [
    addLinkColumn(t, 'environment_id'),
    addLinkColumn(t, 'sprint_id'),
    linkIndex(t, 'environment_id'),
    linkIndex(t, 'sprint_id'),
  ]),

  /* ─── 6. updated_at trigger ───────────────────────────────────────── */
  {
    label: 'fn_env_sprint_set_updated_at',
    sql: `CREATE OR REPLACE FUNCTION env_sprint_set_updated_at()
      RETURNS TRIGGER AS $$
      BEGIN
        NEW.updated_at = NOW();
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`,
  },
  {
    label: 'trg_project_environments_updated_at',
    sql: `DROP TRIGGER IF EXISTS trg_project_environments_updated_at ON project_environments;
          CREATE TRIGGER trg_project_environments_updated_at
            BEFORE UPDATE ON project_environments
            FOR EACH ROW EXECUTE FUNCTION env_sprint_set_updated_at()`,
  },
  {
    label: 'trg_project_sprints_updated_at',
    sql: `DROP TRIGGER IF EXISTS trg_project_sprints_updated_at ON project_sprints;
          CREATE TRIGGER trg_project_sprints_updated_at
            BEFORE UPDATE ON project_sprints
            FOR EACH ROW EXECUTE FUNCTION env_sprint_set_updated_at()`,
  },
  {
    label: 'trg_user_project_context_updated_at',
    sql: `DROP TRIGGER IF EXISTS trg_user_project_context_updated_at ON user_project_context;
          CREATE TRIGGER trg_user_project_context_updated_at
            BEFORE UPDATE ON user_project_context
            FOR EACH ROW EXECUTE FUNCTION env_sprint_set_updated_at()`,
  },

  /* ─── 7. Single-current-sprint enforcement trigger ───────────────────
   * When a sprint is inserted/updated with is_current = true, demote every
   * other sprint of the same project. Belt-and-braces alongside the partial
   * unique index (the index rejects a second current sprint; this trigger
   * makes "set current" idempotent by clearing the previous one first). */
  {
    label: 'fn_enforce_single_current_sprint',
    sql: `CREATE OR REPLACE FUNCTION enforce_single_current_sprint()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.is_current IS TRUE THEN
          UPDATE project_sprints
             SET is_current = false
           WHERE project_id = NEW.project_id
             AND id <> NEW.id
             AND is_current = true;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`,
  },
  {
    label: 'trg_enforce_single_current_sprint',
    sql: `DROP TRIGGER IF EXISTS trg_enforce_single_current_sprint ON project_sprints;
          CREATE TRIGGER trg_enforce_single_current_sprint
            BEFORE INSERT OR UPDATE OF is_current ON project_sprints
            FOR EACH ROW WHEN (NEW.is_current IS TRUE)
            EXECUTE FUNCTION enforce_single_current_sprint()`,
  },

  /* ─── 8. Single-default-environment enforcement trigger ───────────── */
  {
    label: 'fn_enforce_single_default_environment',
    sql: `CREATE OR REPLACE FUNCTION enforce_single_default_environment()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.is_default IS TRUE THEN
          UPDATE project_environments
             SET is_default = false
           WHERE project_id = NEW.project_id
             AND id <> NEW.id
             AND is_default = true;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`,
  },
  {
    label: 'trg_enforce_single_default_environment',
    sql: `DROP TRIGGER IF EXISTS trg_enforce_single_default_environment ON project_environments;
          CREATE TRIGGER trg_enforce_single_default_environment
            BEFORE INSERT OR UPDATE OF is_default ON project_environments
            FOR EACH ROW WHEN (NEW.is_default IS TRUE)
            EXECUTE FUNCTION enforce_single_default_environment()`,
  },

  /* ─── 9. Auto-stamp current sprint on inserts ────────────────────────
   * Generic BEFORE INSERT trigger: when a row lands without a sprint_id but
   * carries a project_id, stamp it with that project's current sprint. Only
   * fills NULLs (never overrides an explicit value) so it's fully backward
   * compatible. Attached to each linked domain table below. */
  {
    label: 'fn_assign_current_sprint',
    sql: `CREATE OR REPLACE FUNCTION assign_current_sprint()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.sprint_id IS NULL AND NEW.project_id IS NOT NULL THEN
          SELECT id INTO NEW.sprint_id
            FROM project_sprints
           WHERE project_id = NEW.project_id AND is_current = true
           LIMIT 1;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`,
  },
  /* ─── 10. Auto-stamp default environment on inserts ───────────────── */
  {
    label: 'fn_assign_default_environment',
    sql: `CREATE OR REPLACE FUNCTION assign_default_environment()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.environment_id IS NULL AND NEW.project_id IS NOT NULL THEN
          SELECT id INTO NEW.environment_id
            FROM project_environments
           WHERE project_id = NEW.project_id AND is_default = true AND is_active = true
           LIMIT 1;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql`,
  },
  /* Attach the auto-stamp triggers to each linked table (guarded). */
  ...LINKED_TABLES.flatMap((t) => [
    {
      label: `trg_${t}_assign_current_sprint`,
      sql: `DO $$ BEGIN
        DROP TRIGGER IF EXISTS trg_${t}_assign_current_sprint ON ${t};
        CREATE TRIGGER trg_${t}_assign_current_sprint
          BEFORE INSERT ON ${t}
          FOR EACH ROW EXECUTE FUNCTION assign_current_sprint();
      EXCEPTION WHEN undefined_table THEN NULL; END $$;`,
    },
    {
      label: `trg_${t}_assign_default_environment`,
      sql: `DO $$ BEGIN
        DROP TRIGGER IF EXISTS trg_${t}_assign_default_environment ON ${t};
        CREATE TRIGGER trg_${t}_assign_default_environment
          BEFORE INSERT ON ${t}
          FOR EACH ROW EXECUTE FUNCTION assign_default_environment();
      EXCEPTION WHEN undefined_table THEN NULL; END $$;`,
    },
  ]),
];

/** Table names this module adds — surfaced to verifySchema / health checks. */
export const ENV_SPRINT_TABLES = [
  'project_environments',
  'project_sprints',
  'user_project_context',
];

/**
 * Apply the env/sprint schema using a caller-supplied executor. The executor
 * mirrors postgres.ts `safeExec` — it must isolate failures (never throw) so
 * one bad statement cannot abort schema initialization.
 */
export async function applyEnvSprintStatements(
  exec: (label: string, sql: string) => Promise<boolean>,
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (const stmt of ENV_SPRINT_STATEMENTS) {
    (await exec(stmt.label, stmt.sql)) ? ok++ : fail++;
  }
  return { ok, fail };
}

/**
 * Run the env/sprint schema programmatically against a Pool/PoolClient (used by
 * `runEnvSprintMigration`). Each statement runs independently; failures are
 * logged via the provided onError callback and do not abort the run.
 */
export async function applyEnvSprintSchema(
  db: Pool | PoolClient,
  onError?: (label: string, err: Error) => void,
): Promise<{ ok: number; fail: number }> {
  return applyEnvSprintStatements(async (label, sql) => {
    try {
      await db.query(sql);
      return true;
    } catch (err) {
      onError?.(label, err as Error);
      return false;
    }
  });
}
