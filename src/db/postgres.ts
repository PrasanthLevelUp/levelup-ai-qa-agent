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
  `);
}

/* -------------------------------------------------------------------------- */
/*  Test Executions                                                           */
/* -------------------------------------------------------------------------- */

export async function logExecution(data: TestExecution): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO test_executions
      (test_name, status, error_message, screenshot_path, github_commit_sha, duration_ms, healing_attempted, healing_succeeded)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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

export async function logHealing(data: HealingAction): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO healing_actions
      (test_execution_id, test_name, failed_locator, healed_locator, healing_strategy, ai_tokens_used,
       success, confidence, error_context, validation_status, validation_reason, patch_path)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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

export async function storePattern(data: LearnedPattern): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO learned_patterns
      (test_name, error_pattern, failed_locator, healed_locator, solution_strategy, confidence, avg_tokens_saved)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
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
    ],
  );
  return result.rows[0].id;
}

/* -------------------------------------------------------------------------- */
/*  Historical Stats                                                          */
/* -------------------------------------------------------------------------- */

export async function getHistoricalStats(): Promise<HistoricalStats> {
  const p = getPool();

  const [execRes, healRes, successRes, tokenRes, patternRes, strategyRes] = await Promise.all([
    p.query('SELECT COUNT(*) as c FROM test_executions'),
    p.query('SELECT COUNT(*) as c FROM healing_actions'),
    p.query('SELECT COUNT(*) as c FROM healing_actions WHERE success = true'),
    p.query('SELECT COALESCE(SUM(ai_tokens_used), 0) as t FROM healing_actions'),
    p.query('SELECT COUNT(*) as c FROM learned_patterns'),
    p.query(`SELECT healing_strategy, COUNT(*) as c FROM healing_actions GROUP BY healing_strategy`),
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

export async function logTokenUsage(engine: string, tokensUsed: number, costUsd: number): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await getPool().query(
    `INSERT INTO token_usage (date, engine, tokens_used, cost_usd) VALUES ($1, $2, $3, $4)`,
    [today, engine, tokensUsed, costUsd],
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
}): Promise<void> {
  await getPool().query(
    `INSERT INTO healing_jobs
      (id, repository_id, repository_url, branch, commit_sha, status, progress,
       created_at, started_at, completed_at, result, error)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
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

export async function logRCA(data: RCARecord): Promise<number> {
  const result = await getPool().query(
    `INSERT INTO rca_analyses
      (test_execution_id, job_id, test_name, root_cause, classification, severity,
       confidence, suggested_fix, affected_component, is_flaky, flaky_reason,
       summary, technical_details, tokens_used, model, analysis_time_ms,
       healing_attempted, healing_succeeded, healed_locator, healing_strategy, error_message)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
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
    ],
  );
  return result.rows[0].id;
}

export async function getRCA(executionId: string): Promise<RCARecord | null> {
  const result = await getPool().query(
    `SELECT * FROM rca_analyses WHERE test_execution_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [executionId],
  );
  return result.rows[0] ?? null;
}

export async function getRCAsForJob(jobId: string): Promise<RCARecord[]> {
  const result = await getPool().query(
    `SELECT * FROM rca_analyses WHERE job_id = $1 ORDER BY created_at ASC`,
    [jobId],
  );
  return result.rows;
}

export async function getRCAStats(): Promise<{
  total: number;
  byClassification: Record<string, number>;
  bySeverity: Record<string, number>;
  avgConfidence: number;
  flakyCount: number;
  healingSuccessRate: number;
}> {
  const pool = getPool();

  const totalRes = await pool.query(`SELECT COUNT(*) AS count FROM rca_analyses`);
  const total = parseInt(totalRes.rows[0].count, 10);

  const classRes = await pool.query(
    `SELECT classification, COUNT(*) AS count FROM rca_analyses GROUP BY classification ORDER BY count DESC`,
  );
  const byClassification: Record<string, number> = {};
  for (const row of classRes.rows) {
    byClassification[row.classification] = parseInt(row.count, 10);
  }

  const sevRes = await pool.query(
    `SELECT severity, COUNT(*) AS count FROM rca_analyses GROUP BY severity ORDER BY count DESC`,
  );
  const bySeverity: Record<string, number> = {};
  for (const row of sevRes.rows) {
    bySeverity[row.severity] = parseInt(row.count, 10);
  }

  const avgRes = await pool.query(
    `SELECT COALESCE(AVG(confidence), 0) AS avg FROM rca_analyses`,
  );
  const avgConfidence = parseFloat(avgRes.rows[0].avg);

  const flakyRes = await pool.query(
    `SELECT COUNT(*) AS count FROM rca_analyses WHERE is_flaky = true`,
  );
  const flakyCount = parseInt(flakyRes.rows[0].count, 10);

  const healRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE healing_attempted = true) AS attempted,
       COUNT(*) FILTER (WHERE healing_succeeded = true) AS succeeded
     FROM rca_analyses`,
  );
  const attempted = parseInt(healRes.rows[0].attempted, 10);
  const succeeded = parseInt(healRes.rows[0].succeeded, 10);
  const healingSuccessRate = attempted > 0 ? succeeded / attempted : 0;

  return { total, byClassification, bySeverity, avgConfidence, flakyCount, healingSuccessRate };
}
