/**
 * Healing Orchestrator v3 (DOM Memory Enhanced)
 * Integrates: DOM Memory → Strategy Selector → Rule/Pattern/AI Engines → Validation → AST Patch → Rerun
 * Features: Confidence-based routing, token budget management, rollback support,
 *           DOM Memory stability scoring, historical selector ranking.
 *
 * KEY DIFFERENTIATOR: Before generating new fixes, queries DOM Memory for:
 *  1. Selector stability history (how often has this selector changed?)
 *  2. Alternative selectors with stability scores
 *  3. Ranks ALL suggestions (engine-generated + DOM Memory alternatives) by stability
 *  4. Records healing observations for future learning
 */

import type { FailureDetails } from './failure-analyzer';
import { HealingStrategySelector, type SelectedStrategy } from './healing-strategy-selector';
import { RuleEngine } from '../engines/rule-engine';
import { PatternEngine } from '../engines/pattern-engine';
import { AIEngine } from '../engines/ai-engine';
import { DOMCandidateExtractor, type DOMExtractionResult } from '../engines/dom-candidate-extractor';
import { SemanticSimilarityEngine } from '../engines/semantic-similarity-engine';
import { ConfidenceEngine, type ConfidenceResult } from '../engines/confidence-engine';
import { ValidationEngine, type ValidationResult } from '../engines/validation-engine';
import { PatchEngine, type PatchResult } from '../engines/patch-engine';
import { RerunEngine, type RerunResult } from '../engines/rerun-engine';
import { DOMMemoryQuery, type DOMMemoryInsight, type AlternativeSelector } from '../services/dom-memory-query';
import { logger } from '../utils/logger';
import {
  logHealing,
  storePattern,
} from '../db/postgres';

const MOD = 'healing-orchestrator';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type HealingStrategy = 'rule_based' | 'database_pattern' | 'ai_reasoning';

export interface HealingSuggestion {
  newLocator: string;
  strategy: HealingStrategy;
  confidence: number;
  tokensUsed: number;
  reasoning: string;
  addExplicitWait: boolean;
  /** Stability score from DOM Memory (0–1, higher = more stable) */
  stabilityScore?: number;
  /** Human-readable stability assessment */
  stabilityAssessment?: string;
}

export interface HealingOutcome {
  suggestion: HealingSuggestion | null;
  attemptedStrategies: HealingStrategy[];
  validationResult?: ValidationResult;
  selectedEngine?: string;
  confidenceResult?: ConfidenceResult;
  domCandidates?: DOMExtractionResult;
  /** DOM Memory insight for the failed selector */
  domMemoryInsight?: DOMMemoryInsight;
}

export interface FinalizeResult {
  success: boolean;
  patchPath?: string;
  rerunResult?: RerunResult;
  engine?: string;
  confidence?: number;
  tokensUsed?: number;
  stabilityScore?: number;
}

/* -------------------------------------------------------------------------- */
/*  Orchestrator                                                              */
/* -------------------------------------------------------------------------- */

export class HealingOrchestrator {
  private readonly validationEngine: ValidationEngine;
  private readonly patchEngine: PatchEngine;
  private readonly rerunEngine: RerunEngine;
  private readonly strategySelector: HealingStrategySelector;
  private readonly domExtractor: DOMCandidateExtractor;
  private readonly similarityEngine: SemanticSimilarityEngine;
  private readonly confidenceEngine: ConfidenceEngine;
  private readonly domMemory: DOMMemoryQuery;

  constructor(
    private readonly ruleEngine: RuleEngine,
    private readonly patternEngine: PatternEngine,
    private readonly aiEngine: AIEngine,
    validationEngine?: ValidationEngine,
    patchEngine?: PatchEngine,
    rerunEngine?: RerunEngine,
    strategySelector?: HealingStrategySelector,
  ) {
    this.validationEngine = validationEngine ?? new ValidationEngine();
    this.patchEngine = patchEngine ?? new PatchEngine();
    this.rerunEngine = rerunEngine ?? new RerunEngine();
    this.strategySelector = strategySelector ?? new HealingStrategySelector();
    this.domExtractor = new DOMCandidateExtractor();
    this.similarityEngine = new SemanticSimilarityEngine();
    this.confidenceEngine = new ConfidenceEngine();
    this.domMemory = new DOMMemoryQuery();
  }

