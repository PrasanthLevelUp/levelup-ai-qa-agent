/**
 * PostgreSQL client — healing history, pattern storage, execution logging.
 * Reads DATABASE_URL from env or /home/ubuntu/shared/.env
 */

import { Pool, type QueryResult } from 'pg';
import * as fs from 'fs';
import { logger } from '../utils/logger';

const MOD = 'postgres';

function getDatabaseUrl(): string {
  if (process.env['DATABASE_URL']) return process.env['DATABASE_URL'];

  const envPath = '/home/ubuntu/shared/.env';
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      if (line.startsWith('DATABASE_URL=')) {
        return line.slice('DATABASE_URL='.length).replace(/^["']|["']$/g, '');
      }
    }
  }
  throw new Error('DATABASE_URL not found in env or /home/ubuntu/shared/.env');
}

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getDatabaseUrl() });
    logger.info(MOD, 'PostgreSQL pool created');
  }
  return pool;
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}

// ─── Test Executions ───────────────────────────────────────────

export interface TestExecution {
  test_name: string;
  status: string;
  error_message?: string;
  screenshot_path?: string;
  dom_snapshot_path?: string;
  github_commit_sha?: string;
  duration_ms?: number;
  healing_attempted?: boolean;
  healing_succeeded?: boolean;
}

export async function logExecution(data: TestExecution): Promise<number> {
  const q = `
    INSERT INTO test_executions
      (test_name, status, error_message, screenshot_path, dom_snapshot_path,
       github_commit_sha, duration_ms, healing_attempted, healing_succeeded)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id`;
  const res: QueryResult = await getPool().query(q, [
    data.test_name, data.status, data.error_message ?? null,
    data.screenshot_path ?? null, data.dom_snapshot_path ?? null,
    data.github_commit_sha ?? null, data.duration_ms ?? 0,
    data.healing_attempted ?? false, data.healing_succeeded ?? false,
  ]);
  const id = res.rows[0]?.id as number;
  logger.info(MOD, `Logged execution id=${id} test=${data.test_name} status=${data.status}`);
  return id;
}

