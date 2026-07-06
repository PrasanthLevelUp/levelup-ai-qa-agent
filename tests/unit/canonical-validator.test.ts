import { validateCanonicalTestCases } from '../../src/engines/canonical-validator';
import type { FormatterTestCase } from '../../src/engines/scenario-builder';

/**
 * Canonical Validator — the deterministic self-check that runs BEFORE the LLM.
 *
 * The one rule that can never bend: the validator NEVER changes the case count
 * (coverage is sacred). It repairs what it safely can and warns on grounding
 * gaps; it does not delete.
 */

/** Build a complete, valid canonical test case; override any field per test. */
function makeCase(overrides: Partial<FormatterTestCase> = {}): FormatterTestCase {
  return {
    title: 'Valid login',
    objective: 'Verify a registered user can log in with valid credentials.',
    scenarioIndex: 0,
    scenarioId: 'auth-pos-valid',
    riskArea: 'authentication',
    preconditions: 'A registered account exists.',
    steps: [
      'Navigate to https://app.example.com/login',
      'Enter a valid email (#email)',
      'Enter a valid password (#password)',
      'Click the submit control (#login-btn)',
    ],
    expectedResult: 'The user is authenticated and lands on the dashboard.',
    testData: 'valid_credentials (keys: email, password)',
    selectors: ['#email', '#password', '#login-btn'],
    priority: 'P0',
    severity: 'critical',
    tags: ['positive', 'authentication'],
    automationReady: true,
    automationComplexity: 'low',
    selectorAvailability: 'high',
    source: 'app_profile',
    sourceEvidence: 'login form on /login',
    ...overrides,
  };
}

/** A knowledge base that grounds the selectors/datasets/pages the fixture uses. */
const KNOWLEDGE = {
  applicationProfile: {
    baseUrl: 'https://app.example.com',
    loginUrl: 'https://app.example.com/login',
    pages: [{ url: 'https://app.example.com/login' }],
    forms: [
      {
        page: 'https://app.example.com/login',
        submitSelector: '#login-btn',
        fields: [{ selector: '#email' }, { selector: '#password' }],
      },
    ],
    keyElements: [],
  },
  testData: [{ name: 'valid_credentials' }],
};

describe('validateCanonicalTestCases — coverage is never reduced', () => {
  it('returns EXACTLY the same number of cases it was given, always', () => {
    const cases = [makeCase(), makeCase({ scenarioId: 'auth-neg-wrong-password' })];
    const { cases: out } = validateCanonicalTestCases(cases, KNOWLEDGE);
    expect(out).toHaveLength(2);
  });

  it('never mutates the caller-supplied cases (works on clones)', () => {
    const original = makeCase({ expectedResult: '' });
    const before = JSON.stringify(original);
    validateCanonicalTestCases([original], KNOWLEDGE);
    expect(JSON.stringify(original)).toBe(before);
  });

  it('passes a fully-valid, fully-grounded case with no errors', () => {
    const { report } = validateCanonicalTestCases([makeCase()], KNOWLEDGE);
    expect(report.ok).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.checked).toBe(1);
  });
});

describe('validateCanonicalTestCases — deterministic repairs', () => {
  it('fills an empty expected result from the objective (repair, not drop)', () => {
    const { cases, report } = validateCanonicalTestCases(
      [makeCase({ expectedResult: '   ', objective: 'Login must succeed.' })],
      KNOWLEDGE,
    );
    expect(cases[0].expectedResult).toBe('Login must succeed.');
    expect(report.repaired).toBeGreaterThan(0);
    expect(report.issues.some(i => i.check === 'expected' && i.repaired)).toBe(true);
  });

  it('removes exact-duplicate steps but keeps order and the first occurrence', () => {
    const dupSteps = [
      'Navigate to https://app.example.com/login',
      'Enter a valid email (#email)',
      'Enter a valid email (#email)',
      'Click the submit control (#login-btn)',
    ];
    const { cases, report } = validateCanonicalTestCases([makeCase({ steps: dupSteps })], KNOWLEDGE);
    expect(cases[0].steps).toEqual([
      'Navigate to https://app.example.com/login',
      'Enter a valid email (#email)',
      'Click the submit control (#login-btn)',
    ]);
    expect(report.issues.some(i => i.check === 'duplicateSteps' && i.repaired)).toBe(true);
  });

  it('de-collides duplicate scenarioIds instead of dropping the second case', () => {
    const cases = [makeCase(), makeCase()]; // same id twice
    const { cases: out, report } = validateCanonicalTestCases(cases, KNOWLEDGE);
    expect(out).toHaveLength(2);
    expect(out[0].scenarioId).toBe('auth-pos-valid');
    expect(out[1].scenarioId).toBe('auth-pos-valid#2');
    expect(report.issues.some(i => i.check === 'uniqueId' && i.repaired)).toBe(true);
  });

  it('inserts a skeleton step when a case has none', () => {
    const { cases, report } = validateCanonicalTestCases([makeCase({ steps: [], selectors: [] })], KNOWLEDGE);
    expect(cases[0].steps.length).toBeGreaterThan(0);
    expect(report.issues.some(i => i.check === 'steps' && i.repaired)).toBe(true);
  });
});

describe('validateCanonicalTestCases — grounding warnings (never errors)', () => {
  it('warns when a selector is not found in the App Profile, but keeps the case', () => {
    const { cases, report } = validateCanonicalTestCases(
      [makeCase({ selectors: ['#email', '#ghost-field'] })],
      KNOWLEDGE,
    );
    expect(cases).toHaveLength(1);
    expect(report.errors).toBe(0);
    expect(report.issues.some(i => i.check === 'selector' && i.severity === 'warn')).toBe(true);
  });

  it('warns when the referenced dataset is not in the retrieved Test Data', () => {
    const { report } = validateCanonicalTestCases(
      [makeCase({ testData: 'ghost_dataset (keys: x)' })],
      KNOWLEDGE,
    );
    expect(report.issues.some(i => i.check === 'dataset' && i.severity === 'warn')).toBe(true);
  });

  it('warns when a navigation target is not among the App Profile pages', () => {
    const { report } = validateCanonicalTestCases(
      [makeCase({ steps: ['Navigate to https://app.example.com/nowhere', 'Click the submit control (#login-btn)'] })],
      KNOWLEDGE,
    );
    expect(report.issues.some(i => i.check === 'page' && i.severity === 'warn')).toBe(true);
  });

  it('fails open: no App Profile means no grounding warnings at all', () => {
    const { cases, report } = validateCanonicalTestCases([makeCase({ selectors: ['#anything'] })], undefined);
    expect(cases).toHaveLength(1);
    expect(report.issues.some(i => i.check === 'selector')).toBe(false);
  });
});
