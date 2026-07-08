/**
 * Unit tests — Verification Standards (Sprint 3)
 * ==============================================
 * The second deterministic rule library. Verifies:
 *   • planVerifications() classifies a step into an ORDERED verification plan
 *     (business-outcome → application-state → critical-ui → negative-state →
 *     technical-state), strongest signal first.
 *   • Negative tests invert the outcome and expect the error to be PRESENT.
 *   • Normal mutating steps assert the ABSENCE of an unexpected error.
 *   • Fail-open: a step with no signal still yields one outcome-level check.
 *   • Pure & deterministic — same step → same plan. No AI.
 */
import {
  planVerifications,
  verificationTiersInOrder,
  VERIFICATION_TIERS,
  type VerifiableStep,
  type VerificationTier,
} from '../../src/script-gen/verification-standards';

/** Minimal step factory. */
function step(partial: Partial<VerifiableStep> & Pick<VerifiableStep, 'action' | 'description'>): VerifiableStep {
  return { ...partial } as VerifiableStep;
}

/** The set of tiers present in a plan. */
function tiers(s: VerifiableStep): VerificationTier[] {
  return planVerifications(s).intents.map((i) => i.tier);
}

describe('the verification hierarchy', () => {
  it('is ordered strongest-signal-first by priority', () => {
    const order = verificationTiersInOrder().map((t) => t.tier);
    expect(order).toEqual([
      'business-outcome',
      'application-state',
      'critical-ui',
      'negative-state',
      'technical-state',
    ]);
  });

  it('business outcome outranks technical state (the whole point)', () => {
    expect(VERIFICATION_TIERS['business-outcome'].priority).toBeGreaterThan(
      VERIFICATION_TIERS['technical-state'].priority,
    );
  });
});

describe('planVerifications — classification', () => {
  it('a checkout/order step verifies the business outcome first', () => {
    const plan = planVerifications(step({ action: 'click', description: 'Complete the order and confirm success' }));
    expect(plan.intents[0].tier).toBe('business-outcome');
    expect(plan.negativeTest).toBe(false);
  });

  it('a cart-count step verifies application state', () => {
    expect(tiers(step({ action: 'assert', description: 'Verify the cart badge shows a count of 1' })))
      .toContain('application-state');
  });

  it('a control-visibility step verifies critical UI', () => {
    expect(tiers(step({ action: 'assert', description: 'The logout button should be visible' })))
      .toContain('critical-ui');
  });

  it('a navigation step verifies technical state', () => {
    expect(tiers(step({ action: 'navigate', description: 'Go to the inventory page' })))
      .toContain('technical-state');
  });

  it('orders every produced plan strongest-first', () => {
    const plan = planVerifications(step({
      action: 'click',
      description: 'Complete checkout — cart total updates and the logout button stays visible on the confirmation page',
    }));
    const priorities = plan.intents.map((i) => i.priority);
    expect(priorities).toEqual([...priorities].sort((a, b) => b - a));
    // A rich step touches multiple tiers.
    expect(plan.intents.length).toBeGreaterThanOrEqual(3);
  });
});

describe('planVerifications — negative tests', () => {
  const neg = step({ action: 'assert', description: 'Verify login fails with an invalid username and shows an error' });

  it('is flagged as a negative test', () => {
    expect(planVerifications(neg).negativeTest).toBe(true);
  });

  it('inverts the business outcome (goal must be blocked)', () => {
    const outcome = planVerifications(neg).intents.find((i) => i.tier === 'business-outcome');
    expect(outcome?.intent).toMatch(/did NOT succeed|blocked/i);
  });

  it('expects the error to be PRESENT (not absent)', () => {
    const negState = planVerifications(neg).intents.find((i) => i.tier === 'negative-state');
    expect(negState?.intent).toMatch(/expected error|IS shown/i);
  });
});

describe('planVerifications — normal mutating steps', () => {
  it('assert the ABSENCE of an unexpected error after a click', () => {
    const negState = planVerifications(step({ action: 'click', description: 'Add a product to the cart' }))
      .intents.find((i) => i.tier === 'negative-state');
    expect(negState?.intent).toMatch(/no unexpected error/i);
  });

  it('a pure assertion (non-mutating) does not invent a negative-state check', () => {
    // "assert" is not a mutating action and this description has no negative signal.
    expect(tiers(step({ action: 'assert', description: 'Confirm the order was placed successfully' })))
      .not.toContain('negative-state');
  });
});

describe('planVerifications — guarantees', () => {
  it('never returns an empty plan (fail-open baseline)', () => {
    const plan = planVerifications(step({ action: 'wait', description: 'pause briefly' }));
    expect(plan.intents.length).toBeGreaterThanOrEqual(1);
    expect(plan.intents[0].tier).toBe('business-outcome');
    expect(plan.intents[0].reason).toMatch(/baseline/i);
  });

  it('is deterministic — same step, identical plan', () => {
    const s = step({ action: 'click', description: 'Complete the order' });
    expect(planVerifications(s)).toEqual(planVerifications(s));
  });

  it('every intent carries a tier, priority and a reason', () => {
    for (const i of planVerifications(step({ action: 'click', description: 'Checkout and verify the total' })).intents) {
      expect(i.tier).toEqual(expect.any(String));
      expect(typeof i.priority).toBe('number');
      expect(i.reason.length).toBeGreaterThan(0);
    }
  });

  it('does not throw on empty/garbage input (fails open)', () => {
    expect(() => planVerifications(step({ action: '', description: '' }))).not.toThrow();
    expect(planVerifications(step({ action: '', description: '' })).intents.length).toBeGreaterThanOrEqual(1);
  });
});
