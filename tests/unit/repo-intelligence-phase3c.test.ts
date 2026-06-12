/**
 * Repository Intelligence Phase 3C — gating + pure-helper unit tests (flags OFF).
 *
 * Verifies that with ALL Phase 3C flags OFF (the default):
 *   - the feature flags read false,
 *   - the three services short-circuit to an `available:false` / empty result
 *     WITHOUT touching the database (so they are safe on any deployment), and
 *   - the pure scoring/graph helper functions are correct in isolation.
 *
 * No database is required for this suite. The flags are explicitly deleted at
 * the top so a polluted environment cannot accidentally enable the features.
 *
 * Run with: npx tsx tests/unit/repo-intelligence-phase3c.test.ts
 */

delete process.env.ENABLE_HEALTH_INTELLIGENCE;
delete process.env.ENABLE_IMPACT_ANALYSIS;
delete process.env.ENABLE_KNOWLEDGE_GRAPH;

import { FEATURE_FLAGS } from '../../src/config/features';
import {
  RepositoryHealthService,
  scoreToGrade,
  HEALTH_WEIGHTS,
} from '../../src/services/repository-health-service';
import { ImpactAnalysisService } from '../../src/services/impact-analysis-service';
import { KnowledgeGraphService } from '../../src/services/knowledge-graph-service';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

