/**
 * PostgreSQL database layer for the self-healing QA agent.
 * Replaces SQLite for production Railway deployment.
 */

import { Pool, type PoolClient } from 'pg';
import { logger } from '../utils/logger';

const MOD = 'postgres';

export interface TestExecution {
  test_name: string;
  status: string;
  error_message?: string;
  screenshot_path?: string;
  github_commit_sha?: string;
  duration_ms?: number;
  healing_attempted?: boolean;
  healing_succeeded?: boolean;
}

export interface HealingAction {
  test_execution_id: number;
  test_name: string;
  failed_locator: string;
  healed_locator?: string;
  healing_strategy: 'rule_based' | 'database_pattern' | 'ai_reasoning';
  ai_tokens_used?: number;
  success?: boolean;
  confidence?: number;
  error_context?: string;
  validation_status?: 'approved' | 'rejected';
  validation_reason?: string;
  patch_path?: string;
}

export interface LearnedPattern {
  test_name: string;
  error_pattern: string;
  failed_locator: string;
  healed_locator: string;
  solution_strategy: string;
  confidence?: number;
  avg_tokens_saved?: number;
}

export interface HistoricalStats {
  total_executions: number;
  total_healings: number;
  success_rate: string;
  total_tokens: number;
  tokens_saved: string;
  learned_patterns: number;
  strategy_breakdown: { rule_based: number; database_pattern: number; ai_reasoning: number };
}

let pool: Pool | null = null;

function getConnectionString(): string {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    throw new Error('DATABASE_URL environment variable is not set');
  }
  return url;
}

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getConnectionString(),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: process.env['DATABASE_SSL'] === 'false' ? false : { rejectUnauthorized: false },
    });
    logger.info(MOD, 'PostgreSQL pool initialized');
  }
  return pool;
}

export async function initDb(): Promise<void> {
  const client = await getPool().connect();
  try {
    await initSchema(client);
    logger.info(MOD, 'PostgreSQL schema initialized');
  } finally {
    client.release();
  }
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    logger.info(MOD, 'PostgreSQL pool closed');
  }
}

