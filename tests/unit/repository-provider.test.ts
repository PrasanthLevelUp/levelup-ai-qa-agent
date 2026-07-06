/**
 * Unit tests for Repository Intelligence Provider.
 *
 * These tests lock the provider contract: fail-open, feature-gated via enabled(),
 * returns RepositoryContext (NOT raw DB rows or graph internals), carries a
 * version, and emits standardized normalized quality signals (grounding/coverage)
 * — NOT confidence (that's centralized).
 *
 * Run with: npx jest tests/unit/repository-provider.test.ts
 */

import { RepositoryProvider } from '../../src/services/repository-provider';
import type { IntelligenceQuery } from '../../src/services/intelligence-provider';

// Mock dependencies
jest.mock('../../src/services/knowledge-graph-service', () => ({
  knowledgeGraphService: {
    getReuseCandidatesForIntent: jest.fn(),
  },
}));

jest.mock('../../src/services/method-intelligence-service');
jest.mock('../../src/services/rag-service');

import { knowledgeGraphService } from '../../src/services/knowledge-graph-service';
import { MethodIntelligenceService } from '../../src/services/method-intelligence-service';
import { getRAGService } from '../../src/services/rag-service';

const mockGetReuseCandidates = knowledgeGraphService.getReuseCandidatesForIntent as jest.MockedFunction<
  typeof knowledgeGraphService.getReuseCandidatesForIntent
>;

const mockMethodSearch = jest.fn();
const mockRagRetrieve = jest.fn();

(MethodIntelligenceService as jest.MockedClass<typeof MethodIntelligenceService>).mockImplementation(() => ({
  search: mockMethodSearch,
} as any));

(getRAGService as jest.MockedFunction<typeof getRAGService>).mockReturnValue({
  retrieve: mockRagRetrieve,
} as any);

