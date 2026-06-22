/**
 * Test Data Store — Unit Tests
 *
 * Project-scoped, environment-aware test data for Script Generation, Framework
 * Auditor, and Healing. Tests the full QA intelligence loop: Test Data Store →
 * Auditor discovers → Test Cases reference → Generation uses.
 *
 * Requires a reachable database (DATABASE_URL). If none is configured the suite
 * SKIPS (a missing DB must not fail CI).
 *
 * Run with (live DB):
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/levelup_test \
 *   DATABASE_SSL=false npx tsx tests/unit/test-data-store.test.ts
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
  await pg.initDb(); // Two-pass for project_id columns (see script-gen-project-scoping.test.ts).
  const pool = pg.getPool();

  // ── Seed: one company, two projects ────────────────────────────────────────
  const companyId = await pg.createCompany('TestDataCo', `testdata-${Date.now()}`);
  const projA = await pg.createProject({ company_id: companyId, name: 'Project A' });
  const projB = await pg.createProject({ company_id: companyId, name: 'Project B' });

  console.log('\n=== Project Isolation ===');
  // Create datasets for each project.
  const dsA = await pg.createTestDataSet({
    companyId,
    projectId: projA.id,
    name: 'valid_users',
    description: 'Project A users',
    environment: 'shared',
  });
  const dsB = await pg.createTestDataSet({
    companyId,
    projectId: projB.id,
    name: 'valid_users',
    description: 'Project B users',
    environment: 'shared',
  });
  assert(dsA.id !== dsB.id, 'two projects can have separate datasets with the same name');

  // Add records.
  await pg.createTestDataRecord({
    datasetId: dsA.id,
    key: 'admin',
    value: { email: 'admin-a@test.com', password: 'passA' },
  });
  await pg.createTestDataRecord({
    datasetId: dsB.id,
    key: 'admin',
    value: { email: 'admin-b@test.com', password: 'passB' },
  });

  // Verify isolation: Project A only sees its dataset.
  const listA = await pg.listTestDataSets(companyId, projA.id);
  const listB = await pg.listTestDataSets(companyId, projB.id);
  assert(listA.length === 1 && listA[0].id === dsA.id, 'Project A lists only its own dataset');
  assert(listB.length === 1 && listB[0].id === dsB.id, 'Project B lists only its own dataset');

  const recordsA = await pg.getTestDataRecords(dsA.id);
  const recordsB = await pg.getTestDataRecords(dsB.id);
  assert(
    recordsA[0].value_jsonb.email === 'admin-a@test.com' &&
    recordsB[0].value_jsonb.email === 'admin-b@test.com',
    'records are NOT crossed between projects',
  );

  // Company-wide dataset (project_id NULL) should be visible to both projects.
  const dsShared = await pg.createTestDataSet({
    companyId,
    projectId: null,
    name: 'shared_config',
    environment: 'shared',
  });
  await pg.createTestDataRecord({
    datasetId: dsShared.id,
    key: 'api_url',
    value: { url: 'https://api.example.com' },
  });
  const listAWithShared = await pg.listTestDataSets(companyId, projA.id);
  const listBWithShared = await pg.listTestDataSets(companyId, projB.id);
  assert(
    listAWithShared.length === 2 && listBWithShared.length === 2,
    'company-wide (project_id NULL) dataset is visible to both projects',
  );

  console.log('\n=== Environment Fallback ===');
  // Create environment-specific datasets.
  const dsProd = await pg.createTestDataSet({
    companyId,
    projectId: projA.id,
    name: 'db_config',
    environment: 'prod',
  });
  const dsSharedEnv = await pg.createTestDataSet({
    companyId,
    projectId: projA.id,
    name: 'db_config',
    environment: 'shared',
  });
  await pg.createTestDataRecord({
    datasetId: dsProd.id,
    key: 'host',
    value: { host: 'prod-db.example.com' },
  });
  await pg.createTestDataRecord({
    datasetId: dsSharedEnv.id,
    key: 'host',
    value: { host: 'shared-db.example.com' },
  });

  // Resolve for 'prod' environment → should get prod dataset.
  const dataProd = await pg.resolveTestData('db_config', companyId, projA.id, 'prod');
  assert(
    dataProd && dataProd[0].value.host === 'prod-db.example.com',
    'resolveTestData prefers target environment (prod)',
  );

  // Resolve for 'staging' environment (not present) → should fall back to 'shared'.
  const dataStaging = await pg.resolveTestData('db_config', companyId, projA.id, 'staging');
  assert(
    dataStaging && dataStaging[0].value.host === 'shared-db.example.com',
    'resolveTestData falls back to shared when target environment not found',
  );

  console.log('\n=== Secret Resolution ===');
  // Set a Railway env var for testing.
  process.env.TEST_SECRET_PASSWORD = 'super-secret-123';

  const dsSecrets = await pg.createTestDataSet({
    companyId,
    projectId: projA.id,
    name: 'credentials',
    environment: 'shared',
  });
  await pg.createTestDataRecord({
    datasetId: dsSecrets.id,
    key: 'admin',
    value: { username: 'admin', password_placeholder: 'will be resolved' },
    isSecret: true,
    secretRef: 'TEST_SECRET_PASSWORD',
  });

  const resolved = await pg.resolveTestData('credentials', companyId, projA.id, 'shared');
  assert(
    resolved && resolved[0].value._resolved === 'super-secret-123',
    'secret references are resolved from Railway env vars',
  );

  // Clean up env var.
  delete process.env.TEST_SECRET_PASSWORD;

  console.log('\n=== Data File Materialization ===');
  const { materializeTestData, hasTestDataFiles, listTestDataFiles } = await import('../../src/services/test-data-materializer');
  const tmpRepoPath = '/tmp/test-data-repo-' + Date.now();
  const fs = await import('fs/promises');
  await fs.mkdir(tmpRepoPath, { recursive: true });

  const result = await materializeTestData(tmpRepoPath, companyId, projA.id, 'shared');
  assert(
    result.filesWritten.length > 0 && result.errors.length === 0,
    'materializeTestData writes data/*.json files with no errors',
  );

  const hasFiles = await hasTestDataFiles(tmpRepoPath);
  assert(hasFiles, 'hasTestDataFiles detects materialized data/ folder');

  const files = await listTestDataFiles(tmpRepoPath);
  assert(
    files.length > 0 && files.some(f => f.includes('valid_users')),
    'listTestDataFiles returns data/*.json paths',
  );

  // Verify file content.
  const validUsersPath = `${tmpRepoPath}/data/valid_users.json`;
  const content = await fs.readFile(validUsersPath, 'utf-8');
  const json = JSON.parse(content);
  assert(
    Array.isArray(json) && json[0].key === 'admin' && json[0].value.email === 'admin-a@test.com',
    'materialized JSON contains correct records',
  );

  // Cleanup temp repo.
  await fs.rm(tmpRepoPath, { recursive: true, force: true });

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await pool.query(`DELETE FROM test_data_records WHERE dataset_id IN (SELECT id FROM test_data_sets WHERE company_id = $1)`, [companyId]);
  await pool.query(`DELETE FROM test_data_sets WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM projects WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  console.log('  ℹ️  cleaned up seeded rows');

  await pg.closeDb();
  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
