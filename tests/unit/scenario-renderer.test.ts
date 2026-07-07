/**
 * PHASE B — Renderer Tests
 *
 * Validate that each renderer is a pure projection: same canonical scenario →
 * different format-specific outputs. No intelligence, no LLM, no side effects.
 */

import {
  ManualRenderer,
  ScriptRenderer,
  BDDRenderer,
  RendererRegistry,
  type CanonicalScenario,
  type ManualTestCase,
  type ScriptTestCase,
  type BDDTestCase,
} from '../../src/renderers/scenario-renderer';

/* ──────────────────────────────────────────────────────────────────────── */
/*  Fixture — canonical scenario (schemaVersion: 2)                          */
/* ──────────────────────────────────────────────────────────────────────── */

const CANONICAL_SCENARIO: CanonicalScenario = {
  schemaVersion: 2,
  title: 'Valid credentials log in successfully',
  objective: 'A registered user with correct credentials is authenticated and lands in the authenticated area.',
  scenarioIndex: 0,
  scenarioId: 'auth-pos-valid',
  riskArea: 'authentication',
  preconditions: 'The application is reachable at https://app.example.com/login; the "standard_user" test-data set is available.',
  steps: [
    'Navigate to the page under test',
    'Enter a valid Email in the Email field',
    'Enter a valid Password in the Password field',
    'Click the Submit button',
  ],
  grounding: [
    { stepIndex: 1, page: 'https://app.example.com/login' },
    { stepIndex: 2, selector: '#email', page: 'https://app.example.com/login', control: 'Email' },
    { stepIndex: 3, selector: '#password', page: 'https://app.example.com/login', control: 'Password' },
    { stepIndex: 4, selector: '#login-btn', page: 'https://app.example.com/login', control: 'Submit' },
  ],
  expected: {
    observable: 'The action succeeds and the user reaches the expected next state (e.g. the "Logout" area is visible).',
    business: 'A registered user with correct credentials is authenticated and lands in the authenticated area.',
    technical: { selector: '#logout-btn', page: 'https://app.example.com/home' },
  },
  expectedResult: 'The action succeeds and the user reaches the expected next state (e.g. the "Logout" area is visible).',
  testData: 'standard_user (keys: email, password)',
  selectors: ['#email', '#password', '#login-btn', '#logout-btn'],
  priority: 'P0',
  severity: 'critical',
  tags: ['authentication', 'positive'],
  automationReady: true,
  automationComplexity: 'low',
  selectorAvailability: 'high',
  source: 'app_profile',
  sourceEvidence: 'Real selectors from https://app.example.com/login',
};

/* ──────────────────────────────────────────────────────────────────────── */
/*  Manual Renderer Tests                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

describe('ManualRenderer — business projection only', () => {
  const renderer = new ManualRenderer();

  it('projects the canonical scenario into a clean, business-readable test case', () => {
    const manual: ManualTestCase = renderer.render(CANONICAL_SCENARIO);

    expect(manual.title).toBe('Valid credentials log in successfully');
    expect(manual.objective).toBe(
      'A registered user with correct credentials is authenticated and lands in the authenticated area.'
    );
    expect(manual.preconditions).toContain('https://app.example.com/login');
    expect(manual.steps).toEqual([
      'Navigate to the page under test',
      'Enter a valid Email in the Email field',
      'Enter a valid Password in the Password field',
      'Click the Submit button',
    ]);
    // Observable expected — NOT "Observe and verify the outcome"
    expect(manual.expected).toBe(
      'The action succeeds and the user reaches the expected next state (e.g. the "Logout" area is visible).'
    );
    expect(manual.priority).toBe('P0');
    expect(manual.severity).toBe('critical');
  });

  it('does NOT expose technical grounding (selectors are hidden from manual QA)', () => {
    const manual: ManualTestCase = renderer.render(CANONICAL_SCENARIO);

    // Steps are business-readable — no selectors in the prose
    const stepsText = manual.steps.join(' ');
    expect(stepsText).not.toContain('#email');
    expect(stepsText).not.toContain('#password');
    expect(stepsText).not.toContain('#login-btn');

    // Expected is observable — no technical selector
    expect(manual.expected).not.toContain('#logout-btn');
  });

  it('falls back to expectedResult when expected.observable is absent (v1 compat)', () => {
    const legacy: CanonicalScenario = {
      ...CANONICAL_SCENARIO,
      expected: undefined,
      expectedResult: 'Login successful',
    };
    const manual = renderer.render(legacy);
    expect(manual.expected).toBe('Login successful');
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/*  Script Renderer Tests                                                    */
/* ──────────────────────────────────────────────────────────────────────── */

