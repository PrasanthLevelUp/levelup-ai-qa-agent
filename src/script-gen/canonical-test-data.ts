/**
 * Canonical Test Data model
 * =========================
 *
 * ONE normalized contract for datasets consumed by Script Generation.
 *
 * ── The problem this solves ──────────────────────────────────────────────────
 * The Test Data Store historically persisted a "user" dataset as SEPARATE
 * key/value rows — one row PER FIELD:
 *
 *     valid_users: [
 *       { key: "email",    value: "pavi@example.com" },
 *       { key: "password", value: "Pavi1812@" },
 *     ]
 *
 * A dataset like this does NOT represent a business entity — it represents the
 * *fields* of one entity, scattered across rows. As a result:
 *   - getRecord("valid_users")           → returns only the FIRST field row
 *                                          ({ key:"email", value:"..." })
 *   - user.username / user.password       → undefined
 *   - the generated script silently fell back to process.env.TEST_USERNAME /
 *     process.env.TEST_PASSWORD, ignoring the real Test Data Store values.
 *
 * ── The fix ──────────────────────────────────────────────────────────────────
 * Datasets must represent COMPLETE business entities — one record per user, each
 * carrying all its related fields:
 *
 *     valid_users: [
 *       { key: "pavi", email: "pavi@example.com", username: "pavi@example.com",
 *         password: "Pavi1812@" }
 *     ]
 *
 * This module normalizes ANY incoming dataset shape into that canonical form:
 *   - field-per-record scalar rows          → collapsed into ONE entity record
 *   - already-entity records (object value) → passed through untouched
 *   - login field aliasing                   → `email` also exposed as `username`
 *     so login(user.username, user.password) binds to the real value even when
 *     the app authenticates by email.
 *
 * Same philosophy as canonical-test-case.ts: normalize on READ now (migration
 * layer for legacy rows) and on WRITE going forward, so the store converges on
 * the canonical entity shape and this read-side layer can eventually be removed.
 */

/** A resolved dataset as delivered to the engine (route → DB records). */
export interface RawDataset {
  name: string;
  environment?: string;
  records: Array<{ key: string; value: any; tags?: string[] }>;
}

/** A canonical entity record — one complete business entity. */
export interface CanonicalRecord {
  /** Stable identifier for the entity within its dataset (e.g. a username). */
  key: string;
  /** All entity fields (username, password, email, …). */
  value: Record<string, any>;
  tags?: string[];
}

export interface CanonicalDataset {
  name: string;
  environment?: string;
  records: CanonicalRecord[];
  /** Diagnostics — how the input was interpreted. */
  diagnostics: {
    /** True when field-per-record rows were collapsed into entity records. */
    reshaped: boolean;
    /** Original record count (before reshaping). */
    inputRecordCount: number;
    /** Canonical record count (after reshaping). */
    outputRecordCount: number;
    /** The detected input shape. */
    sourceShape:
      | 'entity-records'      // records already carry object values (one per entity)
      | 'field-per-record'    // scalar rows keyed by field name → collapsed
      | 'mixed'               // some entity, some field rows
      | 'empty';
    warnings: string[];
  };
}

/**
 * Vocabulary of known ENTITY FIELD names. A dataset whose record keys are drawn
 * from this vocabulary (with scalar values) is the "field-per-record" anti-
 * pattern — its rows are fields of a single entity, not entities themselves.
 *
 * Keys are compared after normalization (lowercased, separators stripped), so
 * "e-mail", "E_Mail" and "email" all match.
 */
const FIELD_VOCAB = new Set<string>([
  // identity / auth
  'email', 'mail', 'username', 'user', 'userid', 'login', 'loginid', 'account',
  'password', 'pass', 'pwd', 'passwd', 'passphrase', 'secret', 'otp', 'pin',
  'token', 'apikey', 'accesstoken',
  // profile
  'name', 'firstname', 'lastname', 'fullname', 'middlename', 'displayname',
  'phone', 'mobile', 'telephone', 'cell',
  'dob', 'birthdate', 'age', 'gender', 'title', 'role',
  // address
  'address', 'address1', 'address2', 'street', 'city', 'state', 'province',
  'zip', 'zipcode', 'postcode', 'postalcode', 'country', 'company',
  // payment
  'card', 'cardnumber', 'cvv', 'cvc', 'expiry', 'expirydate',
]);

/** Normalize a key/field name for vocabulary comparison. */
function normKey(k: string): string {
  return String(k).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** True when a key names a known entity field. */
function isFieldKey(k: string): boolean {
  return FIELD_VOCAB.has(normKey(k));
}

/** True when a value is a scalar (not an object/array), i.e. a single field. */
function isScalar(v: any): boolean {
  return v == null || typeof v !== 'object';
}

/**
 * Canonical field name for an entity property. Collapses separator/case
 * variations ("e-mail" → "email", "user_name" → "username") to a stable name
 * so downstream field lookups (user.username, user.password) resolve.
 */
function canonicalFieldName(k: string): string {
  const n = normKey(k);
  const aliases: Record<string, string> = {
    mail: 'email',
    user: 'username',
    userid: 'username',
    loginid: 'username',
    login: 'username',
    pass: 'password',
    pwd: 'password',
    passwd: 'password',
    firstname: 'firstName',
    lastname: 'lastName',
    fullname: 'fullName',
  };
  if (aliases[n]) return aliases[n];
  return n;
}

/**
 * Derive a stable, human-meaningful record key for a collapsed entity. Prefer a
 * username/email local-part; fall back to a name or the first scalar value.
 */
function deriveEntityKey(entity: Record<string, any>, fallback: string): string {
  const candidates = [entity.username, entity.email, entity.name, entity.fullName];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) {
      // For an email, use the local part as the key (pavi@x.com → pavi).
      const local = c.includes('@') ? c.split('@')[0] : c;
      const clean = local.trim().replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
      if (clean) return clean;
    }
  }
  return fallback;
}

