/**
 * Sprint 4.3 · Healing Risk Classification — HealingRiskClassifier
 * ============================================================================
 *
 * WHAT THIS COVERS:
 * The classifier answers the QA Lead's real question after a heal — "can I
 * trust this change?" — as a coarse LOW / MEDIUM / HIGH band. These tests pin
 * every rule so the mapping stays deterministic: the SAME HealingResult always
 * yields the SAME band. No AI, no scores, no fuzzy logic — just fixed rules.
 */

import {
  HealingRisk,
  HealingRiskClassifier,
  healingRiskClassifier,
} from '../../src/core/healing-risk-classifier';
import type { HealingReasonCode, HealingResult } from '../../src/core/healing-result';

/**
 * Build a minimal HealingResult. The classifier only reads `healed`,
 * `chosenCandidate`, `reasonCode` and `confidence`; the rest is filled with
 * inert defaults so each test states just the fields that matter.
 */
function result(overrides: Partial<HealingResult> = {}): HealingResult {
  return {
    originalSelector: '#old',
    healedSelector: 'button.new',
    healed: true,
    strategy: 'rule_based',
    confidence: 0.9,
    autoApply: true,
    reasonCode: 'SELECTOR_UPDATED',
    reason: 'Selector updated.',
    evidence: [],
    chosenCandidate: 'button.new',
    rankedCandidates: [],
    alternatives: [],
    risk: HealingRisk.MEDIUM,
    ...overrides,
  };
}

describe('Sprint 4.3 — HealingRiskClassifier', () => {
  const classifier = new HealingRiskClassifier();

  /* ---- The rules the brief calls out ----------------------------------- */

  it('attribute-only change with high confidence → LOW', () => {
    const reasons: HealingReasonCode[] = ['ATTRIBUTE_CHANGED', 'ID_CHANGED', 'DATA_TESTID_REMOVED'];
    for (const reasonCode of reasons) {
      expect(classifier.classify(result({ reasonCode, confidence: 0.97 }))).toBe(HealingRisk.LOW);
    }
  });

  it('text change → MEDIUM', () => {
    expect(classifier.classify(result({ reasonCode: 'TEXT_CHANGED', confidence: 0.97 }))).toBe(
      HealingRisk.MEDIUM,
    );
  });

  it('role change → HIGH', () => {
    expect(classifier.classify(result({ reasonCode: 'ROLE_CHANGED', confidence: 0.97 }))).toBe(
      HealingRisk.HIGH,
    );
  });

  it('low confidence (0.62) → HIGH regardless of reason', () => {
    expect(classifier.classify(result({ reasonCode: 'ID_CHANGED', confidence: 0.62 }))).toBe(
      HealingRisk.HIGH,
    );
  });

  it('unknown / unattributed update → MEDIUM', () => {
    expect(classifier.classify(result({ reasonCode: 'SELECTOR_UPDATED', confidence: 0.9 }))).toBe(
      HealingRisk.MEDIUM,
    );
  });

  /* ---- Supporting edges ------------------------------------------------- */

  it('no heal produced → HIGH', () => {
    expect(
      classifier.classify(
        result({ healed: false, chosenCandidate: null, healedSelector: null, reasonCode: 'NO_HEAL', confidence: 0 }),
      ),
    ).toBe(HealingRisk.HIGH);
  });

  it('element moved → HIGH (structural change)', () => {
    expect(classifier.classify(result({ reasonCode: 'ELEMENT_MOVED', confidence: 0.97 }))).toBe(
      HealingRisk.HIGH,
    );
  });

  it('attribute-only change just below the LOW bar (0.94) → MEDIUM', () => {
    expect(classifier.classify(result({ reasonCode: 'ATTRIBUTE_CHANGED', confidence: 0.94 }))).toBe(
      HealingRisk.MEDIUM,
    );
  });

  it('LOW bar is inclusive at exactly 0.95', () => {
    expect(classifier.classify(result({ reasonCode: 'ID_CHANGED', confidence: 0.95 }))).toBe(
      HealingRisk.LOW,
    );
  });

  it('HIGH confidence bound: 0.70 is not low-confidence-high, 0.69 is', () => {
    // 0.70 clears the low-confidence gate → not forced HIGH (attribute-only, but
    // below 0.95 so MEDIUM). 0.69 is below the gate → HIGH.
    expect(classifier.classify(result({ reasonCode: 'ID_CHANGED', confidence: 0.7 }))).toBe(
      HealingRisk.MEDIUM,
    );
    expect(classifier.classify(result({ reasonCode: 'ID_CHANGED', confidence: 0.69 }))).toBe(
      HealingRisk.HIGH,
    );
  });

  it('low confidence beats an otherwise-LOW attribute change', () => {
    // Attribute-only + would-be LOW, but confidence gate fires first → HIGH.
    expect(classifier.classify(result({ reasonCode: 'DATA_TESTID_REMOVED', confidence: 0.5 }))).toBe(
      HealingRisk.HIGH,
    );
  });

  it('LOCATOR_UNSTABLE heal → MEDIUM', () => {
    expect(classifier.classify(result({ reasonCode: 'LOCATOR_UNSTABLE', confidence: 0.9 }))).toBe(
      HealingRisk.MEDIUM,
    );
  });

  it('is deterministic — same input, same band', () => {
    const r = result({ reasonCode: 'ID_CHANGED', confidence: 0.97 });
    expect(classifier.classify(r)).toBe(classifier.classify(r));
    // and the exported singleton agrees with a fresh instance
    expect(healingRiskClassifier.classify(r)).toBe(classifier.classify(r));
  });

  it('enum values keep the wire contract (low/medium/high strings)', () => {
    expect(HealingRisk.LOW).toBe('low');
    expect(HealingRisk.MEDIUM).toBe('medium');
    expect(HealingRisk.HIGH).toBe('high');
  });
});
