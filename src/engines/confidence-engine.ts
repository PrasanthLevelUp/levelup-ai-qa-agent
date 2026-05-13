/**
 * Confidence Engine
 * Generates explainable, multi-dimensional confidence scores for healing suggestions.
 * Instead of a single opaque number, provides a breakdown of WHY a confidence score
 * was assigned — critical for enterprise trust and debugging.
 *
 * Dimensions:
 * 1. Selector quality (semantic vs CSS vs XPath)
 * 2. Similarity score (how close the failed → healed mapping is)
 * 3. Strategy reliability (rule > pattern > AI)
 * 4. Validation status (DOM-verified vs assumed)
 * 5. Historical success (have similar healings worked before?)
 * 6. Context match (same tag, same action, nearby label)
 */

import { logger } from '../utils/logger';

const MOD = 'confidence-engine';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ConfidenceInput {
  strategy: 'rule_based' | 'database_pattern' | 'ai_reasoning' | 'dom_candidate';
  rawConfidence: number;
  selectorType: 'semantic' | 'css_attribute' | 'css_id' | 'xpath' | 'unknown';
  similarityScore?: number;
  domValidated?: boolean;
  historicalSuccessRate?: number;
  matchType?: 'exact_attribute' | 'fuzzy_attribute' | 'semantic' | 'structural';
  sameTag?: boolean;
  sameAction?: boolean;
}

export interface ConfidenceResult {
  finalScore: number; // 0.0 to 1.0
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  autoApply: boolean; // Score >= 0.85
  breakdown: ConfidenceBreakdown;
  reasons: string[];
}

export interface ConfidenceBreakdown {
  selectorQuality: number;
  similarityScore: number;
  strategyReliability: number;
  validationBonus: number;
  historicalBonus: number;
  contextBonus: number;
}

/* -------------------------------------------------------------------------- */
/*  Weights                                                                   */
/* -------------------------------------------------------------------------- */

const WEIGHTS = {
  selectorQuality: 0.15,
  similarity: 0.25,
  strategy: 0.20,
  validation: 0.20,
  historical: 0.10,
  context: 0.10,
};

const STRATEGY_SCORES: Record<string, number> = {
  rule_based: 0.90,
  dom_candidate: 0.85,
  database_pattern: 0.80,
  ai_reasoning: 0.65,
};

const SELECTOR_SCORES: Record<string, number> = {
  semantic: 0.95,
  css_id: 0.85,
  css_attribute: 0.80,
  xpath: 0.60,
  unknown: 0.50,
};

/* -------------------------------------------------------------------------- */
/*  Confidence Engine                                                         */
/* -------------------------------------------------------------------------- */

export class ConfidenceEngine {
  /**
   * Calculate explainable confidence score.
   */
  calculate(input: ConfidenceInput): ConfidenceResult {
    const reasons: string[] = [];

    // 1. Selector quality
    const selectorQuality = SELECTOR_SCORES[input.selectorType] ?? 0.50;
    if (selectorQuality >= 0.90) reasons.push('Uses semantic Playwright locator (best practice)');
    else if (selectorQuality >= 0.80) reasons.push('Uses CSS attribute selector (stable)');
    else reasons.push('Uses fragile selector type');

    // 2. Similarity score
    const similarity = input.similarityScore ?? input.rawConfidence;
    if (similarity >= 0.80) reasons.push(`High similarity score (${similarity.toFixed(2)})`);
    else if (similarity >= 0.60) reasons.push(`Moderate similarity (${similarity.toFixed(2)})`);
    else reasons.push(`Low similarity (${similarity.toFixed(2)})`);

    // 3. Strategy reliability
    const strategyScore = STRATEGY_SCORES[input.strategy] ?? 0.50;
    reasons.push(`Strategy: ${input.strategy} (reliability: ${strategyScore.toFixed(2)})`);

    // 4. Validation bonus
    const validationBonus = input.domValidated ? 1.0 : 0.50;
    if (input.domValidated) reasons.push('DOM-validated: element exists and is interactable');
    else reasons.push('Not DOM-validated (assumed valid)');

    // 5. Historical bonus
    const historicalBonus = input.historicalSuccessRate ?? 0.50;
    if (historicalBonus > 0.80) reasons.push(`Strong historical success rate (${(historicalBonus * 100).toFixed(0)}%)`);

    // 6. Context bonus
    let contextScore = 0.50;
    if (input.sameTag) { contextScore += 0.20; reasons.push('Same element tag'); }
    if (input.sameAction) { contextScore += 0.15; reasons.push('Same action type (fill/click)'); }
    if (input.matchType === 'exact_attribute') { contextScore += 0.15; reasons.push('Exact attribute match'); }
    contextScore = Math.min(1.0, contextScore);

    // Weighted composite
    const finalScore = Math.min(1.0,
      selectorQuality * WEIGHTS.selectorQuality +
      similarity * WEIGHTS.similarity +
      strategyScore * WEIGHTS.strategy +
      validationBonus * WEIGHTS.validation +
      historicalBonus * WEIGHTS.historical +
      contextScore * WEIGHTS.context
    );

    const rounded = Math.round(finalScore * 100) / 100;

    const grade =
      rounded >= 0.90 ? 'A' :
      rounded >= 0.75 ? 'B' :
      rounded >= 0.60 ? 'C' :
      rounded >= 0.45 ? 'D' : 'F';

    const result: ConfidenceResult = {
      finalScore: rounded,
      grade,
      autoApply: rounded >= 0.85,
      breakdown: {
        selectorQuality: Math.round(selectorQuality * 100) / 100,
        similarityScore: Math.round(similarity * 100) / 100,
        strategyReliability: Math.round(strategyScore * 100) / 100,
        validationBonus: Math.round(validationBonus * 100) / 100,
        historicalBonus: Math.round(historicalBonus * 100) / 100,
        contextBonus: Math.round(contextScore * 100) / 100,
      },
      reasons,
    };

    logger.info(MOD, 'Confidence calculated', {
      finalScore: result.finalScore,
      grade: result.grade,
      autoApply: result.autoApply,
      strategy: input.strategy,
    });

    return result;
  }
}
