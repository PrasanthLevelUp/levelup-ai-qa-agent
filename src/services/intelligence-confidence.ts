/**
 * Centralized Intelligence Confidence Scorer
 * ============================================================================
 *
 * Confidence is computed HERE — in the orchestration layer — from the
 * standardized quality `signals` each provider emits. It is **generic**: it
 * does NOT branch on provider name. Providers own their domain facts and
 * normalize them into standard 0-1 quality dimensions (grounding, coverage,
 * freshness, completeness); this scorer combines whatever dimensions are
 * present into a single 0-100 confidence.
 *
 * Why this shape (Phase 2 review)?
 *   • Providers keep the knowledge only they have (what "grounded" means for a
 *     scenario graph, "embedding distance" for a repo, "pages crawled" for an
 *     app profile) — they express it as normalized quality signals.
 *   • The orchestrator stays a THIN, consistent combiner. It never grows a
 *     giant per-source scoring switch, so scores remain comparable across
 *     sources and tuning is a one-file change.
 *   • Testable: pure function of `signals`.
 */

import type { IntelligenceResult, QualitySignals } from './intelligence-provider';

/**
 * Relative weights for the standard quality dimensions. Unknown dimensions in
 * `signals` are ignored (a provider may attach extras, but only weighted ones
 * affect the score). Tuning confidence = editing this map, nothing else.
 */
export const QUALITY_WEIGHTS: Record<string, number> = {
  grounding: 1,
  coverage: 1,
  freshness: 1,
  completeness: 1,
};

/** Clamp into the inclusive 0-1 range; non-finite → 0. */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/**
 * Compute confidence (0-100) generically from normalized quality signals.
 *
 * Rules (provider-agnostic):
 *   • If no weighted quality dimension is present → 0 (advisory only; we don't
 *     invent confidence from nothing).
 *   • Hard floor: if `grounding` is present and 0 → 0. A source with zero
 *     grounding is never confident, regardless of other dimensions.
 *   • Otherwise: weighted average of the present dimensions, scaled to 0-100.
 */
export function computeConfidence(signals: QualitySignals | undefined | null): number {
  if (!signals) return 0;

  // A source that explicitly measured zero grounding is not confident.
  if (typeof signals.grounding === 'number' && clamp01(signals.grounding) <= 0) {
    return 0;
  }

  let weightedSum = 0;
  let weightTotal = 0;
  for (const [dimension, weight] of Object.entries(QUALITY_WEIGHTS)) {
    const raw = signals[dimension];
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      weightedSum += clamp01(raw) * weight;
      weightTotal += weight;
    }
  }

  if (weightTotal === 0) return 0; // no recognized quality dimensions
  return Math.round((weightedSum / weightTotal) * 100);
}

/**
 * Attach a centrally-computed confidence to a gather result (in place) and
 * return it. Unavailable results always score 0. This is the single choke point
 * the registry uses so providers never set confidence themselves.
 */
export function scoreResult<T>(result: IntelligenceResult<T>): IntelligenceResult<T> {
  result.confidence = result.available ? computeConfidence(result.metadata.signals) : 0;
  return result;
}
