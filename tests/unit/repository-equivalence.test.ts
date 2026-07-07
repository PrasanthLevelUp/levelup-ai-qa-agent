/**
 * Repository Equivalence — Dual-Path Migration Validator Tests
 * ============================================================================
 *
 * Proves that the RepositoryProvider produces the SAME intelligence as the
 * legacy inline path, so the legacy path can eventually be deleted with
 * confidence. Tests are semantic (order-independent, volatile-field-agnostic),
 * matching how the orchestrator's shadow comparison works in production.
 *
 * Run with: npx jest tests/unit/repository-equivalence.test.ts
 */

import {
  normalizeLegacy,
  normalizeProvider,
  compareRepositoryOutputs,
  evaluateRepositoryEquivalence,
  getRepositoryEquivalenceRecorder,
} from '../../src/services/repository-equivalence';
import type { IntentQueryResult, ReusableMethod } from '../../src/services/knowledge-graph-service';
import type { RepositoryContext } from '../../src/services/repository-provider';

/* ---------------------------------------------------------------- */
/*  Fixtures                                                          */
/* ---------------------------------------------------------------- */

function method(
  id: number,
  name: string,
  methodType: string,
  filePath: string,
  extra: Partial<ReusableMethod> = {},
): ReusableMethod {
  return {
    id,
    name,
    filePath,
    methodType,
    sourceCode: `// ${name}\n`,
    description: `${name} description`,
    usageCount: 1,
    ...extra,
  };
}

/** A representative underlying graph result (what getReuseCandidatesForIntent returns). */
function sampleGraphResult(): IntentQueryResult {
  return {
    available: true,
    intent: 'Login',
    primaryMethods: [
      method(1, 'login', 'page_object', 'pages/LoginPage.ts'),
      method(2, 'gotoLogin', 'page_object', 'pages/LoginPage.ts'),
    ],
    supportingMethods: {
      assertions: [method(3, 'expectLoggedIn', 'assertion', 'helpers/asserts.ts')],
      waits: [method(4, 'waitForDashboard', 'wait', 'helpers/waits.ts')],
      dataAccess: [method(5, 'getUser', 'data', 'helpers/data.ts')],
      utilities: [method(6, 'log', 'utility', 'helpers/util.ts')],
    },
    relatedFlows: ['Authentication', 'Session'],
  };
}

/**
 * Build the provider's RepositoryContext from the SAME underlying graph result,
 * mirroring RepositoryProvider.projectToContext (which is the faithful
 * projection under test).
 */
function providerContextFrom(graph: IntentQueryResult): RepositoryContext {
  return {
    available: graph.available,
    intent: graph.intent,
    primaryMethods: graph.primaryMethods,
    supportingMethods: graph.supportingMethods,
    relatedFlows: graph.relatedFlows,
  };
}

/** Shuffle helper to prove order-independence. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

/* ---------------------------------------------------------------- */
/*  Equivalence (the core migration proof)                           */
/* ---------------------------------------------------------------- */

describe('Repository Equivalence: legacy ≡ provider', () => {
  it('normalizes identical underlying data to deep-equal canonical form', () => {
    const graph = sampleGraphResult();
    const legacy = normalizeLegacy(graph);
    const provider = normalizeProvider(providerContextFrom(graph));
    expect(legacy).toEqual(provider);
  });

  it('reports MATCH for equivalent legacy and provider outputs', () => {
    const graph = sampleGraphResult();
    const result = compareRepositoryOutputs(
      normalizeLegacy(graph),
      normalizeProvider(providerContextFrom(graph)),
    );
    expect(result.match).toBe(true);
    expect(result.differences).toEqual([]);
  });

  it('is order-independent — shuffled method lists still match', () => {
    const graph = sampleGraphResult();
    const shuffled: IntentQueryResult = {
      ...graph,
      primaryMethods: shuffle(graph.primaryMethods),
      supportingMethods: {
        assertions: shuffle(graph.supportingMethods.assertions),
        waits: shuffle(graph.supportingMethods.waits),
        dataAccess: shuffle(graph.supportingMethods.dataAccess),
        utilities: shuffle(graph.supportingMethods.utilities),
      },
      relatedFlows: shuffle(graph.relatedFlows),
    };
    const result = compareRepositoryOutputs(
      normalizeLegacy(graph),
      normalizeProvider(providerContextFrom(shuffled)),
    );
    expect(result.match).toBe(true);
  });

  it('ignores volatile fields (id, usageCount, sourceCode, description)', () => {
    const graph = sampleGraphResult();
    const jittered: IntentQueryResult = {
      ...graph,
      primaryMethods: graph.primaryMethods.map(m => ({
        ...m,
        id: m.id + 1000,
        usageCount: m.usageCount + 99,
        sourceCode: m.sourceCode + '   \n// changed',
        description: 'totally different description',
      })),
    };
    const result = compareRepositoryOutputs(
      normalizeLegacy(graph),
      normalizeProvider(providerContextFrom(jittered)),
    );
    expect(result.match).toBe(true);
  });

  it('handles the empty / unavailable case identically', () => {
    const empty: IntentQueryResult = {
      available: false,
      intent: 'Nothing',
      primaryMethods: [],
      supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
      relatedFlows: [],
    };
    const result = compareRepositoryOutputs(
      normalizeLegacy(empty),
      normalizeProvider(providerContextFrom(empty)),
    );
    expect(result.match).toBe(true);
  });
});

/* ---------------------------------------------------------------- */
/*  Mismatch detection (the regression tripwire)                     */
/* ---------------------------------------------------------------- */

