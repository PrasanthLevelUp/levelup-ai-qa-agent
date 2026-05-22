/**
 * Real-time AI Cost Tracking & Budget Enforcement
 * Prevents runaway costs as warned in GPT Model PDF.
 *
 * Features:
 * - Track every AI request with model, tokens, cost
 * - Daily budget enforcement with warning thresholds
 * - Monthly projections
 * - Cost breakdown by feature and model
 */

import { getPool } from '../db/postgres';
import { logger } from '../utils/logger';

const MOD = 'cost-tracker';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface CostMetrics {
  dailyTokens: number;
  dailyCostUSD: number;
  monthlyProjection: number;
  budgetRemaining: number;
  isOverBudget: boolean;
  isNearBudget: boolean;
  byFeature: Record<string, { tokens: number; cost: number; requests: number }>;
}

export interface TrackRequestInput {
  model: string;
  tokensUsed: number;
  feature: string;
  taskType?: string;
  userId?: string;
  metadata?: any;
}

/* ------------------------------------------------------------------ */
/*  CostTracker                                                        */
/* ------------------------------------------------------------------ */

export class CostTracker {
  private readonly maxDailyCostUSD: number;
  private readonly warningThreshold: number;

  /** Per-1 K token pricing */
  private readonly pricing: Record<string, { input: number; output: number }> = {
    'gpt-4o-mini':            { input: 0.000_15, output: 0.000_6 },
    'gpt-4o':                 { input: 0.002_5,  output: 0.01 },
    'gpt-4':                  { input: 0.03,     output: 0.06 },
    'text-embedding-3-small': { input: 0.000_02, output: 0 },
  };