  /**
   * Main healing flow — enhanced with DOM Memory + DOM candidate extraction.
   * Priority: DOM Memory Alternatives → DOM Candidates → Rule Engine → Pattern Engine → AI Engine
   *
   * DOM Memory integration (v3):
   *  - Before trying any engine, queries historical selector data
   *  - If a stable alternative exists from past healings, uses it immediately (0 tokens!)
   *  - After engine-generated fixes, ranks them by stability score
   *  - Records healing observation for future learning
   *
   * @param failure - Analyzed failure details
   * @param domHtml - Optional: raw DOM HTML from page.content() for DOM-based healing
   * @param skipLocators - Optional: locators to skip (already tried)
   * @param projectId - Optional: project ID for project-scoped DOM Memory queries
   * @param companyId - Optional: company ID for company-scoped queries
   */
  async heal(
    failure: FailureDetails,
    domHtml?: string,
    skipLocators?: Set<string>,
    projectId?: number,
    companyId?: number,
  ): Promise<HealingOutcome> {
    const attemptedStrategies: HealingStrategy[] = [];
    let domCandidates: DOMExtractionResult | undefined;
    let domMemoryInsight: DOMMemoryInsight | undefined;

    // ── Step 0a: DOM Memory Query (THE MOAT) ──────────────────
    // Query historical selector data BEFORE doing anything else.
    // This is what makes LevelUp different from every other tool.
    if (failure.failedLocator) {
      try {
        domMemoryInsight = await this.domMemory.getInsight(
          failure.failedLocator,
          projectId,
          companyId,
        );

        logger.info(MOD, 'DOM Memory insight retrieved', {
          testName: failure.testName,
          failedSelector: failure.failedLocator.slice(0, 60),
          selectorStability: domMemoryInsight.selectorHistory.stabilityScore,
          alternativesFound: domMemoryInsight.alternatives.length,
          recommendation: domMemoryInsight.recommendation.slice(0, 100),
        });

        // If DOM Memory has a high-confidence stable alternative, use it immediately!
        // This means 0 AI tokens, 0 latency — just historical knowledge.
        const bestAlt = domMemoryInsight.bestAlternative;
        if (bestAlt && bestAlt.compositeScore >= 0.75) {
          // Validate the DOM Memory suggestion
          const validation = this.validationEngine.validate({
            newLocator: bestAlt.selector,
            confidence: bestAlt.compositeScore,
            originalCode: '',
            filePath: failure.filePath,
          });

          if (validation.isValid) {
            logger.info(MOD, '🧠 DOM Memory alternative accepted — 0 AI tokens!', {
              selector: bestAlt.selector,
              compositeScore: bestAlt.compositeScore,
              stabilityScore: bestAlt.stabilityScore,
              source: bestAlt.source,
              reasoning: bestAlt.reasoning,
            });

            const suggestion: HealingSuggestion = {
              newLocator: bestAlt.selector,
              strategy: 'database_pattern', // Closest match — it's from historical data
              confidence: bestAlt.compositeScore,
              tokensUsed: 0,
              reasoning: `[DOM Memory] ${bestAlt.reasoning} — ${domMemoryInsight.recommendation}`,
              addExplicitWait: false,
              stabilityScore: bestAlt.stabilityScore,
              stabilityAssessment: domMemoryInsight.selectorHistory.assessment,
            };

            return {
              suggestion,
              attemptedStrategies: ['database_pattern'],
              selectedEngine: 'dom_memory',
              domMemoryInsight,
            };
          }
        }
      } catch (err: any) {
        // Non-critical — DOM Memory is an enhancement, not a requirement
        logger.warn(MOD, 'DOM Memory query failed (non-critical)', { error: err.message });
      }
    }

    // ── Step 0b: DOM Candidate Extraction (from live DOM HTML) ──
    if (domHtml && failure.failedLocator) {
      logger.info(MOD, 'Running DOM candidate extraction', {
        testName: failure.testName,
        failedLocator: failure.failedLocator,
        domLength: domHtml.length,
      });

      domCandidates = this.domExtractor.extractFromHTML(
        domHtml,
        failure.failedLocator,
        failure.failedLineCode || '',
      );

      if (domCandidates.candidates.length > 0) {
        const topCandidate = domCandidates.candidates[0];

        // Calculate enhanced confidence
        const confidenceResult = this.confidenceEngine.calculate({
          strategy: 'dom_candidate',
          rawConfidence: topCandidate.score,
          selectorType: topCandidate.matchType === 'semantic' ? 'semantic' : 'css_attribute',
          similarityScore: topCandidate.score,
          domValidated: true,
          matchType: topCandidate.matchType,
          sameTag: true,
        });

        // Boost confidence if DOM Memory says this candidate is stable
        let stabilityBoost = 0;
        let stabilityScore: number | undefined;
        if (domMemoryInsight) {
          const altMatch = domMemoryInsight.alternatives.find(
            a => a.selector === topCandidate.selector,
          );
          if (altMatch && altMatch.stabilityScore >= 0.7) {
            stabilityBoost = 0.05; // Small boost for stability-confirmed candidates
            stabilityScore = altMatch.stabilityScore;
          }
        }

        const finalScore = Math.min(1.0, confidenceResult.finalScore + stabilityBoost);

        if (finalScore >= 0.70) {
          logger.info(MOD, 'DOM candidate accepted', {
            selector: topCandidate.selector,
            score: topCandidate.score,
            confidence: finalScore,
            stabilityBoost,
            grade: confidenceResult.grade,
            reasoning: topCandidate.reasoning,
          });

          const suggestion: HealingSuggestion = {
            newLocator: topCandidate.selector,
            strategy: 'rule_based',
            confidence: finalScore,
            tokensUsed: 0,
            reasoning: `[DOM Candidate] ${topCandidate.reasoning}`,
            addExplicitWait: false,
            stabilityScore,
          };

          return {
            suggestion,
            attemptedStrategies: ['rule_based'],
            selectedEngine: 'dom_candidate',
            confidenceResult,
            domCandidates,
            domMemoryInsight,
          };
        }
      }
    }

    // ── Step 1: Use strategy selector to determine best approach ──
    const selected = await this.strategySelector.selectStrategy(
      failure,
      this.ruleEngine,
      this.patternEngine,
      this.aiEngine,
    );

    logger.info(MOD, 'Strategy selected', {
      engine: selected.engine,
      confidence: selected.confidence,
      estimatedTokens: selected.estimatedTokens,
      testName: failure.testName,
    });

    // Step 2: Execute selected engine (or fall through all in priority order)
    if (selected.engine === 'none') {
      const outcome = await this.healFallbackChain(failure, attemptedStrategies);
      // Enrich with stability scores
      if (outcome.suggestion) {
        await this.enrichWithStability(outcome.suggestion, domMemoryInsight);
      }
      outcome.domMemoryInsight = domMemoryInsight;
      return outcome;
    }

    // Try selected engine first, then fall through
    let suggestion: HealingSuggestion | null = null;

    if (selected.engine === 'rule' || selected.engine === 'pattern' || selected.engine === 'ai') {
      suggestion = await this.tryEngine(selected.engine, failure, attemptedStrategies, skipLocators);
    }

    // If selected engine failed, try remaining engines
    if (!suggestion) {
      const engines: Array<'rule' | 'pattern' | 'ai'> = ['rule', 'pattern', 'ai'];
      for (const eng of engines) {
        if (attemptedStrategies.includes(this.engineToStrategy(eng))) continue;
        suggestion = await this.tryEngine(eng, failure, attemptedStrategies, skipLocators);
        if (suggestion) break;
      }
    }

    if (!suggestion) {
      logger.warn(MOD, 'No healing strategy produced a valid suggestion', {
        testName: failure.testName,
        attemptedStrategies,
      });
      return { suggestion: null, attemptedStrategies, selectedEngine: selected.engine, domCandidates, domMemoryInsight };
    }

    // Calculate enhanced confidence for the chosen suggestion
    const confidenceResult = this.confidenceEngine.calculate({
      strategy: suggestion.strategy === 'rule_based' ? 'rule_based'
        : suggestion.strategy === 'database_pattern' ? 'database_pattern'
        : 'ai_reasoning',
      rawConfidence: suggestion.confidence,
      selectorType: suggestion.newLocator.includes('getBy') ? 'semantic' : 'css_attribute',
      similarityScore: suggestion.confidence,
    });

    // Update confidence with enhanced score
    suggestion.confidence = confidenceResult.finalScore;

    // ── Enrich with DOM Memory stability data ──
    await this.enrichWithStability(suggestion, domMemoryInsight);

    // Record token usage for AI calls
    if (suggestion.strategy === 'ai_reasoning' && suggestion.tokensUsed > 0) {
      await this.strategySelector.recordUsage('ai', suggestion.tokensUsed);
    }

    return { suggestion, attemptedStrategies, selectedEngine: selected.engine, confidenceResult, domCandidates, domMemoryInsight };
  }

