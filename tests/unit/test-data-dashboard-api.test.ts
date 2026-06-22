/**
 * Test Data Dashboard API — Unit Tests
 *
 * Covers the DB helpers that back the dashboard UI's linkage & usage views:
 *   • getTestCasesForDatasetDetailed — "which test cases use this dataset?"
 *   • listTestCasesForProject        — picker candidates for linkage management
 *
 * Both must stay project/company scoped (same isolation discipline as PR #118).
 *
 * Requires a reachable database (DATABASE_URL). If none is configured the suite
 * SKIPS (a missing DB must not fail CI).
 *
 * Run with (live DB):
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/levelup_test \
 *   DATABASE_SSL=false npx tsx tests/unit/test-data-dashboard-api.test.ts
 */

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
  await pg.initDb();
  await pg.initDb(); // Two-pass for migrations.
  const pool = pg.getPool();

  const ts = Date.now();
  const companyId = await pg.createCompany(`DashCo-${ts}`, `dash-${ts}`);
  const projA = await pg.createProject({ company_id: companyId, name: 'Dash Project A' });
  const projB = await pg.createProject({ company_id: companyId, name: 'Dash Project B' });

  // Requirement → scenario → two test cases in project A.
  const reqA = await pg.createTestRequirement({
    companyId, projectId: projA.id, title: 'Dash Req A', description: 'desc',
  });
  const scenRes = await pool.query(
    `INSERT INTO generated_test_scenarios (requirement_id, scenario, coverage_type, company_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [reqA, 'Dash Scenario A', 'functional', companyId],
  );
  const scenarioA = scenRes.rows[0];
  const tc1Res = await pool.query(
    `INSERT INTO generated_test_cases (scenario_id, title, expected_result, priority, company_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [scenarioA.id, 'TC-001 Login', 'logged in', 'P0', companyId],
  );
  const tc1 = tc1Res.rows[0].id;
  const tc2Res = await pool.query(
    `INSERT INTO generated_test_cases (scenario_id, title, expected_result, priority, company_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [scenarioA.id, 'TC-002 Checkout', 'checked out', 'P1', companyId],
  );
  const tc2 = tc2Res.rows[0].id;

  // A test case in project B (must NOT appear in project A's picker).
  const reqB = await pg.createTestRequirement({
    companyId, projectId: projB.id, title: 'Dash Req B', description: 'desc',
  });
  const scenBRes = await pool.query(
    `INSERT INTO generated_test_scenarios (requirement_id, scenario, coverage_type, company_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [reqB, 'Dash Scenario B', 'functional', companyId],
  );
  await pool.query(
    `INSERT INTO generated_test_cases (scenario_id, title, expected_result, priority, company_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [scenBRes.rows[0].id, 'TC-B Only', 'b', 'P2', companyId],
  );

  // Datasets + linkage.
  const dsValid = await pg.createTestDataSet({ companyId, projectId: projA.id, name: `valid_users_${ts}`, environment: 'shared' });
  await pg.createTestDataRecord({ datasetId: dsValid.id, key: 'admin', value: { u: 'a' } });
  await pg.linkTestCaseToDataset(tc1, dsValid.id);

  // ── listTestCasesForProject ─────────────────────────────────────────────────
  console.log('\n=== listTestCasesForProject ===');
  const candidatesA = await pg.listTestCasesForProject(companyId, projA.id);
  const idsA = candidatesA.map(c => c.id);
  assert(idsA.includes(tc1) && idsA.includes(tc2), 'project A picker includes its two test cases');
  assert(candidatesA.every(c => c.title && c.requirement), 'candidates carry title + requirement for display');

  const candidatesB = await pg.listTestCasesForProject(companyId, projB.id);
  assert(!candidatesB.some(c => c.id === tc1), 'project B picker excludes project A test cases (isolation)');

  // ── getTestCasesForDatasetDetailed ──────────────────────────────────────────
  console.log('\n=== getTestCasesForDatasetDetailed ===');
  const usage = await pg.getTestCasesForDatasetDetailed(dsValid.id);
  assert(usage.length === 1 && usage[0].id === tc1, 'usage shows exactly the linked test case (TC-001)');
  assert(usage[0].title === 'TC-001 Login' && usage[0].scenario === 'Dash Scenario A', 'usage row carries title + scenario');

  await pg.unlinkTestCaseFromDataset(tc1, dsValid.id);
  const usageAfter = await pg.getTestCasesForDatasetDetailed(dsValid.id);
  assert(usageAfter.length === 0, 'usage empties after unlink');

  // Cleanup — dependency order (no global cascade from companies).
  await pool.query(`DELETE FROM test_data_records WHERE dataset_id IN (SELECT id FROM test_data_sets WHERE company_id = $1)`, [companyId]);
  await pool.query(`DELETE FROM test_data_sets WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM generated_test_cases WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM generated_test_scenarios WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM test_requirements WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM projects WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  console.log('  ℹ️  cleaned up seeded rows');

  await pg.closeDb();

  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
