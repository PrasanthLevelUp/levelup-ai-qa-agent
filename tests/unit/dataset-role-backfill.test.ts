/**
 * Unit tests for the Sprint 2C dataset-role backfill (pure derivation).
 * ==========================================================================
 * The DB apply step is a thin wrapper; the interesting, risk-bearing logic is
 * the DETERMINISTIC derivation — content first (business truth), then an
 * explicit dataset-name fallback. These tests pin that behaviour down.
 */

import {
  CANONICAL_ROLES,
  DATASET_ROLE_MAP,
  deriveRoleFromContent,
  deriveRole,
  planRecordRoleTags,
} from '../../src/db/migrations/dataset-role-backfill';

describe('deriveRoleFromContent — business truth, first match wins', () => {
  it('admin flag → admin_user (boolean or string)', () => {
    expect(deriveRoleFromContent({ values: { username: 'a', password: 'p', is_admin: true } })).toBe('admin_user');
    expect(deriveRoleFromContent({ values: { role: 'administrator' } })).toBe('admin_user');
    expect(deriveRoleFromContent({ values: { is_admin: 'true' } })).toBe('admin_user');
  });

  it('paid plan / premium flag → premium_user', () => {
    expect(deriveRoleFromContent({ values: { plan: 'premium' } })).toBe('premium_user');
    expect(deriveRoleFromContent({ values: { tier: 'enterprise' } })).toBe('premium_user');
    expect(deriveRoleFromContent({ values: { is_premium: true } })).toBe('premium_user');
  });

  it('locked / disabled / inactive → locked_account', () => {
    expect(deriveRoleFromContent({ values: { status: 'locked' } })).toBe('locked_account');
    expect(deriveRoleFromContent({ values: { status: 'suspended' } })).toBe('locked_account');
    expect(deriveRoleFromContent({ values: { locked: true } })).toBe('locked_account');
    // active === false is the disabled signal from the review.
    expect(deriveRoleFromContent({ values: { active: false } })).toBe('locked_account');
    expect(deriveRoleFromContent({ values: { enabled: 'false' } })).toBe('locked_account');
  });

  it('explicit not-registered signal → unregistered_user', () => {
    expect(deriveRoleFromContent({ values: { status: 'unregistered' } })).toBe('unregistered_user');
    expect(deriveRoleFromContent({ values: { registered: false } })).toBe('unregistered_user');
    expect(deriveRoleFromContent({ values: { exists: 'false' } })).toBe('unregistered_user');
  });

  it('a working credential pair → registered_user', () => {
    expect(deriveRoleFromContent({ values: { username: 'standard_user', password: 'secret' } })).toBe('registered_user');
    expect(deriveRoleFromContent({ values: { email: 'a@b.com', pwd: 'x' } })).toBe('registered_user');
  });

  it('priority: admin beats a present credential pair', () => {
    expect(
      deriveRoleFromContent({ values: { username: 'root', password: 'p', is_admin: true } }),
    ).toBe('admin_user');
  });

  it('priority: locked beats credentials (the account exists but cannot log in)', () => {
    expect(
      deriveRoleFromContent({ values: { username: 'u', password: 'p', status: 'locked' } }),
    ).toBe('locked_account');
  });

  it('scalar value keyed under the record key is inspected too', () => {
    expect(deriveRoleFromContent({ key: 'status', values: 'locked' })).toBe('locked_account');
  });

  it('silent content → null (no guess)', () => {
    expect(deriveRoleFromContent({ values: { foo: 'bar' } })).toBeNull();
    expect(deriveRoleFromContent({ values: {} })).toBeNull();
    expect(deriveRoleFromContent({ key: 'note', values: 'hello' })).toBeNull();
  });

  it('only derives roles from the canonical vocabulary', () => {
    const roles = [
      deriveRoleFromContent({ values: { is_admin: true } }),
      deriveRoleFromContent({ values: { plan: 'pro' } }),
      deriveRoleFromContent({ values: { status: 'locked' } }),
      deriveRoleFromContent({ values: { registered: false } }),
      deriveRoleFromContent({ values: { email: 'a', password: 'b' } }),
    ];
    for (const r of roles) expect(CANONICAL_ROLES).toContain(r);
  });
});

describe('deriveRole — content first, then explicit name fallback', () => {
  it('uses content when available, ignoring the dataset name', () => {
    // Name says admin, content says locked → content (business truth) wins.
    expect(
      deriveRole({ datasetName: 'admin_users', record: { values: { status: 'locked' } } }),
    ).toBe('locked_account');
  });

  it('falls back to the explicit name map only when content is silent', () => {
    expect(deriveRole({ datasetName: 'valid_users', record: { values: { note: 'x' } } })).toBe('registered_user');
    expect(deriveRole({ datasetName: 'Locked_Users', record: { values: {} } })).toBe('locked_account');
  });

  it('returns null when neither content nor the name map yields a role', () => {
    expect(deriveRole({ datasetName: 'mystery_dataset', record: { values: { note: 'x' } } })).toBeNull();
    expect(deriveRole({ record: { values: {} } })).toBeNull();
  });

  it('the name map only ever points at canonical roles', () => {
    for (const role of Object.values(DATASET_ROLE_MAP)) expect(CANONICAL_ROLES).toContain(role);
  });
});

describe('planRecordRoleTags — idempotent, additive, non-destructive', () => {
  it('appends the derived role to existing NON-role tags', () => {
    const next = planRecordRoleTags({
      datasetName: 'valid_users',
      record: { values: { username: 'u', password: 'p' }, tags: ['smoke'] },
    });
    expect(next).toEqual(['smoke', 'registered_user']);
  });

  it('skips a record that already carries a canonical role (idempotent)', () => {
    expect(
      planRecordRoleTags({
        datasetName: 'valid_users',
        record: { values: { username: 'u', password: 'p' }, tags: ['registered_user'] },
      }),
    ).toBeNull();
    // Even a DIFFERENT existing role is respected — we never add a second role.
    expect(
      planRecordRoleTags({
        datasetName: 'valid_users',
        record: { values: { username: 'u', password: 'p' }, tags: ['admin_user'] },
      }),
    ).toBeNull();
  });

  it('returns null (no change) when no role can be derived', () => {
    expect(
      planRecordRoleTags({ datasetName: 'mystery', record: { values: { foo: 'bar' }, tags: ['x'] } }),
    ).toBeNull();
  });

  it('running the plan twice is stable (idempotency)', () => {
    const rec = { values: { username: 'u', password: 'p' }, tags: [] as string[] };
    const first = planRecordRoleTags({ datasetName: 'valid_users', record: rec });
    expect(first).toEqual(['registered_user']);
    // Simulate the write, then re-run — nothing more to do.
    const second = planRecordRoleTags({ datasetName: 'valid_users', record: { ...rec, tags: first! } });
    expect(second).toBeNull();
  });

  it('does not mutate the input tags array', () => {
    const tags = ['smoke'];
    planRecordRoleTags({ datasetName: 'valid_users', record: { values: { username: 'u', password: 'p' }, tags } });
    expect(tags).toEqual(['smoke']);
  });
});
