/**
 * Intelligent Model Selection Engine
 * Implements tiered model strategy from GPT Model PDF recommendations.
 *
 * Rules:
 * 1. NEVER use premium models for healing, retries, background jobs
 * 2. ALWAYS use gpt-4o-mini for MVP features
 * 3. ONLY use premium for enterprise demos / complex reasoning
 * 4. Use text-embedding-3-small for similarity (99 % cheaper than LLM)
 */

import { logger } from '../utils/logger';

const MOD = 'model-selector';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type TaskType =
  | 'healing'
  | 'test_generation'
  | 'script_generation'
  | 'rca'
  | 'enterprise_demo'
  | 'complex_reasoning'
  | 'similarity'
  | 'generic';

export type TaskComplexity = 'simple' | 'standard' | 'complex';

export interface ModelConfig {
  model: string;
  maxTokens: number;
  temperature: number;
  reason: string;
  estimatedCostUSD: number;
  isPremium: boolean;
}

export interface CostEstimate {
  inputTokens: number;
  outputTokens: number;
  totalCostUSD: number;
}

/* ------------------------------------------------------------------ */
/*  ModelSelector                                                      */
/* ------------------------------------------------------------------ */

export class ModelSelector {
  private readonly primaryModel: string;
  private readonly premiumModel: string;
  private readonly embeddingModel: string;
  private readonly premiumEnabled: boolean;

  /** Per-1 K token pricing */
  private readonly pricing: Record<string, { input: number; output: number }> = {
    'gpt-4o-mini':              { input: 0.000_15, output: 0.000_6 },
    'gpt-4o':                   { input: 0.002_5,  output: 0.01 },
    'gpt-4':                    { input: 0.03,     output: 0.06 },
    'gpt-4-turbo':              { input: 0.01,     output: 0.03 },
    'text-embedding-3-small':   { input: 0.000_02, output: 0 },
    'text-embedding-3-large':   { input: 0.000_13, output: 0 },
  };

  constructor() {
    this.primaryModel   = process.env['OPENAI_PRIMARY_MODEL']   || 'gpt-4o-mini';
    this.premiumModel   = process.env['OPENAI_PREMIUM_MODEL']   || 'gpt-4o';
    this.embeddingModel = process.env['OPENAI_EMBEDDING_MODEL'] || 'text-embedding-3-small';
    this.premiumEnabled = process.env['ENABLE_PREMIUM_MODE'] === 'true';

    logger.info(MOD, 'Initialized model selector', {
      primary: this.primaryModel,
      premium: this.premiumModel,
      embedding: this.embeddingModel,
      premiumEnabled: this.premiumEnabled,
    });
  }

  /* ---------------------------------------------------------------- */
  /*  Public API                                                       */
  /* ---------------------------------------------------------------- */

  /**
   * Select the most cost-effective model for a given task.
   */
  selectModel(
    taskType: TaskType,
    complexity: TaskComplexity = 'standard',
    forcePremium = false,
  ): ModelConfig {
    logger.debug(MOD, 'Selecting model', { taskType, complexity, forcePremium });

    // Embeddings for similarity tasks
    if (taskType === 'similarity') {
      return this.buildConfig(this.embeddingModel, 8000, 0, 'Embedding model (99 % cheaper than LLM)', false);
    }

    // Healing / RCA — ALWAYS primary
    if (taskType === 'healing' || taskType === 'rca') {
      return this.buildConfig(
        this.primaryModel,
        taskType === 'healing' ? 500 : 1000,
        0.1,
        'Healing / RCA always uses primary model (PDF guideline)',
        false,
      );
    }

    // Premium ONLY if explicitly enabled + requested + allowed
    if (
      this.premiumEnabled &&
      forcePremium &&
      (taskType === 'enterprise_demo' || taskType === 'complex_reasoning')
    ) {
      return this.buildConfig(
        this.premiumModel,
        complexity === 'complex' ? 4000 : 2000,
        0.3,
        `Premium model for ${taskType} (enterprise feature)`,
        true,
      );
    }

    // Default — primary model
    const maxTokens  = this.getMaxTokens(taskType, complexity);
    const temperature = this.getTemperature(taskType);
    return this.buildConfig(
      this.primaryModel,
      maxTokens,
      temperature,
      `Primary model for ${taskType} (cost-optimized)`,
      false,
    );
  }

  /** Estimate cost for given token counts. */
  estimateCost(model: string, inputTokens: number, outputTokens: number): CostEstimate {
    const p = this.pricing[model] || this.pricing['gpt-4o-mini'];
    return {
      inputTokens,
      outputTokens,
      totalCostUSD: (inputTokens / 1000) * p.input + (outputTokens / 1000) * p.output,
    };
  }

  /** Whether this task is allowed to use a premium model. */
  canUsePremium(taskType: TaskType): boolean {
    return this.premiumEnabled && ['enterprise_demo', 'complex_reasoning'].includes(taskType);
  }

  /** Compare cost of primary vs premium for a given input size. */
  compareCosts(taskType: TaskType, inputTokens = 1000): {
    primary: CostEstimate;
    premium: CostEstimate;
    savingsPercent: number;
  } {
    const outputTokens = Math.round(inputTokens * 0.5);
    const primary = this.estimateCost(this.primaryModel, inputTokens, outputTokens);
    const premium = this.estimateCost(this.premiumModel, inputTokens, outputTokens);
    const savingsPercent =
      premium.totalCostUSD > 0
        ? ((premium.totalCostUSD - primary.totalCostUSD) / premium.totalCostUSD) * 100
        : 0;
    return { primary, premium, savingsPercent };
  }

  /** Look up pricing for a model. */
  getPricing(model: string): { input: number; output: number } {
    return this.pricing[model] || this.pricing['gpt-4o-mini'];
  }

  /* ---------------------------------------------------------------- */
  /*  Internal helpers                                                 */
  /* ---------------------------------------------------------------- */

  private getMaxTokens(taskType: TaskType, complexity: TaskComplexity): number {
    const base: Record<TaskType, number> = {
      healing: 500,
      test_generation: 6000,
      script_generation: 2000,
      rca: 1000,
      enterprise_demo: 4000,
      complex_reasoning: 4000,
      similarity: 0,
      generic: 2000,
    };
    const mult: Record<TaskComplexity, number> = { simple: 0.5, standard: 1, complex: 1.5 };
    return Math.round((base[taskType] || 2000) * (mult[complexity] || 1));
  }

  private getTemperature(taskType: TaskType): number {
    const temps: Record<TaskType, number> = {
      healing: 0.1,
      test_generation: 0.3,
      script_generation: 0.2,
      rca: 0.2,
      enterprise_demo: 0.4,
      complex_reasoning: 0.3,
      similarity: 0,
      generic: 0.3,
    };
    return temps[taskType] ?? 0.3;
  }

  private buildConfig(
    model: string,
    maxTokens: number,
    temperature: number,
    reason: string,
    isPremium: boolean,
  ): ModelConfig {
    const estOutput = Math.round(maxTokens * 0.5);
    const { totalCostUSD } = this.estimateCost(model, maxTokens, estOutput);
    return { model, maxTokens, temperature, reason, estimatedCostUSD: totalCostUSD, isPremium };
  }
}
