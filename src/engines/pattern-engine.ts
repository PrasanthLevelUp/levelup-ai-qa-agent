/**
 * Pattern Engine (Level 2)
 * Looks up previously successful locator fixes from PostgreSQL.
 */

import { logger } from '../utils/logger';
import type { FailureDetails } from '../core/failure-analyzer';
import { lookupPattern } from '../db/postgres';

const MOD = 'pattern-engine';

export interface PatternEngineResult {
  newLocator: string;
  confidence: number;
  reasoning: string;
  usageCount: number;
}

export interface PatternTenantScope {
  companyId?: number | null;
  projectId?: number | null;
}

export class PatternEngine {
  async findMatch(
    failure: FailureDetails,
    scope: PatternTenantScope = {},
  ): Promise<PatternEngineResult | null> {
    if (!failure.failedLocator) return null;

    // SECURITY: scope the learned-pattern lookup to the caller's tenant so a
    // healed locator from one company/project is never served to another.
    const pattern = await lookupPattern({
      failed_locator: failure.failedLocator,
      test_name: failure.testName,
      error_pattern: failure.errorPattern,
      company_id: scope.companyId ?? null,
      project_id: scope.projectId ?? null,
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