  constructor() {
    this.maxDailyCostUSD  = parseFloat(process.env['MAX_DAILY_AI_COST_USD'] || '5.00');
    this.warningThreshold = parseFloat(process.env['COST_WARNING_THRESHOLD'] || '0.80');

    logger.info(MOD, 'Initialized cost tracker', {
      maxDailyCost: this.maxDailyCostUSD,
      warningAt: (this.maxDailyCostUSD * this.warningThreshold).toFixed(2),
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Core: track a request                                            */
  /* ---------------------------------------------------------------- */

  /**
   * Record an AI request and enforce budget.
   * Call this AFTER every OpenAI API call.
   */
  async trackRequest(record: TrackRequestInput): Promise<void> {
    const cost = this.calculateCost(record.model, record.tokensUsed);
    const pool = getPool();

    await pool.query(
      `INSERT INTO ai_usage_logs
         (model, tokens_used, cost_usd, feature, task_type, user_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [
        record.model,
        record.tokensUsed,
        cost,
        record.feature,
        record.taskType || null,
        record.userId || null,
        record.metadata ? JSON.stringify(record.metadata) : null,
      ],
    );

    logger.debug(MOD, 'Tracked AI request', {
      model: record.model,
      tokens: record.tokensUsed,
      cost: cost.toFixed(6),
      feature: record.feature,
    });

    // Budget enforcement
    const metrics = await this.getDailyMetrics();

    if (metrics.isOverBudget) {
      logger.error(MOD, '🚨 DAILY BUDGET EXCEEDED', {
        dailyCost: metrics.dailyCostUSD.toFixed(2),
        max: this.maxDailyCostUSD,
      });
      throw new Error(
        `Daily AI budget exceeded: $${metrics.dailyCostUSD.toFixed(2)} / $${this.maxDailyCostUSD.toFixed(2)}`,
      );
    }

    if (metrics.isNearBudget) {
      logger.warn(MOD, '⚠️ Approaching daily budget', {
        dailyCost: metrics.dailyCostUSD.toFixed(2),
        remaining: metrics.budgetRemaining.toFixed(2),
      });
    }
  }

  /* ---------------------------------------------------------------- */
  /*  Metrics                                                          */
  /* ---------------------------------------------------------------- */

  async getDailyMetrics(): Promise<CostMetrics> {
    const pool = getPool();

    const totals = await pool.query(
      `SELECT COALESCE(SUM(tokens_used), 0) AS daily_tokens,
              COALESCE(SUM(cost_usd), 0)    AS daily_cost
       FROM ai_usage_logs
       WHERE DATE(created_at) = CURRENT_DATE`,
    );

    const features = await pool.query(
      `SELECT feature,
              SUM(tokens_used)::int AS tokens,
              SUM(cost_usd)         AS cost,
              COUNT(*)::int         AS requests
       FROM ai_usage_logs
       WHERE DATE(created_at) = CURRENT_DATE
       GROUP BY feature
       ORDER BY cost DESC`,
    );

    const dailyCostUSD = parseFloat(totals.rows[0]?.daily_cost ?? '0');
    const dailyTokens  = parseInt(totals.rows[0]?.daily_tokens ?? '0', 10);

    const byFeature: Record<string, { tokens: number; cost: number; requests: number }> = {};
    for (const row of features.rows) {
      byFeature[row.feature] = {
        tokens: parseInt(row.tokens, 10),
        cost: parseFloat(row.cost),
        requests: parseInt(row.requests, 10),
      };
    }

    const budgetRemaining = this.maxDailyCostUSD - dailyCostUSD;
    const isOverBudget    = dailyCostUSD >= this.maxDailyCostUSD;
    const isNearBudget    = dailyCostUSD >= this.maxDailyCostUSD * this.warningThreshold && !isOverBudget;

    return {
      dailyTokens,
      dailyCostUSD,
      monthlyProjection: dailyCostUSD * 30,
      budgetRemaining,
      isOverBudget,
      isNearBudget,
      byFeature,
    };
  }

  async getRangeMetrics(startDate: Date, endDate: Date): Promise<{
    totalTokens: number;
    totalCostUSD: number;
    byDay: Array<{ date: string; tokens: number; cost: number }>;
    byFeature: Record<string, { tokens: number; cost: number }>;
    byModel: Record<string, { tokens: number; cost: number }>;
  }> {
    const pool = getPool();

    const result = await pool.query(
      `SELECT DATE(created_at)::text AS date,
              feature, model,
              SUM(tokens_used)::int  AS tokens,
              SUM(cost_usd)          AS cost
       FROM ai_usage_logs
       WHERE created_at BETWEEN $1 AND $2
       GROUP BY DATE(created_at), feature, model
       ORDER BY date DESC`,
      [startDate, endDate],
    );

    const byDay: Array<{ date: string; tokens: number; cost: number }> = [];
    const byFeature: Record<string, { tokens: number; cost: number }> = {};
    const byModel: Record<string, { tokens: number; cost: number }> = {};
    let totalTokens = 0;
    let totalCostUSD = 0;

    for (const row of result.rows) {
      const tokens = parseInt(row.tokens, 10);
      const cost   = parseFloat(row.cost);
      totalTokens  += tokens;
      totalCostUSD += cost;

      const existing = byDay.find((d) => d.date === row.date);
      if (existing) { existing.tokens += tokens; existing.cost += cost; }
      else { byDay.push({ date: row.date, tokens, cost }); }

      if (!byFeature[row.feature]) byFeature[row.feature] = { tokens: 0, cost: 0 };
      byFeature[row.feature].tokens += tokens;
      byFeature[row.feature].cost   += cost;

      if (!byModel[row.model]) byModel[row.model] = { tokens: 0, cost: 0 };
      byModel[row.model].tokens += tokens;
      byModel[row.model].cost   += cost;
    }

    return { totalTokens, totalCostUSD, byDay, byFeature, byModel };
  }

  /* ---------------------------------------------------------------- */
  /*  Cost calculation                                                 */
  /* ---------------------------------------------------------------- */

  /** Estimate cost when only total tokens are known (assumes 60 % input / 40 % output). */
  calculateCost(model: string, totalTokens: number): number {
    const p = this.pricing[model] || this.pricing['gpt-4o-mini'];
    const inTok  = Math.round(totalTokens * 0.6);
    const outTok = Math.round(totalTokens * 0.4);
    return (inTok / 1000) * p.input + (outTok / 1000) * p.output;
  }

  /** Exact cost when input / output split is known. */
  calculateExactCost(model: string, inputTokens: number, outputTokens: number): number {
    const p = this.pricing[model] || this.pricing['gpt-4o-mini'];
    return (inputTokens / 1000) * p.input + (outputTokens / 1000) * p.output;
  }
}
