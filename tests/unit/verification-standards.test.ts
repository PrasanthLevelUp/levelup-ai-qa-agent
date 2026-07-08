/**
 * Unit tests — Verification Standards (Sprint 3A)
 * ===============================================
 * The second deterministic rule library. Verifies the OBJECTIVE→EVIDENCE model:
 *   • planVerifications() classifies a step into the business OBJECTIVES it
 *     should prove, driven by verification CATEGORIES (authentication /
 *     shopping / navigation / crud / search / forms). Success is measured in
 *     objectives proven, not assertion count.
 *   • Each objective carries a name, category, priority, strength (⭐ 1–5), a
 *     reason, and the framework-agnostic EVIDENCE (strongest first) that proves
 *     it — several pieces of evidence can back ONE objective.
 *   • Negative tests flip the objective to "action correctly blocked" and expect
 *     the error to be PRESENT.
 *   • Optional context strengthens the plan without changing the architecture.
 *   • Fail-open: a step with no signal still yields one outcome-level objective.
 *   • Pure & deterministic. No AI. Evidence is structured, NOT Playwright.
 */
import {
  planVerifications,
  classifyCategory,
  verificationTiersInOrder,
  VERIFICATION_TIERS,
  type VerifiableStep,
  type EvidenceKind,
} from '../../src/script-gen/verification-standards';