export async function updateExecution(id: number, fields: Partial<TestExecution>): Promise<void> {
  const sets: string[] = [];
  const vals: unknown[] = [];
  let idx = 1;
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = $${idx}`);
    vals.push(v);
    idx++;
  }
  vals.push(id);
  await getPool().query(`UPDATE test_executions SET ${sets.join(', ')} WHERE id = $${idx}`, vals);
}

// ─── Healing Actions ───────────────────────────────────────────

export interface HealingAction {
  test_execution_id: number;
  failed_locator: string;
  healed_locator?: string;
  healing_strategy: 'rule_based' | 'database_pattern' | 'ai_reasoning';
  ai_tokens_used?: number;
  success?: boolean;
  confidence?: number;
  error_context?: string;
  dom_snippet?: string;
}

export async function logHealing(data: HealingAction): Promise<number> {
  const q = `
    INSERT INTO healing_actions
      (test_execution_id, failed_locator, healed_locator, healing_strategy,
       ai_tokens_used, success, confidence, error_context, dom_snippet)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING id`;
  const res = await getPool().query(q, [
    data.test_execution_id, data.failed_locator, data.healed_locator ?? null,
    data.healing_strategy, data.ai_tokens_used ?? 0,
    data.success ?? false, data.confidence ?? 0, data.error_context ?? null,
    data.dom_snippet ?? null,
  ]);
  const id = res.rows[0]?.id as number;
  logger.info(MOD, `Logged healing id=${id} strategy=${data.healing_strategy} success=${data.success}`);
  return id;
}

// ─── Learned Patterns ──────────────────────────────────────────

export interface LearnedPattern {
  error_pattern: string;
  site_url: string;
  failed_locator: string;
  healed_locator: string;
  solution_strategy: string;
  avg_tokens_saved?: number;
}

export async function lookupPattern(failedLocator: string, errorPattern?: string): Promise<{
  healed_locator: string;
  success_count: number;
  confidence: number;
  strategy: string;
} | null> {
  // Exact locator match first
  let res = await getPool().query(
    `SELECT healed_locator, success_count, solution_strategy,
            (success_count::float / GREATEST(success_count + failure_count, 1)) as confidence
     FROM learned_patterns
     WHERE failed_locator = $1
     ORDER BY success_count DESC, last_used DESC
     LIMIT 1`,
    [failedLocator]
  );

  if (res.rows.length === 0 && errorPattern) {
    // Fuzzy match on error pattern
    res = await getPool().query(
      `SELECT healed_locator, success_count, solution_strategy,
              (success_count::float / GREATEST(success_count + failure_count, 1)) as confidence
       FROM learned_patterns
       WHERE error_pattern LIKE $1
       ORDER BY success_count DESC
       LIMIT 1`,
      [`%${errorPattern.slice(0, 100)}%`]
    );
  }

  if (res.rows.length > 0) {
    const row = res.rows[0]!;
    logger.info(MOD, `Pattern found for "${failedLocator}" → "${row.healed_locator}" (${row.success_count} successes)`);
    return {
      healed_locator: row.healed_locator as string,
      success_count: row.success_count as number,
      confidence: row.confidence as number,
      strategy: row.solution_strategy as string,
    };
  }

  logger.info(MOD, `No pattern found for "${failedLocator}"`);
  return null;
}

export async function storePattern(data: LearnedPattern): Promise<number> {
  const q = `
    INSERT INTO learned_patterns
      (error_pattern, site_url, failed_locator, healed_locator,
       solution_strategy, avg_tokens_saved)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (error_pattern, failed_locator, site_url)
    DO UPDATE SET
      success_count = learned_patterns.success_count + 1,
      last_used = NOW(),
      avg_tokens_saved = (learned_patterns.avg_tokens_saved + EXCLUDED.avg_tokens_saved) / 2
    RETURNING id`;
  const res = await getPool().query(q, [
    data.error_pattern, data.site_url, data.failed_locator,
    data.healed_locator, data.solution_strategy, data.avg_tokens_saved ?? 0,
  ]);
  const id = res.rows[0]?.id as number;
  logger.info(MOD, `Stored pattern id=${id} "${data.failed_locator}" → "${data.healed_locator}"`);
  return id;
}

export async function incrementPatternFailure(failedLocator: string, siteUrl: string): Promise<void> {
  await getPool().query(
    `UPDATE learned_patterns SET failure_count = failure_count + 1 WHERE failed_locator = $1 AND site_url = $2`,
    [failedLocator, siteUrl]
  );
}

// ─── Historical Stats ──────────────────────────────────────────

export interface HistoricalStats {
  total_executions: number;
  total_healings: number;
  success_rate: string;
  total_tokens: number;
  tokens_saved: string;
  learned_patterns: number;
  strategy_breakdown: { rule_based: number; database_pattern: number; ai_reasoning: number };
}

export async function getHistoricalStats(): Promise<HistoricalStats> {
  const p = getPool();
  const [execR, healR, successR, tokensR, patternsR, stratR] = await Promise.all([
    p.query('SELECT COUNT(*) as c FROM test_executions'),
    p.query('SELECT COUNT(*) as c FROM healing_actions'),
    p.query('SELECT COUNT(*) as c FROM healing_actions WHERE success = true'),
    p.query('SELECT COALESCE(SUM(ai_tokens_used), 0) as t FROM healing_actions'),
    p.query('SELECT COUNT(*) as c FROM learned_patterns'),
    p.query(`SELECT healing_strategy, COUNT(*) as c FROM healing_actions GROUP BY healing_strategy`),
  ]);

  const totalHeal = Number(healR.rows[0]?.c ?? 0);
  const successHeal = Number(successR.rows[0]?.c ?? 0);
  const stratBreakdown = { rule_based: 0, database_pattern: 0, ai_reasoning: 0 };
  for (const row of stratR.rows) {
    const key = row.healing_strategy as keyof typeof stratBreakdown;
    if (key in stratBreakdown) stratBreakdown[key] = Number(row.c);
  }

  return {
    total_executions: Number(execR.rows[0]?.c ?? 0),
    total_healings: totalHeal,
    success_rate: totalHeal > 0 ? `${((successHeal / totalHeal) * 100).toFixed(1)}%` : 'N/A',
    total_tokens: Number(tokensR.rows[0]?.t ?? 0),
    tokens_saved: totalHeal > 0 ? `~${(stratBreakdown.rule_based + stratBreakdown.database_pattern) * 500} est.` : 'N/A',
    learned_patterns: Number(patternsR.rows[0]?.c ?? 0),
    strategy_breakdown: stratBreakdown,
  };
}

// CLI mode
if (require.main === module) {
  const cmd = process.argv[2];
  (async () => {
    try {
      if (cmd === 'stats') {
        const stats = await getHistoricalStats();
        console.log(JSON.stringify(stats, null, 2));
      } else if (cmd === 'lookup' && process.argv[3]) {
        const result = await lookupPattern(process.argv[3], process.argv[4]);
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('Usage: postgres.ts stats | lookup <locator> [error_pattern]');
      }
    } finally {
      await closePool();
    }
  })();
}
