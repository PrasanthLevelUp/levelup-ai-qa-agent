/**
 * Migration — seed data ROLES onto existing Test Data records (Sprint 2C).
 * ==========================================================================
 * The Dataset Resolver matches a scenario's `requiredDataRole` (e.g.
 * `registered_user`) against the ROLE TAGS on Test Data records. Brand-new
 * installs tag records at creation time, but datasets that already exist from
 * before Sprint 2C carry NO role tags — so the resolver would return `null`
 * for every one of them and users would never see the feature work.
 *
 * This migration seeds those roles ONCE, deterministically, so resolution
 * delivers value the moment the framework ships — no manual re-tagging of
 * dozens of existing datasets.
 *
 * DESIGN RULES (kept intentionally dumb — this is a seed, not intelligence):
 *   1. Derive from RECORD CONTENT first — business truth, not naming habits.
 *      (`is_admin === true` → admin_user, `status === 'locked'` → locked_account…)
 *   2. Only if content is silent, fall back to a small, explicit,
 *      version-controlled dataset-NAME map (below). Names are a convention,
 *      not truth, so they are the fallback — never the primary signal.
 *   3. Deterministic, small, idempotent. A record that ALREADY carries any
 *      canonical role is left untouched (respects manual + creation-time tags).
 *   4. The RESOLVER never sees any of this. `DATASET_ROLE_MAP` lives HERE, in
 *      the migration — the resolver only ever reads the resulting tags.
 *
 * Future datasets should receive their role at creation time; this backfill
 * exists purely to bring PRE-EXISTING data up to the same baseline. It should
 * not grow "smarter" over time.
 */

import type { PoolClient } from 'pg';

/**
 * The canonical role vocabulary the QA Knowledge Base actually asks for via
 * `requiredDataRole`. The backfill only ever seeds one of these — tagging a
 * record with a role no scenario requests would be dead weight.
 */
export const CANONICAL_ROLES = [
  'registered_user',
  'unregistered_user',
  'locked_account',
  'admin_user',
  'premium_user',
] as const;

export type CanonicalRole = (typeof CANONICAL_ROLES)[number];

const CANONICAL_SET: ReadonlySet<string> = new Set(CANONICAL_ROLES);

/**
 * Explicit, version-controlled dataset-NAME → role fallback. Used ONLY when a
 * record's content yields no role. Names are a naming convention, not business
 * truth, which is exactly why this is the fallback and never the primary
 * signal. Extend deliberately; do not turn it into fuzzy matching.
 */
export const DATASET_ROLE_MAP: Readonly<Record<string, CanonicalRole>> = Object.freeze({
  valid_users: 'registered_user',
  registered_users: 'registered_user',
  standard_users: 'registered_user',
  active_users: 'registered_user',
  locked_users: 'locked_account',
  disabled_users: 'locked_account',
  suspended_users: 'locked_account',
  admin_users: 'admin_user',
  administrators: 'admin_user',
  premium_users: 'premium_user',
  paid_users: 'premium_user',
  unregistered_users: 'unregistered_user',
  invalid_users: 'unregistered_user',
  unknown_users: 'unregistered_user',
});

/* ------------------------------------------------------------------ */
/*  Pure derivation (no DB, fully unit-testable)                       */
/* ------------------------------------------------------------------ */

const norm = (s: unknown): string => String(s ?? '').trim().toLowerCase();

/** Coerce booleans that may arrive as real booleans or the strings "true"/"false". */
function asBool(v: unknown): boolean | null {
  if (v === true || v === false) return v;
  const s = norm(v);
  if (s === 'true') return true;
  if (s === 'false') return false;
  return null;
}

/**
 * Flatten a record's stored value into a lower-cased field map. `value_jsonb`
 * is usually an object of fields; when it is a scalar/array the record's `key`
 * is the field name. Field NAMES are lower-cased; values are left as-is.
 */
function fieldsOf(record: { key?: string; values?: unknown }): Record<string, unknown> {
  const v = record.values;
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[norm(k)] = val;
    return out;
  }
  // Scalar / array value — key it under the record key.
  return record.key ? { [norm(record.key)]: v } : {};
}

/**
 * Derive a role from a record's CONTENT (business truth). First match wins, in
 * a fixed, documented priority order. Returns `null` when content is silent.
 */
