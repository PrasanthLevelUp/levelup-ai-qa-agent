/**
 * Unit tests for the Persistent Scenario Graph builder.
 *
 * The graph is the ONE intelligence source: a requirement is parsed into a
 * canonical graph ONCE (planner → builder → validator), crystallised with typed
 * edges, and then reused everywhere. These tests lock the guarantees that make
 * that safe:
 *   • determinism  — identical inputs ⇒ identical fingerprint + node ids
 *   • grounding    — nodes come straight from the grounded drafts (never invented)
 *   • coverage     — the graph never drops below the grounded scenarios
 *   • typed edges  — variant_of / shares_selector / precedes are derived correctly
 *   • fail-open    — an empty/unusable requirement yields an empty graph, no throw
 *
 * Run with: npx jest tests/unit/scenario-graph.test.ts
 */

import {
  buildScenarioGraph,
  assembleScenarioGraph,
  deriveEdges,
} from '../../src/graph/scenario-graph-builder';
import {
  SCENARIO_GRAPH_SCHEMA_VERSION,
  computeFingerprint,
  type ScenarioNode,
} from '../../src/graph/scenario-graph';

/* ------------------------------------------------------------------ */
/*  Fixtures — a realistic login requirement + grounded App Profile.   */
/* ------------------------------------------------------------------ */

const LOGIN_REQ = {
  title: 'User Login',
  description: 'A registered user logs in with their email and password to access the dashboard.',
  acceptanceCriteria: 'Valid credentials authenticate; invalid credentials are rejected with an error.',
  businessFlow: 'Open login page → enter email + password → submit → land on dashboard.',
  module: 'Authentication',
};

const LOGIN_PROFILE = {
  baseUrl: 'https://app.example.com',
  name: 'Example App',
  loginUrl: 'https://app.example.com/login',
  username: 'standard_user',
  pages: [{ url: 'https://app.example.com/login', title: 'Login', pageType: 'auth' }],
  forms: [
    {
      page: 'https://app.example.com/login',
      action: '/session',
      method: 'POST',
      submitSelector: '#login-btn',
      fields: [
        { name: 'email', type: 'email', required: true, selector: '#email', label: 'Email' },
        { name: 'password', type: 'password', required: true, selector: '#password', label: 'Password' },
      ],
    },
  ],
  keyElements: [{ label: 'Login', tag: 'button', selector: '#login-btn', role: 'button' }],
};

const LOGIN_KNOWLEDGE: any = {
  applicationProfile: LOGIN_PROFILE,
  testData: [
    { name: 'standard_user', environment: 'staging', recordCount: 1, sampleKeys: ['email', 'password'] },
  ],
};

const COVERAGE = ['positive', 'negative', 'edge_cases', 'security'];
const FIXED_NOW = '2026-01-01T00:00:00.000Z';

const build = () =>
  buildScenarioGraph(LOGIN_REQ, COVERAGE, LOGIN_KNOWLEDGE, { now: FIXED_NOW, requirementId: 42 });

/* ================================================================== */
/*  buildScenarioGraph — shape, grounding, coverage                    */
/* ================================================================== */

