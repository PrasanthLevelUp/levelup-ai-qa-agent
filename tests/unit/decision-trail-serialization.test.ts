/**
 * Sprint 4.4 · Truthful Healing Presentation — decision_trail (de)serialization
 * ============================================================================
 *
 * WHAT THIS COVERS:
 * Sprint 4.4 co-persists the explainable `HealingResult` into the EXISTING
 * `healing_actions.decision_trail` JSONB alongside the waterfall trail, as a
 * lossless composite `{ trail, healingResult }` — no new columns, no new tables.
 * `serializeDecisionTrail`/`parseDecisionTrail` are the pure round-trip helpers
 * that make this safe and BACKWARD COMPATIBLE with legacy array-shaped rows.
 *
 * DESIGN INVARIANTS UNDER TEST:
 * 1. Composite round-trips losslessly (trail + healingResult both preserved).
 * 2. Trail-only serializes to the LEGACY array shape (unchanged wire format for
 *    any old reader) and parses back to `healingResult: null`.
 * 3. Legacy array rows (written before 4.4) parse to the trail with a null
 *    result — never throw, never lose the trail.
 * 4. Absent/empty inputs serialize to SQL NULL.
 * 5. Malformed / unexpected values degrade to empty, never throw.
 */

import { serializeDecisionTrail, parseDecisionTrail } from '../../src/db/postgres';

const sampleTrail = [
  { layer: 'rule_based', tried: true, won: false },
  { layer: 'dom_memory', tried: true, won: true },
];

const sampleResult = {
  originalSelector: '#old-id',
  healedSelector: '[data-testid="submit"]',
  healed: true,
  strategy: 'dom_memory',
  confidence: 0.91,
  autoApply: true,
  reasonCode: 'ID_CHANGED',
  reason: 'The element id changed; healed to a stable test id.',
  evidence: [{ dimension: 'dom_stability', score: 0.95, detail: 'seen 12 times' }],
  chosenCandidate: '[data-testid="submit"]',
  rankedCandidates: [
    { selector: '[data-testid="submit"]', score: 0.91, rank: 1, chosen: true, source: 'dom_memory', evidence: [] },
  ],
  alternatives: [],
  risk: 'low',
};

describe('serializeDecisionTrail / parseDecisionTrail', () => {
  it('round-trips the composite { trail, healingResult } losslessly', () => {
    const raw = serializeDecisionTrail(sampleTrail as any, sampleResult);
    expect(typeof raw).toBe('string');

    // pg returns already-parsed JSONB; simulate that by parsing the string.
    const parsed = parseDecisionTrail(JSON.parse(raw as string));
    expect(parsed.trail).toEqual(sampleTrail);
    expect(parsed.healingResult).toEqual(sampleResult);
  });

  it('serializes trail-only to the LEGACY array shape (no result present)', () => {
    const raw = serializeDecisionTrail(sampleTrail as any, undefined);
    // Old readers must still see a bare array — not a wrapped object.
    expect(JSON.parse(raw as string)).toEqual(sampleTrail);

    const parsed = parseDecisionTrail(JSON.parse(raw as string));
    expect(parsed.trail).toEqual(sampleTrail);
    expect(parsed.healingResult).toBeNull();
  });

  it('parses a legacy array row (written before 4.4) with a null result', () => {
    const parsed = parseDecisionTrail(sampleTrail);
    expect(parsed.trail).toEqual(sampleTrail);
    expect(parsed.healingResult).toBeNull();
  });

  it('keeps the healingResult even when the trail is absent', () => {
    const raw = serializeDecisionTrail(undefined, sampleResult);
    const parsed = parseDecisionTrail(JSON.parse(raw as string));
    expect(parsed.trail).toBeNull();
    expect(parsed.healingResult).toEqual(sampleResult);
  });

  it('serializes to SQL NULL when neither trail nor result is present', () => {
    expect(serializeDecisionTrail(undefined, undefined)).toBeNull();
    expect(serializeDecisionTrail(null as any, null)).toBeNull();
  });

  it('accepts a JSON string as well as an already-parsed value', () => {
    const raw = serializeDecisionTrail(sampleTrail as any, sampleResult) as string;
    const parsed = parseDecisionTrail(raw); // pass the raw string directly
    expect(parsed.trail).toEqual(sampleTrail);
    expect(parsed.healingResult).toEqual(sampleResult);
  });

  it('degrades to empty on malformed / unexpected values, never throwing', () => {
    expect(parseDecisionTrail('not json{')).toEqual({ trail: null, healingResult: null });
    expect(parseDecisionTrail(null)).toEqual({ trail: null, healingResult: null });
    expect(parseDecisionTrail(undefined)).toEqual({ trail: null, healingResult: null });
    expect(parseDecisionTrail(42)).toEqual({ trail: null, healingResult: null });
    // An object without either key is treated as no trail / no result.
    expect(parseDecisionTrail({ foo: 'bar' })).toEqual({ trail: null, healingResult: null });
  });
});
