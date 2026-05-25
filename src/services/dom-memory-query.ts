/**
 * DOM Memory Query Service
 *
 * Bridge between DOM Memory (historical selector data) and the Healing Engine.
 * Provides selector stability scores, change history, and alternative selectors
 * ranked by historical reliability.
 *
 * This is LevelUp's MOAT — most AI testing tools only analyze current DOM.
 * We analyze DOM HISTORY to make smarter healing decisions.
 */

import { logger } from '../utils/logger';
import {
  getSelectorHistory as dbGetSelectorHistory,
  getAlternativeSelectors as dbGetAlternativeSelectors,
  recordSelectorObservation,
} from '../db/postgres';

const MOD = 'dom-memory-query';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface SelectorHistoryResult {
  selector: string;
  changeCount: number;
  firstSeen: string | null;
  lastSeen: string | null;
  recentChanges: number;
  observations: number;
  stabilityScore: number;
  /** Human-readable stability assessment */
  assessment: string;
}

export interface AlternativeSelector {
  selector: string;
  source: string;
  score: number;
  stabilityScore: number;
  compositeScore: number;
  lastSeen: string | null;
  usageCount: number;
  /** Why this alternative was chosen */
  reasoning: string;
}

export interface DOMMemoryInsight {
  failedSelector: string;
  selectorHistory: SelectorHistoryResult;
  alternatives: AlternativeSelector[];
  bestAlternative: AlternativeSelector | null;
  /** Overall recommendation */
  recommendation: string;
}

/* -------------------------------------------------------------------------- */
/*  Service                                                                   */
/* -------------------------------------------------------------------------- */

export class DOMMemoryQuery {

  /**
   * Get selector change history with stability analysis.
   */
  async getSelectorHistory(
    selector: string,
    projectId?: number,
  ): Promise<SelectorHistoryResult> {
    try {
      const history = await dbGetSelectorHistory(selector, projectId);

      const assessment = this.assessStability(
        history.stabilityScore,
        history.changeCount,
        history.recentChanges,
        history.firstSeen,
      );

      logger.info(MOD, 'Selector history retrieved', {
        selector: selector.slice(0, 60),
        stabilityScore: history.stabilityScore,
        changes: history.changeCount,
        assessment,
      });

      return {
        ...history,
        assessment,
      };
    } catch (error: any) {
      logger.warn(MOD, 'Failed to get selector history', { selector, error: error.message });
      return {
        selector,
        changeCount: 0,
        firstSeen: null,
        lastSeen: null,
        recentChanges: 0,
        observations: 0,
        stabilityScore: 0.5, // Unknown — neutral
        assessment: 'No history available',
      };
    }
  }

  /**
   * Get alternative selectors for the same element, ranked by stability.
   */
  async getAlternativeSelectors(
    failedSelector: string,
    projectId?: number,
    companyId?: number,
  ): Promise<AlternativeSelector[]> {
    try {
      const raw = await dbGetAlternativeSelectors(failedSelector, projectId, companyId);

      const alternatives: AlternativeSelector[] = raw.map(alt => {
        const compositeScore = alt.stabilityScore * 0.6 + alt.score * 0.4;
        return {
          ...alt,
          compositeScore: parseFloat(compositeScore.toFixed(3)),
          reasoning: this.buildAlternativeReasoning(alt),
        };
      });

      logger.info(MOD, 'Alternative selectors found', {
        failedSelector: failedSelector.slice(0, 60),
        alternativesFound: alternatives.length,
        bestScore: alternatives[0]?.compositeScore || 0,
      });

      return alternatives;
    } catch (error: any) {
      logger.warn(MOD, 'Failed to get alternative selectors', {
        failedSelector,
        error: error.message,
      });
      return [];
    }
  }

