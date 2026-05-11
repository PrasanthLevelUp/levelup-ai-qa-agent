/**
 * AI Engine (Level 3)
 * Calls OpenAI only if Level 1 and Level 2 do not produce a fix.
 */

import { logger } from '../utils/logger';
import type { FailureDetails } from '../core/failure-analyzer';
import { OpenAIClient } from '../ai/openai-client';

const MOD = 'ai-engine';

export interface AIEngineResult {
  newLocator: string;
  confidence: number;
  reasoning: string;
  tokensUsed: number;
  model: string;
}

export class AIEngine {
  constructor(private readonly openaiClient: OpenAIClient) {}

  async suggest(failure: FailureDetails): Promise<AIEngineResult | null> {
    const response = await this.openaiClient.suggestSemanticLocator({
      errorMessage: failure.errorMessage,
      failedLine: failure.failedLineCode,
      surroundingCode: failure.surroundingCode,
      failedLocator: failure.failedLocator,
      testName: failure.testName,
    });

    if (!response.newLocator) {
      logger.warn(MOD, 'AI response did not include a new locator', {
        testName: failure.testName,
      });
      return null;
    }

    logger.info(MOD, 'AI suggestion generated', {
      testName: failure.testName,
      tokensUsed: response.tokensUsed,
      confidence: response.confidence,
    });

    return {
      newLocator: response.newLocator,
      confidence: response.confidence,
      reasoning: response.reasoning,
      tokensUsed: response.tokensUsed,
      model: response.model,
    };
  }
}
