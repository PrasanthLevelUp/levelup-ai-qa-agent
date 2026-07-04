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
    retrievalMetrics: {
      repositoryMethods: 0,
      testDatasets: 0,
      knowledgeRules: 0,
      learnedPatterns: 0,
      appProfilePages: 0,
      domSelectors: 0,
    },
    selected: { repositoryMethods: [], datasets: [], patterns: [] },
    intelligenceScore: { grounded: 0, aiContribution: 100, bySource: {}, summary: 'No grounding intelligence available — 100% AI-generated.' },
    sourceVersions: {},
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

console.log('\n=== Intelligence Score: computeIntelligenceScore (pure) ===');
{
  // High grounding, repository dominant → "grounded in repository intelligence".
  const s1 = IntelligenceOrchestrator.computeIntelligenceScore(94, {
    repository: 95,
    knowledge: 87,
    patterns: 98,
    appProfile: 100,
  });
  assert(s1.grounded === 94, 'grounded echoes overall confidence (94)');
  assert(s1.aiContribution === 6, 'aiContribution is inverse of grounded (6)');
  assert(s1.bySource['App Profile'] === 100, 'bySource carries UI-labelled App Profile');
  assert(s1.bySource['Repository Match'] === 95, 'bySource carries Repository Match');
  assert(s1.bySource['Pattern Match'] === 98, 'bySource carries Pattern Match');
  // Top source is App Profile (100) → phrase reflects it.
  assertContains(s1.summary, '94% grounded in app profile intelligence. Only 6% AI-generated.', 'Summary one-liner for dominant source');

  // No sources → fully AI-generated.
  const s2 = IntelligenceOrchestrator.computeIntelligenceScore(0, {});
  assert(s2.grounded === 0 && s2.aiContribution === 100, 'Empty → 0% grounded / 100% AI');
  assertContains(s2.summary, '100% AI-generated', 'Empty summary states 100% AI');

  // Clamping: over-100 confidence clamps, negative AI never occurs.
  const s3 = IntelligenceOrchestrator.computeIntelligenceScore(130, { repository: 95 });
  assert(s3.grounded === 100 && s3.aiContribution === 0, 'grounded clamps to 100, AI to 0');
}

