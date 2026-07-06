/**
 * Requirement → Test Case resolution fallback — Unit Tests
 * ========================================================
 * Regression guard for the "requirement based generation emits 4 generic,
 * 0%-grounded scripts (smoke/search/navigation/form)" bug.
 *
 * Root cause: requirement-based script generation resolves the requirement's
 * test cases ONLY through the RTM foreign key
 * (`generated_test_cases.requirement_id`). When that FK is empty — but the
 * cases ARE linked through the denormalised `traceability_links` audit table —
 * the query returned 0 rows, so `config.testCases` was empty and the engine
 * silently dropped to the generic LLM URL-discovery path.
 *
 * `getTestCasesForRequirement` now resolves cases across ALL THREE ways a
 * requirement can be linked to its test cases, then self-heals:
 *   1. RTM foreign key (`generated_test_cases.requirement_id`),
 *   2. on 0 rows, the `traceability_links` audit table,
 *   3. on still 0 rows, a STRICTLY-GUARDED bridge to the legacy numeric
 *      requirement chain (test_requirements → generated_test_scenarios →
 *      generated_test_cases) — only when EXACTLY ONE legacy requirement in the
 *      same company shares the IDENTICAL title and has cases (ambiguity ⇒ refuse),
 *   and self-heals the RTM link (FK + traceability) so the fast path works next
 *   time. If none of the three resolve, it returns an HONEST empty result.
 *
 * These tests stub the pg pool's `query` so they run with NO database.
 * Run with:  npx tsx tests/unit/requirement-testcase-fallback.test.ts
 */

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

type QueryCall = { sql: string; params: any[] };

