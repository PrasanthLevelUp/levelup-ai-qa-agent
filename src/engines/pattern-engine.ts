/**
 * Pattern Engine (Level 2)
 * Looks up previously successful locator fixes from SQLite.
 */

import { logger } from '../utils/logger';
import type { FailureDetails } from '../core/failure-analyzer';
import { lookupPattern } from '../db/sqlite';

const MOD = 'pattern-engine';

export interface PatternEngineResult {
  newLocator: string;
  confidence: number;
  reasoning: string;
  usageCount: number;
}

export class PatternEngine {
  findMatch(failure: FailureDetails): PatternEngineResult | null {
    if (!failure.failedLocator) return null;

    const pattern = lookupPattern({
      failed_locator: failure.failedLocator,
      test_name: failure.testName,
      error_pattern: failure.errorPattern,
    });

    if (!pattern) {
      logger.info(MOD, 'No learned pattern found', {
        testName: failure.testName,
        failedLocator: failure.failedLocator,
      });
      return null;
    }

    logger.info(MOD, 'Learned pattern hit', {
      testName: failure.testName,
      failedLocator: failure.failedLocator,
      healedLocator: pattern.healed_locator,
      usageCount: pattern.usage_count,
    });

    return {
      newLocator: pattern.healed_locator,
      confidence: pattern.confidence,
      reasoning: `Matched historical fix (usage_count=${pattern.usage_count})`,
      usageCount: pattern.usage_count,
    };
  }
}
