/**
 * Repository Test Inventory — Schema (Sprint RCI-1)
 * =================================================
 * Single source of truth for the `repository_test_inventory` table: the
 * deterministic, per-test inventory produced by scanning an existing
 * Playwright / Cypress / Selenium test repository.
 *
 * This is the FOUNDATION table of Repository Coverage Intelligence. It answers
 * the question "what tests already exist in this repo?" BEFORE any AI
 * generation happens. It is built by a pure static-analysis scanner
 * (`RepositoryInventoryScanner`) — NO LLM, NO embeddings, NO generation.
 *
 * Wired into schema init exactly like RTM / ENV_SPRINT:
 *   1. `initSchema()` in postgres.ts loops `REPOSITORY_INVENTORY_STATEMENTS`
 *      through the same `safeExec` runner (idempotent, created on every start).
 *   2. `runRepositoryInventoryMigration()` runs the same statements on demand.
 *
 * ── Scoping / grain ────────────────────────────────────────────────────────
 * One ROW PER TEST (not per suite/file). Scoped by company_id (required) and
 * project_id (nullable, workspace-aware). Linked to `repositories(id)` via
 * repository_id. Re-scanning is idempotent through the
 * (repository_id, file_path, test_name) unique constraint.
 *
 * Every statement is idempotent (IF NOT EXISTS / guarded DO blocks) and runs
 * through `safeExec`, so a per-environment failure degrades gracefully instead
 * of aborting startup.
 */

import type { Pool, PoolClient } from 'pg';

export interface RepositoryInventoryStatement {
  label: string;
  sql: string;
}

export const REPOSITORY_INVENTORY_STATEMENTS: RepositoryInventoryStatement[] = [
  /* ─── 1. Inventory table (one row per test) ───────────────────────── */
  {
    label: 'repository_test_inventory',
    sql: `CREATE TABLE IF NOT EXISTS repository_test_inventory (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id INTEGER NOT NULL,
      project_id INTEGER,
      repository_id INTEGER,                          -- FK → repositories(id); nullable for ad-hoc scans
      file_path TEXT NOT NULL,                        -- repo-relative path of the spec file
      test_name TEXT NOT NULL,                        -- the string passed to test()/it()
      feature TEXT,                                   -- derived: describe title / file / keyword
      flow TEXT,                                      -- derived: primary user flow (login, checkout, ...)
      page TEXT,                                      -- derived: page/POM under test (LoginPage, ...)
      tags JSONB NOT NULL DEFAULT '[]'::jsonb,        -- @tags + @tc:IDs found in title/body/comments
      assertions JSONB NOT NULL DEFAULT '[]'::jsonb,  -- extracted assertion signatures
      pom_methods JSONB NOT NULL DEFAULT '[]'::jsonb, -- page-object method calls (pageVar.method)
      framework TEXT,                                 -- playwright | cypress | selenium | unknown
      confidence INTEGER NOT NULL DEFAULT 0,          -- 0-100 extraction confidence score
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,    -- raw signals: describe path, line, locators, counts
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
  },

  /* ─── 2. Idempotent re-scan key ───────────────────────────────────── */
  // A test is uniquely identified within a repo by its file + name. COALESCE
  // keeps the constraint valid when repository_id is NULL (ad-hoc path scans).
  {
    label: 'repository_test_inventory_unique',
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS uq_repo_inventory_test
      ON repository_test_inventory (company_id, COALESCE(repository_id, 0), file_path, test_name)`,
  },

  /* ─── 3. Query indexes ────────────────────────────────────────────── */
  {
    label: 'repository_test_inventory_scope_idx',
    sql: `CREATE INDEX IF NOT EXISTS idx_repo_inventory_scope
      ON repository_test_inventory (company_id, project_id)`,
  },
  {
    label: 'repository_test_inventory_repo_idx',
    sql: `CREATE INDEX IF NOT EXISTS idx_repo_inventory_repo
      ON repository_test_inventory (repository_id)`,
  },
  {
    label: 'repository_test_inventory_feature_idx',
    sql: `CREATE INDEX IF NOT EXISTS idx_repo_inventory_feature
      ON repository_test_inventory (company_id, feature)`,
  },
];

export const REPOSITORY_INVENTORY_TABLES = ['repository_test_inventory'];

/**
 * Apply the inventory schema using a caller-supplied executor. The executor
 * mirrors postgres.ts `safeExec` — it must isolate failures (never throw) so
 * one bad statement cannot abort schema initialization.
 */
export async function applyRepositoryInventoryStatements(
  exec: (label: string, sql: string) => Promise<boolean>,
): Promise<{ ok: number; fail: number }> {
  let ok = 0;
  let fail = 0;
  for (const stmt of REPOSITORY_INVENTORY_STATEMENTS) {
    (await exec(stmt.label, stmt.sql)) ? ok++ : fail++;
  }
  return { ok, fail };
}

/**
 * Run the inventory schema programmatically against a Pool/PoolClient (used by
 * `runRepositoryInventoryMigration`). Each statement runs independently;
 * failures are logged via the provided onError callback and do not abort.
 */
export async function applyRepositoryInventorySchema(
  db: Pool | PoolClient,
  onError?: (label: string, err: Error) => void,
): Promise<{ ok: number; fail: number }> {
  return applyRepositoryInventoryStatements(async (label, sql) => {
    try {
      await db.query(sql);
      return true;
    } catch (err) {
      onError?.(label, err as Error);
      return false;
    }
  });
}
