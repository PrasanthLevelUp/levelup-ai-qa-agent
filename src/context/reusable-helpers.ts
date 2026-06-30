/**
 * Reusable-asset classification — shared Repository Intelligence logic.
 *
 * Buckets a repo's helper functions by PURPOSE so script generation can prefer
 * calling an existing project method over emitting new raw Playwright code:
 *   - assertion helpers      (assert/expect/verify/validate…)
 *   - wait / sync helpers     (wait/until/poll/retry…)
 *   - logger helpers          (log/logger/report/trace…)
 *   - test-data access        (getRecord/loadFixture/readJson…)
 *   - generic utilities       (everything else)
 *
 * Used by BOTH the freeform context (context/prompt-builder) and the distilled
 * guide (script-gen/repo-pattern-analyzer) so the "reuse-first" catalog is
 * consistent regardless of which prompt path runs.
 */
import type { RepositoryProfile, FunctionSignature } from './types';

export type HelperEntry = { name: string; params: string; filePath: string };
export type HelperKind = 'assertion' | 'wait' | 'logger' | 'data' | 'utility';

export interface CategorizedHelpers {
  assertion: HelperEntry[];
  wait: HelperEntry[];
  logger: HelperEntry[];
  data: HelperEntry[];
  utility: HelperEntry[];
  /** The repo's logger to import & call instead of console.log (null if none). */
  loggerImpl: { name: string; filePath: string } | null;
}

/**
 * Classify a single helper into exactly one reuse bucket. Names are split into
 * word tokens (camelCase / PascalCase / snake_case) so "expectErrorVisible"
 * yields ['expect','error','visible'] — a lowercased blob would defeat
 * word-level matching. jsdoc and file path provide supplementary signal.
 * Order matters: most specific (data access) first, generic (utility) last.
 */
export function classifyHelper(h: FunctionSignature): HelperKind {
  const tokens = new Set(
    (h.name || '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
  const has = (...words: string[]) => words.some((w) => tokens.has(w));
  const doc = (h.jsdoc || '').toLowerCase();
  const file = (h.filePath || '').toLowerCase();

  // Test-data access patterns (getRecord, loadFixture, readJson, seedUser, …):
  // a data NOUN token, a well-known data fn name, or a data/fixtures folder.
  if (has('record', 'records', 'fixture', 'fixtures', 'dataset', 'datasets', 'testdata', 'userdata', 'seed', 'json', 'csv', 'yaml', 'data')
    || /getrecord|loaddata|readfixture|fromdata|gettestdata|datafactory|datahelper/.test((h.name || '').toLowerCase())
    || /\/(data|fixtures?|test-?data)\//.test(file)) return 'data';
  // Assertion / verification helpers.
  if (has('assert', 'asserts', 'expect', 'expects', 'verify', 'verifies', 'validate', 'validates', 'ensure', 'ensures', 'confirm', 'confirms', 'should', 'check', 'checks', 'match', 'matches')
    || /\bassert|\bexpect|\bverif|\bvalidat/.test(doc)) return 'assertion';
  // Wait / synchronization helpers.
  if (has('wait', 'waits', 'until', 'poll', 'polls', 'retry', 'sync', 'ready', 'loaded', 'settle', 'stable', 'debounce')
    || /\bwait|synchroni|\bpoll|retr(y|ies)/.test(doc)) return 'wait';
  // Logging / reporting helpers.
  if (has('log', 'logs', 'logger', 'logging', 'report', 'reports', 'trace', 'debug', 'step', 'breadcrumb')
    || /\blog|\breport/.test(doc)
    || /logger|logging/.test(file)) return 'logger';
  return 'utility';
}

/**
 * Bucket all of a profile's helpers by purpose and resolve the repo's logger
 * implementation. Each bucket is capped (`perBucket`) so prompt blocks stay
 * token-budgeted; a helper appears in at most one bucket.
 */
export function categorizeHelpers(profile: RepositoryProfile, perBucket = 8): CategorizedHelpers {
  const buckets: Record<HelperKind, HelperEntry[]> = { assertion: [], wait: [], logger: [], data: [], utility: [] };
  for (const h of profile.helperFunctions || []) {
    const entry: HelperEntry = { name: h.name, params: (h.parameters || []).map((p) => p.name).join(', '), filePath: h.filePath };
    buckets[classifyHelper(h)].push(entry);
  }
  for (const k of Object.keys(buckets) as HelperKind[]) buckets[k] = buckets[k].slice(0, perBucket);
  // Logger implementation: a helper named like log/logger, else the first
  // helper that classified into the logger bucket.
  let loggerImpl: { name: string; filePath: string } | null = null;
  const named = (profile.helperFunctions || []).find((h) => /^(log|logger|getlogger|createlogger)$/i.test(h.name));
  if (named) loggerImpl = { name: named.name, filePath: named.filePath };
  else if (buckets.logger.length) loggerImpl = { name: buckets.logger[0].name, filePath: buckets.logger[0].filePath };
  return { ...buckets, loggerImpl };
}