  /**
   * Try all engines in fallback chain order.
   */
  private async healFallbackChain(
    failure: FailureDetails,
    attemptedStrategies: HealingStrategy[],
  ): Promise<HealingOutcome> {
    // Try Rule → Pattern → AI
    for (const eng of ['rule', 'pattern', 'ai'] as const) {
      const suggestion = await this.tryEngine(eng, failure, attemptedStrategies);
      if (suggestion) {
        if (suggestion.strategy === 'ai_reasoning' && suggestion.tokensUsed > 0) {
          await this.strategySelector.recordUsage('ai', suggestion.tokensUsed);
        }
        return { suggestion, attemptedStrategies };
      }
    }

    return { suggestion: null, attemptedStrategies };
  }

  /**
   * Try a specific engine and validate its suggestion.
   */
  private async tryEngine(
    engine: 'rule' | 'pattern' | 'ai',
    failure: FailureDetails,
    attemptedStrategies: HealingStrategy[],
    skipLocators?: Set<string>,
  ): Promise<HealingSuggestion | null> {
    const strategy = this.engineToStrategy(engine);
    attemptedStrategies.push(strategy);

    switch (engine) {
      case 'rule': {
        const ruleResult = this.ruleEngine.generate(failure, skipLocators);
        if (ruleResult.suggestions.length > 0) {
          for (const suggestion of ruleResult.suggestions) {
            const healSuggestion: HealingSuggestion = {
              newLocator: suggestion.newLocator,
              strategy: 'rule_based',
              confidence: suggestion.confidence,
              tokensUsed: 0,
              reasoning: suggestion.reasoning,
              addExplicitWait: ruleResult.addExplicitWait,
            };

            const validation = this.validationEngine.validate({
              newLocator: suggestion.newLocator,
              confidence: suggestion.confidence,
              originalCode: '',
              filePath: failure.filePath,
            });

            if (validation.isValid) {
              logger.info(MOD, 'Rule engine suggestion validated', {
                testName: failure.testName,
                confidence: suggestion.confidence,
                locator: suggestion.newLocator,
              });
              return healSuggestion;
            }

            logger.debug(MOD, 'Rule suggestion rejected', { reason: validation.reason });
          }
        }
        return null;
      }

      case 'pattern': {
        const patternResult = await this.patternEngine.findMatch(failure);
        if (patternResult) {
          const validation = this.validationEngine.validate({
            newLocator: patternResult.newLocator,
            confidence: patternResult.confidence,
            originalCode: '',
            filePath: failure.filePath,
          });

          if (validation.isValid) {
            logger.info(MOD, 'Pattern engine selected', {
              testName: failure.testName,
              confidence: patternResult.confidence,
            });
            return {
              newLocator: patternResult.newLocator,
              strategy: 'database_pattern',
              confidence: patternResult.confidence,
              tokensUsed: 0,
              reasoning: patternResult.reasoning,
              addExplicitWait: false,
            };
          }
        }
        return null;
      }

      case 'ai': {
        const aiResult = await this.aiEngine.suggest(failure);
        if (aiResult) {
          const validation = this.validationEngine.validate({
            newLocator: aiResult.newLocator,
            confidence: aiResult.confidence,
            originalCode: '',
            filePath: failure.filePath,
          });

          if (validation.isValid) {
            logger.info(MOD, 'AI engine selected', {
              testName: failure.testName,
              confidence: aiResult.confidence,
              tokensUsed: aiResult.tokensUsed,
            });
            return {
              newLocator: aiResult.newLocator,
              strategy: 'ai_reasoning',
              confidence: aiResult.confidence,
              tokensUsed: aiResult.tokensUsed,
              reasoning: aiResult.reasoning,
              addExplicitWait: false,
            };
          }
        }
        return null;
      }
    }
  }

