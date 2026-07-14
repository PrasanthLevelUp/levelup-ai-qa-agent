/**
 * Coverage Intelligence · Sprint CI-1 — Existing Test Discovery
 * Unit tests. Deterministic, no LLM, no network. The fixtures below mirror a
 * real SauceDemo-style Playwright suite so the assertions exercise the same
 * kind of prose the engine will see in production.
 */

import {
  discoverExistingTests,
  discoverForScenario,
  extractCandidates,
  tokenize,
  formatDiscovery,
  TfidfCosineScorer,
  ScenarioLike,
  ExistingTestCandidate,
} from '../../src/coverage-intelligence/existing-test-discovery';
import { CoverageDecision } from '../../src/coverage-intelligence/types';
import type { RepositoryProfile } from '../../src/context/types';

/* ------------------------------------------------------------------ */
/*  A realistic SauceDemo-style profile (only the fields CI-1 reads).  */
/* ------------------------------------------------------------------ */

const profile = {
  testSuites: [
    {
      name: 'login',
      filePath: 'tests/login/locked-user.spec.ts',
      testCount: 1,
      testNames: ['locked out user cannot login and sees an error'],
      describeName: 'Login — locked out user',
      tags: ['auth', 'negative'],
      category: 'auth',
    },
    {
      name: 'login',
      filePath: 'tests/login/valid-login.spec.ts',
      testCount: 2,
      testNames: [
        'standard user logs in with valid credentials',
        'user lands on the inventory page after login',
      ],
      describeName: 'Login — happy path',
      tags: ['auth'],
      category: 'auth',
    },
    {
      name: 'login',
      filePath: 'tests/login/invalid-login.spec.ts',
      testCount: 1,
      testNames: ['invalid password is rejected with an error message'],
      describeName: 'Login — invalid credentials',
      tags: ['auth', 'negative'],
      category: 'auth',
    },
    {
      name: 'cart',
      filePath: 'tests/cart/add-to-cart.spec.ts',
      testCount: 1,
      testNames: ['add a product to the cart from the inventory list'],
      describeName: 'Cart',
      tags: ['cart'],
      category: 'crud',
    },
  ],
  businessFlows: [
    {
      name: 'Checkout Flow',
      steps: ['add item to cart', 'go to checkout', 'enter info', 'finish'],
      relatedFiles: ['tests/checkout/checkout.spec.ts'],
      relatedHelpers: [],
      entryUrl: null,
      category: 'payment',
    },
  ],
} as unknown as RepositoryProfile;

/* ------------------------------------------------------------------ */
/*  tokenize + synonym canonicalization                                */
/* ------------------------------------------------------------------ */

describe('tokenize', () => {
  it('canonicalizes auth synonyms (sign in / log in / login)', () => {
    expect(tokenize('Sign in page')).toContain('login');
    expect(tokenize('User can log in')).toContain('login');
    expect(tokenize('Successful login')).toContain('login');
  });

  it('collapses multi-word phrases (locked out, session timeout)', () => {
    expect(tokenize('locked out user')).toContain('locked');
    expect(tokenize('session timeout after login')).toContain('timeout');
    expect(tokenize('non-existent account')).toContain('unknown');
  });

  it('splits camelCase and paths into terms', () => {
    const toks = tokenize('tests/login/lockedUser.spec.ts');
    expect(toks).toContain('locked');
    expect(toks).toContain('user');
  });

  it('drops stopwords and noise', () => {
    const toks = tokenize('the user should be able to verify this');
    expect(toks).not.toContain('the');
    expect(toks).not.toContain('should');
    expect(toks).not.toContain('verify');
  });
});

/* ------------------------------------------------------------------ */
/*  extractCandidates                                                  */
/* ------------------------------------------------------------------ */