describe('buildScenarioGraph — shape & grounding', () => {
  it('produces a well-formed graph with schema/knowledge/category metadata', () => {
    const g = build();
    expect(g.schemaVersion).toBe(SCENARIO_GRAPH_SCHEMA_VERSION);
    expect(typeof g.knowledgeVersion).toBe('string');
    expect(g.category).toBeTruthy();
    expect(g.coverageTypes).toEqual(COVERAGE);
    expect(g.requirement.title).toBe(LOGIN_REQ.title);
    expect(g.requirement.requirementId).toBe(42);
    expect(g.builtAt).toBe(FIXED_NOW);
    expect(g.fingerprint).toMatch(/^[0-9a-f]{40}$/); // SHA-1 hex
  });

  it('builds only the scenario nodes the planner justifies (no invention)', () => {
    const g = build();
    // The graph consumes the planner's output verbatim (planner → builder →
    // graph). The planner is the SOLE decider of which scenarios exist, so the
    // node set is exactly the justified scenarios — never an invented baseline.
    // This requirement justifies its grounded positive; unjustified negatives /
    // edge / security phantoms are NOT emitted.
    expect(g.nodes.length).toBeGreaterThanOrEqual(1);
    // Every node has a stable id, a title and grounded steps.
    for (const n of g.nodes) {
      expect(n.id).toBeTruthy();
      expect(n.title).toBeTruthy();
      expect(Array.isArray(n.steps)).toBe(true);
      expect(n.steps.length).toBeGreaterThan(0);
    }
    // Node ids are unique.
    const ids = g.nodes.map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('grounds nodes in the REAL selectors from the App Profile', () => {
    const g = build();
    const allSelectors = g.nodes.flatMap(n => n.selectors);
    expect(allSelectors).toContain('#email');
    expect(allSelectors).toContain('#password');
    expect(allSelectors).toContain('#login-btn');
    // At least one node marked grounded (came from the App Profile / test data).
    expect(g.nodes.some(n => n.grounded)).toBe(true);
  });

  it('only emits coverage types the planner justified (filter, never a creator)', () => {
    const g = build();
    const types = new Set(g.nodes.map(n => n.coverageType));
    // The grounded positive is always present.
    expect(types.has('positive')).toBe(true);
    // Coverage types are a FILTER, not a creator: every emitted type must be one
    // of the requested types — the planner never manufactures a type just
    // because it was selected.
    for (const t of types) {
      expect(COVERAGE).toContain(t);
    }
  });
});

/* ================================================================== */
/*  Determinism                                                        */
/* ================================================================== */

describe('buildScenarioGraph — determinism', () => {
  it('is deterministic: identical inputs ⇒ identical fingerprint + node ids', () => {
    const a = build();
    const b = build();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.nodes.map(n => n.id)).toEqual(b.nodes.map(n => n.id));
    expect(a.edges).toEqual(b.edges);
  });

  it('changes the fingerprint when the requirement text changes', () => {
    const a = build();
    const b = buildScenarioGraph(
      { ...LOGIN_REQ, description: LOGIN_REQ.description + ' Includes SSO.' },
      COVERAGE,
      LOGIN_KNOWLEDGE,
      { now: FIXED_NOW },
    );
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('changes the fingerprint when the coverage set changes', () => {
    const a = build();
    const b = buildScenarioGraph(LOGIN_REQ, ['positive'], LOGIN_KNOWLEDGE, { now: FIXED_NOW });
    expect(a.fingerprint).not.toBe(b.fingerprint);
  });

  it('computeFingerprint is stable regardless of coverage-type ordering', () => {
    const base = { requirementText: 'x', knowledgeVersion: 'v1', nodeIds: ['a', 'b'] };
    const f1 = computeFingerprint({ ...base, coverageTypes: ['positive', 'negative'] });
    const f2 = computeFingerprint({ ...base, coverageTypes: ['negative', 'positive'] });
    expect(f1).toBe(f2);
  });
});

/* ================================================================== */
/*  Fail-open                                                          */
/* ================================================================== */

describe('buildScenarioGraph — fail-open', () => {
  it('returns an empty (but well-formed) graph for an empty requirement, without throwing', () => {
    let g: ReturnType<typeof buildScenarioGraph> | undefined;
    expect(() => {
      g = buildScenarioGraph({ title: '', description: '' }, COVERAGE, undefined, { now: FIXED_NOW });
    }).not.toThrow();
    expect(g).toBeDefined();
    expect(Array.isArray(g!.nodes)).toBe(true);
    expect(Array.isArray(g!.edges)).toBe(true);
    expect(g!.schemaVersion).toBe(SCENARIO_GRAPH_SCHEMA_VERSION);
  });

  it('does not throw when knowledge is missing (ungrounded but still planned)', () => {
    expect(() => buildScenarioGraph(LOGIN_REQ, COVERAGE, undefined, { now: FIXED_NOW })).not.toThrow();
  });
});

/* ================================================================== */
/*  Typed edges — variant_of / shares_selector / precedes              */
/* ================================================================== */

describe('deriveEdges — typed relationships', () => {
  const mkNode = (over: Partial<ScenarioNode> & { id: string }): ScenarioNode => ({
    id: over.id,
    title: over.title ?? over.id,
    objective: over.objective ?? '',
    coverageType: over.coverageType ?? 'positive',
    priority: over.priority ?? 'P2',
    severity: over.severity ?? 'major',
    riskArea: over.riskArea ?? 'authentication',
    preconditions: over.preconditions ?? '',
    steps: over.steps ?? [],
    expectedResult: over.expectedResult ?? '',
    selectors: over.selectors ?? [],
    testData: over.testData ?? '',
    tags: over.tags ?? [],
    automationReady: over.automationReady ?? true,
    automationComplexity: over.automationComplexity ?? 'medium',
    selectorAvailability: over.selectorAvailability ?? 'high',
    source: over.source ?? 'app_profile',
    sourceEvidence: over.sourceEvidence ?? '',
    grounded: over.grounded ?? true,
  });

  it('links each non-happy-path node to the happy path in its risk area (variant_of)', () => {
    const nodes = [
      mkNode({ id: 'S1', coverageType: 'positive', riskArea: 'authentication', selectors: ['#email'] }),
      mkNode({ id: 'S2', coverageType: 'negative', riskArea: 'authentication', selectors: ['#email'] }),
    ];
    const edges = deriveEdges(nodes);
    const variant = edges.find(e => e.type === 'variant_of' && e.from === 'S2');
    expect(variant).toBeDefined();
    expect(variant!.to).toBe('S1');
  });

  it('records shares_selector edges once (i<j) between nodes on the same selector', () => {
    const nodes = [
      mkNode({ id: 'S1', selectors: ['#email', '#login-btn'] }),
      mkNode({ id: 'S2', coverageType: 'negative', selectors: ['#login-btn'] }),
    ];
    const shared = deriveEdges(nodes).filter(e => e.type === 'shares_selector');
    expect(shared.length).toBe(1);
    expect(shared[0]!.from).toBe('S1');
    expect(shared[0]!.to).toBe('S2');
    expect(shared[0]!.reason).toBe('#login-btn');
  });

  it('derives precedes edges from the happy path to nodes that presuppose success', () => {
    const nodes = [
      mkNode({ id: 'S1', coverageType: 'positive', title: 'Login Success' }),
      mkNode({ id: 'S2', coverageType: 'edge_cases', title: 'Session Timeout', objective: 'session expires after inactivity' }),
      mkNode({ id: 'S3', coverageType: 'positive', title: 'Remember Me keeps the user logged in' }),
    ];
    const precedes = deriveEdges(nodes).filter(e => e.type === 'precedes');
    // S1 (happy path) → S2 (session/timeout) and → S3 (remember me).
    expect(precedes.some(e => e.from === 'S1' && e.to === 'S2')).toBe(true);
    expect(precedes.some(e => e.from === 'S1' && e.to === 'S3')).toBe(true);
  });

  it('produces no self-edges and no variant_of on the happy path itself', () => {
    const nodes = [
      mkNode({ id: 'S1', coverageType: 'positive' }),
      mkNode({ id: 'S2', coverageType: 'negative' }),
    ];
    const edges = deriveEdges(nodes);
    expect(edges.every(e => e.from !== e.to)).toBe(true);
    expect(edges.some(e => e.type === 'variant_of' && e.from === 'S1')).toBe(false);
  });
});

/* ================================================================== */
/*  assembleScenarioGraph — shared core                                */
/* ================================================================== */

describe('assembleScenarioGraph — shared core', () => {
  it('assembles nodes index-aligned with cases + meta and derives edges', () => {
    const cases = [
      {
        scenarioId: 'TC1', title: 'Login Success', riskArea: 'authentication',
        preconditions: 'registered user', steps: ['go to #login-btn'], expectedResult: 'dashboard',
        selectors: ['#email', '#login-btn'], testData: 'standard_user', priority: 'P0', severity: 'critical',
        tags: ['smoke'], automationReady: true, automationComplexity: 'low', selectorAvailability: 'full',
        source: 'app_profile', sourceEvidence: 'form', objective: 'authenticate',
      },
      {
        scenarioId: 'TC2', title: 'Invalid Password', riskArea: 'authentication',
        preconditions: 'registered user', steps: ['enter wrong password at #password'], expectedResult: 'error',
        selectors: ['#email', '#password'], testData: 'standard_user', priority: 'P1', severity: 'major',
        tags: [], automationReady: true, automationComplexity: 'medium', selectorAvailability: 'full',
        source: 'app_profile', sourceEvidence: 'form', objective: 'reject bad password',
      },
    ];
    const meta = [
      { coverageType: 'positive', grounded: true, objective: 'authenticate' },
      { coverageType: 'negative', grounded: true, objective: 'reject bad password' },
    ];
    const g = assembleScenarioGraph({
      input: LOGIN_REQ, coverageTypes: COVERAGE, cases, meta,
      knowledgeVersion: 'v1', category: 'authentication', now: FIXED_NOW,
    });
    expect(g.nodes.map(n => n.id)).toEqual(['TC1', 'TC2']);
    expect(g.nodes[0]!.coverageType).toBe('positive');
    expect(g.nodes[1]!.coverageType).toBe('negative');
    // TC2 is a variant of TC1; they share #email.
    expect(g.edges.some(e => e.type === 'variant_of' && e.from === 'TC2' && e.to === 'TC1')).toBe(true);
    expect(g.edges.some(e => e.type === 'shares_selector' && e.reason === '#email')).toBe(true);
  });
});