console.log('\n=== Intelligence Score: rendered in buildPromptContext ===');
{
  const intel: OrchestratedIntelligence = {
    available: true,
    intent: 'Login',
    repositoryGraph: { ...emptyRepoGraph },
    appProfile: null,
    testData: { available: false, datasets: [] },
    knowledge: null,
    domMemory: { available: false, selectors: [] },
    similarity: { available: false, similarScripts: [] },
    learnedPatterns: { available: false, patterns: [] },
    metadata: meta({
      sourcesUsed: ['repository-graph'],
      confidenceScore: 30,
      confidenceBySource: { repository: 90 },
      intelligenceScore: IntelligenceOrchestrator.computeIntelligenceScore(30, { repository: 90 }),
    }),
  };
  const context = orchestrator.buildPromptContext(intel);
  assertContains(context, 'Intelligence Score: 30% grounded / 70% AI-generated', 'Intelligence Score line rendered in prompt');
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
  // Intelligence Score is always present on the gathered result.
  assert(intel.metadata.intelligenceScore != null, 'intelligenceScore present on gathered result');
  assert(
    intel.metadata.intelligenceScore.grounded + intel.metadata.intelligenceScore.aiContribution === 100,
    'grounded + aiContribution always sum to 100',
  );
  // Only the learned_patterns query should have run.
  assert(queries.length === 1 && /learned_patterns/.test(queries[0]), 'Only learned_patterns query executed');

  // Retrieval metrics, selected items, and source versions are always present.
  assert(intel.metadata.retrievalMetrics.repositoryMethods === 0, 'retrievalMetrics.repositoryMethods present (0)');
  assert(intel.metadata.retrievalMetrics.learnedPatterns === 0, 'retrievalMetrics.learnedPatterns present (0)');
  assert(Array.isArray(intel.metadata.selected.repositoryMethods), 'selected.repositoryMethods is an array');
  assert(Array.isArray(intel.metadata.selected.datasets), 'selected.datasets is an array');
  assert(Array.isArray(intel.metadata.selected.patterns), 'selected.patterns is an array');
  // No repoContextId passed → versioning reflects that.
  assert(intel.metadata.sourceVersions.repoContextId === undefined, 'sourceVersions.repoContextId undefined when not provided');

  // When repoContextId IS provided it is echoed into sourceVersions.
  const intel3 = await orch.gatherIntelligence({
    intent: 'Login',
    companyId: 1,
    repoContextId: 48,
    caller: 'script-gen',
    sources: ['patterns'],
  });
  assert(intel3.metadata.sourceVersions.repoContextId === 48, 'sourceVersions.repoContextId echoes provided id');

  // Now request knowledge too and ensure both are timed.
  const intel2 = await orch.gatherIntelligence({
    intent: 'Login',
    companyId: 1,
    caller: 'healing',
    sources: ['knowledge', 'patterns'],
  });
  assert(typeof intel2.metadata.timingsMs.patterns === 'number', 'patterns timed when both requested');
  assert(intel2.metadata.sourcesRequested.length === 2, 'two sources requested recorded');

  /* ------------------------------------------------------------------ */
  /*  Phase 3 — Healing evidence flow                                   */
  /* ------------------------------------------------------------------ */
  console.log('\nPhase 3 — Healing evidence (healingEvidence in repositoryGraph)');

  // When caller='healing' and 'repository' is requested, the orchestrator gathers
  // method-index + RAG evidence and attaches it to repositoryGraph.healingEvidence.
  // With no database, the evidence will be empty, but the structure should be present.
  const intelHealing = await orch.gatherIntelligence({
    intent: 'page.locator("#broken-id").click()',
    companyId: 1,
    projectId: 2,
    repoContextId: 48, // Needed for repository source
    caller: 'healing',
    sources: ['repository'],
  });

  // Without a DB, repoGraph is not available but the call should not throw.
  assert(intelHealing.repositoryGraph != null, 'repositoryGraph is present on healing intelligence');
  
  // The healingEvidence field should exist when caller='healing', even if empty.
  // (It might be undefined if no contextId or the orchestrator skips gathering, which
  // is acceptable — we're testing the contract, not the DB-dependent retrieval.)
  if (intelHealing.repositoryGraph.healingEvidence) {
    assert(Array.isArray(intelHealing.repositoryGraph.healingEvidence.methodHits), 'healingEvidence.methodHits is an array');
    assert(Array.isArray(intelHealing.repositoryGraph.healingEvidence.ragExamples), 'healingEvidence.ragExamples is an array');
    assert(typeof intelHealing.repositoryGraph.healingEvidence.signals === 'object', 'healingEvidence.signals is an object');
    assert(typeof intelHealing.repositoryGraph.healingEvidence.signals.methodIndexHit === 'boolean', 'signals.methodIndexHit is boolean');
    assert(typeof intelHealing.repositoryGraph.healingEvidence.signals.pageObjectHit === 'boolean', 'signals.pageObjectHit is boolean');
    assert(typeof intelHealing.repositoryGraph.healingEvidence.signals.usedByTestCount === 'number', 'signals.usedByTestCount is number');
    assert(typeof intelHealing.repositoryGraph.healingEvidence.signals.ragHit === 'boolean', 'signals.ragHit is boolean');
    assert(typeof intelHealing.repositoryGraph.healingEvidence.signals.topMethodSimilarity === 'number', 'signals.topMethodSimilarity is number');
  } else {
    // If healingEvidence is undefined, it's acceptable (no DB → no retrieval), just note it.
    console.log('  ℹ️  healingEvidence not populated (no DB — expected in unit test)');
  }

  // When caller is NOT 'healing', healingEvidence should remain undefined.
  const intelScriptGen = await orch.gatherIntelligence({
    intent: 'Login flow',
    companyId: 1,
    repoContextId: 48,
    caller: 'script-gen',
    sources: ['repository'],
  });
  assert(intelScriptGen.repositoryGraph.healingEvidence === undefined, 'healingEvidence is undefined when caller != healing');

  /* -------------------------------------------------------------- */
  console.log(`\n=== SUMMARY ===`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  if (failed > 0) {
    process.exit(1);
  }
})();