async function main() {
  console.log('\n=== Phase 3C flags OFF — gating ===');
  assert(FEATURE_FLAGS.REPO_INTELLIGENCE.HEALTH_INTELLIGENCE === false, 'HEALTH_INTELLIGENCE defaults OFF');
  assert(FEATURE_FLAGS.REPO_INTELLIGENCE.IMPACT_ANALYSIS === false, 'IMPACT_ANALYSIS defaults OFF');
  assert(FEATURE_FLAGS.REPO_INTELLIGENCE.KNOWLEDGE_GRAPH === false, 'KNOWLEDGE_GRAPH defaults OFF');

  const health = new RepositoryHealthService();
  const impact = new ImpactAnalysisService();
  const graph = new KnowledgeGraphService();

  // These must NOT touch the DB when flags are off (no getPool call) — if they
  // did, this would throw because no pool is configured in this test process.
  const h = await health.calculateHealth(123, { persist: true });
  assert(h.available === false, 'calculateHealth returns available:false when flag off');
  assert(h.overallScore === 0, 'calculateHealth overallScore 0 when flag off');
  assert((await health.getHealthTrend(123)).length === 0, 'getHealthTrend empty when flag off');
  assert((await health.detectIssues(123)).length === 0, 'detectIssues empty when flag off');
  assert((await health.getSnapshots(123)).length === 0, 'getSnapshots empty when flag off');

  const im = await impact.analyzeMethodImpact(99);
  assert(im.available === false, 'analyzeMethodImpact available:false when flag off');
  assert(im.blastRadius === 0 && im.affectedMethods.length === 0, 'impact empty when flag off');
  assert((await impact.findBreakingTests(99)).length === 0, 'findBreakingTests empty when flag off');
  const fi = await impact.analyzeFileImpact(1, 'a.ts');
  assert(fi.available === false, 'analyzeFileImpact available:false when flag off');

  const g = await graph.buildGraph(1);
  assert(g.available === false && g.nodes.length === 0, 'buildGraph empty when flag off');
  const nb = await graph.getMethodNeighborhood(1, 2);
  assert(nb.available === false, 'getMethodNeighborhood available:false when flag off');

  console.log('\n=== Health pure scoring helpers ===');
  // Weights sum to 1.0
  const wsum = Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0);
  assert(Math.abs(wsum - 1) < 1e-9, 'HEALTH_WEIGHTS sum to 1.0');

  assert(scoreToGrade(95) === 'A', 'scoreToGrade 95 -> A');
  assert(scoreToGrade(85) === 'B', 'scoreToGrade 85 -> B');
  assert(scoreToGrade(72) === 'C', 'scoreToGrade 72 -> C');
  assert(scoreToGrade(61) === 'D', 'scoreToGrade 61 -> D');
  assert(scoreToGrade(40) === 'F', 'scoreToGrade 40 -> F');

  // scoreComplexity: short simple method = 100; huge fan-out + long = low
  assert(health.scoreComplexity(0, 0) === 100, 'scoreComplexity(0,0) = 100 (trivial)');
  assert(health.scoreComplexity(10, 0) > 90, 'scoreComplexity(10,0) > 90 (simple, tiny penalty)');
  const big = health.scoreComplexity(100, 20);
  assert(big >= 0 && big <= 5, 'scoreComplexity(100,20) near 0 (very complex)');
  assert(health.scoreComplexity(40, 0) < 100 && health.scoreComplexity(40, 0) > 50, 'scoreComplexity scales with size');

  // Sub-score helpers on synthetic metric arrays.
  const mk = (over: Partial<any> = {}) => ({
    id: 1, methodName: 'm', filePath: 'f.ts', methodType: 'helper',
    usageCount: 0, lineCount: 10, hasDescription: false, codeHash: null,
    fanOut: 0, fanIn: 0, ...over,
  });

  // Quality: all documented + reasonable size = 100
  const allGood = [mk({ hasDescription: true, lineCount: 20 }), mk({ hasDescription: true, lineCount: 30 })];
  assert(health.calculateQualityScore(allGood as any) === 100, 'calculateQualityScore all-good = 100');
  assert(health.calculateQualityScore([] as any) === 0, 'calculateQualityScore empty = 0');

  // Coverage: 1 test + 1 prod method = 100; 0 tests = 0
  const cov = [mk({ methodType: 'test' }), mk({ methodType: 'helper' })];
  assert(health.calculateCoverage(cov as any) === 100, 'calculateCoverage 1:1 = 100');
  assert(health.calculateCoverage([mk({ methodType: 'helper' })] as any) === 0, 'calculateCoverage no tests = 0');

  // Reuse: one reused (fanIn>0), one not = 50
  const reuse = [mk({ fanIn: 2 }), mk({ fanIn: 0, usageCount: 0 })];
  assert(health.calculateReuse(reuse as any) === 50, 'calculateReuse half reused = 50');

  // Duplication: two methods sharing a hash = 0 (fully duplicated)
  const dup = [mk({ codeHash: 'x' }), mk({ codeHash: 'x' })];
  assert(health.calculateDuplication(dup as any) === 0, 'calculateDuplication all-dup = 0');
  const noDup = [mk({ codeHash: 'a' }), mk({ codeHash: 'b' })];
  assert(health.calculateDuplication(noDup as any) === 100, 'calculateDuplication unique = 100');
  assert(health.calculateDuplication([mk({ codeHash: null })] as any) === 100, 'calculateDuplication no-hash = 100');

  console.log('\n=== Impact pure helpers ===');
  const deduped = impact.deduplicateById([
    { id: 1, methodName: 'a', filePath: 'f', methodType: 'helper', depth: 3 },
    { id: 1, methodName: 'a', filePath: 'f', methodType: 'helper', depth: 1 },
    { id: 2, methodName: 'b', filePath: 'f', methodType: 'test', depth: 2 },
  ]);
  assert(deduped.length === 2, 'deduplicateById removes duplicate ids');
  assert(deduped.find(d => d.id === 1)!.depth === 1, 'deduplicateById keeps shallowest depth');
  assert(deduped[0].id === 1 && deduped[1].id === 2, 'deduplicateById sorted by depth');

  console.log('\n=== Knowledge graph pure helpers ===');
  assert(graph.hashString('src/foo.ts') === graph.hashString('src/foo.ts'), 'hashString deterministic');
  assert(graph.hashString('a') >= 0 && graph.hashString('a') < 20, 'hashString within 0..19');
  const grouped = graph.groupByFile([
    { id: 1, filePath: 'a.ts' }, { id: 2, filePath: 'a.ts' }, { id: 3, filePath: 'b.ts' },
  ]);
  assert(grouped.get('a.ts')!.length === 2 && grouped.get('b.ts')!.length === 1, 'groupByFile groups ids by file');

  const d3 = graph.exportForD3({
    available: true, repositoryContextId: 1,
    nodes: [{ id: 'm:1', label: 'foo', kind: 'method', group: 2 }],
    edges: [{ source: 'm:1', target: 'm:2', type: 'calls', weight: 3 }],
    stats: { nodeCount: 1, edgeCount: 1, fileCount: 0, testCount: 0 },
  });
  assert(d3.nodes[0].id === 'm:1' && d3.nodes[0].name === 'foo', 'exportForD3 maps node label->name');
  assert(d3.links[0].source === 'm:1' && d3.links[0].value === 3, 'exportForD3 maps edge weight->value');

  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
