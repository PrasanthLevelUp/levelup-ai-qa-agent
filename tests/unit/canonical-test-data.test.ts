/**
 * Canonical Test Data model — Unit Tests
 * ======================================
 * Proves that the SINGLE canonical Test Data contract (`canonical-test-data.ts`)
 * reshapes the "field-per-record" anti-pattern into COMPLETE business entities,
 * so generated scripts consume `user.username` / `user.password` directly rather
 * than silently falling back to process.env.TEST_USERNAME / TEST_PASSWORD.
 *
 * Root cause it fixes: a "valid_users" dataset persisted as
 *     [ {key:"email", value:"pavi@x.com"}, {key:"password", value:"Pavi1812@"} ]
 * is NOT a business entity — it is the *fields* of one entity scattered across
 * rows. getRecord("valid_users") returned only the first field row, so the
 * generated login ignored the real data. The normalizer collapses those rows
 * into ONE entity record { email, username(alias), password }.
 *
 * Run with:  npx tsx tests/unit/canonical-test-data.test.ts
 */

import {
  normalizeDataset,
  normalizeResolvedTestData,
  RawDataset,
} from '../../src/script-gen/canonical-test-data';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function main() {
  console.log('\n── Field-per-record collapse (the CRITICAL fix) ──');
  {
    const raw: RawDataset = {
      name: 'valid_users',
      environment: 'shared',
      records: [
        { key: 'email', value: 'pavi@example.com' },
        { key: 'password', value: 'Pavi1812@' },
      ],
    };
    const ds = normalizeDataset(raw);
    assert(ds.records.length === 1, 'two field rows → ONE entity record');
    assert(ds.diagnostics.reshaped === true, 'diagnostics.reshaped = true');
    assert(ds.diagnostics.sourceShape === 'field-per-record', 'shape detected = field-per-record');
    const e = ds.records[0].value;
    assert(e.email === 'pavi@example.com', 'entity carries email field');
    assert(e.password === 'Pavi1812@', 'entity carries password field');
    assert(e.username === 'pavi@example.com', 'email aliased to username (email-auth login binds)');
    assert(ds.records[0].key === 'pavi', 'entity key derived from email local part');
    assert(ds.diagnostics.warnings.length === 1, 'a re-materialization warning is surfaced');
  }

  console.log('\n── Field-per-record with explicit username + password ──');
  {
    const raw: RawDataset = {
      name: 'valid_users',
      records: [
        { key: 'username', value: 'standard_user' },
        { key: 'password', value: 'secret_sauce' },
      ],
    };
    const ds = normalizeDataset(raw);
    assert(ds.records.length === 1, 'collapsed into ONE entity');
    const e = ds.records[0].value;
    assert(e.username === 'standard_user', 'username preserved (no alias overwrite)');
    assert(e.password === 'secret_sauce', 'password preserved');
    assert(ds.records[0].key === 'standard_user', 'key derived from username');
  }

  console.log('\n── Already-entity record passes through ──');
  {
    const raw: RawDataset = {
      name: 'valid_users',
      records: [
        { key: 'standard_user', value: { username: 'standard_user', password: 'secret_sauce' } },
      ],
    };
    const ds = normalizeDataset(raw);
    assert(ds.records.length === 1, 'entity record kept as-is');
    assert(ds.diagnostics.reshaped === false, 'not reshaped');
    assert(ds.diagnostics.sourceShape === 'entity-records', 'shape = entity-records');
    assert(ds.records[0].value.username === 'standard_user', 'username intact');
    assert(ds.records[0].value.password === 'secret_sauce', 'password intact');
  }

  console.log('\n── Entity record with email but no username gets alias ──');
  {
    const raw: RawDataset = {
      name: 'valid_users',
      records: [{ key: 'pavi', value: { email: 'pavi@example.com', password: 'x' } }],
    };
    const ds = normalizeDataset(raw);
    assert(ds.records[0].value.username === 'pavi@example.com', 'email aliased to username on entity record too');
  }

  console.log('\n── Multiple entity records (list of users) ──');
  {
    const raw: RawDataset = {
      name: 'valid_users',
      records: [
        { key: 'u1', value: { username: 'u1', password: 'p1' } },
        { key: 'u2', value: { username: 'u2', password: 'p2' } },
      ],
    };
    const ds = normalizeDataset(raw);
    assert(ds.records.length === 2, 'both entities preserved (not collapsed)');
    assert(ds.diagnostics.reshaped === false, 'entity list not reshaped');
  }

  console.log('\n── Field-name aliasing (e-mail, user_name, pwd) ──');
  {
    const raw: RawDataset = {
      name: 'valid_users',
      records: [
        { key: 'e-mail', value: 'a@b.com' },
        { key: 'pwd', value: 'p' },
      ],
    };
    const ds = normalizeDataset(raw);
    const e = ds.records[0].value;
    assert(e.email === 'a@b.com', 'e-mail normalized to email');
    assert(e.password === 'p', 'pwd normalized to password');
  }

  console.log('\n── Tags union across collapsed rows ──');
  {
    const raw: RawDataset = {
      name: 'valid_users',
      records: [
        { key: 'email', value: 'a@b.com', tags: ['smoke'] },
        { key: 'password', value: 'p', tags: ['login'] },
      ],
    };
    const ds = normalizeDataset(raw);
    const tags = ds.records[0].tags ?? [];
    assert(tags.includes('smoke') && tags.includes('login'), 'tags unioned from all field rows');
  }

  console.log('\n── Custom (non-vocab) scalar field preserved ──');
  {
    const raw: RawDataset = {
      name: 'valid_users',
      records: [
        { key: 'email', value: 'a@b.com' },
        { key: 'password', value: 'p' },
        { key: 'nickname', value: 'Ace' },
      ],
    };
    const ds = normalizeDataset(raw);
    assert(ds.records.length === 1, 'custom scalar folded into same entity');
    assert(ds.records[0].value.nickname === 'Ace', 'custom field kept');
  }

  console.log('\n── Empty dataset ──');
  {
    const ds = normalizeDataset({ name: 'empty', records: [] });
    assert(ds.records.length === 0, 'no records');
    assert(ds.diagnostics.sourceShape === 'empty', 'shape = empty');
    assert(ds.diagnostics.reshaped === false, 'not reshaped');
  }

  console.log('\n── normalizeResolvedTestData aggregate ──');
  {
    const out = normalizeResolvedTestData([
      { name: 'valid_users', records: [
        { key: 'email', value: 'pavi@example.com' },
        { key: 'password', value: 'Pavi1812@' },
      ] },
      { name: 'products', records: [
        { key: 'p1', value: { sku: 'ABC', price: 9.99 } },
      ] },
    ]);
    assert(out.datasets.length === 2, 'both datasets normalized');
    assert(out.reshapedAny === true, 'reshapedAny flagged when any dataset collapsed');
    assert(out.warnings.length === 1, 'warning surfaced for the reshaped dataset only');
    const users = out.datasets.find((d) => d.name === 'valid_users')!;
    assert(users.records[0].value.username === 'pavi@example.com', 'aggregate: user entity carries aliased username');
  }

  console.log('\n── Guards: malformed datasets skipped ──');
  {
    const out = normalizeResolvedTestData([
      { name: '', records: [{ key: 'x', value: 1 }] } as any,
      { name: 'ok', records: null } as any,
      undefined as any,
    ]);
    assert(out.datasets.length === 0, 'nameless / non-array / undefined datasets skipped');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