describe('ScriptRenderer — technical projection only', () => {
  const renderer = new ScriptRenderer();

  it('projects the canonical scenario into a grounded automation case', () => {
    const script: ScriptTestCase = renderer.render(CANONICAL_SCENARIO);

    expect(script.title).toBe('Valid credentials log in successfully');
    expect(script.grounding.length).toBe(4);

    // Grounding carries the selectors aligned by stepIndex
    const emailGrounding = script.grounding.find(g => g.stepIndex === 2);
    expect(emailGrounding?.selector).toBe('#email');
    expect(emailGrounding?.page).toBe('https://app.example.com/login');
    expect(emailGrounding?.control).toBe('Email');

    // Technical expected: the automation post-condition
    expect(script.expectedTechnical?.selector).toBe('#logout-btn');
    expect(script.expectedTechnical?.page).toBe('https://app.example.com/home');
  });

  it('keeps business steps as context (for readable code comments)', () => {
    const script: ScriptTestCase = renderer.render(CANONICAL_SCENARIO);

    expect(script.steps).toEqual([
      'Navigate to the page under test',
      'Enter a valid Email in the Email field',
      'Enter a valid Password in the Password field',
      'Click the Submit button',
    ]);
  });

  it('handles scenarios with partial grounding gracefully', () => {
    const partial: CanonicalScenario = {
      ...CANONICAL_SCENARIO,
      grounding: [
        { stepIndex: 1, page: 'https://app.example.com/login' },
        { stepIndex: 2, selector: '#email' },
      ],
    };
    const script = renderer.render(partial);
    expect(script.grounding.length).toBe(2);
    expect(script.grounding[1].selector).toBe('#email');
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/*  BDD Renderer Tests                                                       */
/* ──────────────────────────────────────────────────────────────────────── */

describe('BDDRenderer — Gherkin projection', () => {
  const renderer = new BDDRenderer();

  it('projects the canonical scenario into Gherkin-style Given/When/Then', () => {
    const bdd: BDDTestCase = renderer.render(CANONICAL_SCENARIO);

    expect(bdd.scenario).toBe('Valid credentials log in successfully');
    expect(bdd.steps.length).toBe(4);

    // First navigation step → Given
    expect(bdd.steps[0].type).toBe('Given');
    expect(bdd.steps[0].text).toBe('Navigate to the page under test');

    // Action steps → When
    expect(bdd.steps[1].type).toBe('When');
    expect(bdd.steps[1].text).toContain('Email');

    // Expected → Then (separate field, not a step)
    expect(bdd.expected).toBe(
      'The action succeeds and the user reaches the expected next state (e.g. the "Logout" area is visible).'
    );
  });

  it('infers Given from navigation keywords', () => {
    const withOpen: CanonicalScenario = {
      ...CANONICAL_SCENARIO,
      steps: ['Open the application', 'Enter credentials', 'Submit the form'],
    };
    const bdd = renderer.render(withOpen);
    expect(bdd.steps[0].type).toBe('Given');
    expect(bdd.steps[0].text).toBe('Open the application');
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/*  Renderer Registry Tests                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

describe('RendererRegistry — single point of access', () => {
  it('returns the correct renderer for each format', () => {
    expect(RendererRegistry.get('manual')).toBeInstanceOf(ManualRenderer);
    expect(RendererRegistry.get('script')).toBeInstanceOf(ScriptRenderer);
    expect(RendererRegistry.get('bdd')).toBeInstanceOf(BDDRenderer);
  });

  it('throws for unknown format', () => {
    expect(() => RendererRegistry.get('unknown' as any)).toThrow('Unknown renderer format: unknown');
  });

  it('renders via the registry shortcut', () => {
    const manual = RendererRegistry.render<ManualTestCase>(CANONICAL_SCENARIO, 'manual');
    expect(manual.title).toBe('Valid credentials log in successfully');
    expect(manual.steps.length).toBe(4);

    const script = RendererRegistry.render<ScriptTestCase>(CANONICAL_SCENARIO, 'script');
    expect(script.grounding.length).toBe(4);
  });
});

/* ──────────────────────────────────────────────────────────────────────── */
/*  Cross-renderer invariants — Phase B contract                             */
/* ──────────────────────────────────────────────────────────────────────── */

describe('Cross-renderer invariants — Separate DATA, not PIPELINES', () => {
  it('all renderers consume the SAME canonical scenario (no duplicate source)', () => {
    const manual = new ManualRenderer().render(CANONICAL_SCENARIO);
    const script = new ScriptRenderer().render(CANONICAL_SCENARIO);
    const bdd = new BDDRenderer().render(CANONICAL_SCENARIO);

    // All three consumed the same input; they just projected different fields
    expect(manual.title).toBe(CANONICAL_SCENARIO.title);
    expect(script.title).toBe(CANONICAL_SCENARIO.title);
    expect(bdd.scenario).toBe(CANONICAL_SCENARIO.title);
  });

  it('Manual shows business projection; Script shows technical projection', () => {
    const manual = new ManualRenderer().render(CANONICAL_SCENARIO);
    const script = new ScriptRenderer().render(CANONICAL_SCENARIO);

    // Manual: business steps, observable expected (no selectors)
    expect(manual.steps.join(' ')).not.toContain('#email');
    expect(manual.expected).toContain('succeeds');

    // Script: grounding (selectors), technical expected
    expect(script.grounding.some(g => g.selector === '#email')).toBe(true);
    expect(script.expectedTechnical?.selector).toBe('#logout-btn');
  });

  it('renderers are PURE: same input → same output (no side effects)', () => {
    const manual1 = new ManualRenderer().render(CANONICAL_SCENARIO);
    const manual2 = new ManualRenderer().render(CANONICAL_SCENARIO);

    expect(manual1).toEqual(manual2);
  });
});
