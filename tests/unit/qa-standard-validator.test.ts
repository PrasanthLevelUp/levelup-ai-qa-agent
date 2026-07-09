/**
 * Unit tests for the deterministic QA Artifact Standard validator.
 * ============================================================================
 *
 * The validator is the CODE embodiment of the QA Artifact Standard
 * (docs/QA_ARTIFACT_STANDARD.md). These tests assert the machine-checkable
 * subset of the 20 principles is DETECTED after generation — so the standard is
 * enforced by code, not re-taught inside every prompt. Each test targets one
 * principle: a violating case must be flagged (right principle, right field),
 * and a clean, standard-compliant case must pass with zero errors.
 */

import {
  validateQaStandard,
  violationsToInstructions,
  type QaViolation,
} from '../../src/engines/qa-standard-validator';
import type { FormatterTestCase } from '../../src/engines/scenario-builder';

/** Minimal FormatterTestCase factory — only the fields the validator reads
 * matter; the rest are filled with valid placeholders to satisfy the type. */
function mk(overrides: Partial<FormatterTestCase>): FormatterTestCase {
  return {
    schemaVersion: 2,
    title: 'Verify the user can log in when valid credentials are entered.',
    objective: 'Confirm a registered user can sign in.',
    scenarioIndex: 0,
    scenarioId: 'auth-valid-login',
    riskArea: 'authentication',
    preconditions: 'A registered user account exists and the login page is open.',
    steps: [
      'Open the login page.',
      'Enter the registered username.',
      'Enter the valid password.',
      'Click the Login button.',
      'Verify the account dashboard is displayed.',
    ],
    grounding: [],
    expectedResult: 'The account dashboard is displayed and the user session is active.',
    testData: 'registered_user',
    selectors: [],
    priority: 'P1',
    severity: 'major',
    tags: ['positive'],
    automationReady: true,
    automationComplexity: 'low',
    selectorAvailability: 'high',
    source: 'requirement',
    sourceEvidence: 'REQ-1',
    ...overrides,
  } as FormatterTestCase;
}

const errs = (vs: QaViolation[]) => vs.filter(v => v.severity === 'error');
const byPrinciple = (vs: QaViolation[], p: string) => vs.filter(v => v.principle.startsWith(p));

describe('qa-standard-validator — clean baseline', () => {
  it('a fully standard-compliant case passes with zero errors', () => {
    const report = validateQaStandard([mk({})]);
    expect(report.passed).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.checked).toBe(1);
    expect(report.failingIds).not.toContain('auth-valid-login');
  });
});

describe('qa-standard-validator — reusable ValidationReport summary', () => {
  it('a clean batch scores 100 and satisfies every checked principle', () => {
    const report = validateQaStandard([mk({ scenarioId: 'a' }), mk({ scenarioId: 'b' })]);
    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
    expect(report.principlesViolated).toEqual([]);
    // Every principle the validator checks is reported as satisfied.
    expect(report.principlesSatisfied).toEqual(expect.arrayContaining(['P2 one-action-per-step', 'P6 observable-results']));
    expect(report.principlesSatisfied.length).toBeGreaterThanOrEqual(8);
  });

  it('score reflects the % of error-free cases; violated principle leaves satisfied', () => {
    const report = validateQaStandard([
      mk({ scenarioId: 'good' }),
      mk({ scenarioId: 'bad', steps: ['Open the login page.', 'Fill the username selector.'] }), // P5 error
    ]);
    expect(report.passed).toBe(false);
    expect(report.score).toBe(50); // 1 of 2 cases error-free
    expect(report.principlesViolated).toContain('P5 business-language');
    expect(report.principlesSatisfied).not.toContain('P5 business-language');
  });

  it('warnings do NOT reduce the score or fail the gate', () => {
    // A non-"Verify" title is a P11 WARNING only.
    const report = validateQaStandard([mk({ title: 'Login works with valid credentials' })]);
    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
    expect(report.warnings).toBeGreaterThan(0);
    expect(report.principlesViolated).toContain('P11 title-formula');
  });

  it('empty input is a clean 100 with no principles violated', () => {
    const report = validateQaStandard([]);
    expect(report.passed).toBe(true);
    expect(report.score).toBe(100);
    expect(report.principlesViolated).toEqual([]);
  });
});

