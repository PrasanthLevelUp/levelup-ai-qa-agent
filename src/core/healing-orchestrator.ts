/**
 * Healing Orchestrator
 * Central coordinator: Rule Engine -> Pattern Engine -> AI Engine.
 */

import type { FailureDetails } from './failure-analyzer';
import { RuleEngine } from '../engines/rule-engine';
import { PatternEngine } from '../engines/pattern-engine';
import { AIEngine } from '../engines/ai-engine';
import { logger } from '../utils/logger';

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

export class HealingOrchestrator {
  constructor(
    private readonly ruleEngine: RuleEngine,
    private readonly patternEngine: PatternEngine,
    private readonly aiEngine: AIEngine,
  ) {}

  async heal(failure: FailureDetails): Promise<HealingOutcome> {
    const attemptedStrategies: HealingStrategy[] = [];

    attemptedStrategies.push('rule_based');
    const ruleResult = this.ruleEngine.generate(failure);
    if (ruleResult.suggestions.length > 0) {
      const top = ruleResult.suggestions[0]!;
      logger.info(MOD, 'Rule engine selected', {
        testName: failure.testName,
        confidence: top.confidence,
      });
      return {
        suggestion: {
          newLocator: top.newLocator,
          strategy: 'rule_based',
          confidence: top.confidence,
          tokensUsed: 0,
          reasoning: top.reasoning,
          addExplicitWait: ruleResult.addExplicitWait,
        },
        attemptedStrategies,
      };
    }

    attemptedStrategies.push('database_pattern');
    const patternResult = this.patternEngine.findMatch(failure);
    if (patternResult) {
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

    attemptedStrategies.push('ai_reasoning');
    const aiResult = await this.aiEngine.suggest(failure);
    if (aiResult) {
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

    logger.warn(MOD, 'No healing strategy produced a suggestion', {
      testName: failure.testName,
      attemptedStrategies,
    });

    return { suggestion: null, attemptedStrategies };
  }
}