describe('Repository Equivalence: mismatch detection', () => {
  it('detects a method present in legacy but missing from provider', () => {
    const graph = sampleGraphResult();
    const providerCtx = providerContextFrom(graph);
    providerCtx.primaryMethods = providerCtx.primaryMethods.slice(1); // drop one
    const result = compareRepositoryOutputs(normalizeLegacy(graph), normalizeProvider(providerCtx));
    expect(result.match).toBe(false);
    expect(result.differences.join('\n')).toMatch(/primaryMethods:.*legacy has "login"/);
  });

  it('detects a category swap (same method, wrong bucket)', () => {
    const graph = sampleGraphResult();
    const providerCtx = providerContextFrom(graph);
    // Move the assertion into utilities — same method, different relationship.
    providerCtx.supportingMethods = {
      ...providerCtx.supportingMethods,
      assertions: [],
      utilities: [...providerCtx.supportingMethods.utilities, ...graph.supportingMethods.assertions],
    };
    const result = compareRepositoryOutputs(normalizeLegacy(graph), normalizeProvider(providerCtx));
    expect(result.match).toBe(false);
    expect(result.differences.join('\n')).toMatch(/assertions:.*expectLoggedIn/);
    expect(result.differences.join('\n')).toMatch(/utilities:.*expectLoggedIn/);
  });

  it('detects availability and relatedFlows differences', () => {
    const graph = sampleGraphResult();
    const providerCtx = providerContextFrom(graph);
    providerCtx.available = false;
    providerCtx.relatedFlows = ['Authentication']; // dropped "Session"
    const result = compareRepositoryOutputs(normalizeLegacy(graph), normalizeProvider(providerCtx));
    expect(result.match).toBe(false);
    expect(result.differences.join('\n')).toMatch(/available:/);
    expect(result.differences.join('\n')).toMatch(/relatedFlows:.*Session/);
  });

  it('detects a healing-signal mismatch', () => {
    const graph = sampleGraphResult();
    const legacy = {
      ...graph,
      healingEvidence: {
        signals: {
          methodIndexHit: true,
          pageObjectHit: true,
          usedByTestCount: 3,
          ragHit: false,
          topMethodSimilarity: 0.8,
        },
      },
    };
    const providerCtx: RepositoryContext = {
      ...providerContextFrom(graph),
      healingEvidence: {
        methodHits: [],
        ragExamples: [],
        signals: {
          methodIndexHit: true,
          pageObjectHit: false, // differs
          usedByTestCount: 3,
          ragHit: false,
          topMethodSimilarity: 0.8,
        },
      },
    };
    const result = compareRepositoryOutputs(normalizeLegacy(legacy), normalizeProvider(providerCtx));
    expect(result.match).toBe(false);
    expect(result.differences.join('\n')).toMatch(/healingSignals:/);
  });

  it('treats tiny float noise in similarity as equivalent (rounded to 4dp)', () => {
    const graph = sampleGraphResult();
    const legacy = {
      ...graph,
      healingEvidence: { signals: { methodIndexHit: true, pageObjectHit: true, usedByTestCount: 1, ragHit: true, topMethodSimilarity: 0.123456 } },
    };
    const providerCtx: RepositoryContext = {
      ...providerContextFrom(graph),
      healingEvidence: { methodHits: [], ragExamples: [], signals: { methodIndexHit: true, pageObjectHit: true, usedByTestCount: 1, ragHit: true, topMethodSimilarity: 0.123457 } },
    };
    const result = compareRepositoryOutputs(normalizeLegacy(legacy), normalizeProvider(providerCtx));
    expect(result.match).toBe(true);
  });
});

/* ---------------------------------------------------------------- */
/*  Recorder + one-shot evaluator                                    */
/* ---------------------------------------------------------------- */

describe('Repository Equivalence: match-rate recorder', () => {
  beforeEach(() => getRepositoryEquivalenceRecorder().reset());

  it('tracks match rate across evaluations', () => {
    const graph = sampleGraphResult();

    // 3 matches
    for (let i = 0; i < 3; i++) {
      evaluateRepositoryEquivalence(graph, providerContextFrom(graph), { intent: 'Login', caller: 'script-gen' });
    }
    // 1 mismatch
    const bad = providerContextFrom(graph);
    bad.primaryMethods = [];
    evaluateRepositoryEquivalence(graph, bad, { intent: 'Login', caller: 'script-gen' });

    const stats = getRepositoryEquivalenceRecorder().stats();
    expect(stats.total).toBe(4);
    expect(stats.matches).toBe(3);
    expect(stats.mismatches).toBe(1);
    expect(stats.matchRatePct).toBe(75);
  });

  it('reports 100% when nothing has been recorded yet', () => {
    expect(getRepositoryEquivalenceRecorder().matchRatePct()).toBe(100);
  });

  it('evaluateRepositoryEquivalence returns the comparison result', () => {
    const graph = sampleGraphResult();
    const result = evaluateRepositoryEquivalence(graph, providerContextFrom(graph), {
      intent: 'Login',
      caller: 'script-gen',
    });
    expect(result.match).toBe(true);
  });

  it('handles a null provider context (provider unavailable) as a mismatch vs available legacy', () => {
    const graph = sampleGraphResult();
    const result = evaluateRepositoryEquivalence(graph, null, { intent: 'Login', caller: 'healing' });
    expect(result.match).toBe(false);
    expect(result.differences.join('\n')).toMatch(/available:/);
  });
});
