/**
 * Healing Risk Classifier — Sprint 4.3 · Decision Transparency.
 * ============================================================================
 *
 * THE QUESTION IT ANSWERS
 * -----------------------
 * After a heal, the first thing a QA Lead asks is **"Can I trust this change?"**
 * — not "what selector did you pick?". Sprints 4.1 and 4.2 already exposed the
 * `confidence`, `evidence`, `reasonCode`, `chosenCandidate` and `rankedCandidates`.
 * Risk is simply a **deterministic interpretation** of information we already have.
 *
 * DESIGN RULES
 * ------------
 * 1. ONE small enum (`HealingRisk`) and ONE classifier. Nothing else.
 * 2. NO AI, NO ML, NO fuzzy logic, NO weighting, NO scores/percentages. The
 *    rules are a tiny, ordered, deterministic decision list — the same input
 *    always yields the same band.
 * 3. It NEVER re-runs healing or recomputes confidence. It only *reads* the
 *    already-produced `HealingResult`.
 * 4. The enum's string values (`'low' | 'medium' | 'high'`) match the previous
 *    field type verbatim, so the serialized contract is unchanged.
 */

import type { HealingReasonCode, HealingResult } from './healing-result';

/**
 * Coarse, human-facing risk band for a heal. A real `enum` (not strings, not
 * numbers) so call sites are type-checked. String values keep the wire/JSON
 * contract identical to the prior `'low' | 'medium' | 'high'` type.
 */
export enum HealingRisk {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
}

/**
 * Confidence at or above this is required for an attribute-only swap to be LOW.
 * (0.95 == the "confidence >= 95" rule, expressed on the engine's 0..1 scale.)
 */
export const LOW_RISK_MIN_CONFIDENCE = 0.95;

/**
 * Confidence below this is HIGH risk regardless of what changed.
 * (0.70 == the "confidence < 70" rule, on the engine's 0..1 scale.)
 */
export const HIGH_RISK_MAX_CONFIDENCE = 0.7;

/**
 * Reason codes that represent a same-element attribute/id swap — the safest
 * kind of heal, because the element's identity and semantics are unchanged.
 */
const ATTRIBUTE_ONLY_REASONS: ReadonlySet<HealingReasonCode> = new Set<HealingReasonCode>([
  'DATA_TESTID_REMOVED',
  'ID_CHANGED',
  'ATTRIBUTE_CHANGED',
]);

/**
 * Deterministic risk classifier. A single method, a single ordered rule list.
 *
 * The rules, in priority order:
 *   1. Nothing was healed                       → HIGH  (there is no change to trust)
 *   2. Confidence < 0.70                         → HIGH  (the engine itself is unsure)
 *   3. Element role/semantics changed            → HIGH  (a different kind of element)
 *   4. Element moved in the DOM structure        → HIGH  (structural, easy to get wrong)
 *   5. Visible text/copy changed                 → MEDIUM (intentional copy edits happen)
 *   6. Attribute-only swap AND confidence >= 0.95 → LOW   (same element, strong signal)
 *   7. Everything else                           → MEDIUM (default — glance recommended)
 */
export class HealingRiskClassifier {
  classify(result: HealingResult): HealingRisk {
    // 1. No heal produced — there is nothing to trust.
    if (!result.healed || !result.chosenCandidate || result.reasonCode === 'NO_HEAL') {
      return HealingRisk.HIGH;
    }

    // 2. The engine's own confidence is low — dominates every other signal.
    if (result.confidence < HIGH_RISK_MAX_CONFIDENCE) {
      return HealingRisk.HIGH;
    }

    // 3-4. Identity/structure of the element changed — high risk of a wrong target.
    if (result.reasonCode === 'ROLE_CHANGED' || result.reasonCode === 'ELEMENT_MOVED') {
      return HealingRisk.HIGH;
    }

    // 5. Visible copy changed — worth a human glance, but not inherently unsafe.
    if (result.reasonCode === 'TEXT_CHANGED') {
      return HealingRisk.MEDIUM;
    }

    // 6. Same-element attribute/id swap with strong confidence — the safe case.
    if (ATTRIBUTE_ONLY_REASONS.has(result.reasonCode) && result.confidence >= LOW_RISK_MIN_CONFIDENCE) {
      return HealingRisk.LOW;
    }

    // 7. Default: unstable-locator heals, unattributed updates, or attribute
    //    swaps that did not clear the LOW confidence bar. Medium — take a look.
    return HealingRisk.MEDIUM;
  }
}

/** Shared singleton — the classifier is stateless and deterministic. */
export const healingRiskClassifier = new HealingRiskClassifier();
