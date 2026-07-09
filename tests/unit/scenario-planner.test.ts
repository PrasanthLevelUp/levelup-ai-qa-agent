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
  getScenarioTier,
  recognizeScenarioEvidence,
  QA_KNOWLEDGE_BASE,
  QA_KNOWLEDGE_VERSION,
  type NormalizedEvidence,
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

describe('QA Knowledge Engine — getScenarioTier (KB owns obligation tiers)', () => {
  const auth = getBaselineScenarios('authentication');
  const tier = (id: string) => getScenarioTier(auth.find(s => s.id === id)!);

  it('classifies the happy-path as core', () => {
    expect(tier('auth-pos-valid')).toBe('core');
  });

  it('classifies category-universal obligations as mandatory (KB, not the Planner)', () => {
    // Invalid credentials + required fields are obligations of ANY credential
    // login — the KB flags them mandatory so they need no keyword evidence.
    expect(tier('auth-neg-wrong-password')).toBe('mandatory');
    expect(tier('auth-neg-empty-fields')).toBe('mandatory');
  });

  it('classifies mechanism-specific scenarios as conditional (need evidence)', () => {
    // Lockout, session, remember-me, injection, etc. depend on a specific
    // mechanism/option and must be justified by explicit evidence.
    expect(tier('auth-neg-locked-user')).toBe('conditional');
    expect(tier('auth-sec-injection')).toBe('conditional');
    expect(tier('auth-pos-logout')).toBe('conditional');
  });

  it('exactly one core scenario per category, and every scenario has a valid tier', () => {
    for (const scenarios of Object.values(QA_KNOWLEDGE_BASE)) {
      const cores = scenarios.filter(s => getScenarioTier(s) === 'core');
      expect(cores.length).toBe(1);
      for (const s of scenarios) {
        expect(['core', 'mandatory', 'conditional']).toContain(getScenarioTier(s));
      }
    }
  });

  it('authentication (the curated gold standard) has NO dead conditional scenarios', () => {
    // A conditional scenario with no recognition vocabulary could never be
    // emitted (dead scenario). This PR curates authentication so every one of
    // its conditional scenarios carries vocabulary; other categories are curated
    // in later sprints, so this invariant is scoped to authentication for now.
    for (const s of getBaselineScenarios('authentication')) {
      if (getScenarioTier(s) === 'conditional') {
        expect((s.conditionalOnKeywords || []).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('Knowledge layer — recognizeScenarioEvidence (owns vocabulary + matching)', () => {
  const EMPTY: NormalizedEvidence = {
    requirementText: '', requirementLabel: 'the requirement',
    acceptanceClauses: [], appKnowledge: '', testData: '',
  };
  const locked = getBaselineScenarios('authentication').find(s => s.id === 'auth-neg-locked-user')!;
  const bareValid = getBaselineScenarios('authentication').find(s => s.id === 'auth-pos-valid')!;

  it('returns [] when the evidence contains none of the scenario vocabulary (no invention)', () => {
    expect(recognizeScenarioEvidence(locked, EMPTY)).toEqual([]);
  });

  it('returns [] for a scenario with no recognition vocabulary (e.g. a core scenario)', () => {
    // auth-pos-valid is core and carries no conditionalOnKeywords, so the
    // Knowledge layer never recognises it from evidence — the Planner derives it
    // structurally instead.
    expect(recognizeScenarioEvidence(bareValid, {
      ...EMPTY, acceptanceClauses: ['Account is locked after 5 attempts'],
    })).toEqual([]);
  });

  it('matches an acceptance-criteria clause and cites it with a stable AC-n reference', () => {
    const ev: NormalizedEvidence = {
      ...EMPTY,
      acceptanceClauses: ['Valid users can log in', 'Account is locked after 5 failed attempts'],
    };
    const hits = recognizeScenarioEvidence(locked, ev);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].source).toBe('acceptanceCriteria');
    expect(hits[0].reference).toBe('AC-2');
    expect(hits[0].excerpt.toLowerCase()).toContain('locked after 5 failed');
  });

  it('matches test data and cites the dataset with a TD- reference', () => {
    const ev: NormalizedEvidence = { ...EMPTY, testData: 'locked_out_user username password' };
    const hits = recognizeScenarioEvidence(locked, ev);
    expect(hits.some(h => h.source === 'testData' && h.reference.startsWith('TD-'))).toBe(true);
  });

  it('is deterministic', () => {
    const ev: NormalizedEvidence = { ...EMPTY, acceptanceClauses: ['locked after failed attempts'] };
    expect(recognizeScenarioEvidence(locked, ev)).toEqual(recognizeScenarioEvidence(locked, ev));
  });
});

describe('Scenario Planner — planScenarios (single source of truth for existence)', () => {
  it('plans the core happy-path for a login requirement (derived from the Requirement)', () => {
    const plan = planScenarios(
      { title: 'User Login', description: 'Login with email and password.' },
      ['positive', 'negative'],
    );
    expect(plan.classification.category).toBe('authentication');
    expect(plan.isEmpty).toBe(false);
    // The core valid-login scenario is ALWAYS derived from the requirement.
    const valid = plan.scenarios.find(s => s.id === 'auth-pos-valid');
    expect(valid).toBeDefined();
    expect(valid!.provenance.source).toBe('Requirement');
    // Its evidence is a single requirement item with a REQ reference.
    expect(valid!.provenance.evidence).toHaveLength(1);
    expect(valid!.provenance.evidence[0].source).toBe('requirement');
    expect(valid!.provenance.evidence[0].reference).toBe('REQ');
  });

  it('mandatory KB obligations are grounded in the Requirement and named as category obligations', () => {
    const plan = planScenarios(
      { title: 'User Login', description: 'User can log in.' },
      ['negative'],
    );
    const invalidPw = plan.scenarios.find(s => s.id === 'auth-neg-wrong-password');
    expect(invalidPw).toBeDefined();
    // Justified by the Requirement establishing the category (no keyword evidence).
    expect(invalidPw!.provenance.source).toBe('Requirement');
    expect(invalidPw!.provenance.whyExists.toLowerCase()).toContain('authentication obligation');
    expect(invalidPw!.provenance.evidence).toHaveLength(1);
    expect(invalidPw!.provenance.evidence[0].source).toBe('requirement');
    expect(invalidPw!.provenance.evidence[0].reference).toBe('REQ');
    // Still no numeric confidence on the planner's provenance.
    expect((invalidPw!.provenance as any).confidence).toBeUndefined();
  });

  it('a bare requirement yields core + mandatory KB obligations, but NEVER conditional scenarios (no invention)', () => {
    // "user can log in successfully" with positive+negative+edge+security selected.
    // The KB obligations for authentication (valid login + invalid credentials +
    // required fields) ARE emitted — a senior QA writes them for any credential
    // login. But mechanism-specific CONDITIONAL scenarios (lockout, injection,
    // session, remember-me, whitespace, malformed identifier) must NOT appear
    // without explicit evidence — a coverage type never conjures them.
    const plan = planScenarios(
      { title: 'User Login', description: 'User can log in successfully.' },
      ['positive', 'negative', 'edge_cases', 'security'],
    );
    // core + the two mandatory obligations.
    expect(plan.scenarios.map(s => s.id).sort()).toEqual(
      ['auth-neg-empty-fields', 'auth-neg-wrong-password', 'auth-pos-valid'],
    );
    // Every emitted scenario is a core or mandatory obligation (no conditional).
    for (const s of plan.scenarios) {
      expect(['core', 'mandatory']).toContain(getScenarioTier(s));
    }
    // The conditional scenarios were NOT invented from the coverage type alone.
    const ids = new Set(plan.scenarios.map(s => s.id));
    for (const cond of ['auth-neg-locked-user', 'auth-sec-injection', 'auth-sec-session', 'auth-pos-logout']) {
      expect(ids.has(cond)).toBe(false);
    }
  });

  it('acceptance criteria justify a scenario and the provenance cites the exact clause', () => {
    const plan = planScenarios(
      {
        title: 'User Login',
        description: 'User can log in.',
        acceptanceCriteria: '- Valid users can log in\n- Account is locked after 5 failed attempts',
      },
      ['positive', 'negative', 'security'],
    );
    const locked = plan.scenarios.find(s => s.id === 'auth-neg-locked-user');
    expect(locked).toBeDefined();
    expect(locked!.provenance.source).toBe('Acceptance Criteria');
    // The citation quotes the AC clause that justified it.
    expect(locked!.provenance.derivedFrom.toLowerCase()).toContain('locked after 5 failed');
    // The planner emits FACTS (structured evidence), not a numeric confidence.
    // The highest-priority evidence item is the AC clause, with a stable AC-n ref.
    const acItem = locked!.provenance.evidence[0];
    expect(acItem.source).toBe('acceptanceCriteria');
    expect(acItem.reference).toMatch(/^AC-\d+$/);
    expect(acItem.excerpt.toLowerCase()).toContain('locked after 5 failed');
    expect(acItem.id.startsWith('auth-neg-locked-user')).toBe(true);
    // There is deliberately NO confidence on the planner's provenance.
    expect((locked!.provenance as any).confidence).toBeUndefined();
  });

  it('test data justifies a scenario via the Test Data evidence bucket', () => {
    const plan = planScenarios(
      { title: 'User Login', description: 'User can log in.' },
      ['positive', 'negative', 'security'],
      undefined,
      { testData: [{ name: 'locked_out_user', sampleKeys: ['username', 'password'] }] },
    );
    const locked = plan.scenarios.find(s => s.id === 'auth-neg-locked-user');
    expect(locked).toBeDefined();
    expect(locked!.provenance.source).toBe('Test Data');
    // Evidence carries a stable TD- reference into the originating dataset.
    const tdItem = locked!.provenance.evidence.find(e => e.source === 'testData');
    expect(tdItem).toBeDefined();
    expect(tdItem!.reference.startsWith('TD-')).toBe(true);
  });

  it('every planned scenario carries fully populated provenance {whyExists, source, derivedFrom, evidence[]}', () => {
    const plan = planScenarios(
      {
        title: 'User Login',
        description: 'User can log in.',
        acceptanceCriteria: '- Account is locked after repeated failed attempts',
      },
      ['positive', 'negative', 'security'],
    );
    expect(plan.scenarios.length).toBeGreaterThan(0);
    for (const s of plan.scenarios) {
      expect(s.provenance).toBeDefined();
      expect(typeof s.provenance.whyExists).toBe('string');
      expect(s.provenance.whyExists.length).toBeGreaterThan(0);
      expect(['Requirement', 'Acceptance Criteria', 'App Knowledge', 'Test Data'])
        .toContain(s.provenance.source);
      expect(typeof s.provenance.derivedFrom).toBe('string');
      expect(s.provenance.derivedFrom.length).toBeGreaterThan(0);
      // Structured evidence is the planner's contract: at least one strongly-typed
      // item, each with an id / machine source / stable reference / excerpt.
      expect(Array.isArray(s.provenance.evidence)).toBe(true);
      expect(s.provenance.evidence.length).toBeGreaterThan(0);
      for (const e of s.provenance.evidence) {
        expect(typeof e.id).toBe('string');
        expect(e.id.length).toBeGreaterThan(0);
        expect(['acceptanceCriteria', 'requirement', 'appKnowledge', 'testData']).toContain(e.source);
        expect(typeof e.reference).toBe('string');
        expect(e.reference.length).toBeGreaterThan(0);
        expect(typeof e.excerpt).toBe('string');
        expect(e.excerpt.length).toBeGreaterThan(0);
      }
      // The planner attaches NO numeric confidence — the orchestrator scores it.
      expect((s.provenance as any).confidence).toBeUndefined();
    }
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
    expect(plan.scenarios.some(s => s.coverageType === 'security')).toBe(false);
    expect(plan.scenarios.some(s => s.coverageType === 'negative')).toBe(false);
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

  it('renders a plan block that forbids invention, forbids dropping, and cites provenance', () => {
    const plan = planScenarios(
      { title: 'User Login', description: 'Login with email and password; lock after failed attempts.' },
      ['positive', 'negative', 'security'],
    );
    const block = buildScenarioPlanBlock(plan);
    expect(block).toContain('DERIVED SCENARIO PLAN');
    // The block instructs the LLM NOT to invent and NOT to drop scenarios.
    expect(block).toContain('DO NOT invent');
    expect(block).toContain('DO NOT drop');
    expect(block.toLowerCase()).toContain('valid credentials');
    // Each scenario cites its evidence source.
    expect(block).toContain('(source:');
    expect(block).toContain('authentication');
  });
});
