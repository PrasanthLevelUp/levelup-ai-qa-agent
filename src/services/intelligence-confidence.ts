/**
 * Centralized Intelligence Confidence Scorer
 * ============================================================================
 *
 * Confidence is computed HERE — in the orchestration layer — NOT inside each
 * provider. Providers emit raw `signals` (facts); this module turns those facts
 * into a single, consistent confidence number.
 *
 * Why centralize?
 *   • Consistency: one place defines what "80% confident" means. If every
 *     provider invented its own formula, scores would drift and become
 *     incomparable across sources.
 *   • Evolvability: tuning the scoring model (or making it data-driven) is a
 *     single-file change, not a sweep across every provider.
 *   • Testability: the scorer is a pure function of (provider, signals).
 *
 * Adding a new provider's scoring is a small, isolated switch branch here.
 */

import type { IntelligenceMetadata, IntelligenceResult } from './intelligence-provider';

/** Clamp a number into the inclusive 0-100 range. */
function clamp0to100(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/**
 * Read a numeric signal safely (missing / non-numeric → 0).
 */
function num(signals: IntelligenceMetadata['signals'], key: string): number {
  const v = signals[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Compute confidence (0-100) for a gather result from its provider name and
 * raw signals. Unknown providers or unavailable results score 0.
 *
 * Scoring models per source (kept explicit so it's auditable):
 *
 *   scenarioGraph:
 *     - Ungrounded (no scenario backed by real App Profile / Test Data) → 0.
 *       Advisory-only context should never claim confidence.
 *     - Otherwise 60 base + 5 per grounded scenario, capped at 100.
 *       (Identical to the previous provider-local formula — relocated, not changed.)
 */
export function computeConfidence(metadata: IntelligenceMetadata): number {
  const { provider, signals } = metadata;

  switch (provider) {
    case 'scenarioGraph': {
      const grounded = num(signals, 'groundedCount');
      if (grounded <= 0) return 0;
      return clamp0to100(60 + grounded * 5);
    }

    // Future providers register their scoring model here. Until then, a source
    // that emits no known signals is treated as advisory (0) rather than
    // guessing a number.
    default:
      return 0;
  }
}

/**
 * Attach a centrally-computed confidence to a gather result (in place) and
 * return it. Unavailable results always score 0. This is the single choke point
 * the registry uses so providers never set confidence themselves.
 */
export function scoreResult<T>(result: IntelligenceResult<T>): IntelligenceResult<T> {
  result.confidence = result.available ? computeConfidence(result.metadata) : 0;
  return result;
}