describe('RepositoryProvider', () => {
  let provider: RepositoryProvider;
  let originalEnv: string | undefined;

  beforeEach(() => {
    provider = new RepositoryProvider();
    originalEnv = process.env.REPOSITORY_PROVIDER;
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env.REPOSITORY_PROVIDER = originalEnv;
  });

  const baseQuery: IntelligenceQuery = {
    intent: 'User Login',
    companyId: 1,
    projectId: 10,
    repoContextId: 42,
    caller: 'script-gen',
  };

  /* ================================================================== */
  /*  Contract shape                                                     */
  /* ================================================================== */

  it('satisfies the IntelligenceProvider contract (name, version, priority, enabled)', () => {
    expect(provider.name).toBe('repository');
    expect(typeof provider.version).toBe('number');
    expect(provider.priority).toBe(10); // foundational source
    expect(typeof provider.enabled).toBe('function');
  });

  it('enabled() reflects the feature flag', () => {
    process.env.REPOSITORY_PROVIDER = 'true';
    expect(provider.enabled()).toBe(true);
    process.env.REPOSITORY_PROVIDER = 'false';
    expect(provider.enabled()).toBe(false);
    delete process.env.REPOSITORY_PROVIDER;
    expect(provider.enabled()).toBe(false);
  });

  /* ================================================================== */
  /*  Feature flag gating                                                */
  /* ================================================================== */

  it('returns unavailable when feature flag is off', async () => {
    process.env.REPOSITORY_PROVIDER = 'false';

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(false);
    expect(result.context).toBeNull();
    expect(result.metadata.provider).toBe('repository');
    expect(result.metadata.providerVersion).toBe(provider.version);
    expect(result.metadata.signals).toEqual({});
    expect(result.metadata.warnings).toContain('Feature flag REPOSITORY_PROVIDER is off');
    expect(mockGetReuseCandidates).not.toHaveBeenCalled();
    expect(result.confidence).toBeUndefined();
  });

  /* ================================================================== */
  /*  Input validation                                                   */
  /* ================================================================== */

  it('returns unavailable when repoContextId is missing', async () => {
    process.env.REPOSITORY_PROVIDER = 'true';
    const queryWithoutRepo = { ...baseQuery, repoContextId: undefined };

    const result = await provider.gather(queryWithoutRepo);

    expect(result.available).toBe(false);
    expect(result.context).toBeNull();
    expect(result.metadata.warnings).toContain('No repoContextId provided — Repository intelligence unavailable');
    expect(mockGetReuseCandidates).not.toHaveBeenCalled();
  });

  /* ================================================================== */
  /*  Successful gather                                                  */
  /* ================================================================== */

  it('returns RepositoryContext (not raw DB rows) when intelligence is available', async () => {
    process.env.REPOSITORY_PROVIDER = 'true';

    const mockReuseCandidates = {
      available: true,
      intent: 'User Login',
      primaryMethods: [
        {
          id: 1,
          name: 'loginWithCredentials',
          filePath: 'pages/LoginPage.ts',
          methodType: 'page_object',
          sourceCode: 'async loginWithCredentials(user, pass) { ... }',
          description: 'Login with username and password',
          usageCount: 12,
        },
        {
          id: 2,
          name: 'verifyLoginSuccess',
          filePath: 'pages/LoginPage.ts',
          methodType: 'page_object',
          sourceCode: 'async verifyLoginSuccess() { ... }',
          description: 'Verify successful login',
          usageCount: 10,
        },
      ],
      supportingMethods: {
        assertions: [
          {
            id: 3,
            name: 'expectVisible',
            filePath: 'helpers/assertions.ts',
            methodType: 'assertion',
            sourceCode: 'async expectVisible(locator) { ... }',
            description: 'Assert element is visible',
            usageCount: 45,
          },
        ],
        waits: [
          {
            id: 4,
            name: 'waitForPageLoad',
            filePath: 'helpers/waits.ts',
            methodType: 'wait',
            sourceCode: 'async waitForPageLoad() { ... }',
            description: 'Wait for page to load',
            usageCount: 30,
          },
        ],
        dataAccess: [],
        utilities: [],
      },
      relatedFlows: ['Authentication', 'User Management'],
    };

    mockGetReuseCandidates.mockResolvedValue(mockReuseCandidates);

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(true);
    expect(result.context).not.toBeNull();

    const ctx = result.context!;
    expect(ctx.intent).toBe('User Login');
    expect(ctx.primaryMethods).toHaveLength(2);
    expect(ctx.primaryMethods[0]).toEqual({
      id: 1,
      name: 'loginWithCredentials',
      filePath: 'pages/LoginPage.ts',
      methodType: 'page_object',
      sourceCode: 'async loginWithCredentials(user, pass) { ... }',
      description: 'Login with username and password',
      usageCount: 12,
    });
    expect(ctx.supportingMethods.assertions).toHaveLength(1);
    expect(ctx.supportingMethods.waits).toHaveLength(1);
    expect(ctx.relatedFlows).toEqual(['Authentication', 'User Management']);

    // No DB internals leaked
    expect((ctx as any).rows).toBeUndefined();
    expect((ctx as any).graphId).toBeUndefined();

    // Metadata: standardized shape, version, normalized quality signals (not confidence)
    expect(result.metadata.provider).toBe('repository');
    expect(result.metadata.providerVersion).toBe(provider.version);
    expect(result.metadata.items).toBe(2);
    expect(result.metadata.cacheHit).toBe(false);
    // grounding = 3/5 categories covered (primary, assertions, waits); coverage = 3 types / 5 = 0.6
    expect(result.metadata.signals).toEqual({ grounding: 0.6, coverage: 0.6 });
    expect(result.metadata.version?.id).toBe(42);
    expect(result.metadata.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeUndefined();
  });

  it('includes healingEvidence when caller=healing', async () => {
    process.env.REPOSITORY_PROVIDER = 'true';

    const mockReuseCandidates = {
      available: true,
      intent: 'Click Submit',
      primaryMethods: [
        {
          id: 1,
          name: 'clickSubmit',
          filePath: 'pages/FormPage.ts',
          methodType: 'page_object',
          sourceCode: 'async clickSubmit() { ... }',
          description: 'Click submit button',
          usageCount: 5,
        },
      ],
      supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
      relatedFlows: [],
    };

    const mockMethodHits = [
      {
        id: 10,
        methodName: 'submitForm',
        className: 'FormPage',
        methodType: 'page_object',
        filePath: 'pages/FormPage.ts',
        sourceCode: 'await page.click("[data-testid=submit]")',
        similarity: 0.92,
        usageCount: 8,
      },
    ];

    const mockRagExamples = [
      {
        snippet: 'await page.locator("[data-testid=submit]").click()',
        source: 'tests/form.spec.ts',
        similarity: 0.88,
      },
    ];

    mockGetReuseCandidates.mockResolvedValue(mockReuseCandidates);
    mockMethodSearch.mockResolvedValue(mockMethodHits);
    mockRagRetrieve.mockResolvedValue(mockRagExamples);

    const healingQuery = { ...baseQuery, caller: 'healing' as const };
    const result = await provider.gather(healingQuery);

    expect(result.available).toBe(true);
    expect(result.context!.healingEvidence).toBeDefined();
    const evidence = result.context!.healingEvidence!;
    expect(evidence.methodHits).toHaveLength(1);
    expect(evidence.ragExamples).toHaveLength(1);
    expect(evidence.signals).toEqual({
      methodIndexHit: true,
      pageObjectHit: true,
      usedByTestCount: 8,
      ragHit: true,
      topMethodSimilarity: 0.92,
    });
  });

  it('does NOT include healingEvidence when caller is not healing', async () => {
    process.env.REPOSITORY_PROVIDER = 'true';

    const mockReuseCandidates = {
      available: true,
      intent: 'Click Submit',
      primaryMethods: [
        {
          id: 1,
          name: 'clickSubmit',
          filePath: 'pages/FormPage.ts',
          methodType: 'page_object',
          sourceCode: 'async clickSubmit() { ... }',
          description: 'Click submit button',
          usageCount: 5,
        },
      ],
      supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
      relatedFlows: [],
    };

    mockGetReuseCandidates.mockResolvedValue(mockReuseCandidates);

    const result = await provider.gather(baseQuery); // caller = 'script-gen'

    expect(result.available).toBe(true);
    expect(result.context!.healingEvidence).toBeUndefined();
  });

  /* ================================================================== */
  /*  Fail-open behavior                                                 */
  /* ================================================================== */

  it('returns unavailable when graph returns no candidates', async () => {
    process.env.REPOSITORY_PROVIDER = 'true';

    mockGetReuseCandidates.mockResolvedValue({
      available: true,
      intent: 'Unknown Intent',
      primaryMethods: [],
      supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
      relatedFlows: [],
    });

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(false);
    expect(result.context).toBeNull();
    expect(result.metadata.warnings).toContain('Repository graph returned no candidates for this intent');
  });

  it('returns unavailable on error and logs warning (fail-open)', async () => {
    process.env.REPOSITORY_PROVIDER = 'true';

    mockGetReuseCandidates.mockRejectedValue(new Error('Graph query timeout'));

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(false);
    expect(result.context).toBeNull();
    expect(result.metadata.signals).toEqual({});
    expect(result.metadata.warnings.some(w => w.includes('Graph query timeout'))).toBe(true);
  });

  /* ================================================================== */
  /*  Standardized quality signals for centralized scoring               */
  /* ================================================================== */

  it('emits normalized grounding/coverage signals (not confidence)', async () => {
    process.env.REPOSITORY_PROVIDER = 'true';

    const mockReuseCandidates = {
      available: true,
      intent: 'Add to Cart',
      primaryMethods: [{ id: 1, name: 'addToCart', filePath: 'p.ts', methodType: 'page_object', sourceCode: '', description: '', usageCount: 1 }],
      supportingMethods: {
        assertions: [{ id: 2, name: 'expectCartCount', filePath: 'a.ts', methodType: 'assertion', sourceCode: '', description: '', usageCount: 1 }],
        waits: [{ id: 3, name: 'waitForCart', filePath: 'w.ts', methodType: 'wait', sourceCode: '', description: '', usageCount: 1 }],
        dataAccess: [{ id: 4, name: 'getProduct', filePath: 'd.ts', methodType: 'data_access', sourceCode: '', description: '', usageCount: 1 }],
        utilities: [{ id: 5, name: 'formatPrice', filePath: 'u.ts', methodType: 'utility', sourceCode: '', description: '', usageCount: 1 }],
      },
      relatedFlows: [],
    };

    mockGetReuseCandidates.mockResolvedValue(mockReuseCandidates);

    const result = await provider.gather(baseQuery);

    expect(result.available).toBe(true);
    // grounding = 5/5 = 1 (all categories covered); coverage = 5 distinct types / 5 = 1
    expect(result.metadata.signals).toEqual({ grounding: 1, coverage: 1 });
    // Provider does not compute confidence
    expect(result.confidence).toBeUndefined();
  });
});
