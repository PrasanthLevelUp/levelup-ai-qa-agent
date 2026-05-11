/**
 * SQLite database layer for the self-healing QA agent.
 * Replaces PostgreSQL for MVP portability.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

const MOD = 'sqlite';
const DEFAULT_DB_PATH = '/home/ubuntu/healing_data.db';

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

let db: Database.Database | null = null;

function getDbPath(): string {
  return process.env['DATABASE_PATH'] || DEFAULT_DB_PATH;
}

export function getDb(): Database.Database {
  if (!db) {
    const dbPath = getDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
    logger.info(MOD, 'SQLite database initialized', { dbPath });
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function initSchema(conn: Database.Database): void {
  conn.exec(`
    CREATE TABLE IF NOT EXISTS test_executions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_name TEXT NOT NULL,
      status TEXT NOT NULL,
      error_message TEXT,
      screenshot_path TEXT,
      github_commit_sha TEXT,
      duration_ms INTEGER DEFAULT 0,
      healing_attempted INTEGER DEFAULT 0,
      healing_succeeded INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS healing_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      test_execution_id INTEGER NOT NULL,
      test_name TEXT NOT NULL,
      failed_locator TEXT NOT NULL,
      healed_locator TEXT,
      healing_strategy TEXT NOT NULL,
      ai_tokens_used INTEGER DEFAULT 0,
      success INTEGER DEFAULT 0,
      confidence REAL DEFAULT 0,
      error_context TEXT,
      validation_status TEXT,
      validation_reason TEXT,
      patch_path TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(test_execution_id) REFERENCES test_executions(id)
    );

    CREATE TABLE IF NOT EXISTS learned_patterns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
      last_used TEXT DEFAULT CURRENT_TIMESTAMP,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(test_name, error_pattern, failed_locator)
    );

    CREATE INDEX IF NOT EXISTS idx_exec_status ON test_executions(status);
    CREATE INDEX IF NOT EXISTS idx_exec_test_name ON test_executions(test_name);
    CREATE INDEX IF NOT EXISTS idx_heal_exec_id ON healing_actions(test_execution_id);
    CREATE INDEX IF NOT EXISTS idx_heal_strategy ON healing_actions(healing_strategy);
    CREATE INDEX IF NOT EXISTS idx_pattern_locator ON learned_patterns(failed_locator);
    CREATE INDEX IF NOT EXISTS idx_pattern_test_name ON learned_patterns(test_name);
    CREATE INDEX IF NOT EXISTS idx_pattern_error ON learned_patterns(error_pattern);
  `);
}

export function logExecution(data: TestExecution): number {
  const stmt = getDb().prepare(`
    INSERT INTO test_executions
      (test_name, status, error_message, screenshot_path, github_commit_sha, duration_ms, healing_attempted, healing_succeeded)
    VALUES
      (@test_name, @status, @error_message, @screenshot_path, @github_commit_sha, @duration_ms, @healing_attempted, @healing_succeeded)
  `);

  const result = stmt.run({
    test_name: data.test_name,
    status: data.status,
    error_message: data.error_message ?? null,
    screenshot_path: data.screenshot_path ?? null,
    github_commit_sha: data.github_commit_sha ?? null,
    duration_ms: data.duration_ms ?? 0,
    healing_attempted: data.healing_attempted ? 1 : 0,
    healing_succeeded: data.healing_succeeded ? 1 : 0,
  });

  return Number(result.lastInsertRowid);
}

export function updateExecution(id: number, fields: Partial<TestExecution>): void {
  const allowed: Array<keyof TestExecution> = [
    'status', 'error_message', 'screenshot_path', 'github_commit_sha', 'duration_ms', 'healing_attempted', 'healing_succeeded',
  ];

  const updates: string[] = [];
  const values: unknown[] = [];
  for (const key of allowed) {
    if (fields[key] !== undefined) {
      updates.push(`${key} = ?`);
      const value = key === 'healing_attempted' || key === 'healing_succeeded'
        ? ((fields[key] as boolean) ? 1 : 0)
        : fields[key];
      values.push(value);
    }
  }

  if (updates.length === 0) return;

  values.push(id);
  getDb().prepare(`UPDATE test_executions SET ${updates.join(', ')} WHERE id = ?`).run(...values);
}

export function logHealing(data: HealingAction): number {
  const stmt = getDb().prepare(`
    INSERT INTO healing_actions
      (test_execution_id, test_name, failed_locator, healed_locator, healing_strategy, ai_tokens_used,
       success, confidence, error_context, validation_status, validation_reason, patch_path)
    VALUES
      (@test_execution_id, @test_name, @failed_locator, @healed_locator, @healing_strategy, @ai_tokens_used,
       @success, @confidence, @error_context, @validation_status, @validation_reason, @patch_path)
  `);

  const result = stmt.run({
    test_execution_id: data.test_execution_id,
    test_name: data.test_name,
    failed_locator: data.failed_locator,
    healed_locator: data.healed_locator ?? null,
    healing_strategy: data.healing_strategy,
    ai_tokens_used: data.ai_tokens_used ?? 0,
    success: data.success ? 1 : 0,
    confidence: data.confidence ?? 0,
    error_context: data.error_context ?? null,
    validation_status: data.validation_status ?? null,
    validation_reason: data.validation_reason ?? null,
    patch_path: data.patch_path ?? null,
  });

  return Number(result.lastInsertRowid);
}

export function lookupPattern(input: { failed_locator: string; test_name: string; error_pattern: string }): {
  healed_locator: string;
  confidence: number;
  strategy: string;
  usage_count: number;
} | null {
  const exactStmt = getDb().prepare(`
    SELECT healed_locator, confidence, solution_strategy, usage_count
    FROM learned_patterns
    WHERE failed_locator = ? AND test_name = ?
    ORDER BY success_count DESC, usage_count DESC, last_used DESC
    LIMIT 1
  `);

  const errorStmt = getDb().prepare(`
    SELECT healed_locator, confidence, solution_strategy, usage_count
    FROM learned_patterns
    WHERE failed_locator = ? OR (test_name = ? AND error_pattern LIKE ?)
    ORDER BY success_count DESC, usage_count DESC, last_used DESC
    LIMIT 1
  `);

  const exact = exactStmt.get(input.failed_locator, input.test_name) as
    | { healed_locator: string; confidence: number; solution_strategy: string; usage_count: number }
    | undefined;

  const row = exact ?? errorStmt.get(input.failed_locator, input.test_name, `%${input.error_pattern.slice(0, 120)}%`) as
    | { healed_locator: string; confidence: number; solution_strategy: string; usage_count: number }
    | undefined;

  if (!row) return null;

  getDb().prepare(`
    UPDATE learned_patterns
    SET usage_count = usage_count + 1,
        last_used = CURRENT_TIMESTAMP
    WHERE failed_locator = ? AND healed_locator = ?
  `).run(input.failed_locator, row.healed_locator);

  return {
    healed_locator: row.healed_locator,
    confidence: row.confidence,
    strategy: row.solution_strategy,
    usage_count: row.usage_count + 1,
  };
}

export function storePattern(data: LearnedPattern): number {
  const stmt = getDb().prepare(`
    INSERT INTO learned_patterns
      (test_name, error_pattern, failed_locator, healed_locator, solution_strategy, confidence, avg_tokens_saved)
    VALUES
      (@test_name, @error_pattern, @failed_locator, @healed_locator, @solution_strategy, @confidence, @avg_tokens_saved)
    ON CONFLICT(test_name, error_pattern, failed_locator)
    DO UPDATE SET
      healed_locator = excluded.healed_locator,
      solution_strategy = excluded.solution_strategy,
      confidence = excluded.confidence,
      success_count = learned_patterns.success_count + 1,
      usage_count = learned_patterns.usage_count + 1,
      avg_tokens_saved = (learned_patterns.avg_tokens_saved + excluded.avg_tokens_saved) / 2,
      last_used = CURRENT_TIMESTAMP
  `);

  const result = stmt.run({
    test_name: data.test_name,
    error_pattern: data.error_pattern.slice(0, 250),
    failed_locator: data.failed_locator,
    healed_locator: data.healed_locator,
    solution_strategy: data.solution_strategy,
    confidence: data.confidence ?? 0,
    avg_tokens_saved: data.avg_tokens_saved ?? 0,
  });

  return Number(result.lastInsertRowid);
}

export function getHistoricalStats(): HistoricalStats {
  const conn = getDb();
  const totalExecutions = (conn.prepare('SELECT COUNT(*) as c FROM test_executions').get() as { c: number }).c;
  const totalHealings = (conn.prepare('SELECT COUNT(*) as c FROM healing_actions').get() as { c: number }).c;
  const successHealings = (conn.prepare('SELECT COUNT(*) as c FROM healing_actions WHERE success = 1').get() as { c: number }).c;
  const totalTokens = (conn.prepare('SELECT COALESCE(SUM(ai_tokens_used), 0) as t FROM healing_actions').get() as { t: number }).t;
  const patternCount = (conn.prepare('SELECT COUNT(*) as c FROM learned_patterns').get() as { c: number }).c;

  const strategyRows = conn.prepare(`
    SELECT healing_strategy, COUNT(*) as c
    FROM healing_actions
    GROUP BY healing_strategy
  `).all() as Array<{ healing_strategy: 'rule_based' | 'database_pattern' | 'ai_reasoning'; c: number }>;

  const breakdown = { rule_based: 0, database_pattern: 0, ai_reasoning: 0 };
  for (const row of strategyRows) {
    breakdown[row.healing_strategy] = row.c;
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
