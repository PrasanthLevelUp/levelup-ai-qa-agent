/**
 * Intelligence Orchestrator — Unit Tests
 *
 * Tests the query orchestration logic and prompt building without requiring
 * a live database. Covers the Phase-1 review fixes: configurable `sources`,
 * per-source confidence, and per-source timing instrumentation.
 *
 * Run with: npx tsx tests/unit/intelligence-orchestrator.test.ts
 */

import {
  IntelligenceOrchestrator,
  ALL_SOURCES,
  type OrchestratedIntelligence,
  type OrchestratorSource,
} from '../../src/services/intelligence-orchestrator';

/* ------------------------------------------------------------------ */
/*  Assertion harness                                                  */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function assertContains(text: string, substring: string, msg: string) {
  assert(text.includes(substring), msg);
  if (!text.includes(substring)) {
    console.error(`     Expected text to contain: "${substring}"`);
  }
}

/** Build a metadata object with all required fields, overriding as needed. */
function meta(over: Partial<OrchestratedIntelligence['metadata']> = {}): OrchestratedIntelligence['metadata'] {
  return {
    sourcesRequested: ALL_SOURCES.slice(),
    sourcesUsed: [],
    missingCritical: [],
    warnings: [],
    confidenceScore: 0,
    confidenceBySource: {},
    timingsMs: {},
    ...over,
  };
}

const emptyRepoGraph = {
  available: false,
  primaryMethods: [],
  supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
  relatedFlows: [],
};

/* ------------------------------------------------------------------ */
/*  Tests — buildPromptContext (no DB)                                 */
/* ------------------------------------------------------------------ */

const orchestrator = new IntelligenceOrchestrator({ query: async () => ({ rows: [] }) } as any);

console.log('\n=== Empty intelligence ===');
{
  const intel: OrchestratedIntelligence = {
    available: false,
    intent: 'Login',
    repositoryGraph: { ...emptyRepoGraph },
    appProfile: null,
    testData: { available: false, datasets: [] },
    knowledge: null,
    domMemory: { available: false, selectors: [] },
    similarity: { available: false, similarScripts: [] },
    learnedPatterns: { available: false, patterns: [] },
    metadata: meta(),
  };

  const context = orchestrator.buildPromptContext(intel);
  assertContains(context, 'No intelligence available', 'Empty context message present');
  assert(typeof intel.metadata.timingsMs.promptBuild === 'number', 'promptBuild timing recorded even when empty');
}

console.log('\n=== Repository graph methods + per-source confidence ===');
{
  const intel: OrchestratedIntelligence = {
    available: true,
    intent: 'Login',
    repositoryGraph: {
      available: true,
      primaryMethods: [
        {
          id: 1,
          name: 'login',
          filePath: 'pages/LoginPage.ts',
          methodType: 'page_object_method',
          sourceCode: 'async login(username: string, password: string) { ... }',
          description: 'Perform login with credentials',
          usageCount: 10,
        },
      ],
      supportingMethods: {
        assertions: [{ id: 2, name: 'verifyError', filePath: 'helpers/assertions.ts', methodType: 'helper', sourceCode: '', description: '', usageCount: 5 }],
        waits: [{ id: 3, name: 'waitForURL', filePath: 'helpers/waits.ts', methodType: 'helper', sourceCode: '', description: '', usageCount: 8 }],
        dataAccess: [],
        utilities: [],
      },
      relatedFlows: [],
    },
    appProfile: null,
    testData: { available: false, datasets: [] },
    knowledge: null,
    domMemory: { available: false, selectors: [] },
    similarity: { available: false, similarScripts: [] },
    learnedPatterns: { available: false, patterns: [] },
    metadata: meta({
      sourcesUsed: ['repository-graph'],
      confidenceScore: 30,
      confidenceBySource: { repository: 70 },
    }),
  };

  const context = orchestrator.buildPromptContext(intel);
  assertContains(context, 'INTELLIGENCE FOR: LOGIN', 'Header with intent');
  assertContains(context, 'Overall Confidence: 30%', 'Overall confidence score');
  assertContains(context, 'Source Confidence: repository=70%', 'Per-source confidence line');
  assertContains(context, 'REPOSITORY — Existing Code to Reuse (confidence: 70%)', 'Repository header carries confidence');
  assertContains(context, 'Primary Methods:', 'Primary methods section');
  assertContains(context, 'login (pages/LoginPage.ts)', 'Login method listed');
  assertContains(context, 'Assertions:', 'Assertions section');
  assertContains(context, 'verifyError()', 'Assertion helper');
  assertContains(context, 'Wait/Sync Helpers:', 'Wait helpers section');
  assertContains(context, 'waitForURL()', 'Wait helper');
  assertContains(context, 'REUSE EXISTING CODE ABOVE WHENEVER POSSIBLE', 'Reuse instruction');
  assert(typeof intel.metadata.timingsMs.promptBuild === 'number', 'promptBuild timing recorded');
}

