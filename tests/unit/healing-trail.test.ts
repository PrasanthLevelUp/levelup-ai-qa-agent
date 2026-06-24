/**
 * Unit tests for healing-trail.ts — the 3-layer healing observability helper.
 *
 * Pure, deterministic, no I/O. Verifies:
 *   • classifyFailure maps raw FailureType → class + healability
 *   • HealingTrailBuilder records attempts, dedupes applied, finalizes summaries
 *   • summarizeHealingTrails produces an honest job-level one-liner
 */

import {
  classifyFailure,
  HealingTrailBuilder,
  summarizeHealingTrails,
  layerLabel,
  classLabel,
  type HealingTrail,
} from '../../src/core/healing-trail';

describe('classifyFailure', () => {
  it('treats locator failures as healable', () => {
    expect(classifyFailure('locator')).toEqual({ classification: 'healable_locator', healable: true });
    expect(classifyFailure('locator_timeout')).toEqual({ classification: 'healable_locator', healable: true });
  });

  it('treats assertion / navigation / timeout as non-healable', () => {
    expect(classifyFailure('assertion')).toEqual({ classification: 'assertion', healable: false });
    expect(classifyFailure('navigation')).toEqual({ classification: 'navigation', healable: false });
    expect(classifyFailure('timeout')).toEqual({ classification: 'timeout', healable: false });
  });

  it('defaults unknown failure types to healable (enters locator loop)', () => {
    expect(classifyFailure('unknown')).toEqual({ classification: 'unknown', healable: true });
    expect(classifyFailure('something-new')).toEqual({ classification: 'unknown', healable: true });
  });
});

describe('HealingTrailBuilder', () => {
  it('records a skip for an assertion failure and summarizes honestly', () => {
    const b = new HealingTrailBuilder('login should redirect', 'assertion');
    expect(b.isHealable).toBe(false);
    b.skip('Assertion/functional failure — element found but assertion did not match.');
    const trail = b.finalize('not_healed');
    expect(trail.classification).toBe('assertion');
    expect(trail.healable).toBe(false);
    expect(trail.outcome).toBe('not_healed');
    expect(trail.attempts).toHaveLength(1);
    expect(trail.attempts[0].decision).toBe('skipped');
    expect(trail.summary).toMatch(/Assertion\/functional/i);
  });

  it('records rejected + no_candidate attempts for an unhealed locator failure', () => {
    const b = new HealingTrailBuilder('cart add fails', 'locator');
    expect(b.isHealable).toBe(true);
    b.record({ layer: 'rule_based', candidate: '#add', confidence: 0.4, decision: 'rejected', reason: 'low confidence' });
    b.record({ layer: 'ai_reasoning', decision: 'no_candidate', reason: 'exhausted suggestions' });
    const trail = b.finalize('not_healed');
    expect(trail.attempts).toHaveLength(2);
    expect(trail.summary).toMatch(/tried 2 candidate/i);
    expect(trail.summary).toMatch(/rejected/i);
  });

  it('summarizes a healed locator with the winning layer', () => {
    const b = new HealingTrailBuilder('checkout button', 'locator');
    b.record({ layer: 'ai_reasoning', candidate: "getByRole('button',{name:'Checkout'})", confidence: 0.92, decision: 'applied', reason: 'passed on rerun' });
    expect(b.hasApplied).toBe(true);
    const trail = b.finalize('healed');
    expect(trail.outcome).toBe('healed');
    expect(trail.summary).toMatch(/AI Reasoning/i);
    expect(trail.summary).toMatch(/Healed/i);
  });

  it('tracks attemptCount and hasApplied correctly', () => {
    const b = new HealingTrailBuilder('t', 'locator');
    expect(b.attemptCount).toBe(0);
    expect(b.hasApplied).toBe(false);
    b.record({ layer: 'rule_based', decision: 'rejected', reason: 'x' });
    expect(b.attemptCount).toBe(1);
    expect(b.hasApplied).toBe(false);
    b.record({ layer: 'rule_based', decision: 'applied', reason: 'y' });
    expect(b.hasApplied).toBe(true);
  });

  it('uses a summary override when provided', () => {
    const b = new HealingTrailBuilder('t', 'navigation');
    const trail = b.finalize('not_healed', 'custom summary');
    expect(trail.summary).toBe('custom summary');
  });
});

describe('summarizeHealingTrails', () => {
  function trail(partial: Partial<HealingTrail>): HealingTrail {
    return {
      testName: 't', failureType: 'locator', classification: 'healable_locator',
      healable: true, attempts: [], outcome: 'not_healed', summary: '',
      ...partial,
    };
  }

  it('handles the empty case', () => {
    expect(summarizeHealingTrails([])).toMatch(/No failures/i);
  });

  it('reports all-non-locator failures honestly (the SauceDemo case)', () => {
    const trails = Array.from({ length: 7 }, () =>
      trail({ classification: 'assertion', healable: false, outcome: 'not_healed' }));
    const s = summarizeHealingTrails(trails);
    expect(s).toMatch(/7 failures/i);
    expect(s).toMatch(/7 non-locator/i);
    expect(s).toMatch(/nothing to heal/i);
    expect(s).toMatch(/assertion\/functional/i);
  });

  it('reports a mix of healed and unresolved', () => {
    const trails = [
      trail({ classification: 'healable_locator', healable: true, outcome: 'healed' }),
      trail({ classification: 'healable_locator', healable: true, outcome: 'not_healed' }),
      trail({ classification: 'navigation', healable: false, outcome: 'not_healed' }),
    ];
    const s = summarizeHealingTrails(trails);
    expect(s).toMatch(/3 failures/i);
    expect(s).toMatch(/1 healed/i);
    expect(s).toMatch(/1 broken-locator unresolved/i);
    expect(s).toMatch(/navigation\/environment/i);
  });
});

describe('label helpers', () => {
  it('labels layers and classes', () => {
    expect(layerLabel('rule_based')).toMatch(/Rule Engine/);
    expect(layerLabel('database_pattern')).toMatch(/Pattern\/DB/);
    expect(layerLabel('ai_reasoning')).toMatch(/AI Reasoning/);
    expect(classLabel('assertion')).toMatch(/assertion/);
    expect(classLabel('navigation')).toMatch(/environment/);
  });
});