async function initSchema(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS test_executions (
      id SERIAL PRIMARY KEY,
      test_name TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      screenshot_path TEXT,
      github_commit_sha TEXT,
      duration_ms INTEGER DEFAULT 0,
      healing_attempted BOOLEAN DEFAULT FALSE,
      healing_succeeded BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS healing_actions (
      id SERIAL PRIMARY KEY,
      test_execution_id INTEGER NOT NULL REFERENCES test_executions(id),
      test_name TEXT NOT NULL,
      failed_locator TEXT NOT NULL,
      healed_locator TEXT,
      healing_strategy TEXT NOT NULL,
      ai_tokens_used INTEGER DEFAULT 0,
      success BOOLEAN DEFAULT FALSE,
      confidence REAL DEFAULT 0,
      error_context TEXT,
      validation_status TEXT,
      validation_reason TEXT,
      patch_path TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS learned_patterns (
      id SERIAL PRIMARY KEY,
      test_name TEXT NOT NULL,
      error_pattern TEXT NOT NULL,
      failed_locator TEXT NOT NULL,
      healed_locator TEXT NOT NULL,
      solution_strategy TEXT NOT NULL,
      confidence REAL DEFAULT 0,
      success_count INTEGER DEFAULT 1,
      failure_count INTEGER DEFAULT 0,
      usage_count INTEGER DEFAULT 0,
      avg_tokens_saved INTEGER DEFAULT 0,
      last_used TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(test_name, error_pattern, failed_locator)
    );

    CREATE TABLE IF NOT EXISTS healing_jobs (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      repository_url TEXT,
      branch TEXT DEFAULT 'main',
      commit_sha TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      progress TEXT DEFAULT '',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      result TEXT,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS token_usage (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      engine TEXT NOT NULL,
      tokens_used INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rca_analyses (
      id SERIAL PRIMARY KEY,
      test_execution_id INTEGER REFERENCES test_executions(id),
      job_id TEXT,
      test_name TEXT NOT NULL,
      root_cause TEXT NOT NULL,
      classification TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'medium',
      confidence REAL DEFAULT 0,
      suggested_fix TEXT,
      affected_component TEXT,
      is_flaky BOOLEAN DEFAULT FALSE,
      flaky_reason TEXT,
      summary TEXT,
      technical_details TEXT,
      tokens_used INTEGER DEFAULT 0,
      model TEXT DEFAULT 'gpt-4o-mini',
      analysis_time_ms INTEGER DEFAULT 0,
      healing_attempted BOOLEAN DEFAULT FALSE,
      healing_succeeded BOOLEAN DEFAULT FALSE,
      healed_locator TEXT,
      healing_strategy TEXT,
      error_message TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_exec_status ON test_executions(status);
    CREATE INDEX IF NOT EXISTS idx_exec_test_name ON test_executions(test_name);
    CREATE INDEX IF NOT EXISTS idx_heal_exec_id ON healing_actions(test_execution_id);
    CREATE INDEX IF NOT EXISTS idx_heal_strategy ON healing_actions(healing_strategy);
    CREATE INDEX IF NOT EXISTS idx_pattern_locator ON learned_patterns(failed_locator);
    CREATE INDEX IF NOT EXISTS idx_pattern_test_name ON learned_patterns(test_name);
    CREATE INDEX IF NOT EXISTS idx_pattern_error ON learned_patterns(error_pattern);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON healing_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(date);
    CREATE INDEX IF NOT EXISTS idx_rca_test_name ON rca_analyses(test_name);
    CREATE INDEX IF NOT EXISTS idx_rca_classification ON rca_analyses(classification);
    CREATE INDEX IF NOT EXISTS idx_rca_job_id ON rca_analyses(job_id);
    CREATE INDEX IF NOT EXISTS idx_rca_exec_id ON rca_analyses(test_execution_id);

    CREATE TABLE IF NOT EXISTS pr_automations (
      id SERIAL PRIMARY KEY,
      job_id TEXT NOT NULL,
      pr_url TEXT NOT NULL,
      pr_number INTEGER NOT NULL,
      branch_name TEXT NOT NULL,
      commit_sha TEXT,
      repo_owner TEXT NOT NULL,
      repo_name TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      files_changed TEXT[],
      healing_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'open',
      merged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pr_job_id ON pr_automations(job_id);
    CREATE INDEX IF NOT EXISTS idx_pr_status ON pr_automations(status);

    -- Script Generation tables
    CREATE TABLE IF NOT EXISTS generated_scripts (
      id SERIAL PRIMARY KEY,
      url TEXT NOT NULL,
      page_type TEXT,
      workflow_graph JSONB,
      instructions TEXT,
      script_content TEXT,
      test_plan JSONB,
      validation_status TEXT DEFAULT 'pending',
      reliability_score REAL DEFAULT 0,
      review_score REAL,
      review_issues JSONB,
      tokens_used INTEGER DEFAULT 0,
      model TEXT,
      generation_time_ms INTEGER,
      files_generated JSONB,
      negative_tests_included BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_gs_url ON generated_scripts(url);
    CREATE INDEX IF NOT EXISTS idx_gs_created ON generated_scripts(created_at DESC);

    CREATE TABLE IF NOT EXISTS dom_snapshots (
      id SERIAL PRIMARY KEY,
      script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
      page_url TEXT NOT NULL,
      html_snapshot TEXT,
      elements_count INTEGER DEFAULT 0,
      page_type TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_dom_script ON dom_snapshots(script_id);

    CREATE TABLE IF NOT EXISTS selector_scores (
      id SERIAL PRIMARY KEY,
      script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
      selector TEXT NOT NULL,
      score REAL DEFAULT 0,
      strategy TEXT,
      element_type TEXT,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sel_script ON selector_scores(script_id);

    CREATE TABLE IF NOT EXISTS workflow_maps (
      id SERIAL PRIMARY KEY,
      script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
      source_page TEXT,
      target_page TEXT,
      action TEXT,
      link_text TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_wf_script ON workflow_maps(script_id);

    CREATE TABLE IF NOT EXISTS generated_projects (
      id SERIAL PRIMARY KEY,
      script_id INTEGER REFERENCES generated_scripts(id) ON DELETE CASCADE,
      project_dir TEXT,
      file_count INTEGER DEFAULT 0,
      total_size INTEGER DEFAULT 0,
      structure JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_gp_script ON generated_projects(script_id);

    -- Authentication tables
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role VARCHAR(50) DEFAULT 'client',
      company_name VARCHAR(255),
      is_active BOOLEAN DEFAULT true,
      last_login TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
    CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      username VARCHAR(100),
      action TEXT NOT NULL,
      resource TEXT,
      resource_id TEXT,
      ip_address VARCHAR(45),
      user_agent TEXT,
      details JSONB,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_user ON audit_logs(user_id);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action);
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL,
      ip_address VARCHAR(45),
      user_agent TEXT,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS notification_configs (
      id SERIAL PRIMARY KEY,
      tool_type TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      status TEXT DEFAULT 'connected',
      config JSONB DEFAULT '{}',
      connected_at TIMESTAMPTZ,
      last_tested_at TIMESTAMPTZ,
      last_test_result TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notif_tool ON notification_configs(tool_type);

    CREATE TABLE IF NOT EXISTS notification_logs (
      id SERIAL PRIMARY KEY,
      tool_type TEXT NOT NULL,
      event_type TEXT NOT NULL,
      channel TEXT,
      message_preview TEXT,
      status TEXT DEFAULT 'sent',
      error TEXT,
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_notif_log_type ON notification_logs(tool_type);
    CREATE INDEX IF NOT EXISTS idx_notif_log_created ON notification_logs(created_at DESC);

    -- Multi-tenant: Companies
    CREATE TABLE IF NOT EXISTS companies (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL UNIQUE,
      slug VARCHAR(100) NOT NULL UNIQUE,
      is_active BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_companies_slug ON companies(slug);

    -- Add company_id columns (safe idempotent ALTER)
    DO $$ BEGIN
      -- test_executions
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='test_executions' AND column_name='company_id') THEN
        ALTER TABLE test_executions ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- healing_actions
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='healing_actions' AND column_name='company_id') THEN
        ALTER TABLE healing_actions ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- learned_patterns
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='learned_patterns' AND column_name='company_id') THEN
        ALTER TABLE learned_patterns ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- healing_jobs
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='healing_jobs' AND column_name='company_id') THEN
        ALTER TABLE healing_jobs ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- token_usage
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='token_usage' AND column_name='company_id') THEN
        ALTER TABLE token_usage ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- rca_analyses
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='rca_analyses' AND column_name='company_id') THEN
        ALTER TABLE rca_analyses ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- pr_automations
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='pr_automations' AND column_name='company_id') THEN
        ALTER TABLE pr_automations ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- generated_scripts
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='generated_scripts' AND column_name='company_id') THEN
        ALTER TABLE generated_scripts ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- notification_configs
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notification_configs' AND column_name='company_id') THEN
        ALTER TABLE notification_configs ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- notification_logs
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='notification_logs' AND column_name='company_id') THEN
        ALTER TABLE notification_logs ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
      -- users
      IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='company_id') THEN
        ALTER TABLE users ADD COLUMN company_id INTEGER REFERENCES companies(id);
      END IF;
    END $$;

    -- Indexes for company_id columns
    CREATE INDEX IF NOT EXISTS idx_exec_company ON test_executions(company_id);
    CREATE INDEX IF NOT EXISTS idx_heal_company ON healing_actions(company_id);
    CREATE INDEX IF NOT EXISTS idx_pattern_company ON learned_patterns(company_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_company ON healing_jobs(company_id);
    CREATE INDEX IF NOT EXISTS idx_token_company ON token_usage(company_id);
    CREATE INDEX IF NOT EXISTS idx_rca_company ON rca_analyses(company_id);
    CREATE INDEX IF NOT EXISTS idx_pr_company ON pr_automations(company_id);
    CREATE INDEX IF NOT EXISTS idx_gs_company ON generated_scripts(company_id);
    CREATE INDEX IF NOT EXISTS idx_notif_config_company ON notification_configs(company_id);
    CREATE INDEX IF NOT EXISTS idx_notif_log_company ON notification_logs(company_id);
    CREATE INDEX IF NOT EXISTS idx_users_company ON users(company_id);
  `);

  // Ensure default company exists and backfill orphaned data
  await migrateDefaultCompany(client);
}

/* -------------------------------------------------------------------------- */
/*  Multi-tenant Migration Helper                                             */
/* -------------------------------------------------------------------------- */

async function migrateDefaultCompany(client: PoolClient): Promise<void> {
  // Ensure "Default" company exists
  const { rows } = await client.query(
    `INSERT INTO companies (name, slug) VALUES ('Default', 'default')
     ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
     RETURNING id`
  );
  const defaultId = rows[0].id;

  // Backfill any rows without company_id
  const tables = [
    'test_executions', 'healing_actions', 'learned_patterns',
    'healing_jobs', 'token_usage', 'rca_analyses', 'pr_automations',
    'generated_scripts', 'notification_configs', 'notification_logs', 'users',
  ];
  for (const t of tables) {
    await client.query(`UPDATE ${t} SET company_id = $1 WHERE company_id IS NULL`, [defaultId]);
  }

  // Migrate notification_configs unique constraint: tool_type → (tool_type, company_id)
  await client.query(`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'notification_configs_tool_type_key'
          AND conrelid = 'notification_configs'::regclass
      ) THEN
        ALTER TABLE notification_configs DROP CONSTRAINT notification_configs_tool_type_key;
        CREATE UNIQUE INDEX IF NOT EXISTS uq_notif_tool_company
          ON notification_configs (tool_type, COALESCE(company_id, 0));
      END IF;
    END $$;
  `);
}

/* -------------------------------------------------------------------------- */
/*  Company CRUD                                                              */
/* -------------------------------------------------------------------------- */

export async function createCompany(name: string, slug: string): Promise<number> {
  const pool = getPool();
  const { rows } = await pool.query(
    `INSERT INTO companies (name, slug) VALUES ($1, $2) RETURNING id`,
    [name, slug],
  );
  return rows[0].id;
}

export async function getCompanies(): Promise<Array<{ id: number; name: string; slug: string; is_active: boolean; created_at: string }>> {
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT id, name, slug, is_active, created_at FROM companies ORDER BY name`
  );
  return rows;
}

export async function getCompanyById(id: number): Promise<{ id: number; name: string; slug: string; is_active: boolean } | null> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT id, name, slug, is_active FROM companies WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getCompanyBySlug(slug: string): Promise<{ id: number; name: string; slug: string; is_active: boolean } | null> {
  const pool = getPool();
  const { rows } = await pool.query(`SELECT id, name, slug, is_active FROM companies WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

export async function updateCompany(id: number, data: { name?: string; is_active?: boolean }): Promise<void> {
  const pool = getPool();
  const sets: string[] = ['updated_at = NOW()'];
  const vals: any[] = [];
  let idx = 1;
  if (data.name !== undefined) { sets.push(`name = $${idx++}`); vals.push(data.name); }
  if (data.is_active !== undefined) { sets.push(`is_active = $${idx++}`); vals.push(data.is_active); }
  vals.push(id);
  await pool.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
}

/* -------------------------------------------------------------------------- */
/*  Test Executions                                                           */
/* -------------------------------------------------------------------------- */

export async function logExecution(data: TestExecution, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO test_executions
      (test_name, status, error_message, screenshot_path, github_commit_sha, duration_ms, healing_attempted, healing_succeeded, company_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id`,
    [
      data.test_name,
      data.status,
      data.error_message ?? null,
      data.screenshot_path ?? null,
      data.github_commit_sha ?? null,
      data.duration_ms ?? 0,
      data.healing_attempted ?? false,
      data.healing_succeeded ?? false,
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function updateExecution(id: number, fields: Partial<TestExecution>): Promise<void> {
  const allowed: Array<keyof TestExecution> = [
    'status', 'error_message', 'screenshot_path', 'github_commit_sha', 'duration_ms', 'healing_attempted', 'healing_succeeded',
  ];

  const updates: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = $${paramIdx}`);
      values.push(fields[key]);
      paramIdx++;
    }
  }

  if (updates.length === 0) return;

  values.push(id);
  await getPool().query(
    `UPDATE test_executions SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
    values,
  );
}

/* -------------------------------------------------------------------------- */
/*  Healing Actions                                                           */
/* -------------------------------------------------------------------------- */

export async function logHealing(data: HealingAction, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO healing_actions
      (test_execution_id, test_name, failed_locator, healed_locator, healing_strategy, ai_tokens_used,
       success, confidence, error_context, validation_status, validation_reason, patch_path, company_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING id`,
    [
      data.test_execution_id,
      data.test_name,
      data.failed_locator,
      data.healed_locator ?? null,
      data.healing_strategy,
      data.ai_tokens_used ?? 0,
      data.success ?? false,
      data.confidence ?? 0,
      data.error_context ?? null,
      data.validation_status ?? null,
      data.validation_reason ?? null,
      data.patch_path ?? null,
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

/* -------------------------------------------------------------------------- */
/*  Learned Patterns                                                          */
/* -------------------------------------------------------------------------- */

export async function lookupPattern(input: {
  failed_locator: string;
  test_name: string;
  error_pattern: string;
}): Promise<{
  healed_locator: string;
  confidence: number;
  strategy: string;
  usage_count: number;
} | null> {
  // Try exact match first
  const exact = await getPool().query(
    `SELECT healed_locator, confidence, solution_strategy, usage_count
    FROM learned_patterns
    WHERE failed_locator = $1 AND test_name = $2
    ORDER BY success_count DESC, usage_count DESC, last_used DESC
    LIMIT 1`,
    [input.failed_locator, input.test_name],
  );

  let row = exact.rows[0];

  if (!row) {
    // Try fuzzy match
    const fuzzy = await getPool().query(
      `SELECT healed_locator, confidence, solution_strategy, usage_count
      FROM learned_patterns
      WHERE failed_locator = $1 OR (test_name = $2 AND error_pattern LIKE $3)
      ORDER BY success_count DESC, usage_count DESC, last_used DESC
      LIMIT 1`,
      [input.failed_locator, input.test_name, `%${input.error_pattern.slice(0, 120)}%`],
    );
    row = fuzzy.rows[0];
  }

  if (!row) return null;

  // Update usage count
  await getPool().query(
    `UPDATE learned_patterns
    SET usage_count = usage_count + 1, last_used = NOW()
    WHERE failed_locator = $1 AND healed_locator = $2`,
    [input.failed_locator, row.healed_locator],
  );

  return {
    healed_locator: row.healed_locator,
    confidence: row.confidence,
    strategy: row.solution_strategy,
    usage_count: row.usage_count + 1,
  };
}

export async function storePattern(data: LearnedPattern, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO learned_patterns
      (test_name, error_pattern, failed_locator, healed_locator, solution_strategy, confidence, avg_tokens_saved, company_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    ON CONFLICT(test_name, error_pattern, failed_locator)
    DO UPDATE SET
      healed_locator = EXCLUDED.healed_locator,
      solution_strategy = EXCLUDED.solution_strategy,
      confidence = EXCLUDED.confidence,
      success_count = learned_patterns.success_count + 1,
      usage_count = learned_patterns.usage_count + 1,
      avg_tokens_saved = (learned_patterns.avg_tokens_saved + EXCLUDED.avg_tokens_saved) / 2,
      last_used = NOW()
    RETURNING id`,
    [
      data.test_name,
      data.error_pattern.slice(0, 250),
      data.failed_locator,
      data.healed_locator,
      data.solution_strategy,
      data.confidence ?? 0,
      data.avg_tokens_saved ?? 0,
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

/* -------------------------------------------------------------------------- */
/*  Historical Stats                                                          */
/* -------------------------------------------------------------------------- */

export async function getHistoricalStats(companyId?: number): Promise<HistoricalStats> {
  const p = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';

  const [execRes, healRes, successRes, tokenRes, patternRes, strategyRes] = await Promise.all([
    p.query(`SELECT COUNT(*) as c FROM test_executions ${cf}`),
    p.query(`SELECT COUNT(*) as c FROM healing_actions ${cf}`),
    p.query(`SELECT COUNT(*) as c FROM healing_actions WHERE success = true ${cfAnd}`),
    p.query(`SELECT COALESCE(SUM(ai_tokens_used), 0) as t FROM healing_actions ${cf}`),
    p.query(`SELECT COUNT(*) as c FROM learned_patterns ${cf}`),
    p.query(`SELECT healing_strategy, COUNT(*) as c FROM healing_actions ${cf} GROUP BY healing_strategy`),
  ]);

  const totalExecutions = parseInt(execRes.rows[0].c, 10);
  const totalHealings = parseInt(healRes.rows[0].c, 10);
  const successHealings = parseInt(successRes.rows[0].c, 10);
  const totalTokens = parseInt(tokenRes.rows[0].t, 10);
  const patternCount = parseInt(patternRes.rows[0].c, 10);

  const breakdown = { rule_based: 0, database_pattern: 0, ai_reasoning: 0 };
  for (const row of strategyRes.rows) {
    const strategy = row.healing_strategy as keyof typeof breakdown;
    if (strategy in breakdown) {
      breakdown[strategy] = parseInt(row.c, 10);
    }
  }

  const successRate = totalHealings > 0 ? `${((successHealings / totalHealings) * 100).toFixed(1)}%` : 'N/A';
  const tokensSaved = totalHealings > 0
    ? `~${(breakdown.rule_based + breakdown.database_pattern) * 500} est.`
    : 'N/A';

  return {
    total_executions: totalExecutions,
    total_healings: totalHealings,
    success_rate: successRate,
    total_tokens: totalTokens,
    tokens_saved: tokensSaved,
    learned_patterns: patternCount,
    strategy_breakdown: breakdown,
  };
}

/* -------------------------------------------------------------------------- */
/*  Token Usage                                                               */
/* -------------------------------------------------------------------------- */

export async function logTokenUsage(engine: string, tokensUsed: number, costUsd: number, companyId?: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await getPool().query(
    `INSERT INTO token_usage (date, engine, tokens_used, cost_usd, company_id) VALUES ($1, $2, $3, $4, $5)`,
    [today, engine, tokensUsed, costUsd, companyId ?? null],
  );
}

export async function getTokensUsedToday(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const result = await getPool().query(
    `SELECT COALESCE(SUM(tokens_used), 0) AS total FROM token_usage WHERE date = $1`,
    [today],
  );
  return parseInt(result.rows[0].total, 10);
}

export async function getDailyCostUsd(): Promise<number> {
  const today = new Date().toISOString().slice(0, 10);
  const result = await getPool().query(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM token_usage WHERE date = $1`,
    [today],
  );
  return parseFloat(result.rows[0].total);
}

/* -------------------------------------------------------------------------- */
/*  Jobs Persistence                                                          */
/* -------------------------------------------------------------------------- */

export async function persistJob(job: {
  id: string;
  repositoryId: string;
  repositoryUrl?: string;
  branch: string;
  commit?: string;
  status: string;
  progress: string;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: any;
  error?: string;
  companyId?: number;
}): Promise<void> {
  await getPool().query(
    `INSERT INTO healing_jobs
      (id, repository_id, repository_url, branch, commit_sha, status, progress,
       created_at, started_at, completed_at, result, error, company_id)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    ON CONFLICT(id) DO UPDATE SET
      status = EXCLUDED.status,
      progress = EXCLUDED.progress,
      started_at = EXCLUDED.started_at,
      completed_at = EXCLUDED.completed_at,
      result = EXCLUDED.result,
      error = EXCLUDED.error`,
    [
      job.id,
      job.repositoryId,
      job.repositoryUrl ?? null,
      job.branch,
      job.commit ?? null,
      job.status,
      job.progress,
      job.createdAt,
      job.startedAt ?? null,
      job.completedAt ?? null,
      job.result ? JSON.stringify(job.result) : null,
      job.error ?? null,
      job.companyId ?? null,
    ],
  );
}

export async function loadJobFromDb(jobId: string): Promise<any | null> {
  const result = await getPool().query('SELECT * FROM healing_jobs WHERE id = $1', [jobId]);
  return result.rows[0] ?? null;
}

export async function loadPersistedJobs(statuses: string[]): Promise<any[]> {
  const result = await getPool().query(
    `SELECT * FROM healing_jobs WHERE status = ANY($1) ORDER BY created_at DESC LIMIT 50`,
    [statuses],
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/*  RCA Analysis Persistence                                                  */
/* -------------------------------------------------------------------------- */

export interface RCARecord {
  id?: number;
  test_execution_id: string;
  job_id: string;
  test_name: string;
  root_cause: string;
  classification: string;
  severity: string;
  confidence: number;
  suggested_fix: string;
  affected_component: string;
  is_flaky: boolean;
  flaky_reason?: string;
  summary: string;
  technical_details?: string;
  tokens_used: number;
  model: string;
  analysis_time_ms: number;
  healing_attempted: boolean;
  healing_succeeded: boolean;
  healed_locator?: string;
  healing_strategy?: string;
  error_message?: string;
  created_at?: string;
}

export async function logRCA(data: RCARecord, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO rca_analyses
      (test_execution_id, job_id, test_name, root_cause, classification, severity,
       confidence, suggested_fix, affected_component, is_flaky, flaky_reason,
       summary, technical_details, tokens_used, model, analysis_time_ms,
       healing_attempted, healing_succeeded, healed_locator, healing_strategy, error_message, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
    RETURNING id`,
    [
      data.test_execution_id,
      data.job_id,
      data.test_name,
      data.root_cause,
      data.classification,
      data.severity,
      data.confidence,
      data.suggested_fix,
      data.affected_component,
      data.is_flaky,
      data.flaky_reason ?? null,
      data.summary,
      data.technical_details ?? null,
      data.tokens_used,
      data.model,
      data.analysis_time_ms,
      data.healing_attempted,
      data.healing_succeeded,
      data.healed_locator ?? null,
      data.healing_strategy ?? null,
      data.error_message ?? null,
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function getRCA(executionId: string, companyId?: number): Promise<RCARecord | null> {
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM rca_analyses WHERE test_execution_id = $1 ${cfAnd} ORDER BY created_at DESC LIMIT 1`,
    [executionId],
  );
  return result.rows[0] ?? null;
}

export async function getRCAsForJob(jobId: string, companyId?: number): Promise<RCARecord[]> {
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM rca_analyses WHERE job_id = $1 ${cfAnd} ORDER BY created_at ASC`,
    [jobId],
  );
  return result.rows;
}

export async function getRCAStats(companyId?: number): Promise<{
  total: number;
  byClassification: Record<string, number>;
  bySeverity: Record<string, number>;
  avgConfidence: number;
  flakyCount: number;
  healingSuccessRate: number;
}> {
  const pool = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';

  const totalRes = await pool.query(`SELECT COUNT(*) AS count FROM rca_analyses ${cf}`);
  const total = parseInt(totalRes.rows[0].count, 10);

  const classRes = await pool.query(
    `SELECT classification, COUNT(*) AS count FROM rca_analyses ${cf} GROUP BY classification ORDER BY count DESC`,
  );
  const byClassification: Record<string, number> = {};
  for (const row of classRes.rows) {
    byClassification[row.classification] = parseInt(row.count, 10);
  }

  const sevRes = await pool.query(
    `SELECT severity, COUNT(*) AS count FROM rca_analyses ${cf} GROUP BY severity ORDER BY count DESC`,
  );
  const bySeverity: Record<string, number> = {};
  for (const row of sevRes.rows) {
    bySeverity[row.severity] = parseInt(row.count, 10);
  }

  const avgRes = await pool.query(
    `SELECT COALESCE(AVG(confidence), 0) AS avg FROM rca_analyses ${cf}`,
  );
  const avgConfidence = parseFloat(avgRes.rows[0].avg);

  const flakyRes = await pool.query(
    `SELECT COUNT(*) AS count FROM rca_analyses WHERE is_flaky = true ${cfAnd}`,
  );
  const flakyCount = parseInt(flakyRes.rows[0].count, 10);

  const healRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE healing_attempted = true) AS attempted,
       COUNT(*) FILTER (WHERE healing_succeeded = true) AS succeeded
     FROM rca_analyses ${cf}`,
  );
  const attempted = parseInt(healRes.rows[0].attempted, 10);
  const succeeded = parseInt(healRes.rows[0].succeeded, 10);
  const healingSuccessRate = attempted > 0 ? succeeded / attempted : 0;

  return { total, byClassification, bySeverity, avgConfidence, flakyCount, healingSuccessRate };
}

/* -------------------------------------------------------------------------- */
/*  Flaky Test Analytics                                                      */
/* -------------------------------------------------------------------------- */

export interface FlakyTestSummary {
  test_name: string;
  flaky_count: number;
  total_analyses: number;
  flaky_rate: number;
  latest_reason: string | null;
  latest_severity: string;
  classifications: string[];
  first_seen: string;
  last_seen: string;
  affected_components: string[];
}

export async function getFlakyTests(companyId?: number): Promise<FlakyTestSummary[]> {
  const pool = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await pool.query(`
    WITH flaky_agg AS (
      SELECT
        test_name,
        COUNT(*) FILTER (WHERE is_flaky = true) AS flaky_count,
        COUNT(*) AS total_analyses,
        ARRAY_AGG(DISTINCT classification) FILTER (WHERE classification IS NOT NULL) AS classifications,
        ARRAY_AGG(DISTINCT affected_component) FILTER (WHERE affected_component IS NOT NULL) AS affected_components,
        MIN(created_at) AS first_seen,
        MAX(created_at) AS last_seen
      FROM rca_analyses
      ${cf}
      GROUP BY test_name
      HAVING COUNT(*) FILTER (WHERE is_flaky = true) > 0
    ),
    latest_flaky AS (
      SELECT DISTINCT ON (test_name)
        test_name, flaky_reason, severity
      FROM rca_analyses
      WHERE is_flaky = true ${cfAnd}
      ORDER BY test_name, created_at DESC
    )
    SELECT
      f.test_name,
      f.flaky_count,
      f.total_analyses,
      ROUND((f.flaky_count::numeric / NULLIF(f.total_analyses, 0)) * 100, 1) AS flaky_rate,
      l.flaky_reason AS latest_reason,
      COALESCE(l.severity, 'medium') AS latest_severity,
      f.classifications,
      f.first_seen,
      f.last_seen,
      f.affected_components
    FROM flaky_agg f
    LEFT JOIN latest_flaky l ON l.test_name = f.test_name
    ORDER BY f.flaky_count DESC, f.last_seen DESC
  `);
  return result.rows;
}

export async function getFlakyTrend(days: number = 30, companyId?: number): Promise<Array<{ date: string; flaky: number; total: number }>> {
  const pool = getPool();
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await pool.query(`
    SELECT
      DATE(created_at) AS date,
      COUNT(*) FILTER (WHERE is_flaky = true) AS flaky,
      COUNT(*) AS total
    FROM rca_analyses
    WHERE created_at >= NOW() - INTERVAL '${days} days' ${cfAnd}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);
  return result.rows.map(r => ({
    date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
    flaky: parseInt(r.flaky, 10),
    total: parseInt(r.total, 10),
  }));
}

export async function getFlakyHistory(testName: string, companyId?: number): Promise<RCARecord[]> {
  const pool = getPool();
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await pool.query(
    `SELECT * FROM rca_analyses WHERE test_name = $1 ${cfAnd} ORDER BY created_at DESC LIMIT 50`,
    [testName],
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/*  DOM Memory Analytics                                                      */
/* -------------------------------------------------------------------------- */

export async function getDomMemoryStats(companyId?: number): Promise<{
  totalSnapshots: number;
  totalSelectors: number;
  uniquePages: number;
  avgSelectorScore: number;
  totalLocatorChanges: number;
  uniqueHealedLocators: number;
}> {
  const pool = getPool();
  // DOM snapshots/selectors join through generated_scripts for company scope
  const snapCf = companyId ? `WHERE ds.script_id IN (SELECT id FROM generated_scripts WHERE company_id = ${companyId})` : '';
  const selCf = companyId ? `WHERE ss.script_id IN (SELECT id FROM generated_scripts WHERE company_id = ${companyId})` : '';
  const haCf = companyId ? `AND company_id = ${companyId}` : '';
  const [snapRes, selRes, pagesRes, avgRes, changesRes, uniqueHealedRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS c FROM dom_snapshots ds ${snapCf}`),
    pool.query(`SELECT COUNT(*) AS c FROM selector_scores ss ${selCf}`),
    pool.query(`SELECT COUNT(DISTINCT ds.page_url) AS c FROM dom_snapshots ds ${snapCf}`),
    pool.query(`SELECT COALESCE(AVG(ss.score), 0) AS avg FROM selector_scores ss ${selCf}`),
    pool.query(`SELECT COUNT(*) AS c FROM healing_actions WHERE healed_locator IS NOT NULL AND healed_locator != failed_locator ${haCf}`),
    pool.query(`SELECT COUNT(DISTINCT healed_locator) AS c FROM healing_actions WHERE healed_locator IS NOT NULL ${haCf}`),
  ]);
  return {
    totalSnapshots: parseInt(snapRes.rows[0].c, 10),
    totalSelectors: parseInt(selRes.rows[0].c, 10),
    uniquePages: parseInt(pagesRes.rows[0].c, 10),
    avgSelectorScore: parseFloat(parseFloat(avgRes.rows[0].avg).toFixed(2)),
    totalLocatorChanges: parseInt(changesRes.rows[0].c, 10),
    uniqueHealedLocators: parseInt(uniqueHealedRes.rows[0].c, 10),
  };
}

export async function getDomSnapshots(limit = 50, companyId?: number): Promise<any[]> {
  const cf = companyId ? `WHERE gs.company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT ds.*, gs.url AS script_url, gs.test_count
     FROM dom_snapshots ds
     LEFT JOIN generated_scripts gs ON gs.id = ds.script_id
     ${cf}
     ORDER BY ds.created_at DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getSelectorHealth(limit = 100, companyId?: number): Promise<any[]> {
  const cfJoin = companyId ? `JOIN generated_scripts gs ON gs.id = ss.script_id AND gs.company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT
       ss.selector,
       ROUND(AVG(ss.score)::numeric, 2) AS avg_score,
       COUNT(*) AS usage_count,
       MAX(ss.strategy) AS strategy,
       MAX(ss.element_type) AS element_type,
       ARRAY_AGG(DISTINCT ss.reason) FILTER (WHERE ss.reason IS NOT NULL) AS reasons,
       MIN(ss.created_at) AS first_seen,
       MAX(ss.created_at) AS last_seen
     FROM selector_scores ss
     ${cfJoin}
     GROUP BY ss.selector
     ORDER BY AVG(ss.score) ASC, COUNT(*) DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getLocatorEvolution(limit = 50, companyId?: number): Promise<any[]> {
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT
       failed_locator,
       healed_locator,
       healing_strategy,
       test_name,
       success,
       confidence,
       COUNT(*) AS occurrence_count,
       MIN(created_at) AS first_seen,
       MAX(created_at) AS last_seen
     FROM healing_actions
     WHERE healed_locator IS NOT NULL ${cfAnd}
     GROUP BY failed_locator, healed_locator, healing_strategy, test_name, success, confidence
     ORDER BY COUNT(*) DESC, MAX(created_at) DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getPageElementTrend(days = 30, companyId?: number): Promise<Array<{ date: string; pages: number; elements: number; snapshots: number }>> {
  const cfJoin = companyId ? `JOIN generated_scripts gs ON gs.id = ds.script_id AND gs.company_id = ${companyId}` : '';
  const result = await getPool().query(`
    SELECT
      DATE(ds.created_at) AS date,
      COUNT(DISTINCT ds.page_url) AS pages,
      COALESCE(SUM(ds.elements_count), 0) AS elements,
      COUNT(*) AS snapshots
    FROM dom_snapshots ds
    ${cfJoin}
    WHERE ds.created_at >= NOW() - INTERVAL '${days} days'
    GROUP BY DATE(ds.created_at)
    ORDER BY date ASC
  `);
  return result.rows.map(r => ({
    date: r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date),
    pages: parseInt(r.pages, 10),
    elements: parseInt(r.elements, 10),
    snapshots: parseInt(r.snapshots, 10),
  }));
}

export async function getSelectorScoreDistribution(companyId?: number): Promise<Array<{ range: string; count: number }>> {
  const cfJoin = companyId ? `JOIN generated_scripts gs ON gs.id = ss.script_id AND gs.company_id = ${companyId}` : '';
  const result = await getPool().query(`
    SELECT
      CASE
        WHEN ss.score >= 0.8 THEN 'Excellent (0.8-1.0)'
        WHEN ss.score >= 0.6 THEN 'Good (0.6-0.8)'
        WHEN ss.score >= 0.4 THEN 'Fair (0.4-0.6)'
        WHEN ss.score >= 0.2 THEN 'Poor (0.2-0.4)'
        ELSE 'Critical (0-0.2)'
      END AS range,
      COUNT(*) AS count
    FROM selector_scores ss
    ${cfJoin}
    GROUP BY range
    ORDER BY MIN(ss.score) DESC
  `);
  return result.rows.map(r => ({ range: r.range, count: parseInt(r.count, 10) }));
}

/* -------------------------------------------------------------------------- */
/*  Learning Engine Analytics                                                 */
/* -------------------------------------------------------------------------- */

export async function getLearningStats(companyId?: number): Promise<{
  totalPatterns: number;
  totalUsages: number;
  avgConfidence: number;
  avgTokensSaved: number;
  totalTokensSaved: number;
  topStrategy: string;
  activePatterns: number;
  stalePatterns: number;
}> {
  const pool = getPool();
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const [totalRes, usageRes, avgRes, tokenRes, stratRes, activeRes, staleRes] = await Promise.all([
    pool.query(`SELECT COUNT(*) AS c FROM learned_patterns ${cf}`),
    pool.query(`SELECT COALESCE(SUM(usage_count), 0) AS c FROM learned_patterns ${cf}`),
    pool.query(`SELECT COALESCE(AVG(confidence), 0) AS avg FROM learned_patterns ${cf}`),
    pool.query(`SELECT COALESCE(SUM(avg_tokens_saved * usage_count), 0) AS total, COALESCE(AVG(avg_tokens_saved), 0) AS avg FROM learned_patterns ${cf}`),
    pool.query(`SELECT solution_strategy, COUNT(*) AS c FROM learned_patterns ${cf} GROUP BY solution_strategy ORDER BY c DESC LIMIT 1`),
    pool.query(`SELECT COUNT(*) AS c FROM learned_patterns WHERE last_used >= NOW() - INTERVAL '30 days' ${cfAnd}`),
    pool.query(`SELECT COUNT(*) AS c FROM learned_patterns WHERE last_used < NOW() - INTERVAL '90 days' ${cfAnd}`),
  ]);
  return {
    totalPatterns: parseInt(totalRes.rows[0].c, 10),
    totalUsages: parseInt(usageRes.rows[0].c, 10),
    avgConfidence: parseFloat(parseFloat(avgRes.rows[0].avg).toFixed(3)),
    avgTokensSaved: parseFloat(parseFloat(tokenRes.rows[0].avg).toFixed(0)),
    totalTokensSaved: parseInt(tokenRes.rows[0].total, 10),
    topStrategy: stratRes.rows[0]?.solution_strategy || 'N/A',
    activePatterns: parseInt(activeRes.rows[0].c, 10),
    stalePatterns: parseInt(staleRes.rows[0].c, 10),
  };
}

export async function getPatternsList(limit = 100, companyId?: number): Promise<any[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM learned_patterns ${cf} ORDER BY usage_count DESC, success_count DESC, last_used DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getStrategyEffectiveness(companyId?: number): Promise<Array<{
  strategy: string;
  pattern_count: number;
  total_usages: number;
  avg_confidence: number;
  total_successes: number;
  total_failures: number;
  success_rate: number;
  avg_tokens_saved: number;
}>> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(`
    SELECT
      solution_strategy AS strategy,
      COUNT(*) AS pattern_count,
      COALESCE(SUM(usage_count), 0) AS total_usages,
      ROUND(AVG(confidence)::numeric, 3) AS avg_confidence,
      COALESCE(SUM(success_count), 0) AS total_successes,
      COALESCE(SUM(failure_count), 0) AS total_failures,
      CASE WHEN SUM(success_count) + SUM(failure_count) > 0
        THEN ROUND((SUM(success_count)::numeric / (SUM(success_count) + SUM(failure_count))) * 100, 1)
        ELSE 0
      END AS success_rate,
      ROUND(AVG(avg_tokens_saved)::numeric, 0) AS avg_tokens_saved
    FROM learned_patterns
    ${cf}
    GROUP BY solution_strategy
    ORDER BY total_usages DESC
  `);
  return result.rows.map(r => ({
    strategy: r.strategy,
    pattern_count: parseInt(r.pattern_count, 10),
    total_usages: parseInt(r.total_usages, 10),
    avg_confidence: parseFloat(r.avg_confidence),
    total_successes: parseInt(r.total_successes, 10),
    total_failures: parseInt(r.total_failures, 10),
    success_rate: parseFloat(r.success_rate),
    avg_tokens_saved: parseInt(r.avg_tokens_saved, 10),
  }));
}

export async function getLearningVelocity(days = 30, companyId?: number): Promise<Array<{ date: string; new_patterns: number; usages: number }>> {
  const pool = getPool();
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await pool.query(`
    SELECT
      DATE(created_at) AS date,
      COUNT(*) AS new_patterns
    FROM learned_patterns
    WHERE created_at >= NOW() - INTERVAL '${days} days' ${cfAnd}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);
  // Also get usage trend from healing_actions using pattern_match strategy
  const usageResult = await pool.query(`
    SELECT
      DATE(created_at) AS date,
      COUNT(*) AS usages
    FROM healing_actions
    WHERE healing_strategy = 'pattern_match'
      AND created_at >= NOW() - INTERVAL '${days} days' ${cfAnd}
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `);
  const usageMap: Record<string, number> = {};
  usageResult.rows.forEach(r => {
    const d = r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date);
    usageMap[d] = parseInt(r.usages, 10);
  });

  return result.rows.map(r => {
    const d = r.date instanceof Date ? r.date.toISOString().split('T')[0] : String(r.date);
    return {
      date: d,
      new_patterns: parseInt(r.new_patterns, 10),
      usages: usageMap[d] || 0,
    };
  });
}

export async function getTopPatterns(limit = 10, companyId?: number): Promise<any[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT
       test_name, failed_locator, healed_locator, solution_strategy,
       confidence, success_count, failure_count, usage_count,
       avg_tokens_saved, last_used, created_at
     FROM learned_patterns
     ${cf}
     ORDER BY usage_count DESC, success_count DESC
     LIMIT $1`,
    [limit],
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/*  PR Automation Persistence                                                 */
/* -------------------------------------------------------------------------- */

export interface PRRecord {
  id?: number;
  job_id: string;
  pr_url: string;
  pr_number: number;
  branch_name: string;
  commit_sha?: string;
  repo_owner: string;
  repo_name: string;
  base_branch: string;
  files_changed?: string[];
  healing_count: number;
  status?: string;
  merged_at?: string;
  created_at?: string;
}

export async function logPR(data: PRRecord, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO pr_automations
      (job_id, pr_url, pr_number, branch_name, commit_sha,
       repo_owner, repo_name, base_branch, files_changed, healing_count, status, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    RETURNING id`,
    [
      data.job_id,
      data.pr_url,
      data.pr_number,
      data.branch_name,
      data.commit_sha ?? null,
      data.repo_owner,
      data.repo_name,
      data.base_branch,
      data.files_changed ?? [],
      data.healing_count,
      data.status ?? 'open',
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function getPRForJob(jobId: string): Promise<PRRecord | null> {
  const result = await getPool().query(
    `SELECT * FROM pr_automations WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [jobId],
  );
  return result.rows[0] ?? null;
}

export async function getRecentPRs(limit = 20): Promise<PRRecord[]> {
  const result = await getPool().query(
    `SELECT * FROM pr_automations ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function updatePRStatus(prId: number, status: string, mergedAt?: string): Promise<void> {
  await getPool().query(
    `UPDATE pr_automations SET status = $1, merged_at = $2 WHERE id = $3`,
    [status, mergedAt ?? null, prId],
  );
}

/* -------------------------------------------------------------------------- */
/*  Script Generation Persistence                                            */
/* -------------------------------------------------------------------------- */

export interface GeneratedScriptRecord {
  id?: number;
  url: string;
  page_type?: string;
  workflow_graph?: any;
  instructions?: string;
  script_content?: string;
  test_plan?: any;
  validation_status?: string;
  reliability_score?: number;
  review_score?: number;
  review_issues?: any;
  tokens_used?: number;
  model?: string;
  generation_time_ms?: number;
  files_generated?: any;
  negative_tests_included?: boolean;
  created_at?: string;
}

export async function logGeneratedScript(data: GeneratedScriptRecord, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO generated_scripts
      (url, page_type, workflow_graph, instructions, script_content, test_plan,
       validation_status, reliability_score, review_score, review_issues,
       tokens_used, model, generation_time_ms, files_generated, negative_tests_included, company_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
    RETURNING id`,
    [
      data.url,
      data.page_type ?? null,
      data.workflow_graph ? JSON.stringify(data.workflow_graph) : null,
      data.instructions ?? null,
      data.script_content ?? null,
      data.test_plan ? JSON.stringify(data.test_plan) : null,
      data.validation_status ?? 'pending',
      data.reliability_score ?? 0,
      data.review_score ?? null,
      data.review_issues ? JSON.stringify(data.review_issues) : null,
      data.tokens_used ?? 0,
      data.model ?? null,
      data.generation_time_ms ?? null,
      data.files_generated ? JSON.stringify(data.files_generated) : null,
      data.negative_tests_included ?? false,
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function getGeneratedScript(id: number, companyId?: number): Promise<GeneratedScriptRecord | null> {
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM generated_scripts WHERE id = $1 ${cfAnd}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function getRecentScripts(limit = 20, companyId?: number): Promise<GeneratedScriptRecord[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM generated_scripts ${cf} ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function updateScriptReview(
  scriptId: number,
  reviewScore: number,
  reviewIssues: any[],
): Promise<void> {
  await getPool().query(
    `UPDATE generated_scripts SET review_score = $1, review_issues = $2 WHERE id = $3`,
    [reviewScore, JSON.stringify(reviewIssues), scriptId],
  );
}

export async function logDomSnapshot(data: {
  script_id: number;
  page_url: string;
  html_snapshot?: string;
  elements_count: number;
  page_type?: string;
}): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO dom_snapshots (script_id, page_url, html_snapshot, elements_count, page_type)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id`,
    [data.script_id, data.page_url, data.html_snapshot ?? null, data.elements_count, data.page_type ?? null],
  );
  return result.rows[0].id;
}

export async function logSelectorScores(
  scriptId: number,
  scores: Array<{ selector: string; score: number; strategy: string; element_type?: string; reason?: string }>,
): Promise<void> {
  if (scores.length === 0) return;
  const values: any[] = [];
  const placeholders: string[] = [];
  let idx = 1;
  for (const s of scores) {
    placeholders.push(`($${idx},$${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4},$${idx + 5})`);
    values.push(scriptId, s.selector, s.score, s.strategy, s.element_type ?? null, s.reason ?? null);
    idx += 6;
  }
  await getPool().query(
    `INSERT INTO selector_scores (script_id, selector, score, strategy, element_type, reason)
    VALUES ${placeholders.join(',')}`,
    values,
  );
}

export async function logWorkflowMaps(
  scriptId: number,
  maps: Array<{ source_page: string; target_page: string; action: string; link_text?: string }>,
): Promise<void> {
  if (maps.length === 0) return;
  const values: any[] = [];
  const placeholders: string[] = [];
  let idx = 1;
  for (const m of maps) {
    placeholders.push(`($${idx},$${idx + 1},$${idx + 2},$${idx + 3},$${idx + 4})`);
    values.push(scriptId, m.source_page, m.target_page, m.action, m.link_text ?? null);
    idx += 5;
  }
  await getPool().query(
    `INSERT INTO workflow_maps (script_id, source_page, target_page, action, link_text)
    VALUES ${placeholders.join(',')}`,
    values,
  );
}

export async function logProjectExport(data: {
  script_id: number;
  project_dir: string;
  file_count: number;
  total_size: number;
  structure?: any;
}): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO generated_projects (script_id, project_dir, file_count, total_size, structure)
    VALUES ($1,$2,$3,$4,$5)
    RETURNING id`,
    [data.script_id, data.project_dir, data.file_count, data.total_size, data.structure ? JSON.stringify(data.structure) : null],
  );
  return result.rows[0].id;
}

/* -------------------------------------------------------------------------- */
/*  User Management                                                          */
/* -------------------------------------------------------------------------- */

export interface UserRecord {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  company_name: string | null;
  company_id: number | null;
  is_active: boolean;
  last_login: string | null;
  created_at: string;
  updated_at: string;
}

export async function createUser(data: {
  username: string;
  password_hash: string;
  role?: string;
  company_name?: string;
  company_id?: number;
}): Promise<UserRecord> {
  const result = await getPool().query(
    `INSERT INTO users (username, password_hash, role, company_name, company_id)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *`,
    [data.username, data.password_hash, data.role || 'client', data.company_name || null, data.company_id || null],
  );
  return result.rows[0];
}

export async function getUserByUsername(username: string): Promise<UserRecord | null> {
  const result = await getPool().query(
    `SELECT u.*, c.name AS company_display_name, c.slug AS company_slug
     FROM users u LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.username = $1 AND u.is_active = true`,
    [username],
  );
  return result.rows[0] ?? null;
}

export async function getUserById(id: number): Promise<UserRecord | null> {
  const result = await getPool().query(
    `SELECT u.*, c.name AS company_display_name, c.slug AS company_slug
     FROM users u LEFT JOIN companies c ON c.id = u.company_id
     WHERE u.id = $1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function updateLastLogin(userId: number): Promise<void> {
  await getPool().query(
    `UPDATE users SET last_login = NOW(), updated_at = NOW() WHERE id = $1`,
    [userId],
  );
}

export async function listUsers(companyId?: number): Promise<UserRecord[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT id, username, role, company_name, company_id, is_active, last_login, created_at, updated_at
     FROM users ${cf} ORDER BY created_at ASC`,
  );
  return result.rows;
}

export async function deactivateUser(userId: number): Promise<void> {
  await getPool().query(
    `UPDATE users SET is_active = false, updated_at = NOW() WHERE id = $1`,
    [userId],
  );
}

/* -------------------------------------------------------------------------- */
/*  Audit Logging                                                            */
/* -------------------------------------------------------------------------- */

export interface AuditLogRecord {
  id?: number;
  user_id: number | null;
  username: string;
  action: string;
  resource?: string;
  resource_id?: string;
  ip_address?: string;
  user_agent?: string;
  details?: any;
  created_at?: string;
}

export async function logAudit(data: AuditLogRecord): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO audit_logs (user_id, username, action, resource, resource_id, ip_address, user_agent, details)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id`,
    [
      data.user_id,
      data.username,
      data.action,
      data.resource ?? null,
      data.resource_id ?? null,
      data.ip_address ?? null,
      data.user_agent ?? null,
      data.details ? JSON.stringify(data.details) : null,
    ],
  );
  return result.rows[0].id;
}

export async function getAuditLogs(limit = 50, offset = 0): Promise<AuditLogRecord[]> {
  const result = await getPool().query(
    `SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return result.rows;
}

/* -------------------------------------------------------------------------- */
/*  Session Management                                                       */
/* -------------------------------------------------------------------------- */

export async function createSession(data: {
  user_id: number;
  token_hash: string;
  ip_address?: string;
  user_agent?: string;
  expires_at: Date;
}): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO sessions (user_id, token_hash, ip_address, user_agent, expires_at)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id`,
    [data.user_id, data.token_hash, data.ip_address ?? null, data.user_agent ?? null, data.expires_at],
  );
  return result.rows[0].id;
}

export async function invalidateUserSessions(userId: number): Promise<void> {
  await getPool().query(
    `DELETE FROM sessions WHERE user_id = $1`,
    [userId],
  );
}

export async function cleanExpiredSessions(): Promise<number> {
  const result = await getPool().query(
    `DELETE FROM sessions WHERE expires_at < NOW()`,
  );
  return result.rowCount ?? 0;
}


/* -------------------------------------------------------------------------- */
/*  Notification Configs                                                       */
/* -------------------------------------------------------------------------- */

export interface NotificationConfig {
  id: number;
  tool_type: string;
  display_name: string;
  status: string;
  config: Record<string, any>;
  connected_at: string | null;
  last_tested_at: string | null;
  last_test_result: string | null;
  created_at: string;
  updated_at: string;
}

export async function getNotificationConfigs(companyId?: number): Promise<NotificationConfig[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM notification_configs ${cf} ORDER BY created_at ASC`,
  );
  return result.rows;
}

export async function getNotificationConfigByType(toolType: string, companyId?: number): Promise<NotificationConfig | null> {
  const cfAnd = companyId ? `AND company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM notification_configs WHERE tool_type = $1 ${cfAnd}`,
    [toolType],
  );
  return result.rows[0] || null;
}

export async function upsertNotificationConfig(data: {
  tool_type: string;
  display_name: string;
  config: Record<string, any>;
}, companyId?: number): Promise<NotificationConfig> {
  const cid = companyId ?? null;
  const result = await getPool().query(
    `INSERT INTO notification_configs (tool_type, display_name, status, config, connected_at, updated_at, company_id)
     VALUES ($1, $2, 'connected', $3, NOW(), NOW(), $4)
     ON CONFLICT (tool_type, COALESCE(company_id, 0))
     DO UPDATE SET
       display_name = EXCLUDED.display_name,
       config = EXCLUDED.config,
       status = 'connected',
       connected_at = NOW(),
       updated_at = NOW(),
       last_test_result = NULL
     RETURNING *`,
    [data.tool_type, data.display_name, JSON.stringify(data.config), cid],
  );
  return result.rows[0];
}

export async function deleteNotificationConfig(id: number): Promise<boolean> {
  const result = await getPool().query(
    `DELETE FROM notification_configs WHERE id = $1`,
    [id],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateNotificationTestResult(
  id: number,
  success: boolean,
): Promise<void> {
  await getPool().query(
    `UPDATE notification_configs
     SET last_tested_at = NOW(),
         last_test_result = $2,
         status = CASE WHEN $2 = 'success' THEN 'connected' ELSE 'error' END,
         updated_at = NOW()
     WHERE id = $1`,
    [id, success ? 'success' : 'failed'],
  );
}

/* -------------------------------------------------------------------------- */
/*  Notification Logs                                                          */
/* -------------------------------------------------------------------------- */

export async function insertNotificationLog(data: {
  tool_type: string;
  event_type: string;
  channel?: string;
  message_preview?: string;
  status: string;
  error?: string;
  metadata?: Record<string, any>;
}, companyId?: number): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO notification_logs (tool_type, event_type, channel, message_preview, status, error, metadata, company_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      data.tool_type,
      data.event_type,
      data.channel ?? null,
      data.message_preview ?? null,
      data.status,
      data.error ?? null,
      JSON.stringify(data.metadata ?? {}),
      companyId ?? null,
    ],
  );
  return result.rows[0].id;
}

export async function getNotificationLogs(limit = 50, companyId?: number): Promise<any[]> {
  const cf = companyId ? `WHERE company_id = ${companyId}` : '';
  const result = await getPool().query(
    `SELECT * FROM notification_logs ${cf} ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return result.rows;
}