describe('qa-standard-validator — P2 one-action-per-step', () => {
  it('flags a step that enters two data items in one action', () => {
    const report = validateQaStandard([
      mk({ steps: ['Open the login page.', 'Enter the username and password.', 'Click the Login button.', 'Verify the dashboard is displayed.'] }),
    ]);
    const p2 = byPrinciple(report.violations, 'P2');
    expect(p2.length).toBeGreaterThan(0);
    expect(p2[0].field).toBe('steps');
    expect(p2[0].severity).toBe('error');
    expect(report.passed).toBe(false);
  });

  it('does NOT flag a single control label containing "and"', () => {
    const report = validateQaStandard([
      mk({ steps: ['Open the form.', 'Click the Save and Exit button.', 'Verify the confirmation message is displayed.'] }),
    ]);
    expect(byPrinciple(report.violations, 'P2').length).toBe(0);
  });
});

describe('qa-standard-validator — P3 user-actions-only', () => {
  it('flags meta verbs like "Ensure"/"Observe" as non-user actions', () => {
    const report = validateQaStandard([
      mk({ steps: ['Open the login page.', 'Ensure the username field is present.', 'Click the Login button.', 'Verify the dashboard is displayed.'] }),
    ]);
    const p3 = byPrinciple(report.violations, 'P3');
    expect(p3.length).toBeGreaterThan(0);
    expect(errs(report.violations).length).toBeGreaterThan(0);
  });
});

describe('qa-standard-validator — P5 business-language', () => {
  it('flags automation vocabulary in steps', () => {
    const report = validateQaStandard([
      mk({ steps: ['Open the login page.', 'Fill the username selector.', 'Click the Login button.', 'Verify the dashboard is displayed.'] }),
    ]);
    const p5 = byPrinciple(report.violations, 'P5');
    expect(p5.length).toBeGreaterThan(0);
    expect(p5[0].severity).toBe('error');
  });
});

describe('qa-standard-validator — P4 verification-not-action', () => {
  it('flags a step that mixes an action with a verification', () => {
    const report = validateQaStandard([
      mk({ steps: ['Open the login page.', 'Click the Login button and verify the dashboard is displayed.'] }),
    ]);
    const p4 = byPrinciple(report.violations, 'P4');
    expect(p4.length).toBeGreaterThan(0);
    expect(p4[0].severity).toBe('error');
  });
});

describe('qa-standard-validator — P6 observable-results', () => {
  it('flags an abstract expected result', () => {
    const report = validateQaStandard([mk({ expectedResult: 'Login successful.' })]);
    const p6 = byPrinciple(report.violations, 'P6');
    expect(p6.length).toBeGreaterThan(0);
    expect(p6[0].field).toBe('expected');
    expect(p6[0].severity).toBe('error');
  });

  it('flags an empty expected result', () => {
    const report = validateQaStandard([mk({ expectedResult: '' })]);
    expect(byPrinciple(report.violations, 'P6').length).toBeGreaterThan(0);
  });

  it('accepts an abstract phrase when a concrete observable accompanies it', () => {
    const report = validateQaStandard([
      mk({ expectedResult: 'The login is successful and the account dashboard page is displayed.' }),
    ]);
    expect(byPrinciple(report.violations, 'P6').length).toBe(0);
  });
});

describe('qa-standard-validator — P11 title-formula (warn)', () => {
  it('warns when the title does not start with "Verify"', () => {
    const report = validateQaStandard([mk({ title: 'Login works with valid credentials' })]);
    const p11 = byPrinciple(report.violations, 'P11');
    expect(p11.length).toBe(1);
    expect(p11[0].severity).toBe('warn');
    // A warning alone does NOT fail the batch.
    expect(report.passed).toBe(true);
  });
});

describe('qa-standard-validator — reporting contract', () => {
  it('groups violations by scenarioId and lists failing ids', () => {
    const report = validateQaStandard([
      mk({ scenarioId: 'a', steps: ['Ensure the page loads.'] }),
      mk({ scenarioId: 'b' }), // clean
    ]);
    expect(report.byId.has('a')).toBe(true);
    expect(report.failingIds).toContain('a');
    expect(report.failingIds).not.toContain('b');
  });

  it('violationsToInstructions produces short, field-scoped repair lines', () => {
    const report = validateQaStandard([
      mk({ scenarioId: 'a', steps: ['Open the login page.', 'Enter the username and password.'] }),
    ]);
    const lines = violationsToInstructions(report.byId.get('a') || []);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some(l => l.startsWith('[step'))).toBe(true);
  });

  it('never throws on empty input', () => {
    const report = validateQaStandard([]);
    expect(report.passed).toBe(true);
    expect(report.checked).toBe(0);
    expect(report.violations).toEqual([]);
  });
});
