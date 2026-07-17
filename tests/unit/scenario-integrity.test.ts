/**
 * Unit tests — Scenario Integrity Validator (Sprint 1.5)
 * =======================================================
 * Verifies each deterministic check (a clean pass case + a clear warn case),
 * the readiness aggregation, and the two non-negotiable invariants:
 *   • generationAllowed is ALWAYS true (never blocks), even at low score.
 *   • the validator is pure (never mutates its input) and never throws.
 */
import {
  validateScenarioIntegrity,
  type ScenarioForIntegrity,
} from '../../src/engines/scenario-integrity';
import {
  checkPersonaConsistency,
  checkCoveragePolarity,
  checkTestDataSuitability,
  checkExpectedResultConsistency,
  checkStepCompleteness,
  checkPreconditions,
  checkBusinessFlow,
  checkGroundingCompleteness,
} from '../../src/engines/scenario-integrity/checks';

// A clean, internally-consistent happy-path scenario used as a baseline.
const CLEAN_POSITIVE: ScenarioForIntegrity = {
  title: 'Successful login with valid credentials',
  objective: 'Verify a registered user can log in successfully',
  coverageType: 'positive',
  preconditions: 'User is registered and has a valid account',
  steps: [
    'Open the login page',
    'Enter valid email address',
    'Enter valid password',
    'Click Sign In',
  ],
  grounding: [
    { stepIndex: 2, selector: '#email', control: 'Email' },
    { stepIndex: 3, selector: '#password', control: 'Password' },
    { stepIndex: 4, selector: '#signin', control: 'Sign In' },
  ],
  expected: { observable: 'User is redirected to dashboard and login is successful' },
  expectedResult: 'User is redirected to dashboard and login is successful',
  testData: 'Valid email and correct password',
};

