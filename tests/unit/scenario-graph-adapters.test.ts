/**
 * Unit tests for the Scenario Graph adapters — the "reuse everywhere" layer.
 *
 * Each consuming module reads the SAME graph via a pure projection. These tests
 * lock that every projection is a faithful, deterministic view of the one
 * intelligence source (no re-derivation, no invention):
 *   • Test Case Lab   — one case per node, in order
 *   • Script Gen      — dependsOn sourced from `precedes` edges
 *   • Healing         — selector → impacted scenarios + urgency
 *   • RTM             — one row per node, traced to the requirement + variant_of
 *   • Impact Analysis — direct hits + one-hop blast radius
 *
 * Run with: npx jest tests/unit/scenario-graph-adapters.test.ts
 */

import { assembleScenarioGraph } from '../../src/graph/scenario-graph-builder';
import {
  toTestCaseLab,
  toScriptGenSpecs,
  toHealingContext,
  toRTMRows,
  toRTMCoverageSummary,
  toImpactAnalysis,
  isHappyPath,
} from '../../src/graph/scenario-graph-adapters';
import type { ScenarioGraph } from '../../src/graph/scenario-graph';

/* ------------------------------------------------------------------ */
/*  Fixture graph — 3 nodes with realistic edges.                      */
/* ------------------------------------------------------------------ */

const mkCase = (over: any) => ({
  scenarioId: over.scenarioId,
  title: over.title,
  objective: over.objective ?? '',
  riskArea: over.riskArea ?? 'authentication',
  preconditions: over.preconditions ?? 'registered user',
  steps: over.steps ?? [],
  expectedResult: over.expectedResult ?? 'ok',
  selectors: over.selectors ?? [],
  testData: over.testData ?? 'standard_user',
  priority: over.priority ?? 'P2',
  severity: over.severity ?? 'major',
  tags: over.tags ?? [],
  automationReady: over.automationReady ?? true,
  automationComplexity: over.automationComplexity ?? 'medium',
  selectorAvailability: over.selectorAvailability ?? 'full',
  source: over.source ?? 'app_profile',
  sourceEvidence: over.sourceEvidence ?? 'form',
});

function buildFixture(): ScenarioGraph {
  const cases = [
    mkCase({
      scenarioId: 'TC1', title: 'Login Success', priority: 'P0', severity: 'critical',
      steps: ['navigate to https://app.example.com/login', 'fill #email', 'fill #password', 'click #login-btn'],
      selectors: ['#email', '#password', '#login-btn'], objective: 'authenticate a valid user',
    }),
    mkCase({
      scenarioId: 'TC2', title: 'Invalid Password', priority: 'P1',
      steps: ['navigate to https://app.example.com/login', 'fill #email', 'fill wrong #password', 'click #login-btn'],
      selectors: ['#email', '#password', '#login-btn'], objective: 'reject an invalid password',
    }),
    mkCase({
      scenarioId: 'TC3', title: 'Session Timeout', priority: 'P2',
      steps: ['given a logged-in user', 'wait for the session to expire', 'observe redirect to login'],
      selectors: ['#login-btn'], objective: 'session expires after inactivity',
    }),
  ];
  const meta = [
    { coverageType: 'positive', grounded: true, objective: 'authenticate a valid user' },
    { coverageType: 'negative', grounded: true, objective: 'reject an invalid password' },
    { coverageType: 'edge_cases', grounded: true, objective: 'session expires after inactivity' },
  ];
  return assembleScenarioGraph({
    input: { title: 'User Login', description: 'login', module: 'Authentication', jiraId: 'AUTH-1' },
    coverageTypes: ['positive', 'negative', 'edge_cases'],
    cases, meta, knowledgeVersion: 'v1', category: 'authentication',
    requirementId: 7, now: '2026-01-01T00:00:00.000Z',
  });
}

const graph = buildFixture();

/* ================================================================== */
/*  1. Test Case Lab                                                   */
/* ================================================================== */

describe('toTestCaseLab', () => {
  it('projects exactly one case + one scenario per node, in order', () => {
    const p = toTestCaseLab(graph);
    expect(p.testCases.length).toBe(graph.nodes.length);
    expect(p.scenarios.length).toBe(graph.nodes.length);
    expect(p.testCases.map(c => c.scenarioId)).toEqual(['TC1', 'TC2', 'TC3']);
    expect(p.testCases.map(c => c.scenarioIndex)).toEqual([0, 1, 2]);
  });

  it('carries grounded selectors and metadata through unchanged', () => {
    const p = toTestCaseLab(graph);
    expect(p.testCases[0]!.selectors).toEqual(['#email', '#password', '#login-btn']);
    expect(p.testCases[0]!.priority).toBe('P0');
    expect(p.scenarios[0]!.coverageType).toBe('positive');
  });
});

/* ================================================================== */
/*  2. Script Generation                                               */
/* ================================================================== */

