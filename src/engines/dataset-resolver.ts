/**
 * Dataset Resolver — Sprint 2C.
 * ============================================================================
 *
 * ONE job: turn a `RequiredDataRole` (e.g. "registered_user") into a concrete
 * `ResolvedDatasetRecord` (a real dataset + record + values), deterministically,
 * with NO business logic anywhere else.
 *
 * What this module is NOT allowed to know:
 *   • It knows NOTHING about authentication, login, checkout, or any domain.
 *   • It never reads a scenario, planner output, graph, requirement, title,
 *     coverage type, or app profile. Its ONLY inputs are a role string and the
 *     datasets available to match against.
 *   • It never invents a dataset filename, never returns "credentials", never
 *     picks datasets[0], never does keyword sniffing like title.includes('login').
 *
 * How a dataset advertises the role it can satisfy: the DATA declares it, not
 * the resolver. A dataset (or an individual record) carries the role(s) it
 * serves in `roles` / `tags`. The resolver simply matches the requested role
 * against that declared metadata and scores the candidates. This is why adding
 * a new role (premium_user, locked_account, …) needs ZERO code change here —
 * the role is reusable data, the resolver stays boring.
 *
 * Determinism: `resolve` is a pure function of its inputs. Same inputs → same
 * record, every time. It never mutates the datasets it is given. Scoring /
 * ranking is an internal detail — callers only ever receive the winning
 * `ResolvedDatasetRecord` (or `null`), never the scores.
 *
 * Pipeline position (resolution happens in exactly ONE place):
 *   Planner → Scenario Graph → FormatterInput → [Dataset Resolver] → LLM
 */

/* ------------------------------------------------------------------ */
/*  Frozen contract                                                    */
/* ------------------------------------------------------------------ */

/**
 * A generic, reusable data role. Deliberately a bare string alias: roles are
 * stable identifiers ("registered_user", "locked_account", "unregistered_user",
 * "admin_user", "premium_user") and are NEVER expanded into composites like
 * "registered_user_with_items".
 */
export type RequiredDataRole = string;

/**
 * ONE record inside a dataset. Generic — the resolver never interprets what a
 * field means; `values` is opaque key→value data. `tags` optionally declares the
 * role(s) this specific record satisfies (record-level role granularity, e.g. a
 * "locked_out_user" record inside a broader users dataset).
 */
export interface DatasetRecordInput {
  /** Stable record id / key within its dataset (e.g. "standard_user"). */
  readonly recordId: string;
  /** Opaque field values (e.g. { username, password }). Never interpreted. */
  readonly values: Readonly<Record<string, string>>;
  /** Roles/classification this record satisfies (e.g. ["registered_user"]). */
  readonly tags?: readonly string[];
}

/**
 * A dataset available to resolve against. The dataset (and/or its records)
 * DECLARES the role(s) it serves — the resolver matches against that declaration
 * and never infers meaning from the dataset's name or domain.
 */
export interface Dataset {
  /** Stable dataset id (e.g. "valid_users"). */
  readonly datasetId: string;
  /** Human-readable dataset name (often equal to the id). */
  readonly name: string;
  /** Roles this dataset serves at the dataset level (e.g. ["registered_user"]). */
  readonly roles?: readonly string[];
  /** The dataset's records (ordered; order is used for deterministic tie-breaks). */
  readonly records: readonly DatasetRecordInput[];
  /**
   * Optional freeform metadata tokens (labels / environment) used ONLY as a
   * small deterministic tie-breaker between equally role-matched datasets.
   */
  readonly metadata?: readonly string[];
}

/**
 * The ONLY thing a consumer ever receives. No scenario, no planner, no graph,
 * no scores/ranking — just the resolved truth: which dataset, which record, and
 * its values, plus a confidence and a human-readable reason for traceability.
 */
export interface ResolvedDatasetRecord {
  readonly datasetId: string;
  readonly recordId: string;
  readonly values: Readonly<Record<string, string>>;
  /** 0..1 — how confident the deterministic match is. */
  readonly confidence: number;
  /** Human-readable explanation (traceability), e.g. why this record won. */
  readonly reason: string;
}

/* ------------------------------------------------------------------ */
/*  Deterministic scoring weights (illustrative, intentionally tiny)   */
/* ------------------------------------------------------------------ */

/**
 * Fixed weights. Role match dominates; key completeness and metadata overlap are
 * minor deterministic tie-breakers. NOT machine-learning, NOT tunable magic —
 * just enough to pick a single winner reproducibly.
 */
const WEIGHT_ROLE = 0.7;
const WEIGHT_KEYS = 0.2;
const WEIGHT_METADATA = 0.1;

