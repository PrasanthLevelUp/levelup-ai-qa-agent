/**
 * Healing Orchestrator v2 (Hardened)
 * Integrates: Strategy Selector → Rule/Pattern/AI Engines → Validation → AST Patch → Rerun
 * Features: Confidence-based routing, token budget management, rollback support.
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
}

export interface HealingOutcome {
  suggestion: HealingSuggestion | null;
  attemptedStrategies: HealingStrategy[];
  validationResult?: ValidationResult;
  selectedEngine?: string;
  confidenceResult?: ConfidenceResult;
  domCandidates?: DOMExtractionResult;
}

export interface FinalizeResult {
  success: boolean;
  patchPath?: string;
  rerunResult?: RerunResult;
  engine?: string;
  confidence?: number;
  tokensUsed?: number;
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
  }

  /**
   * Main healing flow — enhanced with DOM candidate extraction.
   * Priority: DOM Candidates → Rule Engine → Pattern Engine → AI Engine
   *
   * @param failure - Analyzed failure details
   * @param domHtml - Optional: raw DOM HTML from page.content() for DOM-based healing
   */
  async heal(failure: FailureDetails, domHtml?: string): Promise<HealingOutcome> {
    const attemptedStrategies: HealingStrategy[] = [];
    let domCandidates: DOMExtractionResult | undefined;

    // Step 0: DOM Candidate Extraction (if DOM HTML is available)
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

        if (confidenceResult.finalScore >= 0.70) {
          logger.info(MOD, 'DOM candidate accepted', {
            selector: topCandidate.selector,
            score: topCandidate.score,
            confidence: confidenceResult.finalScore,
            grade: confidenceResult.grade,
            reasoning: topCandidate.reasoning,
          });

          const suggestion: HealingSuggestion = {
            newLocator: topCandidate.selector,
            strategy: 'rule_based', // DOM extraction is deterministic, 0 tokens
            confidence: confidenceResult.finalScore,
            tokensUsed: 0,
            reasoning: `[DOM Candidate] ${topCandidate.reasoning}`,
            addExplicitWait: false,
          };

          return {
            suggestion,
            attemptedStrategies: ['rule_based'],
            selectedEngine: 'dom_candidate',
            confidenceResult,
            domCandidates,
          };
        }
      }
    }

    // Step 1: Use strategy selector to determine best approach
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
      // Try all engines in order as fallback
      return this.healFallbackChain(failure, attemptedStrategies);
    }

    // Try selected engine first, then fall through
    let suggestion: HealingSuggestion | null = null;

    if (selected.engine === 'rule' || selected.engine === 'pattern' || selected.engine === 'ai') {
      suggestion = await this.tryEngine(selected.engine, failure, attemptedStrategies);
    }

    // If selected engine failed, try remaining engines
    if (!suggestion) {
      const engines: Array<'rule' | 'pattern' | 'ai'> = ['rule', 'pattern', 'ai'];
      for (const eng of engines) {
        if (attemptedStrategies.includes(this.engineToStrategy(eng))) continue;
        suggestion = await this.tryEngine(eng, failure, attemptedStrategies);
        if (suggestion) break;
      }
    }

    if (!suggestion) {
      logger.warn(MOD, 'No healing strategy produced a valid suggestion', {
        testName: failure.testName,
        attemptedStrategies,
      });
      return { suggestion: null, attemptedStrategies, selectedEngine: selected.engine, domCandidates };
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

    // Record token usage for AI calls
    if (suggestion.strategy === 'ai_reasoning' && suggestion.tokensUsed > 0) {
      await this.strategySelector.recordUsage('ai', suggestion.tokensUsed);
    }

    return { suggestion, attemptedStrategies, selectedEngine: selected.engine, confidenceResult, domCandidates };
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
  ): Promise<HealingSuggestion | null> {
    const strategy = this.engineToStrategy(engine);
    attemptedStrategies.push(strategy);

    switch (engine) {
      case 'rule': {
        const ruleResult = this.ruleEngine.generate(failure);
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
   * Finalize a successful healing — generate patch, store to DB, etc.
   */
  async finalize(
    suggestion: HealingSuggestion,
    failure: FailureDetails,
    originalCode: string,
    fixedCode: string,
    executionId: number,
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

    logger.info(MOD, 'Healing finalized', {
      testName: failure.testName,
      strategy: suggestion.strategy,
      patchPath: patch.patchPath,
      confidence: suggestion.confidence,
    });

    return {
      success: true,
      patchPath: patch.patchPath,
      engine: suggestion.strategy,
      confidence: suggestion.confidence,
      tokensUsed: suggestion.tokensUsed,
    };
  }
}
