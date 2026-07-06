/**
 * Unit tests for the QA-first Scenario Planner + QA Knowledge Engine.
 *
 * These modules are PURE + synchronous (zero LLM tokens), so the whole suite
 * runs offline. They only use `import type` from test-coverage-engine, so no
 * engine construction / API key is needed.
 *
 * Run with: npx jest tests/unit/scenario-planner.test.ts
 */

import {
  classifyQACategory,
  getBaselineScenarios,
  QA_KNOWLEDGE_BASE,
  QA_KNOWLEDGE_VERSION,
} from '../../src/engines/qa-knowledge-engine';
import {
  planScenarios,
  buildScenarioPlanBlock,
} from '../../src/engines/scenario-planner';
import type { CoverageType } from '../../src/engines/test-coverage-engine';

describe('QA Knowledge Engine — classifyQACategory', () => {
  it('classifies a login requirement as authentication', () => {
    const c = classifyQACategory({ title: 'User Login', description: 'User logs in with email and password.' });
    expect(c.category).toBe('authentication');
    expect(c.confidence).toBeGreaterThan(0);
    expect(c.matchedSignals.length).toBeGreaterThan(0);
  });

  it('classifies a payment requirement as payment (not checkout/crud)', () => {
    const c = classifyQACategory({ title: 'Process card payment', description: 'Charge the customer card and issue a refund on failure.' });
    expect(c.category).toBe('payment');
  });

  it('classifies a checkout requirement as checkout', () => {
    const c = classifyQACategory({ title: 'Checkout flow', description: 'User reviews cart, enters shipping, and places the order.' });
    expect(c.category).toBe('checkout');
  });

  it('classifies a search requirement as search', () => {
    const c = classifyQACategory({ title: 'Product search', description: 'User can search and filter and sort the catalog.' });
    expect(c.category).toBe('search');
  });

  it('classifies a create/edit form requirement as crud', () => {
    const c = classifyQACategory({ title: 'Manage contacts', description: 'Create, edit and delete a contact record via a form.' });
    expect(c.category).toBe('crud');
  });

  it('falls back to generic (confidence 0) for an unrecognised requirement', () => {
    const c = classifyQACategory({ title: 'Marketing banner colour', description: 'The homepage hero banner uses the brand teal.' });
    expect(c.category).toBe('generic');
    expect(c.confidence).toBe(0);
  });

  it('is deterministic — same input yields identical classification', () => {
    const input = { title: 'User Login', description: 'Login with email/password; lock after failed attempts.' };
    const a = classifyQACategory(input);
    const b = classifyQACategory(input);
    expect(a).toEqual(b);
  });

  it('a feature-type hint nudges an ambiguous requirement toward the aligned category', () => {
    // "manage" alone would lean crud/admin; the auth hint should pull it to authentication.
    const c = classifyQACategory(
      { title: 'Manage sign-in', description: 'Users sign in to the portal.' },
      'authentication',
    );
    expect(c.category).toBe('authentication');
  });
});

describe('QA Knowledge Engine — knowledge base integrity', () => {
  const validTypes: CoverageType[] = [
    'positive', 'negative', 'edge_cases', 'boundary', 'security', 'api', 'ui',
    'mobile', 'accessibility', 'performance', 'integration', 'regression',
    'cross_browser', 'data_validation', 'role_based', 'localization',
  ];

  it('exposes a KB version string', () => {
    expect(typeof QA_KNOWLEDGE_VERSION).toBe('string');
    expect(QA_KNOWLEDGE_VERSION.length).toBeGreaterThan(0);
  });

  it('every baseline scenario uses a valid CoverageType and has unique ids per category', () => {
    for (const [category, scenarios] of Object.entries(QA_KNOWLEDGE_BASE)) {
      const ids = new Set<string>();
      for (const s of scenarios) {
        expect(validTypes).toContain(s.coverageType);
        expect(s.title.length).toBeGreaterThan(0);
        expect(s.objective.length).toBeGreaterThan(0);
        expect(ids.has(s.id)).toBe(false);
        ids.add(s.id);
      }
      // Each category should carry a meaningful baseline.
      expect(scenarios.length).toBeGreaterThanOrEqual(5);
      // sanity: id prefixes shouldn't collide across categories in an obvious way
      expect(category.length).toBeGreaterThan(0);
    }
  });

  it('getBaselineScenarios returns [] for generic', () => {
    expect(getBaselineScenarios('generic')).toEqual([]);
  });
});

