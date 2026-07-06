/**
 * Unit tests for Scenario Graph Intelligence Provider.
 *
 * These tests lock the provider contract: fail-open, feature-gated, returns
 * ScenarioContext (NOT raw graph), confidence scoring, topological sort.
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
  /*  Feature flag gating                                                */
  /* ================================================================== */

  it('returns unavailable when feature flag is off', async () => {
    process.env.SCENARIO_GRAPH_PROVIDER = 'false';

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(false);
    expect(result.context).toBeNull();
    expect(result.metadata.confidence).toBe(0);
    expect(result.metadata.warnings).toContain('Feature flag SCENARIO_GRAPH_PROVIDER is off');
    expect(mockGetOrBuildScenarioGraph).not.toHaveBeenCalled();
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

  it('returns ScenarioContext (not raw graph) when graph is available', async () => {
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
    expect(result.context!.scenarioCount).toBe(2);
    expect(result.context!.groundedCount).toBe(2);
    expect(result.context!.scenarios).toHaveLength(2);
    expect(result.context!.scenarios[0]).toEqual({
      id: 'TC1',
      title: 'Login Success',
      objective: 'authenticate',
      coverageType: 'positive',
      priority: 'P0' as const,
      severity: 'critical' as const,
      riskArea: 'auth',
      automationReady: true,
      automationComplexity: 'low' as const,
      grounded: true,
    });

    // Variants are extracted
    expect(result.context!.variants).toHaveLength(1);
    expect(result.context!.variants[0]).toEqual({
      scenarioId: 'TC2',
      variantOf: 'TC1',
      reason: 'negative variant',
    });

    // No raw graph fields exposed (nodes, edges, fingerprint)
    expect((result.context as any).nodes).toBeUndefined();
    expect((result.context as any).edges).toBeUndefined();
    expect((result.context as any).fingerprint).toBeUndefined();

    // Metadata
    expect(result.metadata.confidence).toBeGreaterThan(0);
    expect(result.metadata.version?.fingerprint).toBe('abc123');
    expect(result.metadata.timingMs).toBeGreaterThanOrEqual(0);
  });

  /* ================================================================== */
  /*  Dependencies & topological sort                                    */
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
    expect(result.context!.dependencies).toHaveLength(2);
    expect(result.context!.dependencies).toContainEqual({
      scenarioId: 'TC2',
      dependsOn: ['TC1'],
      reason: 'requires login first',
    });
    expect(result.context!.dependencies).toContainEqual({
      scenarioId: 'TC3',
      dependsOn: ['TC1'],
      reason: 'requires login first',
    });

    // Precedence: TC1 must come before TC2 and TC3
    expect(result.context!.precedence).toEqual(['TC1', 'TC2', 'TC3']);
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
    expect(result.context!.dependencies).toHaveLength(0);
    expect(result.context!.precedence).toEqual(['TC1', 'TC2']); // Original order
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
    expect(result.metadata.confidence).toBe(0);
    expect(result.metadata.warnings.some(w => w.includes('DB connection failed'))).toBe(true);
  });

  /* ================================================================== */
  /*  Confidence scoring                                                 */
  /* ================================================================== */

  it('scores confidence based on grounded scenario count', async () => {
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
    expect(result.context!.groundedCount).toBe(1);
    // Confidence formula: 60 + groundedCount * 5 = 65
    expect(result.metadata.confidence).toBe(65);
  });

  it('returns confidence 0 when no scenarios are grounded', async () => {
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
          automationComplexity: 'low' as const, selectorAvailability: 'high' as const, source: 'requirement' as const,
          sourceEvidence: '', grounded: false,
        },
      ],
      edges: [],
      fingerprint: 'noground',
      builtAt: '2026-01-01T00:00:00Z',
    };

    mockGetOrBuildScenarioGraph.mockResolvedValue({
      graph: mockGraph,
      origin: 'built' as const,
      persisted: false,
    });

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(true);
    expect(result.context!.groundedCount).toBe(0);
    expect(result.metadata.confidence).toBe(0);
  });
});
