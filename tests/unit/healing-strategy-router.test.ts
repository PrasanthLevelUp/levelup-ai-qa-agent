import { routeHealingStrategy } from '../../src/core/healing-strategy-router';
import type { FailureDiagnosis, FailureCategory } from '../../src/core/failure-classifier';

function diag(overrides: Partial<FailureDiagnosis> = {}): FailureDiagnosis {
  return {
    category: 'locator' as FailureCategory,
    confidence: 0.85,
    locator: '#login-button',
    locatorResolvedFromPageObject: false,
    file: '/repo/tests/login.spec.ts',
    line: 42,
    action: 'click',
    waitingFor: null,
    expected: null,
    actual: null,
    rootCause: 'x',
    recommendedAction: 'y',
    healableByLocatorSwap: true,
    evidence: [],
    recommendedStrategy: 'locator_swap',
    evidenceBased: false,
    ...overrides,
  };
}

describe('routeHealingStrategy', () => {
  it('routes a healable locator failure to locator_swap', () => {
    const plan = routeHealingStrategy(diag());
    expect(plan.remedy).toBe('locator_swap');
    expect(plan.shouldAttemptLocatorHealing).toBe(true);
    expect(plan.reportOnly).toBe(false);
  });

  it('routes a locator failure WITHOUT a concrete locator to report_only (the bug fix)', () => {
    const plan = routeHealingStrategy(
      diag({ locator: null, healableByLocatorSwap: false, confidence: 0.5 }),
    );
    expect(plan.remedy).toBe('report_only');
    expect(plan.shouldAttemptLocatorHealing).toBe(false);
    expect(plan.reportOnly).toBe(true);
  });

  it('routes a timing failure to inject_wait (never changes the locator)', () => {
    const plan = routeHealingStrategy(
      diag({ category: 'timing', healableByLocatorSwap: false, confidence: 0.7, locator: null }),
    );
    expect(plan.remedy).toBe('inject_wait');
    expect(plan.shouldAttemptLocatorHealing).toBe(false);
  });

  it('honors an evidence-driven wait_for_overlay strategy on a timing failure', () => {
    const plan = routeHealingStrategy(
      diag({
        category: 'timing',
        healableByLocatorSwap: false,
        confidence: 0.95,
        recommendedStrategy: 'wait_for_overlay',
        evidenceBased: true,
      }),
    );
    expect(plan.remedy).toBe('inject_wait');
    expect(plan.recommendedStrategy).toBe('wait_for_overlay');
    expect(plan.shouldAttemptLocatorHealing).toBe(false);
  });

  it('never swaps a locator on a timing failure even if the strategy says locator_swap', () => {
    const plan = routeHealingStrategy(
      diag({ category: 'timing', confidence: 0.9, recommendedStrategy: 'locator_swap' }),
    );
    expect(plan.shouldAttemptLocatorHealing).toBe(false);
    expect(plan.remedy).toBe('inject_wait');
  });

  it.each<FailureCategory>(['assertion', 'navigation', 'api', 'environment', 'framework', 'unknown'])(
    'routes %s failures to report_only',
    (category) => {
      const plan = routeHealingStrategy(
        diag({ category, healableByLocatorSwap: false, confidence: 0.8, locator: null }),
      );
      expect(plan.remedy).toBe('report_only');
      expect(plan.shouldAttemptLocatorHealing).toBe(false);
      expect(plan.reportOnly).toBe(true);
    },
  );

  it('degrades a low-confidence non-locator diagnosis to report_only', () => {
    const plan = routeHealingStrategy(
      diag({ category: 'timing', confidence: 0.2, healableByLocatorSwap: false, locator: null }),
    );
    expect(plan.remedy).toBe('report_only');
  });

  it('still attempts locator healing for a high-confidence locator diagnosis even at lower confidence floor', () => {
    const plan = routeHealingStrategy(diag({ confidence: 0.82 }));
    expect(plan.shouldAttemptLocatorHealing).toBe(true);
  });
});