async function main() {
  // A dummy connection string so getPool() can build a Pool without connecting.
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgres://u:p@127.0.0.1:5432/none';
  process.env['DATABASE_SSL'] = 'false';

  const pg = await import('../../src/db/postgres');
  const pool: any = pg.getPool();

  const REQ = 'c45af114-f0cb-4547-b13e-e0d5888289ac';
  const COMPANY = 42;

  // Helper to build a canned test-case row (shape the engine consumes).
  const caseRow = (id: number, title: string) => ({
    id, title, priority: 'P1', severity: 'major',
    steps: [], expected_result: 'ok', preconditions: null, test_data: null,
    tags: [], automation_ready: true, is_automated: false,
    last_automated_script_id: null, last_automated_at: null,
    requirement_id: null, created_at: new Date().toISOString(),
    script_count: 0, automation_status: 'not_automated',
  });

  /* ── Scenario 1: FK is empty, cases recovered via traceability_links ────── */
  {
    const calls: QueryCall[] = [];
    pool.query = async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ');
      // Primary FK query → 0 rows (the bug condition).
      if (s.includes('FROM generated_test_cases tc') && s.includes('WHERE tc.requirement_id = $1')) {
        return { rows: [], rowCount: 0 };
      }
      // Traceability fallback → returns the 2 linked cases.
      if (s.includes('FROM traceability_links tl') && s.includes("tl.link_type = 'requirement_to_testcase'")) {
        return { rows: [caseRow(101, 'Valid login'), caseRow(102, 'Invalid credentials')], rowCount: 2 };
      }
      // Self-heal UPDATE.
      if (s.startsWith('UPDATE generated_test_cases SET requirement_id')) {
        return { rows: [], rowCount: 2 };
      }
      throw new Error('Unexpected SQL in scenario 1: ' + s.slice(0, 120));
    };

    const rows = await pg.getTestCasesForRequirement(REQ, COMPANY);
    assert(rows.length === 2, 'S1: recovers 2 cases via traceability when FK is empty');
    assert(rows[0].id === 101 && rows[1].id === 102, 'S1: returns the linked cases in order');

    const ranFk = calls.some(c => /WHERE tc\.requirement_id = \$1/.test(c.sql.replace(/\s+/g, ' ')));
    const ranTrace = calls.some(c => /FROM traceability_links tl/.test(c.sql));
    const ranHeal = calls.some(c => /^UPDATE generated_test_cases SET requirement_id/.test(c.sql.trim()));
    assert(ranFk, 'S1: attempted the FK query first');
    assert(ranTrace, 'S1: fell back to the traceability_links query');
    assert(ranHeal, 'S1: self-healed the FK with an UPDATE');

    // The fallback + heal must both be company-scoped (multi-tenant safety).
    const traceCall = calls.find(c => /FROM traceability_links tl/.test(c.sql))!;
    assert(traceCall.params.includes(COMPANY), 'S1: traceability query is company-scoped');
    const healCall = calls.find(c => /^UPDATE generated_test_cases SET requirement_id/.test(c.sql.trim()))!;
    assert(healCall.params.includes(REQ) && healCall.params.includes(COMPANY),
      'S1: self-heal writes the requirement UUID, company-scoped');
  }

  /* ── Scenario 2: FK populated → fast path, NO fallback, NO heal ─────────── */
  {
    const calls: QueryCall[] = [];
    pool.query = async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('FROM generated_test_cases tc') && s.includes('WHERE tc.requirement_id = $1')) {
        return { rows: [caseRow(201, 'Case A'), caseRow(202, 'Case B'), caseRow(203, 'Case C')], rowCount: 3 };
      }
      throw new Error('Unexpected SQL in scenario 2 (fallback should NOT run): ' + s.slice(0, 120));
    };

    const rows = await pg.getTestCasesForRequirement(REQ, COMPANY);
    assert(rows.length === 3, 'S2: FK fast path returns all 3 cases');
    const ranTrace = calls.some(c => /FROM traceability_links tl/.test(c.sql));
    const ranHeal = calls.some(c => /^UPDATE generated_test_cases/.test(c.sql.trim()));
    assert(!ranTrace, 'S2: does NOT run the traceability fallback when FK finds cases');
    assert(!ranHeal, 'S2: does NOT self-heal when FK already correct');
  }

  /* ── Scenario 3: FK + traceability empty, no legacy title match → honest 0 ─ */
  {
    pool.query = async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('FROM generated_test_cases tc') && s.includes('WHERE tc.requirement_id = $1')) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('FROM traceability_links tl')) {
        return { rows: [], rowCount: 0 };
      }
      // Bridge: requirement identity resolves...
      if (s.includes('SELECT title, company_id FROM requirements')) {
        return { rows: [{ title: 'User Login', company_id: COMPANY }], rowCount: 1 };
      }
      // ...but there is NO legacy requirement with that exact title that has cases.
      if (s.includes('FROM test_requirements trq')) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error('Unexpected SQL in scenario 3: ' + s.slice(0, 120));
    };
    const rows = await pg.getTestCasesForRequirement(REQ, COMPANY);
    assert(rows.length === 0, 'S3: returns empty when no FK, no traceability, and no legacy title match');
  }

  /* ── Scenario 4: traceability query throws → degrades to empty (no throw) ─ */
  {
    pool.query = async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('FROM generated_test_cases tc') && s.includes('WHERE tc.requirement_id = $1')) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('FROM traceability_links tl')) {
        throw new Error('simulated DB error');
      }
      // Bridge also finds nothing (requirement identity missing).
      if (s.includes('SELECT title, company_id FROM requirements')) {
        return { rows: [], rowCount: 0 };
      }
      throw new Error('Unexpected SQL in scenario 4: ' + s.slice(0, 120));
    };
    let threw = false;
    let rows: any[] = [];
    try { rows = await pg.getTestCasesForRequirement(REQ, COMPANY); }
    catch { threw = true; }
    assert(!threw, 'S4: a fallback DB error is swallowed (never throws to the caller)');
    assert(rows.length === 0, 'S4: degrades to empty on fallback error');
  }

  /* ── Scenario 5: legacy numeric-chain bridge — exactly ONE title match ──── */
  {
    const calls: QueryCall[] = [];
    pool.query = async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ');
      // FK + traceability both empty (cases live only under the numeric chain).
      if (s.includes('FROM generated_test_cases tc') && s.includes('WHERE tc.requirement_id = $1')) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('FROM traceability_links tl')) {
        return { rows: [], rowCount: 0 };
      }
      // Bridge: resolve requirement identity.
      if (s.includes('SELECT title, company_id FROM requirements')) {
        return { rows: [{ title: 'User Login', company_id: COMPANY }], rowCount: 1 };
      }
      // Exactly one legacy requirement with that title that has cases.
      if (s.includes('FROM test_requirements trq')) {
        return { rows: [{ id: 777, case_count: 2 }], rowCount: 1 };
      }
      // Bridged cases pulled via the scenario chain.
      if (s.includes('FROM generated_test_cases tc') && s.includes('JOIN generated_test_scenarios ts ON tc.scenario_id = ts.id')) {
        return { rows: [caseRow(301, 'Valid login'), caseRow(302, 'Locked account')], rowCount: 2 };
      }
      // Self-heal via linkTestCasesToRequirement: requirement existence check,
      // per-case UPDATE, and traceability_links INSERT — all succeed.
      if (s.includes('SELECT id FROM requirements WHERE id = $1 AND company_id')) {
        return { rows: [{ id: REQ }], rowCount: 1 };
      }
      if (s.startsWith('UPDATE generated_test_cases SET requirement_id')) {
        return { rows: [], rowCount: 1 };
      }
      if (s.includes('INSERT INTO traceability_links')) {
        return { rows: [{ id: 1 }], rowCount: 1 };
      }
      throw new Error('Unexpected SQL in scenario 5: ' + s.slice(0, 120));
    };
    const rows = await pg.getTestCasesForRequirement(REQ, COMPANY);
    assert(rows.length === 2, 'S5: bridges 2 cases from the sole exact-title legacy requirement');
    assert(rows[0].id === 301 && rows[1].id === 302, 'S5: returns the bridged cases in order');
    const ranCandidates = calls.some(c => /FROM test_requirements trq/.test(c.sql));
    const ranBridge = calls.some(c => /JOIN generated_test_scenarios ts ON tc\.scenario_id = ts\.id/.test(c.sql.replace(/\s+/g, ' ')));
    const ranHeal = calls.some(c => /^UPDATE generated_test_cases SET requirement_id/.test(c.sql.trim()));
    assert(ranCandidates, 'S5: queried legacy requirements by exact title + company');
    assert(ranBridge, 'S5: pulled cases via the numeric scenario chain');
    assert(ranHeal, 'S5: self-healed the RTM link (FK + traceability)');
    const candCall = calls.find(c => /FROM test_requirements trq/.test(c.sql))!;
    assert(candCall.params.includes(COMPANY) && candCall.params.includes('User Login'),
      'S5: title match is company-scoped and title-exact');
  }

  /* ── Scenario 6: AMBIGUOUS — 2+ legacy title matches → refuse, honest 0 ─── */
  {
    const calls: QueryCall[] = [];
    pool.query = async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ');
      if (s.includes('FROM generated_test_cases tc') && s.includes('WHERE tc.requirement_id = $1')) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('FROM traceability_links tl')) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes('SELECT title, company_id FROM requirements')) {
        return { rows: [{ title: 'User Login', company_id: COMPANY }], rowCount: 1 };
      }
      // TWO legacy requirements share the exact title → ambiguous.
      if (s.includes('FROM test_requirements trq')) {
        return { rows: [{ id: 777, case_count: 2 }, { id: 888, case_count: 5 }], rowCount: 2 };
      }
      throw new Error('Unexpected SQL in scenario 6 (must NOT bridge/heal): ' + s.slice(0, 120));
    };
    const rows = await pg.getTestCasesForRequirement(REQ, COMPANY);
    assert(rows.length === 0, 'S6: refuses to bridge when >1 legacy requirement shares the title (honest empty)');
    const ranBridge = calls.some(c => /JOIN generated_test_scenarios ts ON tc\.scenario_id = ts\.id/.test(c.sql.replace(/\s+/g, ' ')));
    const ranHeal = calls.some(c => /^UPDATE generated_test_cases SET requirement_id/.test(c.sql.trim()));
    assert(!ranBridge, 'S6: does NOT pull cases when the match is ambiguous');
    assert(!ranHeal, 'S6: does NOT self-heal when the match is ambiguous');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