/** Split a token bag into normalized lowercase words (on _/-/space). */
function tokens(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[\s_\-]+/).map(t => t.trim()).filter(Boolean),
  );
}

/** True when the role is declared by the dataset OR any of its records. */
function declaresRole(ds: Dataset, role: RequiredDataRole): boolean {
  if (ds.roles?.includes(role)) return true;
  return ds.records.some(r => r.tags?.includes(role));
}

/** Pick the record that best matches the role, deterministically. */
function selectRecord(ds: Dataset, role: RequiredDataRole): DatasetRecordInput | undefined {
  // Prefer a record that explicitly declares the role (record-level granularity),
  // in input order; otherwise fall back to the first record.
  return ds.records.find(r => r.tags?.includes(role)) ?? ds.records[0];
}

/** Fraction (0..1) of a record's fields that carry a non-empty value. */
function keyCompleteness(rec: DatasetRecordInput | undefined): number {
  if (!rec) return 0;
  const vals = Object.values(rec.values);
  if (vals.length === 0) return 0;
  const filled = vals.filter(v => typeof v === 'string' && v.trim().length > 0).length;
  return filled / vals.length;
}

/** Token overlap (0..1) between the role and the dataset's metadata/name. */
function metadataOverlap(ds: Dataset, role: RequiredDataRole): number {
  const roleTokens = tokens(role);
  if (roleTokens.size === 0) return 0;
  const metaTokens = new Set<string>([
    ...tokens(ds.name),
    ...tokens(ds.datasetId),
    ...(ds.metadata ?? []).flatMap(m => Array.from(tokens(m))),
  ]);
  let hits = 0;
  for (const t of roleTokens) if (metaTokens.has(t)) hits++;
  return hits / roleTokens.size;
}

interface ScoredCandidate {
  dataset: Dataset;
  record: DatasetRecordInput;
  roleScore: number;
  keyScore: number;
  metaScore: number;
  score: number;
}

/* ------------------------------------------------------------------ */
/*  The resolver                                                       */
/* ------------------------------------------------------------------ */

/**
 * Single-responsibility resolver. One public method. No state, no I/O, no LLM,
 * no cache, no registry, no provider — deliberately boring and predictable.
 */
export class DatasetResolver {
  /**
   * Resolve a role to a concrete dataset record. Returns `null` when NO dataset
   * declares the role (the formatter must keep working without a resolved
   * record — resolution is best-effort, never required). Pure & deterministic;
   * never mutates `availableDatasets`.
   */
  resolve(
    role: RequiredDataRole,
    availableDatasets: readonly Dataset[],
  ): ResolvedDatasetRecord | null {
    if (!role || !availableDatasets?.length) return null;

    // Step 1 — filter to datasets that DECLARE the role (dataset or record level).
    const candidates = availableDatasets.filter(ds => declaresRole(ds, role));
    if (candidates.length === 0) return null;

    // Step 2 — score each candidate deterministically.
    const scored: ScoredCandidate[] = candidates.map(ds => {
      const record = selectRecord(ds, role)!; // declaresRole guarantees ≥1 record path
      const roleScore = ds.roles?.includes(role) || record.tags?.includes(role) ? 1 : 0;
      const keyScore = keyCompleteness(record);
      const metaScore = metadataOverlap(ds, role);
      const score = WEIGHT_ROLE * roleScore + WEIGHT_KEYS * keyScore + WEIGHT_METADATA * metaScore;
      return { dataset: ds, record, roleScore, keyScore, metaScore, score };
    });

    // Step 3 — rank. Highest score wins; ties broken deterministically by
    // datasetId (asc) then recordId (asc) so the same inputs always win.
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (a.dataset.datasetId !== b.dataset.datasetId)
        return a.dataset.datasetId < b.dataset.datasetId ? -1 : 1;
      return a.record.recordId < b.record.recordId ? -1 : 1;
    });

    const winner = scored[0];
    return {
      datasetId: winner.dataset.datasetId,
      recordId: winner.record.recordId,
      // Copy values so the returned record can be frozen without touching input.
      values: Object.freeze({ ...winner.record.values }),
      confidence: Math.round(winner.score * 100) / 100,
      reason:
        `role '${role}' matched dataset '${winner.dataset.datasetId}'` +
        `${winner.dataset.roles?.includes(role) ? ' (dataset role)' : ' (record tag)'}` +
        ` → record '${winner.record.recordId}'` +
        (scored.length > 1 ? ` (best of ${scored.length} candidates)` : ''),
    };
  }
}

/** Shared stateless instance — the resolver holds no state. */
export const datasetResolver = new DatasetResolver();