  private engineToStrategy(engine: 'rule' | 'pattern' | 'ai'): HealingStrategy {
    switch (engine) {
      case 'rule': return 'rule_based';
      case 'pattern': return 'database_pattern';
      case 'ai': return 'ai_reasoning';
    }
  }

  /**
   * Enrich a healing suggestion with DOM Memory stability data.
   * Looks up the proposed new locator in DOM Memory and attaches stability info.
   * Also applies a confidence boost for stable selectors.
   */
  private async enrichWithStability(
    suggestion: HealingSuggestion,
    domMemoryInsight?: DOMMemoryInsight,
  ): Promise<void> {
    try {
      // Check if the proposed locator matches any DOM Memory alternative
      if (domMemoryInsight?.alternatives.length) {
        const match = domMemoryInsight.alternatives.find(
          a => a.selector === suggestion.newLocator,
        );
        if (match) {
          suggestion.stabilityScore = match.stabilityScore;
          suggestion.stabilityAssessment =
            match.stabilityScore >= 0.8 ? 'Highly stable — historically reliable' :
            match.stabilityScore >= 0.5 ? 'Moderately stable' :
            'Stability unknown — no significant history';

          // Boost confidence for stable selectors (max +0.05)
          if (match.stabilityScore >= 0.8) {
            suggestion.confidence = Math.min(1.0, suggestion.confidence + 0.05);
          } else if (match.stabilityScore < 0.3) {
            // Penalise unstable selectors slightly
            suggestion.confidence = Math.max(0.1, suggestion.confidence - 0.03);
          }

          logger.info(MOD, 'Stability data attached to suggestion', {
            selector: suggestion.newLocator.slice(0, 60),
            stabilityScore: match.stabilityScore,
            adjustedConfidence: suggestion.confidence,
          });
          return;
        }
      }

      // If no match in DOM Memory alternatives, do a direct lookup
      const history = await this.domMemory.getSelectorHistory(suggestion.newLocator);
      if (history.observations > 0) {
        suggestion.stabilityScore = history.stabilityScore;
        suggestion.stabilityAssessment = history.observations > 0
          ? `Stability: ${history.stabilityScore.toFixed(2)} — ${history.changeCount} change(s) recorded`
          : 'New selector — no history available';
      }
    } catch {
      // Non-critical — don't break healing
    }
  }