describe('toScriptGenSpecs', () => {
  it('emits one spec per node with grounded steps + selectors', () => {
    const specs = toScriptGenSpecs(graph);
    expect(specs.map(s => s.scenarioId)).toEqual(['TC1', 'TC2', 'TC3']);
    expect(specs[0]!.steps.length).toBeGreaterThan(0);
    expect(specs[0]!.selectors).toContain('#login-btn');
  });

  it('populates dependsOn from precedes edges (Session Timeout depends on Login Success)', () => {
    const specs = toScriptGenSpecs(graph);
    const timeout = specs.find(s => s.scenarioId === 'TC3')!;
    expect(timeout.dependsOn).toContain('TC1');
    // The happy path itself depends on nothing.
    const success = specs.find(s => s.scenarioId === 'TC1')!;
    expect(success.dependsOn).toEqual([]);
  });
});

/* ================================================================== */
/*  3. Healing                                                         */
/* ================================================================== */

describe('toHealingContext', () => {
  it('maps a broken selector to every impacted scenario', () => {
    const ctx = toHealingContext(graph, '#login-btn');
    // All three nodes reference #login-btn.
    expect(ctx.impactedScenarioIds.sort()).toEqual(['TC1', 'TC2', 'TC3']);
    expect(ctx.impactedTitles).toContain('Login Success');
  });

  it('reports the highest priority among impacted scenarios (heal urgency)', () => {
    const ctx = toHealingContext(graph, '#password');
    // #password is used by TC1 (P0) and TC2 (P1) ⇒ topPriority P0.
    expect(ctx.topPriority).toBe('P0');
  });

  it('returns an empty context for an unknown selector (fail-open)', () => {
    const ctx = toHealingContext(graph, '#does-not-exist');
    expect(ctx.impactedScenarioIds).toEqual([]);
    expect(ctx.topPriority).toBe('P3');
  });
});

/* ================================================================== */
/*  4. RTM                                                             */
/* ================================================================== */

describe('toRTMRows / toRTMCoverageSummary', () => {
  it('emits one row per scenario, each traced back to the requirement', () => {
    const rows = toRTMRows(graph);
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.requirementTitle).toBe('User Login');
      expect(r.requirementModule).toBe('Authentication');
      expect(r.jiraId).toBe('AUTH-1');
    }
  });

  it('records variant_of linkage for non-happy-path rows', () => {
    const rows = toRTMRows(graph);
    const invalid = rows.find(r => r.scenarioId === 'TC2')!;
    expect(invalid.variantOf).toBe('TC1');
    const success = rows.find(r => r.scenarioId === 'TC1')!;
    expect(success.variantOf).toBeUndefined();
  });

  it('summarises coverage counts + grounded total', () => {
    const s = toRTMCoverageSummary(graph);
    expect(s.total).toBe(3);
    expect(s.grounded).toBe(3);
    expect(s.byCoverageType.positive).toBe(1);
    expect(s.byCoverageType.negative).toBe(1);
    expect(s.byCoverageType.edge_cases).toBe(1);
  });
});

/* ================================================================== */
/*  5. Impact Analysis                                                 */
/* ================================================================== */

describe('toImpactAnalysis', () => {
  it('reports directly impacted scenarios for a changed selector', () => {
    const r = toImpactAnalysis(graph, { selectors: ['#password'] });
    // #password is directly used by TC1 + TC2.
    expect(r.directScenarioIds.sort()).toEqual(['TC1', 'TC2']);
    expect(r.changedSelectors).toEqual(['#password']);
  });

  it('expands to the one-hop blast radius via variant_of / shares_selector', () => {
    const r = toImpactAnalysis(graph, { selectors: ['#password'] });
    // Transitive set is a superset of the direct set.
    for (const id of r.directScenarioIds) expect(r.transitiveScenarioIds).toContain(id);
    expect(r.transitiveScenarioIds.length).toBeGreaterThanOrEqual(r.directScenarioIds.length);
  });

  it('reports directly impacted scenarios for a changed page', () => {
    const r = toImpactAnalysis(graph, { pages: ['app.example.com/login'] });
    // TC1 + TC2 navigate to the login page.
    expect(r.directScenarioIds.sort()).toEqual(['TC1', 'TC2']);
  });

  it('returns an empty blast radius when nothing matches (fail-open)', () => {
    const r = toImpactAnalysis(graph, { selectors: ['#ghost'], pages: ['/nope'] });
    expect(r.directScenarioIds).toEqual([]);
    expect(r.transitiveScenarioIds).toEqual([]);
  });
});

/* ================================================================== */
/*  Convenience                                                        */
/* ================================================================== */

describe('isHappyPath', () => {
  it('recognises the positive origin node as a happy path', () => {
    const success = graph.nodes.find(n => n.id === 'TC1')!;
    expect(isHappyPath(graph, success)).toBe(true);
  });

  it('does not treat a negative variant as a happy path', () => {
    const invalid = graph.nodes.find(n => n.id === 'TC2')!;
    expect(isHappyPath(graph, invalid)).toBe(false);
  });
});
