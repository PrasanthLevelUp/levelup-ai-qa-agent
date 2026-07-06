/**
 * Unit tests for Scenario Graph Intelligence Provider.
 *
 * These tests lock the provider contract: fail-open, feature-gated via
 * enabled(), returns a ScenarioContextBundle (NOT raw graph), emits raw signals
 * (NOT confidence — that's centralized), and topological sort.
 *
 * Run with: npx jest tests/unit/scenario-graph-provider.test.ts
 */

import { ScenarioGraphProvider } from '../../src/services/scenario-graph-provider';
import type { IntelligenceQuery } from '../../src/services/intelligence-provider';

// Mock the graph service
jest.mock('../../src/graph/scenario-graph-service', () => ({
  getOrBuildScenarioGraph: jest.fn(),
}));

import { getOrBuildScenarioGraph } from '../../src/graph/scenario-graph-service';

const mockGetOrBuildScenarioGraph = getOrBuildScenarioGraph as jest.MockedFunction<
  typeof getOrBuildScenarioGraph
>;

describe('ScenarioGraphProvider', () => {
  let provider: ScenarioGraphProvider;
  let originalEnv: string | undefined;

  beforeEach(() => {
    provider = new ScenarioGraphProvider();
    originalEnv = process.env.SCENARIO_GRAPH_PROVIDER;
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env.SCENARIO_GRAPH_PROVIDER = originalEnv;
  });

  const baseQuery: IntelligenceQuery = {
    intent: 'User Login',
    companyId: 1,
    projectId: 10,
    requirementId: 42,
    caller: 'script-gen',
  };

  /* ================================================================== */
  /*  Contract shape                                                     */
  /* ================================================================== */

  it('satisfies the IntelligenceProvider contract (name, priority, enabled)', () => {
    expect(provider.name).toBe('scenarioGraph');
    expect(typeof provider.priority).toBe('number');
    expect(typeof provider.enabled).toBe('function');
  });

  it('enabled() reflects the feature flag', () => {
    process.env.SCENARIO_GRAPH_PROVIDER = 'true';
    expect(provider.enabled()).toBe(true);
    process.env.SCENARIO_GRAPH_PROVIDER = 'false';
    expect(provider.enabled()).toBe(false);
    delete process.env.SCENARIO_GRAPH_PROVIDER;
    expect(provider.enabled()).toBe(false);
  });

  /* ================================================================== */
  /*  Feature flag gating                                                */
  /* ================================================================== */

  it('returns unavailable when feature flag is off', async () => {
    process.env.SCENARIO_GRAPH_PROVIDER = 'false';

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(false);
    expect(result.context).toBeNull();
    expect(result.metadata.provider).toBe('scenarioGraph');
    expect(result.metadata.signals).toEqual({});
    expect(result.metadata.warnings).toContain('Feature flag SCENARIO_GRAPH_PROVIDER is off');
    expect(mockGetOrBuildScenarioGraph).not.toHaveBeenCalled();
    // Provider never sets confidence — that's the orchestration layer's job.
    expect(result.confidence).toBeUndefined();
  });

  it('returns unavailable when feature flag is not set', async () => {
    delete process.env.SCENARIO_GRAPH_PROVIDER;

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(false);
    expect(mockGetOrBuildScenarioGraph).not.toHaveBeenCalled();
  });

  /* ================================================================== */
  /*  Input validation                                                   */
  /* ================================================================== */

  it('returns unavailable when requirementId is missing', async () => {
    process.env.SCENARIO_GRAPH_PROVIDER = 'true';
    const queryWithoutReq = { ...baseQuery, requirementId: undefined };

    const result = await provider.gather(queryWithoutReq);

    expect(result.available).toBe(false);
    expect(result.context).toBeNull();
    expect(result.metadata.warnings).toContain('No requirementId provided — Scenario Graph unavailable');
    expect(mockGetOrBuildScenarioGraph).not.toHaveBeenCalled();
  });

  /* ================================================================== */
  /*  Successful gather                                                  */
  /* ================================================================== */

  it('returns a ScenarioContextBundle (not raw graph) when graph is available', async () => {
    process.env.SCENARIO_GRAPH_PROVIDER = 'true';

    const mockGraph = {
      schemaVersion: '1.0.0',
      knowledgeVersion: 'v1',
      category: 'authentication',
      coverageTypes: ['positive', 'negative'],
      requirement: { requirementId: 42, title: 'User Login' },
      nodes: [
        {
          id: 'TC1', title: 'Login Success', objective: 'authenticate', coverageType: 'positive',
          priority: 'P0' as const, severity: 'critical' as const, riskArea: 'auth', preconditions: '', steps: [],
          expectedResult: 'ok', selectors: [], testData: '', tags: [], automationReady: true,
          automationComplexity: 'low' as const, selectorAvailability: 'high' as const, source: 'app_profile' as const,
          sourceEvidence: 'form', grounded: true,
        },
        {
          id: 'TC2', title: 'Invalid Password', objective: 'reject', coverageType: 'negative',
          priority: 'P1' as const, severity: 'major' as const, riskArea: 'auth', preconditions: '', steps: [],
          expectedResult: 'error', selectors: [], testData: '', tags: [], automationReady: true,
          automationComplexity: 'medium' as const, selectorAvailability: 'high' as const, source: 'app_profile' as const,
          sourceEvidence: 'form', grounded: true,
        },
      ],
      edges: [
        { from: 'TC2', to: 'TC1', type: 'variant_of' as const, reason: 'negative variant' },
      ],
      fingerprint: 'abc123',
      builtAt: '2026-01-01T00:00:00Z',
    };

    mockGetOrBuildScenarioGraph.mockResolvedValue({
      graph: mockGraph,
      origin: 'built' as const,
      persisted: false,
    });

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(true);
    expect(result.context).not.toBeNull();

    const { base, execution, coverage, impact } = result.context!;

    // Base slice
    expect(base.scenarioCount).toBe(2);
    expect(base.groundedCount).toBe(2);
    expect(base.scenarios).toHaveLength(2);
    expect(base.scenarios[0]).toEqual({
      id: 'TC1',
      title: 'Login Success',
      objective: 'authenticate',
      coverageType: 'positive',
      priority: 'P0',
      severity: 'critical',
      riskArea: 'auth',
      automationReady: true,
      automationComplexity: 'low',
      grounded: true,
    });

    // Coverage slice — variants + coverageByType histogram
    expect(coverage.variants).toHaveLength(1);
    expect(coverage.variants[0]).toEqual({
      scenarioId: 'TC2',
      variantOf: 'TC1',
      reason: 'negative variant',
    });
    expect(coverage.coverageByType).toEqual({ positive: 1, negative: 1 });

    // Execution + impact slices present
    expect(execution.dependencies).toEqual([]);
    expect(impact.affectedModules).toEqual([]);

    // No raw graph fields leaked anywhere in the bundle
    expect((base as any).nodes).toBeUndefined();
    expect((base as any).edges).toBeUndefined();
    expect((result.context as any).fingerprint).toBeUndefined();

    // Metadata: standardized shape, signals (not confidence)
    expect(result.metadata.provider).toBe('scenarioGraph');
    expect(result.metadata.items).toBe(2);
    expect(result.metadata.cacheHit).toBe(false); // origin was 'built'
    expect(result.metadata.signals).toEqual({ scenarioCount: 2, groundedCount: 2 });
    expect(result.metadata.version?.fingerprint).toBe('abc123');
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
    // Provider does not compute confidence
    expect(result.confidence).toBeUndefined();
  });

  it('reports cacheHit=true when the graph was reused', async () => {
    process.env.SCENARIO_GRAPH_PROVIDER = 'true';

    mockGetOrBuildScenarioGraph.mockResolvedValue({
      graph: {
        schemaVersion: '1.0.0', knowledgeVersion: 'v1', category: 'auth', coverageTypes: ['positive'],
        requirement: { requirementId: 42, title: 'Login' },
        nodes: [{
          id: 'TC1', title: 'S1', objective: '', coverageType: 'positive',
          priority: 'P0' as const, severity: 'critical' as const, riskArea: 'auth', preconditions: '', steps: [],
          expectedResult: '', selectors: [], testData: '', tags: [], automationReady: true,
          automationComplexity: 'low' as const, selectorAvailability: 'high' as const, source: 'app_profile' as const,
          sourceEvidence: '', grounded: true,
        }],
        edges: [], fingerprint: 'reused-fp', builtAt: '2026-01-01T00:00:00Z',
      },
      origin: 'reused' as const,
      persisted: true,
    });

    const result = await provider.gather(baseQuery);
    expect(result.metadata.cacheHit).toBe(true);
  });

  /* ================================================================== */
  /*  Dependencies & topological sort (execution slice)                  */
  /* ================================================================== */

  it('extracts dependencies and computes precedence order', async () => {
    process.env.SCENARIO_GRAPH_PROVIDER = 'true';

    const mockGraph = {
      schemaVersion: '1.0.0',
      knowledgeVersion: 'v1',
      category: 'authentication',
      coverageTypes: ['positive', 'edge_cases'],
      requirement: { requirementId: 42, title: 'User Login' },
      nodes: [
        {
          id: 'TC1', title: 'Login Success', objective: '', coverageType: 'positive',
          priority: 'P0' as const, severity: 'critical' as const, riskArea: 'auth', preconditions: '', steps: [],
          expectedResult: '', selectors: [], testData: '', tags: [], automationReady: true,
          automationComplexity: 'low' as const, selectorAvailability: 'high' as const, source: 'app_profile' as const,
          sourceEvidence: '', grounded: true,
        },
        {
          id: 'TC2', title: 'Session Timeout', objective: '', coverageType: 'edge_cases',
          priority: 'P2' as const, severity: 'minor' as const, riskArea: 'auth', preconditions: '', steps: [],
          expectedResult: '', selectors: [], testData: '', tags: [], automationReady: true,
          automationComplexity: 'medium' as const, selectorAvailability: 'high' as const, source: 'app_profile' as const,
          sourceEvidence: '', grounded: true,
        },
        {
          id: 'TC3', title: 'Remember Me', objective: '', coverageType: 'positive',
          priority: 'P2' as const, severity: 'minor' as const, riskArea: 'auth', preconditions: '', steps: [],
          expectedResult: '', selectors: [], testData: '', tags: [], automationReady: true,
          automationComplexity: 'medium' as const, selectorAvailability: 'high' as const, source: 'app_profile' as const,
          sourceEvidence: '', grounded: false,
        },
      ],
      edges: [
        { from: 'TC1', to: 'TC2', type: 'precedes' as const, reason: 'requires login first' },
        { from: 'TC1', to: 'TC3', type: 'precedes' as const, reason: 'requires login first' },
      ],
      fingerprint: 'def456',
      builtAt: '2026-01-01T00:00:00Z',
    };

    mockGetOrBuildScenarioGraph.mockResolvedValue({
      graph: mockGraph,
      origin: 'reused' as const,
      persisted: true,
    });

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(true);
    const { execution } = result.context!;
    expect(execution.dependencies).toHaveLength(2);
    expect(execution.dependencies).toContainEqual({
      scenarioId: 'TC2',
      dependsOn: ['TC1'],
      reason: 'requires login first',
    });
    expect(execution.dependencies).toContainEqual({
      scenarioId: 'TC3',
      dependsOn: ['TC1'],
      reason: 'requires login first',
    });

    // Precedence: TC1 must come before TC2 and TC3
    expect(execution.precedence).toEqual(['TC1', 'TC2', 'TC3']);
  });

  it('returns original order when no dependencies exist', async () => {
    process.env.SCENARIO_GRAPH_PROVIDER = 'true';

    const mockGraph = {
      schemaVersion: '1.0.0',
      knowledgeVersion: 'v1',
      category: 'authentication',
      coverageTypes: ['positive'],
      requirement: { requirementId: 42, title: 'User Login' },
      nodes: [
        {
          id: 'TC1', title: 'Scenario 1', objective: '', coverageType: 'positive',
          priority: 'P0' as const, severity: 'critical' as const, riskArea: 'auth', preconditions: '', steps: [],
          expectedResult: '', selectors: [], testData: '', tags: [], automationReady: true,
          automationComplexity: 'low' as const, selectorAvailability: 'high' as const, source: 'app_profile' as const,
          sourceEvidence: '', grounded: true,
        },
        {
          id: 'TC2', title: 'Scenario 2', objective: '', coverageType: 'positive',
          priority: 'P1' as const, severity: 'major' as const, riskArea: 'auth', preconditions: '', steps: [],
          expectedResult: '', selectors: [], testData: '', tags: [], automationReady: true,
          automationComplexity: 'low' as const, selectorAvailability: 'high' as const, source: 'app_profile' as const,
          sourceEvidence: '', grounded: true,
        },
      ],
      edges: [], // No dependencies
      fingerprint: 'xyz789',
      builtAt: '2026-01-01T00:00:00Z',
    };

    mockGetOrBuildScenarioGraph.mockResolvedValue({
      graph: mockGraph,
      origin: 'built' as const,
      persisted: false,
    });

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(true);
    expect(result.context!.execution.dependencies).toHaveLength(0);
    expect(result.context!.execution.precedence).toEqual(['TC1', 'TC2']); // Original order
  });

  /* ================================================================== */
  /*  Fail-open behavior                                                 */
  /* ================================================================== */

  it('returns unavailable when graph has no nodes', async () => {
    process.env.SCENARIO_GRAPH_PROVIDER = 'true';

    mockGetOrBuildScenarioGraph.mockResolvedValue({
      graph: {
        schemaVersion: '1.0.0',
        knowledgeVersion: 'v1',
        category: 'unknown',
        coverageTypes: [],
        requirement: { requirementId: 42, title: 'Empty' },
        nodes: [],
        edges: [],
        fingerprint: 'empty',
        builtAt: '2026-01-01T00:00:00Z',
      },
      origin: 'built' as const,
      persisted: false,
    });

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(false);
    expect(result.context).toBeNull();
    expect(result.metadata.warnings).toContain('Scenario Graph returned no scenarios for this requirement');
  });

  it('returns unavailable on error and logs warning (fail-open)', async () => {
    process.env.SCENARIO_GRAPH_PROVIDER = 'true';

    mockGetOrBuildScenarioGraph.mockRejectedValue(new Error('DB connection failed'));

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(false);
    expect(result.context).toBeNull();
    expect(result.metadata.signals).toEqual({});
    expect(result.metadata.warnings.some(w => w.includes('DB connection failed'))).toBe(true);
  });

  /* ================================================================== */
  /*  Signals for centralized scoring                                    */
  /* ================================================================== */

  it('emits grounded/scenario signals for the centralized scorer', async () => {
    process.env.SCENARIO_GRAPH_PROVIDER = 'true';

    const mockGraph = {
      schemaVersion: '1.0.0',
      knowledgeVersion: 'v1',
      category: 'auth',
      coverageTypes: ['positive'],
      requirement: { requirementId: 42, title: 'Login' },
      nodes: [
        {
          id: 'TC1', title: 'S1', objective: '', coverageType: 'positive',
          priority: 'P0' as const, severity: 'critical' as const, riskArea: 'auth', preconditions: '', steps: [],
          expectedResult: '', selectors: [], testData: '', tags: [], automationReady: true,
          automationComplexity: 'low' as const, selectorAvailability: 'high' as const, source: 'app_profile' as const,
          sourceEvidence: '', grounded: true, // Grounded
        },
        {
          id: 'TC2', title: 'S2', objective: '', coverageType: 'positive',
          priority: 'P1' as const, severity: 'major' as const, riskArea: 'auth', preconditions: '', steps: [],
          expectedResult: '', selectors: [], testData: '', tags: [], automationReady: true,
          automationComplexity: 'low' as const, selectorAvailability: 'high' as const, source: 'requirement' as const,
          sourceEvidence: '', grounded: false, // Not grounded
        },
      ],
      edges: [],
      fingerprint: 'conf',
      builtAt: '2026-01-01T00:00:00Z',
    };

    mockGetOrBuildScenarioGraph.mockResolvedValue({
      graph: mockGraph,
      origin: 'built' as const,
      persisted: false,
    });

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(true);
    expect(result.context!.base.groundedCount).toBe(1);
    expect(result.metadata.signals).toEqual({ scenarioCount: 2, groundedCount: 1 });
  });
});