console.log('\n=== Test data and learned patterns (confidence annotations) ===');
{
  const intel: OrchestratedIntelligence = {
    available: true,
    intent: 'Login',
    repositoryGraph: { ...emptyRepoGraph },
    appProfile: null,
    testData: {
      available: true,
      datasets: [
        { name: 'locked_users', recordCount: 5, sampleRecords: ['{"username":"locked_out_user","password":"secret"}'] },
      ],
    },
    knowledge: null,
    domMemory: { available: false, selectors: [] },
    similarity: { available: false, similarScripts: [] },
    learnedPatterns: {
      available: true,
      patterns: [
        { pattern_type: 'best_practice', pattern_description: 'Always use waitForURL() after navigation', confidence_score: 0.95, usage_count: 42 },
        { pattern_type: 'anti_pattern', pattern_description: 'Avoid waitForTimeout()', confidence_score: 0.88, usage_count: 8 },
      ],
    },
    metadata: meta({
      sourcesUsed: ['test-data', 'learned-patterns'],
      confidenceScore: 20,
      confidenceBySource: { testData: 100, patterns: 60 },
    }),
  };

  const context = orchestrator.buildPromptContext(intel);
  assertContains(context, 'TEST DATA — Available Datasets (confidence: 100%)', 'Test data header confidence');
  assertContains(context, 'locked_users (5 records)', 'Dataset name and count');
  assertContains(context, 'locked_out_user', 'Sample record');
  assertContains(context, 'LEARNED PATTERNS — Best Practices (confidence: 60%)', 'Patterns header confidence');
  assertContains(context, '[best_practice] Always use waitForURL() after navigation', 'Best practice pattern');
  assertContains(context, '[anti_pattern] Avoid waitForTimeout()', 'Anti-pattern');
  assertContains(context, 'Source Confidence: testData=100%, patterns=60%', 'Combined per-source line');
}

console.log('\n=== Warnings ===');
{
  const intel: OrchestratedIntelligence = {
    available: true,
    intent: 'Login',
    repositoryGraph: { ...emptyRepoGraph, available: true },
    appProfile: null,
    testData: { available: false, datasets: [] },
    knowledge: null,
    domMemory: { available: false, selectors: [] },
    similarity: { available: false, similarScripts: [] },
    learnedPatterns: { available: false, patterns: [] },
    metadata: meta({
      missingCritical: ['repository-context-id'],
      warnings: ['Repository graph returned no candidates for this intent', 'App profile not found'],
    }),
  };

  const context = orchestrator.buildPromptContext(intel);
  assertContains(context, '⚠️ Warnings:', 'Warnings section');
  assertContains(context, 'Repository graph returned no candidates for this intent', 'First warning');
  assertContains(context, 'App profile not found', 'Second warning');
}

/* ------------------------------------------------------------------ */
/*  Tests — gatherIntelligence (mocked pool): sources filter + timing  */
/* ------------------------------------------------------------------ */

console.log('\n=== gatherIntelligence: configurable sources filter ===');
(async () => {
  // Track which DB-backed sources got queried via the mocked pool.
  const queries: string[] = [];
  const mockPool = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: [] };
    },
  } as any;
  const orch = new IntelligenceOrchestrator(mockPool);

  // Request ONLY patterns. No repoContextId / targetUrl / projectId so the
  // other sources are skipped anyway — but the key check is that only the
  // requested sources are attempted and timed.
  const intel = await orch.gatherIntelligence({
    intent: 'Login',
    companyId: 1,
    caller: 'script-gen',
    sources: ['patterns'],
  });

  assert(intel.metadata.sourcesRequested.length === 1 && intel.metadata.sourcesRequested[0] === 'patterns',
    'Only requested source recorded in sourcesRequested');
  assert(typeof intel.metadata.timingsMs.patterns === 'number', 'patterns source timed');
  assert(intel.metadata.timingsMs.knowledge === undefined, 'knowledge NOT timed (not requested)');
  assert(intel.metadata.timingsMs.domMemory === undefined, 'domMemory NOT timed (not requested)');
  assert(typeof intel.metadata.timingsMs.total === 'number', 'total timing recorded');
  // Only the learned_patterns query should have run.
  assert(queries.length === 1 && /learned_patterns/.test(queries[0]), 'Only learned_patterns query executed');

  // Now request knowledge too and ensure both are timed.
  const intel2 = await orch.gatherIntelligence({
    intent: 'Login',
    companyId: 1,
    caller: 'healing',
    sources: ['knowledge', 'patterns'],
  });
  assert(typeof intel2.metadata.timingsMs.patterns === 'number', 'patterns timed when both requested');
  assert(intel2.metadata.sourcesRequested.length === 2, 'two sources requested recorded');

  /* -------------------------------------------------------------- */
  console.log(`\n=== SUMMARY ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
})();