describe('extractCandidates', () => {
  it('flattens every test name plus business flows into candidates', () => {
    const cands = extractCandidates(profile);
    // 1 + 2 + 1 + 1 test names = 5, plus 1 business flow = 6
    expect(cands.length).toBe(6);
    expect(cands.filter((c) => c.source === 'test').length).toBe(5);
    expect(cands.filter((c) => c.source === 'business-flow').length).toBe(1);
    const ref = cands.find((c) => c.testName.includes('locked out'))?.ref;
    expect(ref).toBe(
      'tests/login/locked-user.spec.ts :: locked out user cannot login and sees an error',
    );
  });

  it('returns [] for an empty profile', () => {
    expect(extractCandidates({ testSuites: [], businessFlows: [] } as unknown as RepositoryProfile))
      .toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/*  ACCEPTANCE CRITERIA — the founder's demo cases                     */
/* ------------------------------------------------------------------ */

describe('acceptance criteria', () => {
  it('"Locked / disabled account cannot log in" → EXISTING / reuse, points to locked-user.spec.ts', () => {
    const scenario: ScenarioLike = {
      id: 'auth-neg-locked-user',
      title: 'Locked / disabled account cannot log in',
      objective: 'A user whose account is locked is prevented from logging in and shown an error.',
      coverageType: 'negative',
      riskArea: 'auth',
    };
    const [res] = discoverExistingTests([scenario], profile);
    expect(res.status).toBe('existing');
    expect(res.recommendation).toBe(CoverageDecision.REUSE);
    expect(res.existingTest).toContain('tests/login/locked-user.spec.ts');
    expect(res.confidence).toBeGreaterThanOrEqual(72);
    expect(res.matchedOn).toContain('locked');
  });

  it('"Session timeout after login" → MISSING / generate, no existing test', () => {
    const scenario: ScenarioLike = {
      id: 'auth-session-timeout',
      title: 'Session timeout after login',
      objective: 'After a period of inactivity the session expires and the user must re-authenticate.',
      coverageType: 'negative',
      riskArea: 'auth',
    };
    const [res] = discoverExistingTests([scenario], profile);
    expect(res.status).toBe('missing');
    expect(res.recommendation).toBe(CoverageDecision.GENERATE);
    expect(res.existingTest).toBeNull();
    expect(res.confidence).toBeLessThan(40);
  });
});

/* ------------------------------------------------------------------ */
/*  Polarity guard — the honesty feature                               */
/* ------------------------------------------------------------------ */

describe('polarity guard', () => {
  it('a positive scenario is NOT reported as reuse of a negative test', () => {
    const scenario: ScenarioLike = {
      id: 'auth-pos-valid-login',
      title: 'Valid credentials log in successfully',
      objective: 'A standard user with valid credentials logs in and reaches the inventory page.',
      coverageType: 'positive',
      riskArea: 'auth',
    };
    const [res] = discoverExistingTests([scenario], profile);
    // There IS a matching positive test, so this should be existing/reuse and
    // must point at the valid-login spec, never the invalid/locked ones.
    expect(res.existingTest).toContain('valid-login.spec.ts');
    expect(res.status).toBe('existing');
  });

  it('a negative scenario with no positive-safe match is capped below reuse', () => {
    // "Invalid username shows error" shares polarity with invalid-login, so it
    // reuses. But a NEGATIVE scenario matched only against a POSITIVE candidate
    // must be capped to extend, never reuse.
    const cands: ExistingTestCandidate[] = [
      {
        ref: 'tests/login/valid-login.spec.ts :: valid login succeeds',
        filePath: 'tests/login/valid-login.spec.ts',
        testName: 'valid login succeeds',
        suiteName: 'login',
        category: 'auth',
        tags: [],
        source: 'test',
      },
    ];
    const scenario: ScenarioLike = {
      id: 'neg',
      title: 'Invalid login is rejected',
      coverageType: 'negative',
    };
    const res = discoverForScenario(
      scenario,
      cands,
      cands.map((c) => tokenize(`${c.testName}`)),
      { existingThreshold: 0.72, partialThreshold: 0.4, maxAlternatives: 3, scorer: new TfidfCosineScorer() },
    );
    expect(res.recommendation).not.toBe(CoverageDecision.REUSE);
  });
});

/* ------------------------------------------------------------------ */
/*  Batch behaviour + edge cases                                       */
/* ------------------------------------------------------------------ */

describe('discoverExistingTests (batch)', () => {
  it('returns one result per scenario, in input order', () => {
    const scenarios: ScenarioLike[] = [
      { id: 's1', title: 'Locked account cannot log in' },
      { id: 's2', title: 'Add a product to the cart' },
      { id: 's3', title: 'Session timeout after login' },
    ];
    const results = discoverExistingTests(scenarios, profile);
    expect(results.map((r) => r.scenarioId)).toEqual(['s1', 's2', 's3']);
    expect(results[1].existingTest).toContain('add-to-cart.spec.ts');
  });

  it('every scenario is MISSING/generate when the repo has no tests', () => {
    const scenarios: ScenarioLike[] = [
      { id: 's1', title: 'Locked account cannot log in' },
      { id: 's2', title: 'Add a product to the cart' },
    ];
    const results = discoverExistingTests(scenarios, {
      testSuites: [],
      businessFlows: [],
    } as unknown as RepositoryProfile);
    expect(results.every((r) => r.status === 'missing' && r.recommendation === CoverageDecision.GENERATE)).toBe(true);
    expect(results.every((r) => r.confidence === 0)).toBe(true);
  });

  it('handles a null profile without throwing', () => {
    const results = discoverExistingTests([{ id: 's1', title: 'anything' }], null);
    expect(results[0].status).toBe('missing');
  });

  it('matches a scenario against a business flow when no per-test title fits', () => {
    const [res] = discoverExistingTests(
      [{ id: 'flow', title: 'Complete checkout flow' }],
      profile,
    );
    expect(res.existingTest).toContain('checkout');
  });
});

/* ------------------------------------------------------------------ */
/*  formatDiscovery render                                             */
/* ------------------------------------------------------------------ */

describe('formatDiscovery', () => {
  it('renders a readable block with status, confidence and recommendation', () => {
    const results = discoverExistingTests(
      [
        { id: 's1', title: 'Locked account cannot log in' },
        { id: 's2', title: 'Session timeout after login' },
      ],
      profile,
    );
    const text = formatDiscovery(results);
    expect(text).toContain('Existing Test Discovery');
    expect(text).toMatch(/EXISTING|MISSING|PARTIAL/);
    expect(text).toMatch(/REUSE|GENERATE|EXTEND/);
  });
});
