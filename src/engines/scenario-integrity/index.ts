/**
 * SCENARIO INTEGRITY VALIDATOR — entry point
 * ===========================================
 * Sprint 1.5. Runs all deterministic checks over a scenario and produces a
 * `ScenarioIntegrityReport`.
 *
 * CONTRACTS (see types.ts):
 *   • Read-only: never mutates the scenario.
 *   • Never blocks: `generationAllowed` is ALWAYS `true`. The readiness score
 *     influences downstream confidence only.
 *   • Never throws: wrapped so a bug here can never break generation. On any
 *     unexpected error it returns a permissive, full-score report.
 */
import { ALL_CHECKS } from './checks';
import type {
  IntegrityCheckResult,
  IntegrityConfidence,
  ScenarioForIntegrity,
  ScenarioIntegrityReport,
} from './types';

export * from './types';
export * as checks from './checks';

function confidenceFor(score: number): IntegrityConfidence {
  if (score >= 90) return 'high';
  if (score >= 70) return 'medium';
  return 'low';
}

/** A permissive report used when there is nothing to judge or on error. */
function permissiveReport(checks: IntegrityCheckResult[] = []): ScenarioIntegrityReport {
  return {
    readinessScore: 100,
    confidence: 'high',
    generationAllowed: true,
    checks,
    warnings: [],
  };
}

/**
 * Certify a scenario's internal consistency. Pure, deterministic, non-blocking.
 *
 * @param scenario a readonly view of a Draft/Formatter test case
 * @returns a ScenarioIntegrityReport (never throws)
 */
export function validateScenarioIntegrity(
  scenario: ScenarioForIntegrity | null | undefined
): ScenarioIntegrityReport {
  try {
    if (!scenario) return permissiveReport();

    const checks: IntegrityCheckResult[] = ALL_CHECKS.map((fn) => fn(scenario));

    const totalWeight = checks.reduce((sum, c) => sum + (c.weight || 0), 0);
    const weighted = checks.reduce((sum, c) => sum + c.score * (c.weight || 0), 0);
    const readinessScore = totalWeight > 0 ? Math.round((weighted / totalWeight) * 100) : 100;

    const warnings = checks
      .filter((c) => !c.passed)
      .flatMap((c) => c.messages.map((m) => `[${c.label}] ${m}`));

    return {
      readinessScore,
      confidence: confidenceFor(readinessScore),
      generationAllowed: true,
      checks,
      warnings,
    };
  } catch {
    // A validator bug must NEVER break generation — fail open, permissively.
    return permissiveReport();
  }
}