  /**
   * Full DOM Memory insight for a failed selector — combines history +
   * alternatives into a single actionable result for the healing engine.
   */
  async getInsight(
    failedSelector: string,
    projectId?: number,
    companyId?: number,
  ): Promise<DOMMemoryInsight> {
    const [selectorHistory, alternatives] = await Promise.all([
      this.getSelectorHistory(failedSelector, projectId),
      this.getAlternativeSelectors(failedSelector, projectId, companyId),
    ]);

    const bestAlternative = alternatives.length > 0 ? alternatives[0] : null;

    const recommendation = this.buildRecommendation(
      selectorHistory,
      bestAlternative,
      alternatives.length,
    );

    logger.info(MOD, 'DOM Memory insight generated', {
      failedSelector: failedSelector.slice(0, 60),
      stability: selectorHistory.stabilityScore,
      alternatives: alternatives.length,
      bestAlt: bestAlternative?.selector?.slice(0, 60) || 'none',
      recommendation: recommendation.slice(0, 100),
    });

    return {
      failedSelector,
      selectorHistory,
      alternatives,
      bestAlternative,
      recommendation,
    };
  }

  /**
   * Record that a healing occurred (logs to selector history for future reference).
   */
  async recordHealingObservation(data: {
    failedSelector: string;
    healedSelector: string;
    projectId?: number;
    companyId?: number;
    pageUrl?: string;
    elementType?: string;
    source?: string;
  }): Promise<void> {
    try {
      // Record the failed selector as "changed"
      await recordSelectorObservation({
        projectId: data.projectId,
        companyId: data.companyId,
        pageUrl: data.pageUrl,
        selector: data.healedSelector,
        previousSelector: data.failedSelector,
        elementType: data.elementType,
        changeType: 'healed',
        source: data.source || 'healing',
        metadata: { healedFrom: data.failedSelector },
      });

      logger.debug(MOD, 'Healing observation recorded', {
        failed: data.failedSelector.slice(0, 60),
        healed: data.healedSelector.slice(0, 60),
      });
    } catch (error: any) {
      // Non-critical — don't break healing flow
      logger.warn(MOD, 'Failed to record healing observation', { error: error.message });
    }
  }

  /* ── Private helpers ─────────────────────────────────────── */

  private assessStability(
    score: number,
    changes: number,
    recentChanges: number,
    firstSeen: string | null,
  ): string {
    if (score >= 0.9) return 'Highly stable — rarely changes';
    if (score >= 0.7) return 'Stable — occasional changes';
    if (score >= 0.5) return 'Moderate — changes periodically';
    if (score >= 0.3) return 'Unstable — changes frequently';
    if (recentChanges > 2) return 'Very unstable — changed multiple times recently';
    return 'Unreliable — avoid using this selector';
  }

  private buildAlternativeReasoning(alt: {
    source: string;
    stabilityScore: number;
    score: number;
    usageCount: number;
  }): string {
    const parts: string[] = [];

    switch (alt.source) {
      case 'healing_history':
        parts.push(`Previously healed this exact failure ${alt.usageCount} time(s)`);
        break;
      case 'learned_pattern':
        parts.push(`Learned pattern with ${alt.usageCount} successful heal(s)`);
        break;
      case 'element_history':
        parts.push('Same element identified via DOM Memory tracking');
        break;
      case 'selector_scores':
        parts.push(`High quality selector (score: ${alt.score.toFixed(2)})`);
        break;
    }

    if (alt.stabilityScore >= 0.8) parts.push('highly stable');
    else if (alt.stabilityScore >= 0.5) parts.push('moderately stable');
    else parts.push('stability unknown');

    return parts.join(' — ');
  }

  private buildRecommendation(
    history: SelectorHistoryResult,
    bestAlt: AlternativeSelector | null,
    altCount: number,
  ): string {
    if (history.stabilityScore <= 0.3 && bestAlt && bestAlt.stabilityScore >= 0.7) {
      return `Failed selector is unstable (score: ${history.stabilityScore}). ` +
        `Recommend switching to "${bestAlt.selector}" which has been stable ` +
        `(score: ${bestAlt.stabilityScore}).`;
    }

    if (bestAlt && bestAlt.compositeScore >= 0.7) {
      return `Found ${altCount} alternative(s). Best option: "${bestAlt.selector}" ` +
        `(composite: ${bestAlt.compositeScore}, stability: ${bestAlt.stabilityScore}).`;
    }

    if (altCount > 0) {
      return `Found ${altCount} alternative(s) but none with high confidence. ` +
        `Consider using data-testid for reliable automation.`;
    }

    if (history.observations === 0) {
      return 'No DOM Memory history for this selector. Building baseline data.';
    }

    return `Selector stability: ${history.stabilityScore.toFixed(2)}. ` +
      `${history.assessment}. No better alternatives found.`;
  }
}
