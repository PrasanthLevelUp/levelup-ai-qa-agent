/**
 * Repository Intelligence Phase 3C — REAL Postgres integration (flags ON).
 *
 * Exercises the health scoring, impact-analysis recursive CTEs and knowledge
 * graph builder end-to-end against a live PostgreSQL database, using a small
 * synthetic method graph seeded into `repository_methods` /
 * `method_dependencies`.
 *
 * Requires a reachable database (DATABASE_URL). If none is configured the suite
 * SKIPS (a missing DB must not fail CI). All Phase 3 + 3C flags are set BEFORE
 * any project module is imported, because feature flags are frozen at
 * features.ts import time — so every project import below is a dynamic import()
 * inside main().
 *
 * Run with (live DB):
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/levelup_test \
 *   DATABASE_SSL=false npx tsx tests/unit/repo-intelligence-phase3c-db.test.ts
 */

process.env.ENABLE_METHOD_INTELLIGENCE = 'true';
process.env.ENABLE_HEALTH_INTELLIGENCE = 'true';
process.env.ENABLE_IMPACT_ANALYSIS = 'true';
process.env.ENABLE_KNOWLEDGE_GRAPH = 'true';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.log('⏭️  SKIP — DATABASE_URL not set (live-DB integration test)');
    process.exit(0);
  }

  const pg = await import('../../src/db/postgres');
  const { repositoryHealthService } = await import('../../src/services/repository-health-service');
  const { impactAnalysisService } = await import('../../src/services/impact-analysis-service');
  const { knowledgeGraphService } = await import('../../src/services/knowledge-graph-service');

  console.log('\n=== Phase 3C live-DB integration (flags ON) ===');
  await pg.initDb();

  assert(pg.isMethodIntelAvailable() === true, 'method-intelligence schema available');
  assert(pg.isHealthIntelAvailable() === true, 'health-intelligence schema available');

  const pool = pg.getPool();

  // Seed a repository context (FK target). Unique repo_id per run.
  const repoId = `phase3c-test-${Date.now()}`;
  const ctxRes = await pool.query(
    `INSERT INTO repository_contexts (repo_id, profile, profile_version)
     VALUES ($1, '{}'::jsonb, 1) RETURNING id`,
    [repoId],
  );
  const ctxId = ctxRes.rows[0].id as number;
  console.log(`  ℹ️  seeded repository_context id=${ctxId}`);

  // Build a small graph:
  //   testLogin (test)  --calls--> login (page_object_method) --calls--> click (helper)
  //   login also --calls--> waitForSpinner (helper, also called by openCart)
  //   openCart (page_object_method) --calls--> waitForSpinner
  //   orphan (helper) — unused, no description, long (complexity issue)
  //   dupA / dupB (helper) — identical code_hash (duplicate issue)
  const mk = (over: Partial<any>) => ({
    repositoryContextId: ctxId,
    methodName: 'x', filePath: 'f.ts', className: null,
    parameters: [], returnType: null, isAsync: false,
    methodType: 'helper', sourceCode: 'code', codeHash: 'h',
    lineStart: 1, lineEnd: 10, description: 'desc', tags: [],
    ...over,
  });

  const methods = [
    mk({ methodName: 'testLogin', filePath: 'login.spec.ts', methodType: 'test', codeHash: 'c-testLogin', lineEnd: 8, description: 'test' }),
    mk({ methodName: 'login', filePath: 'LoginPage.ts', methodType: 'page_object_method', codeHash: 'c-login', lineEnd: 25, description: 'logs in' }),
    mk({ methodName: 'click', filePath: 'BasePage.ts', methodType: 'helper', codeHash: 'c-click', lineEnd: 5, description: 'clicks' }),
    mk({ methodName: 'waitForSpinner', filePath: 'BasePage.ts', methodType: 'helper', codeHash: 'c-wait', lineEnd: 12, description: 'waits' }),
    mk({ methodName: 'openCart', filePath: 'CartPage.ts', methodType: 'page_object_method', codeHash: 'c-cart', lineEnd: 20, description: 'opens' }),
    mk({ methodName: 'orphan', filePath: 'Dead.ts', methodType: 'helper', codeHash: 'c-orphan', lineStart: 1, lineEnd: 200, description: null }),
    mk({ methodName: 'dupA', filePath: 'DupA.ts', methodType: 'helper', codeHash: 'dup-hash', lineEnd: 6, description: 'd' }),
    mk({ methodName: 'dupB', filePath: 'DupB.ts', methodType: 'helper', codeHash: 'dup-hash', lineEnd: 6, description: 'd' }),
  ];

  const { stored, idByName } = await pg.replaceRepositoryMethods(ctxId, methods as any);
  assert(stored === methods.length, `stored all ${methods.length} methods (got ${stored})`);

  const id = (n: string) => idByName.get(n)!;
  await pg.upsertMethodDependency(id('testLogin'), id('login'));
  await pg.upsertMethodDependency(id('login'), id('click'));
  await pg.upsertMethodDependency(id('login'), id('waitForSpinner'));
  await pg.upsertMethodDependency(id('openCart'), id('waitForSpinner'));

  // ── Health scoring ──────────────────────────────────────────────────────
  console.log('\n--- Health ---');
  const health = await repositoryHealthService.calculateHealth(ctxId, { persist: true });
  assert(health.available === true, 'health available');
  assert(health.totals.methods === 8, `total methods = 8 (got ${health.totals.methods})`);
  assert(health.totals.tests === 1, `total tests = 1 (got ${health.totals.tests})`);
  assert(health.overallScore > 0 && health.overallScore <= 100, `overall score in (0,100]: ${health.overallScore}`);
  assert(['A', 'B', 'C', 'D', 'F'].includes(health.grade), `grade assigned: ${health.grade}`);
  // duplication < 100 because dupA/dupB share a hash
  assert(health.subScores.duplication < 100, `duplication penalised: ${health.subScores.duplication}`);
  // reuse > 0 because click/waitForSpinner/login have incoming edges
  assert(health.subScores.reuse > 0, `reuse > 0: ${health.subScores.reuse}`);

  const snaps = await repositoryHealthService.getSnapshots(ctxId, 5);
  assert(snaps.length === 1, `snapshot persisted (got ${snaps.length})`);
  assert(Math.abs(snaps[0].overallScore - health.overallScore) < 0.01, 'snapshot overall matches computed');

  // Re-run same day overwrites (no duplicate row).
  await repositoryHealthService.calculateHealth(ctxId, { persist: true });
  const snaps2 = await repositoryHealthService.getSnapshots(ctxId, 5);
  assert(snaps2.length === 1, 'same-day re-run upserts (still 1 snapshot)');

  // Issues detection
  const issues = await repositoryHealthService.detectIssues(ctxId);
  assert(issues.some(i => i.issueType === 'duplicate' && (i.methodName === 'dupA' || i.methodName === 'dupB')), 'duplicate issue detected');
  assert(issues.some(i => i.issueType === 'unused' && i.methodName === 'orphan'), 'unused issue detected (orphan)');
  assert(issues.some(i => i.issueType === 'high_complexity' && i.methodName === 'orphan'), 'high_complexity issue detected (200-line orphan)');
  const persistedIssues = await pg.getQualityIssues(ctxId, {});
  assert(persistedIssues.length === issues.length, `issues persisted (${persistedIssues.length})`);

  // ── Impact analysis (recursive CTE) ───────────────────────────────────────
  console.log('\n--- Impact ---');
  // Who breaks if `click` changes? -> login (depth 1) -> testLogin (depth 2)
  const clickImpact = await impactAnalysisService.analyzeMethodImpact(id('click'));
  assert(clickImpact.available === true, 'click impact available');
  const names = clickImpact.affectedMethods.map(m => m.methodName).sort();
  assert(names.includes('login') && names.includes('testLogin'), 'click impact reaches login + testLogin transitively');
  assert(clickImpact.blastRadius === 2, `click blast radius = 2 (got ${clickImpact.blastRadius})`);
  assert(clickImpact.maxDepth === 2, `click max depth = 2 (got ${clickImpact.maxDepth})`);
  assert(clickImpact.affectedTests.length === 1 && clickImpact.affectedTests[0].methodName === 'testLogin', 'click breaks testLogin');
  assert(clickImpact.dependencyChains.length >= 1, 'dependency chain returned');
  const chain = clickImpact.dependencyChains[0].map(s => s.methodName);
  assert(chain[0] === 'testLogin' && chain[chain.length - 1] === 'click', `chain runs testLogin..click: ${chain.join('->')}`);

  // waitForSpinner is called by login AND openCart -> blast includes login, testLogin, openCart
  const waitImpact = await impactAnalysisService.analyzeMethodImpact(id('waitForSpinner'));
  const waitNames = waitImpact.affectedMethods.map(m => m.methodName).sort();
  assert(['login', 'openCart', 'testLogin'].every(n => waitNames.includes(n)), 'waitForSpinner impacts login, openCart, testLogin');
  assert(waitImpact.blastRadius === 3, `waitForSpinner blast radius = 3 (got ${waitImpact.blastRadius})`);

  // orphan has no callers -> empty blast radius
  const orphanImpact = await impactAnalysisService.analyzeMethodImpact(id('orphan'));
  assert(orphanImpact.available === true && orphanImpact.blastRadius === 0, 'orphan blast radius = 0');

  // findBreakingTests convenience
  const breaking = await impactAnalysisService.findBreakingTests(id('click'));
  assert(breaking.length === 1 && breaking[0].methodName === 'testLogin', 'findBreakingTests(click) = [testLogin]');

  // file impact: changing BasePage.ts (click + waitForSpinner) affects login/testLogin/openCart
  const fileImpact = await impactAnalysisService.analyzeFileImpact(ctxId, 'BasePage.ts');
  assert(fileImpact.available === true, 'file impact available');
  assert(fileImpact.changedMethods === 2, `BasePage.ts has 2 methods (got ${fileImpact.changedMethods})`);
  const fileNames = fileImpact.affectedMethods.map(m => m.methodName).sort();
  assert(['login', 'openCart', 'testLogin'].every(n => fileNames.includes(n)), 'BasePage.ts impact reaches login/openCart/testLogin');
  assert(!fileNames.includes('click') && !fileNames.includes('waitForSpinner'), 'file impact excludes same-file methods');

  // ── Knowledge graph ───────────────────────────────────────────────────────
  console.log('\n--- Knowledge Graph ---');
  const graph = await knowledgeGraphService.buildGraph(ctxId);
  assert(graph.available === true, 'graph available');
  // 8 method nodes + file nodes (6 distinct files)
  const methodNodes = graph.nodes.filter(n => n.kind === 'method' || n.kind === 'test');
  const fileNodes = graph.nodes.filter(n => n.kind === 'file');
  assert(methodNodes.length === 8, `8 method/test nodes (got ${methodNodes.length})`);
  assert(graph.stats.testCount === 1, `graph testCount = 1 (got ${graph.stats.testCount})`);
  assert(fileNodes.length === graph.stats.fileCount && fileNodes.length === 7, `7 distinct file nodes (got ${fileNodes.length})`);
  // calls edges = 4 method->method; in_file edges = 8
  const callEdges = graph.edges.filter(e => e.type === 'calls' || e.type === 'tests');
  const inFileEdges = graph.edges.filter(e => e.type === 'in_file');
  assert(callEdges.length === 4, `4 call/tests edges (got ${callEdges.length})`);
  assert(inFileEdges.length === 8, `8 in_file edges (got ${inFileEdges.length})`);
  // testLogin -> login should be a 'tests' edge
  assert(graph.edges.some(e => e.type === 'tests' && e.source === `m:${id('testLogin')}`), 'testLogin->login is a tests edge');

  const d3 = knowledgeGraphService.exportForD3(graph);
  assert(d3.nodes.length === graph.nodes.length && d3.links.length === graph.edges.length, 'D3 export node/link counts match');
  assert(d3.nodes.every(n => typeof n.id === 'string' && typeof n.group === 'number'), 'D3 nodes well-formed');

  // neighborhood around login (depth 1): login, click, waitForSpinner, testLogin
  const nb = await knowledgeGraphService.getMethodNeighborhood(id('login'), 1);
  assert(nb.available === true, 'neighborhood available');
  const nbNames = nb.nodes.map(n => n.label).sort();
  assert(['click', 'login', 'testLogin', 'waitForSpinner'].every(n => nbNames.includes(n)), 'login depth-1 neighborhood correct');

  // Cleanup (cascade deletes methods/deps/snapshots/issues).
  await pool.query(`DELETE FROM repository_contexts WHERE id = $1`, [ctxId]);
  console.log(`  ℹ️  cleaned up context id=${ctxId}`);

  await pg.closeDb();
  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
