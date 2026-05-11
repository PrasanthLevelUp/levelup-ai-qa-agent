/**
 * Healing Strategy Selector
 * Confidence-based routing between Rule / Pattern / AI engines.
 * Manages token budgets, cost tracking, and fallback logic.
 */

import { logger } from '../utils/logger';
import { getDb } from '../db/sqlite';
import type { FailureDetails } from './failure-analyzer';
import type { RuleEngine, RuleEngineResult } from '../engines/rule-engine';
import type { PatternEngine, PatternEngineResult } from '../engines/pattern-engine';
import type { AIEngine } from '../engines/ai-engine';

const MOD = 'strategy-selector';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface StrategyConfig {
  confidenceThresholds: {
    rule: number;    // 0.70 — rule engine must score this to use
    pattern: number; // 0.60 — pattern engine threshold
    ai: number;      // 0.50 — AI engine threshold (lowest)
  };
  costLimits: {
    perHealing: number; // Max $ per healing attempt
    perDay: number;     // Daily budget in tokens
  };
}

export type EngineType = 'rule' | 'pattern' | 'ai' | 'none';

export interface SelectedStrategy {
  engine: EngineType;
  confidence: number;
  estimatedCost: number;
  estimatedTokens: number;
  reason: string;
}

const DEFAULT_CONFIG: StrategyConfig = {
  confidenceThresholds: {
    rule: 0.70,
    pattern: 0.60,
    ai: 0.50,
  },
  costLimits: {
    perHealing: parseFloat(process.env['MAX_COST_PER_HEALING'] || '0.10'),
    perDay: parseInt(process.env['MAX_DAILY_TOKEN_BUDGET'] || '100000', 10),
  },
};

/* -------------------------------------------------------------------------- */
/*  Token Usage DB                                                            */
/* -------------------------------------------------------------------------- */

export function initTokenUsageTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS token_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      engine TEXT NOT NULL,
      tokens_used INTEGER NOT NULL,
      cost_usd REAL NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_token_usage_date ON token_usage(date);
  `);
}

export function logTokenUsage(engine: string, tokensUsed: number, costUsd: number): void {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  db.prepare(
    `INSERT INTO token_usage (date, engine, tokens_used, cost_usd) VALUES (?, ?, ?, ?)`,
  ).run(today, engine, tokensUsed, costUsd);
}

export function getTokensUsedToday(): number {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    `SELECT COALESCE(SUM(tokens_used), 0) AS total FROM token_usage WHERE date = ?`,
  ).get(today) as { total: number };
  return row.total;
}

export function getDailyCostUsd(): number {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const row = db.prepare(
    `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM token_usage WHERE date = ?`,
  ).get(today) as { total: number };
  return row.total;
}

/* -------------------------------------------------------------------------- */
/*  Strategy Selector                                                        */
/* -------------------------------------------------------------------------- */

export class HealingStrategySelector {
  private readonly config: StrategyConfig;

  constructor(config?: Partial<StrategyConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    // Ensure the token_usage table exists
    try { initTokenUsageTable(); } catch {}
  }

  /**
   * Select the best strategy for a given failure.
   * Priority: Rule (free/fast) → Pattern (free/learned) → AI (costs tokens).
   */
  async selectStrategy(
    failure: FailureDetails,
    ruleEngine: RuleEngine,
    patternEngine: PatternEngine,
    aiEngine: AIEngine,
  ): Promise<SelectedStrategy> {
    // Priority 1: Rule Engine (free, fast, deterministic)
    const ruleResult = ruleEngine.generate(failure);
    const bestRule = ruleResult.suggestions[0];
    if (bestRule && bestRule.confidence >= this.config.confidenceThresholds.rule) {
      logger.info(MOD, 'Rule engine selected', {
        confidence: bestRule.confidence,
        testName: failure.testName,
      });
      return {
        engine: 'rule',
        confidence: bestRule.confidence,
        estimatedCost: 0,
        estimatedTokens: 0,
        reason: `Rule engine: ${bestRule.reasoning}`,
      };
    }

    // Priority 2: Pattern Engine (free, learned from history)
    const patternResult = patternEngine.findMatch(failure);
    if (patternResult && patternResult.confidence >= this.config.confidenceThresholds.pattern) {
      logger.info(MOD, 'Pattern engine selected', {
        confidence: patternResult.confidence,
        testName: failure.testName,
      });
      return {
        engine: 'pattern',
        confidence: patternResult.confidence,
        estimatedCost: 0,
        estimatedTokens: 0,
        reason: `Pattern engine: ${patternResult.reasoning}`,
      };
    }

    // Priority 3: AI Engine (costs tokens, flexible)
    const availableBudget = this.getAvailableTokenBudget();
    const estimatedTokens = 2000; // Estimated tokens per AI call
    const estimatedCost = estimatedTokens * 0.00003; // ~$0.03 per 1K tokens (gpt-4o-mini)

    if (availableBudget >= estimatedTokens) {
      logger.info(MOD, 'AI engine selected', {
        availableBudget,
        estimatedTokens,
        testName: failure.testName,
      });
      return {
        engine: 'ai',
        confidence: this.config.confidenceThresholds.ai,
        estimatedCost,
        estimatedTokens,
        reason: `AI engine: budget available (${availableBudget} tokens remaining today)`,
      };
    }

    // No strategy available
    logger.warn(MOD, 'No strategy available', {
      testName: failure.testName,
      ruleConfidence: bestRule?.confidence ?? 0,
      patternMatch: !!patternResult,
      aiAvailable: availableBudget >= estimatedTokens,
    });

    return {
      engine: 'none',
      confidence: 0,
      estimatedCost: 0,
      estimatedTokens: 0,
      reason: `All strategies exhausted or below confidence threshold. Rule: ${bestRule?.confidence?.toFixed(2) ?? 'N/A'}, Pattern: ${patternResult ? 'found but low confidence' : 'no match'}, AI: budget ${availableBudget < estimatedTokens ? 'exhausted' : 'available'}`,
    };
  }

  getAvailableTokenBudget(): number {
    try {
      const used = getTokensUsedToday();
      const limit = this.config.costLimits.perDay;
      return Math.max(0, limit - used);
    } catch {
      return this.config.costLimits.perDay; // If DB fails, assume full budget
    }
  }

  /**
   * Record token usage after an AI call completes.
   */
  recordUsage(engine: string, tokensUsed: number): void {
    const costUsd = tokensUsed * 0.00003;
    try {
      logTokenUsage(engine, tokensUsed, costUsd);
      logger.info(MOD, 'Token usage recorded', { engine, tokensUsed, costUsd });
    } catch (err: any) {
      logger.warn(MOD, 'Failed to record token usage', { error: err.message });
    }
  }

  /**
   * Get usage statistics for reporting.
   */
  getUsageStats(): { tokensUsedToday: number; budgetRemaining: number; dailyCost: number } {
    try {
      const tokensUsedToday = getTokensUsedToday();
      const dailyCost = getDailyCostUsd();
      return {
        tokensUsedToday,
        budgetRemaining: Math.max(0, this.config.costLimits.perDay - tokensUsedToday),
        dailyCost,
      };
    } catch {
      return { tokensUsedToday: 0, budgetRemaining: this.config.costLimits.perDay, dailyCost: 0 };
    }
  }
}
