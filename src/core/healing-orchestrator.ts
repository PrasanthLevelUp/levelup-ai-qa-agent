/**
 * Healing Orchestrator (Refined)
 * Clean flow between all components: Rule Engine → Pattern Engine → AI Engine
 * with Validation Engine and Rerun Engine integration.
 */

import type { FailureDetails } from './failure-analyzer';
import { RuleEngine } from '../engines/rule-engine';
import { PatternEngine } from '../engines/pattern-engine';
import { AIEngine } from '../engines/ai-engine';
import { ValidationEngine } from '../engines/validation-engine';
import { PatchEngine } from '../engines/patch-engine';
import { RerunEngine, type RerunResult } from '../engines/rerun-engine';
import { logger } from '../utils/logger';
import {
  logHealing,
  storePattern,
} from '../db/sqlite';

const MOD = 'healing-orchestrator';

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
}

export interface FinalizeResult {
  success: boolean;
  patchPath?: string;
  rerunResult?: RerunResult;
}

export class HealingOrchestrator {
  private readonly validationEngine: ValidationEngine;
  private readonly patchEngine: PatchEngine;
  private readonly rerunEngine: RerunEngine;

  constructor(
    private readonly ruleEngine: RuleEngine,
    private readonly patternEngine: PatternEngine,
    private readonly aiEngine: AIEngine,
    validationEngine?: ValidationEngine,
    patchEngine?: PatchEngine,
    rerunEngine?: RerunEngine,
  ) {
    this.validationEngine = validationEngine ?? new ValidationEngine();
    this.patchEngine = patchEngine ?? new PatchEngine();
    this.rerunEngine = rerunEngine ?? new RerunEngine();
  }

  /**
   * Main healing flow — tries each strategy in order.
   */
  async heal(failure: FailureDetails): Promise<HealingOutcome> {
    const attemptedStrategies: HealingStrategy[] = [];

    // Step 1: Try Rule Engine (Level 1)
    attemptedStrategies.push('rule_based');
    const ruleResult = this.ruleEngine.generate(failure);
    if (ruleResult.suggestions.length > 0) {
      // Try each rule suggestion through validation
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
          return { suggestion: healSuggestion, attemptedStrategies };
        }

        logger.debug(MOD, 'Rule suggestion rejected by validation', {
          reason: validation.reason,
        });
      }
    }

    // Step 2: Pattern Engine (Level 2)
    attemptedStrategies.push('database_pattern');
    const patternResult = this.patternEngine.findMatch(failure);
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
          suggestion: {
            newLocator: patternResult.newLocator,
            strategy: 'database_pattern',
            confidence: patternResult.confidence,
            tokensUsed: 0,
            reasoning: patternResult.reasoning,
            addExplicitWait: false,
          },
          attemptedStrategies,
        };
      }
    }

    // Step 3: AI Engine (Level 3)
    attemptedStrategies.push('ai_reasoning');
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
          suggestion: {
            newLocator: aiResult.newLocator,
            strategy: 'ai_reasoning',
            confidence: aiResult.confidence,
            tokensUsed: aiResult.tokensUsed,
            reasoning: aiResult.reasoning,
            addExplicitWait: false,
          },
          attemptedStrategies,
        };
      }
    }

    logger.warn(MOD, 'No healing strategy produced a valid suggestion', {
      testName: failure.testName,
      attemptedStrategies,
    });

    return { suggestion: null, attemptedStrategies };
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
    logHealing({
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
    storePattern({
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
    });

    return { success: true, patchPath: patch.patchPath };
  }
}
