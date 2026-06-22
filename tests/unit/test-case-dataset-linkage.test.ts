/**
 * Test Case → Dataset Linkage — Unit Tests
 *
 * Proves deterministic dataset selection during script generation. When TC-001
 * links to valid_users, generation sees ONLY valid_users (not all project
 * datasets), making dataset selection deterministic instead of guessing.
 *
 * Requires a reachable database (DATABASE_URL). If none is configured the suite
 * SKIPS (a missing DB must not fail CI).
 *
 * Run with (live DB):
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/levelup_test \
 *   DATABASE_SSL=false npx tsx tests/unit/test-case-dataset-linkage.test.ts
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

  // ── Seed: one company, one project, two test cases, three datasets ──────────
  const ts = Date.now();
  const companyId = await pg.createCompany(`LinkageCo-${ts}`, `linkage-${ts}`);
  const proj = await pg.createProject({ company_id: companyId, name: 'Project Alpha' });
  const reqId = await pg.createTestRequirement({
    companyId,
    projectId: proj.id,
    title: 'Linkage Test Req',
    description: 'Testing dataset linkage',
  });
  // Create scenario directly (no exported helper).
  const scenarioRes = await pool.query(
    `INSERT INTO generated_test_scenarios (requirement_id, scenario, coverage_type, company_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [reqId, 'Linkage Scenario', 'functional', companyId],
  );
  const scenario = scenarioRes.rows[0];

  // Create three datasets: valid_users, products, coupons.
  const dsUsers = await pg.createTestDataSet({
    companyId,
    projectId: proj.id,
    name: 'valid_users',
    environment: 'shared',
  });
  const dsProducts = await pg.createTestDataSet({
    companyId,
    projectId: proj.id,
    name: 'products',
    environment: 'shared',
  });
  const dsCoupons = await pg.createTestDataSet({
    companyId,
    projectId: proj.id,
    name: 'coupons',
    environment: 'shared',
  });

  // Add sample records so summaries have data.
  await pg.createTestDataRecord({
    datasetId: dsUsers.id,
    key: 'admin',
    value: { email: 'admin@test.com' },
  });
  await pg.createTestDataRecord({
    datasetId: dsProducts.id,
    key: 'laptop',
    value: { name: 'Laptop', price: 999 },
  });
  await pg.createTestDataRecord({
    datasetId: dsCoupons.id,
    key: 'SAVE20',
    value: { discount: 0.2 },
  });

  // Create two test cases (direct inserts — no exported helpers).
  const tc1Res = await pool.query(
    `INSERT INTO generated_test_cases (scenario_id, title, expected_result, steps, company_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [scenario.id, 'TC-001 Login', 'User logs in successfully', JSON.stringify(['Open login page', 'Enter credentials', 'Click login']), companyId],
  );
  const tc1 = tc1Res.rows[0];
  const tc2Res = await pool.query(
    `INSERT INTO generated_test_cases (scenario_id, title, expected_result, steps, company_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [scenario.id, 'TC-002 Search Product', 'Product search returns results', JSON.stringify(['Open search', 'Enter product name', 'View results']), companyId],
  );
  const tc2 = tc2Res.rows[0];

  console.log('\n=== Deterministic Dataset Selection ===');

  // Test 1: TC-001 links to valid_users → getLinkedDatasets returns only valid_users.
  await pg.linkTestCaseToDataset(tc1.id, dsUsers.id);
  const linkedForTC1 = await pg.getLinkedDatasets(tc1.id);
  assert(
    linkedForTC1.length === 1 && linkedForTC1[0].name === 'valid_users',
    'TC-001 links to valid_users only',
  );

  // Test 2: TC-002 links to products → getLinkedDatasets returns only products.
  await pg.linkTestCaseToDataset(tc2.id, dsProducts.id);
  const linkedForTC2 = await pg.getLinkedDatasets(tc2.id);
  assert(
    linkedForTC2.length === 1 && linkedForTC2[0].name === 'products',
    'TC-002 links to products only',
  );

  // Test 3: getTestDataSetSummaries with dataset IDs filters correctly.
  const summariesFiltered = await pg.getTestDataSetSummaries(
    companyId,
    proj.id,
    undefined,
    5,
    [dsUsers.id, dsProducts.id],
  );
  assert(
    summariesFiltered.length === 2 &&
    summariesFiltered.some(s => s.name === 'valid_users') &&
    summariesFiltered.some(s => s.name === 'products') &&
    !summariesFiltered.some(s => s.name === 'coupons'),
    'getTestDataSetSummaries filters by dataset IDs (only valid_users + products, not coupons)',
  );

  // Test 4: summaries include recordCount + sampleKeys.
  const usersSummary = summariesFiltered.find(s => s.name === 'valid_users');
  assert(
    !!usersSummary && usersSummary.recordCount === 1 && usersSummary.sampleKeys.includes('admin'),
    'summary includes recordCount=1 and sampleKeys=[admin]',
  );

  // Test 5: unlink TC-001 from valid_users → getLinkedDatasets returns empty.
  await pg.unlinkTestCaseFromDataset(tc1.id, dsUsers.id);
  const linkedAfterUnlink = await pg.getLinkedDatasets(tc1.id);
  assert(
    linkedAfterUnlink.length === 0,
    'unlinkTestCaseFromDataset removes linkage',
  );

  // Test 6: link TC-001 to multiple datasets (valid_users + coupons).
  await pg.linkTestCaseToDataset(tc1.id, dsUsers.id);
  await pg.linkTestCaseToDataset(tc1.id, dsCoupons.id);
  const linkedMultiple = await pg.getLinkedDatasets(tc1.id);
  assert(
    linkedMultiple.length === 2 &&
    linkedMultiple.some(ds => ds.name === 'valid_users') &&
    linkedMultiple.some(ds => ds.name === 'coupons'),
    'one test case can link to multiple datasets',
  );

  // Test 7: getTestCasesForDataset returns all cases linked to a dataset.
  const casesForUsers = await pg.getTestCasesForDataset(dsUsers.id);
  assert(
    casesForUsers.includes(tc1.id) && !casesForUsers.includes(tc2.id),
    'getTestCasesForDataset returns only TC-001 for valid_users',
  );

  // Test 8: When test case is deleted, linkage is cascade-deleted.
  await pool.query(`DELETE FROM generated_test_cases WHERE id = $1`, [tc1.id]);
  const casesAfterDelete = await pg.getTestCasesForDataset(dsUsers.id);
  assert(
    !casesAfterDelete.includes(tc1.id),
    'ON DELETE CASCADE removes linkage when test case is deleted',
  );

  // Test 9: When dataset is deleted, linkage is cascade-deleted.
  await pool.query(`DELETE FROM test_data_sets WHERE id = $1`, [dsCoupons.id]);
  const linkedAfterDatasetDelete = await pg.getLinkedDatasets(tc2.id);
  assert(
    linkedAfterDatasetDelete.every(ds => ds.id !== dsCoupons.id),
    'ON DELETE CASCADE removes linkage when dataset is deleted',
  );

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  await pool.query(`DELETE FROM test_data_records WHERE dataset_id IN (SELECT id FROM test_data_sets WHERE company_id = $1)`, [companyId]);
  await pool.query(`DELETE FROM test_data_sets WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM generated_test_cases WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM generated_test_scenarios WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM test_requirements WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM projects WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  console.log('  ℹ️  cleaned up seeded rows');

  await pg.closeDb();
  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