describe('validateScenarioIntegrity — report shape & invariants', () => {
  it('produces a well-formed report for a clean scenario', () => {
    const r = validateScenarioIntegrity(CLEAN_POSITIVE);
    expect(r.generationAllowed).toBe(true);
    expect(r.readinessScore).toBeGreaterThanOrEqual(90);
    expect(r.confidence).toBe('high');
    // 10 checks: the 8 original consistency checks + the field-validity check
    // (Scenario ↔ Fields Step Validator, Sprint 2) + the expected-result-
    // provable check (Observable/Grounded/Black-box, Expected Result Excellence).
    expect(r.checks).toHaveLength(10);
    expect(r.warnings).toHaveLength(0);
  });

  it('NEVER blocks generation, even for a badly inconsistent scenario (low score)', () => {
    const broken: ScenarioForIntegrity = {
      title: 'Successful checkout',
      objective: 'Verify successful purchase',
      coverageType: 'positive',
      preconditions: '',
      steps: ['Proceed to checkout', 'Enter card and pay now', 'Log out', 'Add item to cart'],
      expected: { observable: 'Payment is rejected due to invalid card' },
      expectedResult: 'Payment is rejected due to invalid card',
      testData: 'Invalid expired card',
    };
    const r = validateScenarioIntegrity(broken);
    expect(r.generationAllowed).toBe(true); // hard invariant
    expect(r.readinessScore).toBeLessThan(70);
    expect(r.confidence).toBe('low');
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('is pure — does not mutate the input scenario', () => {
    const snapshot = JSON.parse(JSON.stringify(CLEAN_POSITIVE));
    validateScenarioIntegrity(CLEAN_POSITIVE);
    expect(CLEAN_POSITIVE).toEqual(snapshot);
  });

  it('never throws and fails open on null/undefined input', () => {
    expect(validateScenarioIntegrity(null).generationAllowed).toBe(true);
    expect(validateScenarioIntegrity(undefined).readinessScore).toBe(100);
    expect(validateScenarioIntegrity({}).generationAllowed).toBe(true);
  });

  it('is deterministic — same input yields identical report', () => {
    expect(validateScenarioIntegrity(CLEAN_POSITIVE)).toEqual(
      validateScenarioIntegrity(CLEAN_POSITIVE)
    );
  });
});

describe('1. persona consistency', () => {
  it('passes when title, data and expected all align (positive)', () => {
    expect(checkPersonaConsistency(CLEAN_POSITIVE).passed).toBe(true);
  });

  it('warns when a positive title has negative test data', () => {
    const r = checkPersonaConsistency({
      ...CLEAN_POSITIVE,
      testData: 'invalid password',
    });
    expect(r.passed).toBe(false);
    expect(r.messages.join(' ')).toMatch(/negative/i);
  });

  it('warns when a negative title expects success', () => {
    const r = checkPersonaConsistency({
      title: 'Login with invalid password is denied',
      objective: 'Verify login fails for wrong password',
      expected: { observable: 'Login is successful' },
      expectedResult: 'Login is successful',
    });
    expect(r.passed).toBe(false);
  });
});

describe('2. coverage polarity', () => {
  it('passes when expected polarity matches coverage', () => {
    expect(checkCoveragePolarity(CLEAN_POSITIVE).passed).toBe(true);
  });

  it('warns when negative coverage expects success', () => {
    const r = checkCoveragePolarity({
      coverageType: 'negative',
      expected: { observable: 'Login is successful and user reaches dashboard' },
      expectedResult: 'Login is successful and user reaches dashboard',
    });
    expect(r.passed).toBe(false);
  });

  it('warns when positive coverage expects failure', () => {
    const r = checkCoveragePolarity({
      coverageType: 'positive',
      expected: { observable: 'An error is shown and the request is rejected' },
      expectedResult: 'An error is shown and the request is rejected',
    });
    expect(r.passed).toBe(false);
  });
});

describe('3. test data suitability', () => {
  it('passes for positive coverage with valid data', () => {
    expect(checkTestDataSuitability(CLEAN_POSITIVE).passed).toBe(true);
  });

  it('warns for positive coverage with negative data', () => {
    const r = checkTestDataSuitability({
      coverageType: 'positive',
      testData: 'invalid, expired credentials',
    });
    expect(r.passed).toBe(false);
  });

  it('warns for negative coverage with clean valid data', () => {
    const r = checkTestDataSuitability({
      coverageType: 'negative',
      testData: 'valid correct email and password',
    });
    expect(r.passed).toBe(false);
  });
});

describe('4. expected result consistency', () => {
  it('passes when an aligned observable exists', () => {
    expect(checkExpectedResultConsistency(CLEAN_POSITIVE).passed).toBe(true);
  });

  it('warns when no observable expected result is present', () => {
    const r = checkExpectedResultConsistency({ title: 'x', objective: 'y' });
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
  });

  it('warns when objective and observable disagree in polarity', () => {
    const r = checkExpectedResultConsistency({
      objective: 'Verify successful login',
      expected: { observable: 'An error message is displayed' },
    });
    expect(r.passed).toBe(false);
  });
});

describe('5. step completeness', () => {
  it('passes for a complete form flow', () => {
    expect(checkStepCompleteness(CLEAN_POSITIVE).passed).toBe(true);
  });

  it('warns when there are no steps', () => {
    const r = checkStepCompleteness({ steps: [] });
    expect(r.passed).toBe(false);
    expect(r.score).toBe(0);
  });

  it('warns when a form submit has no preceding input step', () => {
    const r = checkStepCompleteness({
      steps: ['Open the login page', 'Click Sign In'],
    });
    expect(r.passed).toBe(false);
  });
});

describe('6. preconditions', () => {
  it('passes when preconditions establish a session for auth-required steps', () => {
    const r = checkPreconditions({
      preconditions: 'User is logged in with a valid session',
      steps: ['Open account page', 'View my orders'],
    });
    expect(r.passed).toBe(true);
  });

  it('warns when an auth-required step lacks a session precondition', () => {
    const r = checkPreconditions({
      preconditions: '',
      steps: ['Open the checkout page', 'Enter shipping details'],
    });
    expect(r.passed).toBe(false);
  });

  it('passes when the flow logs in within its own steps', () => {
    const r = checkPreconditions({
      preconditions: '',
      steps: ['Open login page', 'Sign in with valid credentials', 'Open account page'],
    });
    expect(r.passed).toBe(true);
  });
});

describe('7. business flow consistency', () => {
  it('passes for a natural shopping flow', () => {
    const r = checkBusinessFlow({
      steps: [
        'Open the home page',
        'Search for a product',
        'Add to cart',
        'View cart',
        'Proceed to checkout',
        'Enter payment and pay now',
      ],
    });
    expect(r.passed).toBe(true);
  });

  it('warns when checkout happens with nothing added to cart', () => {
    const r = checkBusinessFlow({
      steps: ['Open the home page', 'Proceed to checkout', 'Pay now'],
    });
    expect(r.passed).toBe(false);
    expect(r.messages.join(' ')).toMatch(/cart/i);
  });

  it('warns when an in-session action follows logout', () => {
    const r = checkBusinessFlow({
      steps: ['Log in', 'Log out', 'Add to cart'],
    });
    expect(r.passed).toBe(false);
    expect(r.messages.join(' ')).toMatch(/logout/i);
  });

  it('warns when payment occurs before checkout', () => {
    const r = checkBusinessFlow({
      steps: ['Add to cart', 'Enter payment and pay now', 'Proceed to checkout'],
    });
    expect(r.passed).toBe(false);
  });

  it('warns when login appears after order confirmation', () => {
    const r = checkBusinessFlow({
      steps: ['Add to cart', 'Proceed to checkout', 'Order confirmed', 'Log in'],
    });
    expect(r.passed).toBe(false);
  });

  it('does not fire on short/ambiguous flows', () => {
    expect(checkBusinessFlow({ steps: ['Open the page'] }).passed).toBe(true);
  });
});

describe('8. grounding completeness', () => {
  it('scores full when all actionable steps are grounded', () => {
    const r = checkGroundingCompleteness(CLEAN_POSITIVE);
    expect(r.score).toBe(1);
    expect(r.passed).toBe(true);
  });

  it('lowers score (but does not hard-fail generation) when grounding is sparse', () => {
    const r = checkGroundingCompleteness({
      steps: ['Enter email', 'Enter password', 'Click Sign In'],
      grounding: [],
    });
    expect(r.score).toBeLessThan(0.5);
    // low weight → contributes to score, never blocks
    expect(r.weight).toBeLessThanOrEqual(2);
  });

  it('is neutral when there are no actionable steps', () => {
    const r = checkGroundingCompleteness({ steps: ['Observe the page'], grounding: [] });
    expect(r.score).toBe(1);
  });
});