export function deriveRoleFromContent(record: { key?: string; values?: unknown }): CanonicalRole | null {
  const f = fieldsOf(record);
  const pick = (...names: string[]): unknown => {
    for (const n of names) if (n in f) return f[n];
    return undefined;
  };
  const valueIn = (raw: unknown, set: Set<string>): boolean => set.has(norm(raw));

  // 1) Admin — an explicit admin flag or an admin-ish role/type value.
  if (
    asBool(pick('is_admin', 'isadmin', 'admin')) === true ||
    valueIn(pick('role', 'user_role', 'type', 'usertype', 'account_type'),
      new Set(['admin', 'administrator', 'superuser', 'super_admin', 'root']))
  ) {
    return 'admin_user';
  }

  // 2) Premium — a premium flag or a paid plan/tier value.
  if (
    asBool(pick('is_premium', 'premium')) === true ||
    valueIn(pick('plan', 'tier', 'subscription', 'membership'),
      new Set(['premium', 'pro', 'paid', 'gold', 'platinum', 'enterprise']))
  ) {
    return 'premium_user';
  }

  // 3) Locked / disabled — the account exists but cannot authenticate.
  {
    const status = norm(pick('status', 'account_status', 'state'));
    const lockedStatus = new Set(['locked', 'disabled', 'suspended', 'inactive', 'blocked', 'deactivated']);
    if (
      lockedStatus.has(status) ||
      asBool(pick('locked', 'is_locked')) === true ||
      asBool(pick('disabled', 'is_disabled')) === true ||
      asBool(pick('active', 'is_active', 'enabled', 'is_enabled')) === false
    ) {
      return 'locked_account';
    }
  }

  // 4) Unregistered — an explicit "does not exist / not registered" signal.
  {
    const status = norm(pick('status', 'account_status', 'state'));
    if (
      new Set(['unregistered', 'unknown', 'nonexistent', 'not_registered']).has(status) ||
      asBool(pick('registered', 'is_registered', 'exists')) === false
    ) {
      return 'unregistered_user';
    }
  }

  // 5) A working credential pair → an ordinary registered user.
  {
    const hasIdentifier = ['username', 'email', 'user', 'login', 'userid', 'user_id']
      .some(n => n in f && norm(f[n]).length > 0);
    const hasPassword = ['password', 'pass', 'pwd', 'passwd', 'secret']
      .some(n => n in f && norm(f[n]).length > 0);
    if (hasIdentifier && hasPassword) return 'registered_user';
  }

  return null;
}

/**
 * Derive a role for a record: CONTENT first (business truth), then the explicit
 * dataset-name fallback. Returns `null` when neither yields a role.
 */
export function deriveRole(args: {
  datasetName?: string;
  record: { key?: string; values?: unknown };
}): CanonicalRole | null {
  const fromContent = deriveRoleFromContent(args.record);
  if (fromContent) return fromContent;
  const byName = DATASET_ROLE_MAP[norm(args.datasetName)];
  return byName ?? null;
}

/**
 * Decide the tags a record should carry AFTER the backfill, or `null` when it
 * must be left untouched. Idempotent by construction:
 *   • a record already carrying ANY canonical role is skipped (returns null),
 *   • otherwise the derived role is appended to its existing tags (deduped).
 */
export function planRecordRoleTags(args: {
  datasetName?: string;
  record: { key?: string; values?: unknown; tags?: readonly string[] | null };
}): string[] | null {
  const existing = (args.record.tags ?? []).filter(t => typeof t === 'string');
  // Already role-tagged (manually, at creation, or by a previous run) → skip.
  if (existing.some(t => CANONICAL_SET.has(norm(t)))) return null;
  const role = deriveRole({ datasetName: args.datasetName, record: args.record });
  if (!role) return null;
  if (existing.map(norm).includes(role)) return null;
  return [...existing, role];
}

/* ------------------------------------------------------------------ */
/*  DB backfill (thin — applies the pure logic idempotently)           */
/* ------------------------------------------------------------------ */

export interface BackfillResult {
  scanned: number;
  tagged: number;
  skipped: number;
}

/**
 * Seed role tags onto every EXISTING Test Data record that has none. Runs at
 * startup (see `migrateDefaultCompany`). Idempotent: it only looks at records
 * that carry no canonical role, so a second run tags nothing. Non-fatal by
 * design — a failure here must never block boot.
 */
export async function backfillDatasetRoleTags(client: PoolClient): Promise<BackfillResult> {
  const result: BackfillResult = { scanned: 0, tagged: 0, skipped: 0 };

  // Only records that do not yet carry ANY canonical role. The GIN index on
  // `tags` makes the overlap check cheap; after the first run this returns 0.
  const { rows } = await client.query(
    `SELECT r.id, r.key, r.value_jsonb, r.tags, s.name AS dataset_name
       FROM test_data_records r
       JOIN test_data_sets s ON s.id = r.dataset_id
      WHERE r.tags IS NULL OR NOT (r.tags && $1::text[])`,
    [Array.from(CANONICAL_ROLES)],
  );

  for (const row of rows) {
    result.scanned++;
    const nextTags = planRecordRoleTags({
      datasetName: row.dataset_name,
      record: { key: row.key, values: row.value_jsonb, tags: row.tags },
    });
    if (!nextTags) {
      result.skipped++;
      continue;
    }
    await client.query(`UPDATE test_data_records SET tags = $1, updated_at = NOW() WHERE id = $2`, [
      nextTags,
      row.id,
    ]);
    result.tagged++;
  }

  return result;
}