/**
 * Normalize a single dataset into complete business entities.
 *
 * Rules:
 *  - When EVERY record already carries an object value → entity-records; keep.
 *  - When records are scalar rows keyed by field names → field-per-record;
 *    collapse them all into ONE entity (unique keys guarantee a single entity).
 *  - Mixed → keep object records as-is; collapse the trailing scalar field rows
 *    into one additional entity.
 *  - Login alias: an entity with `email` but no `username` gets
 *    `username = email` so login(user.username, …) binds to the real value.
 */
export function normalizeDataset(raw: RawDataset): CanonicalDataset {
  const warnings: string[] = [];
  const inputRecords = Array.isArray(raw.records) ? raw.records : [];
  const inputRecordCount = inputRecords.length;

  if (inputRecordCount === 0) {
    return {
      name: raw.name,
      environment: raw.environment,
      records: [],
      diagnostics: {
        reshaped: false,
        inputRecordCount: 0,
        outputRecordCount: 0,
        sourceShape: 'empty',
        warnings,
      },
    };
  }

  const objectRecords = inputRecords.filter((r) => r && !isScalar(r.value));
  const scalarFieldRecords = inputRecords.filter(
    (r) => r && isScalar(r.value) && isFieldKey(r.key),
  );
  const otherScalarRecords = inputRecords.filter(
    (r) => r && isScalar(r.value) && !isFieldKey(r.key),
  );

  // Case A: no scalar field rows → already entity-modeled. Pass through, but
  // still apply the login alias so email-authenticated apps bind correctly.
  if (scalarFieldRecords.length === 0) {
    const records: CanonicalRecord[] = inputRecords.map((r) => {
      const value =
        r && !isScalar(r.value)
          ? applyLoginAlias({ ...r.value })
          : { value: r?.value };
      return { key: String(r?.key ?? ''), value, tags: r?.tags };
    });
    return {
      name: raw.name,
      environment: raw.environment,
      records,
      diagnostics: {
        reshaped: false,
        inputRecordCount,
        outputRecordCount: records.length,
        sourceShape: 'entity-records',
        warnings,
      },
    };
  }

  // Case B / C: collapse the scalar field rows into a single entity.
  const entity: Record<string, any> = {};
  const entityTags = new Set<string>();
  for (const r of scalarFieldRecords) {
    entity[canonicalFieldName(r.key)] = r.value;
    for (const t of r.tags ?? []) entityTags.add(t);
  }
  // Preserve non-vocab scalar rows as raw fields too (best-effort — keeps any
  // custom fields the author added, e.g. "nickname").
  for (const r of otherScalarRecords) {
    const fname = canonicalFieldName(r.key);
    if (!(fname in entity)) entity[fname] = r.value;
    for (const t of r.tags ?? []) entityTags.add(t);
  }
  applyLoginAlias(entity);

  const collapsedEntity: CanonicalRecord = {
    key: deriveEntityKey(entity, 'record_1'),
    value: entity,
    tags: entityTags.size ? [...entityTags] : undefined,
  };

  const records: CanonicalRecord[] = [];
  // Keep any pre-existing entity records first (mixed datasets), then the one
  // collapsed from the scalar field rows.
  for (const r of objectRecords) {
    records.push({
      key: String(r.key),
      value: applyLoginAlias({ ...r.value }),
      tags: r.tags,
    });
  }
  records.push(collapsedEntity);

  const sourceShape: CanonicalDataset['diagnostics']['sourceShape'] =
    objectRecords.length > 0 ? 'mixed' : 'field-per-record';

  warnings.push(
    `Dataset "${raw.name}" was stored as ${scalarFieldRecords.length} field-per-record row(s) ` +
      `(${scalarFieldRecords.map((r) => r.key).join(', ')}); collapsed into 1 entity record ` +
      `keyed "${collapsedEntity.key}". Re-materialize the dataset to persist it canonically.`,
  );

  return {
    name: raw.name,
    environment: raw.environment,
    records,
    diagnostics: {
      reshaped: true,
      inputRecordCount,
      outputRecordCount: records.length,
      sourceShape,
      warnings,
    },
  };
}

/**
 * Login field alias: when an entity authenticates by email but has no explicit
 * username, expose the email ALSO as `username` so a generated
 * login(user.username, user.password) call binds to the real credential rather
 * than falling back to process.env. Mutates and returns the entity.
 */
function applyLoginAlias(entity: Record<string, any>): Record<string, any> {
  if (entity.username == null && typeof entity.email === 'string' && entity.email.trim()) {
    entity.username = entity.email;
  }
  return entity;
}

/**
 * Normalize a full list of resolved datasets. Pure and deterministic — safe to
 * call on every generation. Returns the canonical datasets plus aggregated
 * diagnostics for observability.
 */
export function normalizeResolvedTestData(
  datasets: RawDataset[] | undefined,
): { datasets: CanonicalDataset[]; reshapedAny: boolean; warnings: string[] } {
  const out: CanonicalDataset[] = [];
  const warnings: string[] = [];
  let reshapedAny = false;
  for (const ds of datasets ?? []) {
    if (!ds?.name || !Array.isArray(ds.records)) continue;
    const norm = normalizeDataset(ds);
    out.push(norm);
    if (norm.diagnostics.reshaped) reshapedAny = true;
    warnings.push(...norm.diagnostics.warnings);
  }
  return { datasets: out, reshapedAny, warnings };
}