function step(partial: Partial<VerifiableStep> & Pick<VerifiableStep, 'action' | 'description'>): VerifiableStep {
  return { ...partial } as VerifiableStep;
}
/** The single primary objective for a step (the usual case). */
function objective(s: VerifiableStep, ctx?: Parameters<typeof planVerifications>[1]) {
  return planVerifications(s, ctx).objectives[0]!;
}
function evidence(s: VerifiableStep, ctx?: Parameters<typeof planVerifications>[1]): EvidenceKind[] {
  return objective(s, ctx).evidence;
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

describe('planVerifications — objectives (the unit of value)', () => {
  it('names the business objective for an authentication step', () => {
    const o = objective(step({ action: 'click', description: 'Log in with valid credentials' }));
    expect(o.objective).toBe('user authenticated');
    expect(o.category).toBe('authentication');
    expect(o.negative).toBe(false);
  });

  it('distinguishes cart update from order placement in shopping', () => {
    expect(objective(step({ action: 'click', description: 'Add a product to the cart' })).objective).toBe('cart updated');
    expect(objective(step({ action: 'click', description: 'Finish and place the order' })).objective).toBe('order placed');
  });

  it('produces exactly one primary objective per checkpoint step', () => {
    expect(planVerifications(step({ action: 'click', description: 'Complete checkout and confirm success' })).objectives).toHaveLength(1);
  });

  it('the objective inherits the strength of its strongest evidence', () => {
    const o = objective(step({ action: 'click', description: 'Complete the order and confirm success' }));
    expect(o.strength).toBe(5); // success-indicator
    expect(o.evidence[0]).toBe('success-indicator');
  });
});

describe('planVerifications — evidence (one objective, several proofs)', () => {
  it('backs one objective with multiple pieces of evidence', () => {
    const ev = evidence(
      step({ action: 'click', description: 'Log in with valid credentials' }),
      { pageObjectMembers: ['login', 'logout'] },
    );
    // authentication: success-indicator + landmark-control + error-absent — still ONE objective.
    expect(ev).toContain('success-indicator');
    expect(ev).toContain('landmark-control');
    expect(ev).toContain('error-absent');
  });

  it('orders evidence strongest-first', () => {
    const ev = evidence(step({ action: 'click', description: 'Complete checkout — cart total updates on the confirmation page' }));
    // success-indicator (5) must precede weaker evidence.
    expect(ev[0]).toBe('success-indicator');
  });

  it('prefers strong evidence — drops the weak navigation check when a real outcome is observable', () => {
    const ev = evidence(step({ action: 'navigate', description: 'Go to the inventory product page' }));
    // shopping/navigation mix yields a real landmark; the weak URL check is dropped.
    if (ev.length > 1) expect(ev).not.toContain('navigation');
  });

  it('keeps the no-error guard only where it matters (authentication & forms)', () => {
    expect(evidence(step({ action: 'click', description: 'Log in with valid credentials' }))).toContain('error-absent');
    expect(evidence(step({ action: 'click', description: 'Submit the contact form' }))).toContain('error-absent');
    // shopping is a mutating flow but does not warrant an explicit no-error check.
    expect(evidence(step({ action: 'click', description: 'Add a product to the cart' }))).not.toContain('error-absent');
  });
});

describe('planVerifications — negative tests', () => {
  const neg = step({ action: 'assert', description: 'Verify login fails with an invalid username and shows an error' });

  it('is flagged as a negative test', () => {
    expect(planVerifications(neg).negativeTest).toBe(true);
  });

  it('flips the objective to a correctly-blocked action', () => {
    expect(objective(neg).objective).toBe('action correctly blocked');
    expect(objective(neg).negative).toBe(true);
  });

  it('proves the blocked outcome with error-PRESENT evidence', () => {
    expect(evidence(neg)).toEqual(['error-present']);
  });
});

describe('planVerifications — normal mutating steps', () => {
  it('a positive step never asks for an error to be PRESENT', () => {
    expect(evidence(step({ action: 'click', description: 'Add a product to the cart' }))).not.toContain('error-present');
  });

  it('a positive authentication step guards against an unexpected error (absent, not present)', () => {
    const ev = evidence(step({ action: 'click', description: 'Log in with valid credentials' }));
    expect(ev).toContain('error-absent');
    expect(ev).not.toContain('error-present');
  });
});

describe('planVerifications — context strengthening', () => {
  it('adds a landmark-control proof when context exposes a landmark control', () => {
    const ev = evidence(
      step({ action: 'click', description: 'Log in with valid credentials' }),
      { pageObjectMembers: ['login', 'logout', 'getErrorMessage'] },
    );
    expect(ev).toContain('landmark-control');
  });

  it('context is optional — plan is valid without it', () => {
    expect(() => planVerifications(step({ action: 'click', description: 'Log in' }))).not.toThrow();
  });
});

describe('planVerifications — guarantees', () => {
  it('never returns an empty plan and always states an objective', () => {
    const plan = planVerifications(step({ action: 'wait', description: 'pause briefly' }));
    expect(plan.objectives.length).toBeGreaterThanOrEqual(1);
    expect(plan.objectives[0]!.evidence.length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to a baseline outcome objective when truly nothing matches', () => {
    // Empty text cannot be classified by any signal → the baseline branch fires.
    const o = objective(step({ action: 'wait', description: '' }));
    expect(o.evidence).toEqual(['success-indicator']);
    expect(o.reason).toMatch(/baseline/i);
  });

  it('is deterministic — same step, identical plan', () => {
    const s = step({ action: 'click', description: 'Complete the order' });
    expect(planVerifications(s)).toEqual(planVerifications(s));
  });

  it('every objective carries name, priority, strength, category, evidence and a reason', () => {
    const o = objective(step({ action: 'click', description: 'Checkout and verify the total' }));
    expect(o.objective.length).toBeGreaterThan(0);
    expect(typeof o.priority).toBe('number');
    expect(o.strength).toBeGreaterThanOrEqual(1);
    expect(o.strength).toBeLessThanOrEqual(5);
    expect(o.category).toEqual(expect.any(String));
    expect(o.evidence.length).toBeGreaterThanOrEqual(1);
    expect(o.reason.length).toBeGreaterThan(0);
  });

  it('produces structured evidence, not Playwright code', () => {
    for (const o of planVerifications(step({ action: 'click', description: 'Complete checkout' })).objectives) {
      expect(o.objective).not.toMatch(/expect\(|toBeVisible|toHaveURL/);
      for (const e of o.evidence) expect(e).not.toMatch(/expect\(|toBeVisible|page\./);
    }
  });

  it('does not throw on empty/garbage input (fails open)', () => {
    expect(() => planVerifications(step({ action: '', description: '' }))).not.toThrow();
    expect(planVerifications(step({ action: '', description: '' })).objectives.length).toBeGreaterThanOrEqual(1);
  });
});
