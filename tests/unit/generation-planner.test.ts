/**
 * Coverage Intelligence · Sprint CI-3 — Generation Planning
 * Unit tests. Deterministic routing on top of CI-1.
 */

import {
  buildGenerationPlan,
  formatGenerationPlan,
  GenerationPlan,
} from '../../src/coverage-intelligence/generation-planner';
import { GenerationDecision } from '../../src/coverage-intelligence/types';
import type { ScenarioLike } from '../../src/coverage-intelligence/existing-test-discovery';
import type { RepositoryProfile } from '../../src/context/types';

/* ------------------------------------------------------------------ */
/*  A minimal profile for routing tests                                */
/* ------------------------------------------------------------------ */

const profile = {
  testSuites: [
    {
      name: 'login',
      filePath: 'tests/login/locked-user.spec.ts',
      testCount: 1,
      testNames: ['locked out user cannot login'],
      describeName: 'Login',
      tags: ['auth', 'negative'],
      category: 'auth',
    },
    {
      name: 'login',
      filePath: 'tests/login/valid-login.spec.ts',
      testCount: 1,
      testNames: ['valid login succeeds'],
      describeName: 'Login',
      tags: ['auth'],
      category: 'auth',
    },
  ],
  businessFlows: [],
} as unknown as RepositoryProfile;

/* ------------------------------------------------------------------ */
/*  buildGenerationPlan                                                */
/* ------------------------------------------------------------------ */

describe('buildGenerationPlan', () => {
  it('routes scenarios into the three buckets (reuse, extend, generate)', () => {
    const scenarios: ScenarioLike[] = [
      { id: 's1', title: 'Locked account cannot log in' },
      { id: 's2', title: 'Valid credentials log in successfully' },
      { id: 's3', title: 'Session timeout after login' },
      { id: 's4', title: 'Password reset flow' },
    ];

    const plan = buildGenerationPlan(scenarios, profile);

    // At least one reuse (locked user matches), at least one generate (session timeout/password reset)
    expect(plan.skip.length).toBeGreaterThanOrEqual(1);
    expect(plan.generate.length).toBeGreaterThanOrEqual(1);

    // Total planned = sum of buckets
    const total = plan.skip.length + plan.extend.length + plan.generate.length;
    expect(total).toBe(scenarios.length);

    // generationQueue = extend + generate
    expect(plan.generationQueue.length).toBe(plan.extend.length + plan.generate.length);
  });

  it('returns empty buckets for an empty input', () => {
    const plan = buildGenerationPlan([], profile);
    expect(plan.skip.length).toBe(0);
    expect(plan.extend.length).toBe(0);
    expect(plan.generate.length).toBe(0);
    expect(plan.generationQueue.length).toBe(0);
  });

  it('returns all generate when the profile is empty (no existing tests)', () => {
    const scenarios: ScenarioLike[] = [
      { id: 's1', title: 'Locked account cannot log in' },
      { id: 's2', title: 'Session timeout after login' },
    ];

    const plan = buildGenerationPlan(scenarios, {
      testSuites: [],
      businessFlows: [],
    } as unknown as RepositoryProfile);

    expect(plan.skip.length).toBe(0);
    expect(plan.extend.length).toBe(0);
    expect(plan.generate.length).toBe(2);
    expect(plan.generationQueue.length).toBe(2);
  });

  it('every item in the plan has a scenario + coverage', () => {
    const scenarios: ScenarioLike[] = [
      { id: 's1', title: 'Locked account cannot log in' },
      { id: 's2', title: 'Session timeout after login' },
    ];

    const plan = buildGenerationPlan(scenarios, profile);
    const allItems = [...plan.skip, ...plan.extend, ...plan.generate];

    for (const item of allItems) {
      expect(item.scenario).toBeDefined();
      expect(item.scenario.id).toBeTruthy();
      expect(item.coverage).toBeDefined();
      expect(item.coverage.recommendation).toBeDefined();
    }
  });

  it('generationQueue contains only extend + generate (never reuse)', () => {
    const scenarios: ScenarioLike[] = [
      { id: 's1', title: 'Locked account cannot log in' },
      { id: 's2', title: 'Valid credentials log in successfully' },
      { id: 's3', title: 'Session timeout after login' },
    ];

    const plan = buildGenerationPlan(scenarios, profile);

    // generationQueue must not contain any skip items
    for (const item of plan.generationQueue) {
      expect(item.coverage.recommendation).not.toBe(GenerationDecision.SKIP);
    }

    // generationQueue is exactly extend + generate
    const expectedQueue = [...plan.extend, ...plan.generate];
    expect(plan.generationQueue.length).toBe(expectedQueue.length);
  });
});

/* ------------------------------------------------------------------ */
/*  formatGenerationPlan                                               */
/* ------------------------------------------------------------------ */

describe('formatGenerationPlan', () => {
  it('renders the simple summary format', () => {
    const plan: GenerationPlan = {
      skip: [
        {
          scenario: { id: 's1', title: 'A' },
          coverage: {
            scenarioId: 's1',
            scenario: 'A',
            status: 'existing',
            confidence: 85,
            existingTest: 'a',
            recommendation: GenerationDecision.SKIP,
            matchedOn: [],
            reason: '',
            alternatives: [],
          },
        },
      ],
      extend: [
        {
          scenario: { id: 's2', title: 'B' },
          coverage: {
            scenarioId: 's2',
            scenario: 'B',
            status: 'partial',
            confidence: 50,
            existingTest: 'b',
            recommendation: GenerationDecision.EXTEND,
            matchedOn: [],
            reason: '',
            alternatives: [],
          },
        },
      ],
      generate: [
        {
          scenario: { id: 's3', title: 'C' },
          coverage: {
            scenarioId: 's3',
            scenario: 'C',
            status: 'missing',
            confidence: 0,
            existingTest: null,
            recommendation: GenerationDecision.GENERATE,
            matchedOn: [],
            reason: '',
            alternatives: [],
          },
        },
        {
          scenario: { id: 's4', title: 'D' },
          coverage: {
            scenarioId: 's4',
            scenario: 'D',
            status: 'missing',
            confidence: 0,
            existingTest: null,
            recommendation: GenerationDecision.GENERATE,
            matchedOn: [],
            reason: '',
            alternatives: [],
          },
        },
      ],
      generationQueue: [],
    };
    plan.generationQueue = [...plan.extend, ...plan.generate];

    const text = formatGenerationPlan(plan);
    expect(text).toContain('Generation Plan');
    expect(text).toContain('  4 Planned');
    expect(text).toContain('  1 Skip');
    expect(text).toContain('  1 Extend');
    expect(text).toContain('  2 Generate');
    expect(text).toContain('  3 In Generation Queue');
  });

  it('renders zeros for an empty plan', () => {
    const plan: GenerationPlan = {
      skip: [],
      extend: [],
      generate: [],
      generationQueue: [],
    };

    const text = formatGenerationPlan(plan);
    expect(text).toContain('  0 Planned');
    expect(text).toContain('  0 Skip');
    expect(text).toContain('  0 Extend');
    expect(text).toContain('  0 Generate');
    expect(text).toContain('  0 In Generation Queue');
  });
});
