/**
 * Script Generation — strict project scoping (cross-project leak guard).
 *
 * Reproduces and locks down the reported bug: Script Generation was pulling
 * ANOTHER project's profile locators. Repository Intelligence (repository_contexts)
 * and legacy application knowledge (application_knowledge) MUST be resolved
 * strictly within company_id + project_id — Project A must never receive
 * Project B's scanned page-objects / locators or module knowledge.
 *
 * This is a REAL Postgres integration test. It seeds two projects in the same
 * company that share the SAME repo_id, gives each its own scanned profile +
 * knowledge, and asserts each project only ever sees its own data (with a
 * graceful fall-back to company-wide rows where project_id IS NULL).
 *
 * Requires a reachable database (DATABASE_URL). If none is configured the suite
 * SKIPS (a missing DB must not fail CI).
 *
 * Run with (live DB):
 *   DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/levelup_test \
 *   DATABASE_SSL=false npx tsx tests/unit/script-gen-project-scoping.test.ts
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
  // Two passes: the additive project_id ALTERs live in one atomic DO-block that
  // references tables created across the whole schema. On a brand-new database
  // the first pass creates every table; the second pass then applies the
  // project_id columns/indexes (production DBs reach this steady state
  // incrementally). Idempotent, so re-running is safe.
  await pg.initDb();
  await pg.initDb();
  const pool = pg.getPool();

  // ── Seed: one company, two projects, one shared repo_id ───────────────────
  const companyId = await pg.createCompany('ScopeCo', `scopeco-${Date.now()}`);
  const projA = await pg.createProject({ company_id: companyId, name: 'Project A' });
  const projB = await pg.createProject({ company_id: companyId, name: 'Project B' });
  const repoId = `github.com/acme/shared-repo#${Date.now()}`;

  // Distinct scanned profiles per project — different page-object locators.
  const profileA: any = {
    framework: 'playwright', language: 'typescript', testPattern: 'pom',
    pageObjects: [{ name: 'LoginPageA', selectors: { submit: '#a-login-btn' } }],
    helperFunctions: [], fixtures: [],
  };
  const profileB: any = {
    framework: 'playwright', language: 'typescript', testPattern: 'pom',
    pageObjects: [{ name: 'LoginPageB', selectors: { submit: '#b-login-btn' } }],
    helperFunctions: [], fixtures: [],
  };

  console.log('\n=== Repository context scoping ===');
  const idA = await pg.saveRepositoryContext(repoId, profileA, 10, companyId, projA.id);
  const idB = await pg.saveRepositoryContext(repoId, profileB, 10, companyId, projB.id);
  assert(idA !== idB, 'two projects sharing a repo keep SEPARATE context rows (no clobber)');

  const gotA = await pg.getRepositoryContext(repoId, companyId, projA.id);
  const gotB = await pg.getRepositoryContext(repoId, companyId, projB.id);
  assert(gotA?.pageObjects?.[0]?.name === 'LoginPageA', 'Project A resolves its OWN repo profile');
  assert(gotB?.pageObjects?.[0]?.name === 'LoginPageB', 'Project B resolves its OWN repo profile');
  assert(
    (gotA as any)?.pageObjects?.[0]?.selectors?.submit === '#a-login-btn' &&
    (gotB as any)?.pageObjects?.[0]?.selectors?.submit === '#b-login-btn',
    'locators are NOT crossed between projects (the reported leak)',
  );

  // A project with NO scanned context for this repo must NOT inherit another
  // project's profile — it gets null (→ greenfield) instead of leaking.
  const projC = await pg.createProject({ company_id: companyId, name: 'Project C' });
  const gotC = await pg.getRepositoryContext(repoId, companyId, projC.id);
  assert(gotC === null, 'unscanned Project C gets NULL (greenfield), never another project\'s locators');

  // Company-wide row (project_id NULL) should still be visible as a fallback.
  const repoId2 = `github.com/acme/legacy-repo#${Date.now()}`;
  const legacyProfile: any = { framework: 'playwright', language: 'typescript', testPattern: 'pom', pageObjects: [{ name: 'LegacyPage' }], helperFunctions: [], fixtures: [] };
  await pg.saveRepositoryContext(repoId2, legacyProfile, 10, companyId); // no projectId → company-wide
  const legacyForA = await pg.getRepositoryContext(repoId2, companyId, projA.id);
  assert(legacyForA?.pageObjects?.[0]?.name === 'LegacyPage', 'company-wide (project_id NULL) profile still falls back for any project');

  // ── Application knowledge scoping ─────────────────────────────────────────
  console.log('\n=== Application knowledge scoping ===');
  await pg.upsertApplicationKnowledge({ module: 'Checkout', workflow: 'A-flow', companyId, projectId: projA.id });
  await pg.upsertApplicationKnowledge({ module: 'Checkout', workflow: 'B-flow', companyId, projectId: projB.id });
  await pg.upsertApplicationKnowledge({ module: 'Shared', workflow: 'company-wide', companyId }); // project_id NULL

  const knA = await pg.getApplicationKnowledge(companyId, projA.id);
  const knB = await pg.getApplicationKnowledge(companyId, projB.id);
  const checkoutA = knA.find((k: any) => k.module === 'Checkout');
  const checkoutB = knB.find((k: any) => k.module === 'Checkout');
  assert(checkoutA?.workflow === 'A-flow', 'Project A sees its OWN Checkout knowledge');
  assert(checkoutB?.workflow === 'B-flow', 'Project B sees its OWN Checkout knowledge');
  assert(
    !knA.some((k: any) => k.workflow === 'B-flow') && !knB.some((k: any) => k.workflow === 'A-flow'),
    'application knowledge does NOT cross between projects',
  );
  assert(
    knA.some((k: any) => k.module === 'Shared') && knB.some((k: any) => k.module === 'Shared'),
    'company-wide (project_id NULL) knowledge is shared as a fallback',
  );

  // ── Cleanup ───────────────────────────────────────────────────────────────
  await pool.query(`DELETE FROM repository_contexts WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM application_knowledge WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM projects WHERE company_id = $1`, [companyId]);
  await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  console.log('  ℹ️  cleaned up seeded rows');

  await pg.closeDb();
  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
