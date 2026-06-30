/**
 * Intelligence Orchestrator — Unit Tests
 *
 * Tests the query orchestration logic and prompt building without requiring
 * a live database.
 *
 * Run with: npx tsx tests/unit/intelligence-orchestrator.test.ts
 */

import { IntelligenceOrchestrator, type OrchestratedIntelligence } from '../../src/services/intelligence-orchestrator';

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

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

// Mock pool to avoid requiring DATABASE_URL
const mockPool = {
  query: async () => ({ rows: [] }),
} as any;

const orchestrator = new IntelligenceOrchestrator(mockPool);

console.log('\n=== Empty intelligence ===');
{
  const intel: OrchestratedIntelligence = {
    available: false,
    intent: 'Login',
    repositoryGraph: {
      available: false,
      primaryMethods: [],
      supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
      relatedFlows: [],
    },
    appProfile: null,
    testData: { available: false, datasets: [] },
    knowledge: null,
    domMemory: { available: false, selectors: [] },
    similarity: { available: false, similarScripts: [] },
    learnedPatterns: { available: false, patterns: [] },
    metadata: { sourcesUsed: [], missingCritical: [], warnings: [], confidenceScore: 0 },
  };

  const context = orchestrator.buildPromptContext(intel);
  assertContains(context, 'No intelligence available', 'Empty context message present');
}

console.log('\n=== Repository graph methods ===');
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
    metadata: { sourcesUsed: ['repository-graph'], missingCritical: [], warnings: [], confidenceScore: 30 },
  };

  const context = orchestrator.buildPromptContext(intel);
  assertContains(context, 'INTELLIGENCE FOR: LOGIN', 'Header with intent');
  assertContains(context, 'Confidence: 30%', 'Confidence score');
  assertContains(context, 'REPOSITORY — Existing Code to Reuse', 'Repository section header');
  assertContains(context, 'Primary Methods:', 'Primary methods section');
  assertContains(context, 'login (pages/LoginPage.ts)', 'Login method listed');
  assertContains(context, 'Assertions:', 'Assertions section');
  assertContains(context, 'verifyError()', 'Assertion helper');
  assertContains(context, 'Wait/Sync Helpers:', 'Wait helpers section');
  assertContains(context, 'waitForURL()', 'Wait helper');
  assertContains(context, 'REUSE EXISTING CODE ABOVE WHENEVER POSSIBLE', 'Reuse instruction');
}

console.log('\n=== Test data and learned patterns ===');
{
  const intel: OrchestratedIntelligence = {
    available: true,
    intent: 'Login',
    repositoryGraph: {
      available: false,
      primaryMethods: [],
      supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
      relatedFlows: [],
    },
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
    metadata: { sourcesUsed: ['test-data', 'learned-patterns'], missingCritical: [], warnings: [], confidenceScore: 20 },
  };

  const context = orchestrator.buildPromptContext(intel);
  assertContains(context, 'TEST DATA — Available Datasets', 'Test data section');
  assertContains(context, 'locked_users (5 records)', 'Dataset name and count');
  assertContains(context, 'locked_out_user', 'Sample record');
  assertContains(context, 'LEARNED PATTERNS — Best Practices', 'Learned patterns section');
  assertContains(context, '[best_practice] Always use waitForURL() after navigation', 'Best practice pattern');
  assertContains(context, '[anti_pattern] Avoid waitForTimeout()', 'Anti-pattern');
}

console.log('\n=== Warnings ===');
{
  const intel: OrchestratedIntelligence = {
    available: true,
    intent: 'Login',
    repositoryGraph: {
      available: true,
      primaryMethods: [],
      supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
      relatedFlows: [],
    },
    appProfile: null,
    testData: { available: false, datasets: [] },
    knowledge: null,
    domMemory: { available: false, selectors: [] },
    similarity: { available: false, similarScripts: [] },
    learnedPatterns: { available: false, patterns: [] },
    metadata: {
      sourcesUsed: [],
      missingCritical: ['repository-context-id'],
      warnings: ['Repository graph returned no candidates for this intent', 'App profile not found'],
      confidenceScore: 0,
    },
  };

  const context = orchestrator.buildPromptContext(intel);
  assertContains(context, '⚠️ Warnings:', 'Warnings section');
  assertContains(context, 'Repository graph returned no candidates for this intent', 'First warning');
  assertContains(context, 'App profile not found', 'Second warning');
}

/* ------------------------------------------------------------------ */
/*  Summary                                                            */
/* ------------------------------------------------------------------ */

console.log(`\n=== SUMMARY ===`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
if (failed > 0) {
  process.exit(1);
}