describe('Scenario Planner — planScenarios', () => {
  it('plans authentication scenarios for a login requirement', () => {
    const plan = planScenarios(
      { title: 'User Login', description: 'Login with email and password.' },
      ['positive', 'negative'],
    );
    expect(plan.classification.category).toBe('authentication');
    expect(plan.isEmpty).toBe(false);
    expect(plan.scenarios.length).toBeGreaterThan(0);
    // Must include the canonical valid-login + invalid-password obligations.
    const titles = plan.scenarios.map(s => s.title.toLowerCase());
    expect(titles.some(t => t.includes('valid credentials'))).toBe(true);
    expect(titles.some(t => t.includes('invalid password'))).toBe(true);
  });

  it('respects the user coverage selection — never plans a type the user did not pick (Priority 1)', () => {
    const selected: CoverageType[] = ['positive'];
    const plan = planScenarios(
      { title: 'User Login', description: 'Login with email and password.' },
      selected,
    );
    for (const s of plan.scenarios) {
      expect(selected).toContain(s.coverageType);
    }
    // security/negative scenarios must NOT appear when only positive is selected.
    expect(plan.scenarios.some(s => s.coverageType === 'security')).toBe(false);
    expect(plan.scenarios.some(s => s.coverageType === 'negative')).toBe(false);
  });

  it('flags conditional scenarios when their keywords are absent from the requirement', () => {
    // No mention of "remember me" / "logout" → those planned positive scenarios are conditional.
    const plan = planScenarios(
      { title: 'User Login', description: 'A user signs in with valid credentials.' },
      ['positive'],
    );
    const rememberMe = plan.scenarios.find(s => s.id === 'auth-pos-remember-me');
    expect(rememberMe).toBeDefined();
    expect(rememberMe!.conditional).toBe(true);
  });

  it('marks a conditional scenario as NOT conditional when its keyword is present', () => {
    const plan = planScenarios(
      { title: 'User Login', description: 'Login supports a remember-me option to persist the session.' },
      ['positive'],
    );
    const rememberMe = plan.scenarios.find(s => s.id === 'auth-pos-remember-me');
    expect(rememberMe).toBeDefined();
    expect(rememberMe!.conditional).toBe(false);
  });

  it('returns an empty plan for a generic (unrecognised) requirement', () => {
    const plan = planScenarios(
      { title: 'Homepage banner colour', description: 'Use the brand teal on the hero.' },
      ['positive', 'negative'],
    );
    expect(plan.classification.category).toBe('generic');
    expect(plan.isEmpty).toBe(true);
    expect(plan.scenarios).toEqual([]);
  });

  it('is pure/deterministic — same inputs yield an identical plan', () => {
    const input = { title: 'Checkout flow', description: 'Review cart, enter shipping, place order.' };
    const a = planScenarios(input, ['positive', 'negative', 'integration']);
    const b = planScenarios(input, ['positive', 'negative', 'integration']);
    expect(a).toEqual(b);
  });
});

describe('Scenario Planner — buildScenarioPlanBlock', () => {
  it('returns empty string for an empty plan (legacy fallback)', () => {
    const plan = planScenarios(
      { title: 'Homepage banner colour', description: 'Use the brand teal.' },
      ['positive'],
    );
    expect(buildScenarioPlanBlock(plan)).toBe('');
  });

  it('renders a plan block that instructs the LLM to EXPAND (not invent) and lists planned scenarios', () => {
    const plan = planScenarios(
      { title: 'User Login', description: 'Login with email and password; lock after failed attempts.' },
      ['positive', 'negative', 'security'],
    );
    const block = buildScenarioPlanBlock(plan);
    expect(block).toContain('DETERMINISTIC SCENARIO PLAN');
    expect(block).toContain('EXPAND');
    expect(block.toLowerCase()).toContain('valid credentials');
    // The category + confidence are surfaced for transparency.
    expect(block).toContain('authentication');
  });
});
