/**
 * Unit tests — Verification Standards (Sprint 3)
 * ==============================================
 * The second deterministic rule library. Verifies:
 *   • planVerifications() classifies a step into an ORDERED plan of structured
 *     intents (strongest evidence first), driven by verification CATEGORIES
 *     (authentication / shopping / navigation / crud / search / forms).
 *   • Each intent carries a tier, priority, strength (⭐ 1–5), category, reason.
 *   • Negative tests invert the outcome and expect the error to be PRESENT.
 *   • Optional context strengthens the plan without changing the architecture.
 *   • Fail-open: a step with no signal still yields one outcome-level check.
 *   • Pure & deterministic. No AI. Output is structured intent, NOT Playwright.
 */
import {
  planVerifications,
  classifyCategory,
  verificationTiersInOrder,
  VERIFICATION_TIERS,
  type VerifiableStep,
  type VerificationTier,
} from '../../src/script-gen/verification-standards';

function step(partial: Partial<VerifiableStep> & Pick<VerifiableStep, 'action' | 'description'>): VerifiableStep {
  return { ...partial } as VerifiableStep;
}
function tiers(s: VerifiableStep): VerificationTier[] {
  return planVerifications(s).intents.map((i) => i.tier);
}

describe('the verification hierarchy', () => {
  it('is ordered strongest-evidence-first by priority', () => {
    expect(verificationTiersInOrder().map((t) => t.tier)).toEqual([
      'business-outcome', 'application-state', 'critical-ui', 'negative-state', 'technical-state',
    ]);
  });

  it('assigns descending strength ⭐5 → ⭐1 down the hierarchy', () => {
    expect(verificationTiersInOrder().map((t) => t.strength)).toEqual([5, 4, 3, 2, 1]);
  });

  it('business outcome outranks technical state (the whole point)', () => {
    expect(VERIFICATION_TIERS['business-outcome'].priority).toBeGreaterThan(
      VERIFICATION_TIERS['technical-state'].priority,
    );
  });
});

describe('classifyCategory — maintainable categories, not regex-per-feature', () => {
  it.each([
    ['Login with valid credentials', 'authentication'],
    ['Add a product to the cart and checkout', 'shopping'],
    ['Create a new employee record', 'crud'],
    ['Search and filter the results', 'search'],
    ['Submit the contact form', 'forms'],
    ['Navigate to the dashboard page', 'navigation'],
    ['do the thing', 'generic'],
  ])('%s → %s', (desc, expected) => {
    expect(classifyCategory(desc)).toBe(expected);
  });
});

describe('planVerifications — classification', () => {
  it('a checkout/order step verifies the business outcome first', () => {
    const plan = planVerifications(step({ action: 'click', description: 'Complete the order and confirm success' }));
    expect(plan.intents[0].tier).toBe('business-outcome');
    expect(plan.intents[0].strength).toBe(5);
    expect(plan.category).toBe('shopping');
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

  it('a positive step never asks for an error to be shown', () => {
    const negState = planVerifications(step({ action: 'assert', description: 'Confirm the order was placed successfully' }))
      .intents.find((i) => i.tier === 'negative-state');
    // shopping category includes a negative-state tier, but for a POSITIVE step
    // it must be the "no unexpected error" (absence) form, never "error IS shown".
    if (negState) expect(negState.intent).toMatch(/no unexpected error/i);
  });
});

describe('planVerifications — context strengthening', () => {
  it('adds a critical-UI check when context exposes a landmark control', () => {
    const withCtx = planVerifications(
      step({ action: 'click', description: 'Log in with valid credentials' }),
      { pageObjectMembers: ['login', 'logout', 'getErrorMessage'] },
    );
    const ui = withCtx.intents.find((i) => i.tier === 'critical-ui');
    expect(ui).toBeDefined();
  });

  it('context is optional — plan is valid without it', () => {
    expect(() => planVerifications(step({ action: 'click', description: 'Log in' }))).not.toThrow();
  });
});

describe('planVerifications — guarantees', () => {
  it('never returns an empty plan and leads with the strongest tier', () => {
    const plan = planVerifications(step({ action: 'wait', description: 'pause briefly' }));
    expect(plan.intents.length).toBeGreaterThanOrEqual(1);
    expect(plan.intents[0].tier).toBe('business-outcome');
  });

  it('falls back to a baseline outcome intent when truly nothing matches', () => {
    // Empty text cannot be classified by any signal → the baseline branch fires.
    const plan = planVerifications(step({ action: 'wait', description: '' }));
    expect(plan.intents[0].tier).toBe('business-outcome');
    expect(plan.intents[0].reason).toMatch(/baseline/i);
  });

  it('is deterministic — same step, identical plan', () => {
    const s = step({ action: 'click', description: 'Complete the order' });
    expect(planVerifications(s)).toEqual(planVerifications(s));
  });

  it('every intent carries tier, priority, strength, category and a reason', () => {
    for (const i of planVerifications(step({ action: 'click', description: 'Checkout and verify the total' })).intents) {
      expect(i.tier).toEqual(expect.any(String));
      expect(typeof i.priority).toBe('number');
      expect(i.strength).toBeGreaterThanOrEqual(1);
      expect(i.strength).toBeLessThanOrEqual(5);
      expect(i.category).toEqual(expect.any(String));
      expect(i.reason.length).toBeGreaterThan(0);
    }
  });

  it('produces structured intent, not Playwright code', () => {
    for (const i of planVerifications(step({ action: 'click', description: 'Complete checkout' })).intents) {
      expect(i.intent).not.toMatch(/expect\(|toBeVisible|toHaveURL/);
    }
  });

  it('does not throw on empty/garbage input (fails open)', () => {
    expect(() => planVerifications(step({ action: '', description: '' }))).not.toThrow();
    expect(planVerifications(step({ action: '', description: '' })).intents.length).toBeGreaterThanOrEqual(1);
  });
});