  /**
   * Finalize a successful healing — generate patch, store to DB, record to DOM Memory.
   */
  async finalize(
    suggestion: HealingSuggestion,
    failure: FailureDetails,
    originalCode: string,
    fixedCode: string,
    executionId: number,
    projectId?: number,
    companyId?: number,
  ): Promise<FinalizeResult> {
    // Generate patch
    const patch = this.patchEngine.generatePatch(
      failure.filePath,
      failure.lineNumber,
      originalCode,
      fixedCode,
      `Heal: ${failure.testName} — ${suggestion.reasoning}`,
      suggestion.strategy,
    );

    // Log to database
    await logHealing({
      test_execution_id: executionId,
      test_name: failure.testName,
      failed_locator: failure.failedLocator,
      healed_locator: suggestion.newLocator,
      healing_strategy: suggestion.strategy,
      ai_tokens_used: suggestion.tokensUsed,
      success: true,
      confidence: suggestion.confidence,
      error_context: failure.errorMessage.slice(0, 500),
      validation_status: 'approved',
      validation_reason: suggestion.reasoning,
      patch_path: patch.patchPath,
    });

    // Store learned pattern
    await storePattern({
      test_name: failure.testName,
      error_pattern: failure.errorPattern,
      failed_locator: failure.failedLocator,
      healed_locator: suggestion.newLocator,
      solution_strategy: suggestion.strategy,
      confidence: suggestion.confidence,
      avg_tokens_saved: suggestion.tokensUsed,
    });

    // ── Record to DOM Memory for future learning ──
    // This is how the system gets smarter over time
    try {
      await this.domMemory.recordHealingObservation({
        failedSelector: failure.failedLocator,
        healedSelector: suggestion.newLocator,
        projectId,
        companyId,
        pageUrl: failure.url || undefined,
        source: `healing:${suggestion.strategy}`,
      });
    } catch {
      // Non-critical — don't fail the finalize
    }

    logger.info(MOD, 'Healing finalized', {
      testName: failure.testName,
      strategy: suggestion.strategy,
      patchPath: patch.patchPath,
      confidence: suggestion.confidence,
      stabilityScore: suggestion.stabilityScore,
    });

    return {
      success: true,
      patchPath: patch.patchPath,
      engine: suggestion.strategy,
      confidence: suggestion.confidence,
      tokensUsed: suggestion.tokensUsed,
      stabilityScore: suggestion.stabilityScore,
    };
  }
}
