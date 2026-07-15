/**
 * Workspace scope filter helpers (Sprint 1 — Workspace Context migration).
 * ========================================================================
 * Tiny, reusable builders that append **optional** parameterised SQL fragments
 * for the Workspace dimensions that map onto persisted columns:
 *
 *   • Environment (WHERE) → `environment_id = $n`
 *   • Time        (WHEN)  → `created_at >= $n` / `created_at <= $n`
 *
 * They are deliberately transport-agnostic: callers pass plain values (already
 * extracted from query params or headers upstream) plus the running `params`
 * array, and get back a clause string using the correct positional placeholders.
 *
 * INVARIANT — every filter is additive and optional: when a value is null /
 * undefined the helper contributes nothing, so existing callers that don't pass
 * scope keep their exact previous behaviour. This is what lets us extend the
 * three vertical-slice endpoints (Executions / Healings / Flaky) without a
 * migration, new middleware, or any change to unrelated callers.
 *
 * Sprint 2 (ROI / Analytics / Metrics) reuses these same helpers — do not
 * re-implement date/env clause logic inline anywhere else.
 */

/** Coerce a raw request value into a positive integer id, or null. */
export function parseScopeId(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = parseInt(String(raw), 10);
  return Number.isNaN(n) || n <= 0 ? null : n;
}

/**
 * Coerce a raw request value into an ISO date string suitable for a timestamptz
 * comparison, or null when absent/invalid. Accepts `YYYY-MM-DD` or full ISO.
 */
export function parseScopeDate(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const s = String(raw);
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : s;
}

export interface DateFilterOpts {
  startDate?: string | null;
  endDate?: string | null;
  /** Column to compare against. Defaults to `created_at`. */
  column?: string;
}

/**
 * Append `>= startDate` / `<= endDate` clauses (either, both, or neither).
 * Mutates `params` by pushing the bound values and returns the SQL fragment
 * (prefixed with ` AND ` when non-empty, else '').
 */
export function buildDateFilter(params: any[], opts: DateFilterOpts): string {
  const col = opts.column ?? 'created_at';
  const parts: string[] = [];
  const start = parseScopeDate(opts.startDate);
  const end = parseScopeDate(opts.endDate);
  if (start) {
    params.push(start);
    parts.push(`${col} >= $${params.length}`);
  }
  if (end) {
    params.push(end);
    parts.push(`${col} <= $${params.length}`);
  }
  return parts.length ? ` AND ${parts.join(' AND ')}` : '';
}

export interface EnvironmentFilterOpts {
  environmentId?: number | null;
  /** Column to compare against. Defaults to `environment_id`. */
  column?: string;
}

/**
 * Append an `environment_id = $n` equality clause when an id is supplied.
 * Mutates `params` and returns the SQL fragment (prefixed with ` AND `) or ''.
 */
export function buildEnvironmentFilter(params: any[], opts: EnvironmentFilterOpts): string {
  const col = opts.column ?? 'environment_id';
  const envId = typeof opts.environmentId === 'number' && opts.environmentId > 0 ? opts.environmentId : null;
  if (envId != null) {
    params.push(envId);
    return ` AND ${col} = $${params.length}`;
  }
  return '';
}

/** Convenience bag of the optional scope inputs the slice endpoints accept. */
export interface ScopeInput {
  environmentId?: number | null;
  startDate?: string | null;
  endDate?: string | null;
}
