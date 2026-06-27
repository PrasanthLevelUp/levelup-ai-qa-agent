/**
 * Execution lifecycle helpers — PURE functions (no I/O) that translate raw
 * Playwright outcomes into the canonical {status, result} split and enforce the
 * platform's core invariant:
 *
 *      ONE test execution  ==  exactly ONE ExecutionRecord
 *
 * The invariant is the foundation of the whole platform: the dashboard, replay,
 * analytics and learning all assume a record is never duplicated, never missing
 * and never silently overwritten by a different test. These helpers let us prove
 * that property in unit tests and assert it at runtime cheaply.
 *
 * Everything here is deterministic and side-effect free so it can be exhaustively
 * unit tested without a database or a browser.
 */
import type {
  ExecutionRecord,
  TestOutcome,
  ExecutionLifecycleStatus,
  ExecutionStage,
} from './execution-record';

/** Raw per-test status as reported by Playwright's JSON results. */
export type PlaywrightTestStatus = 'passed' | 'failed' | 'timedout' | 'timedOut' | 'skipped' | 'interrupted';

/**
 * A single test in the run "universe" — every spec/test that actually ran (or was
 * skipped), regardless of outcome. Enumerated from the Playwright results file by
 * `artifact-collector.enumerateAllTests`. This is the denominator the invariant
 * checks records against.
 */
export interface EnumeratedTest {
  testName: string;
  file?: string;
  status: PlaywrightTestStatus;
  durationMs?: number;
}

/**
 * Map a raw Playwright outcome to the canonical lifecycle terminal state. Note a
 * `failed`/`timedout` test that was subsequently healed is NOT decided here — the
 * worker promotes it to `{ completed, healed }` once validation confirms the fix.
 * This function only encodes the *unhealed* mapping from a raw run.
 */
export function deriveResult(
  status: PlaywrightTestStatus,
): { status: ExecutionLifecycleStatus; result: TestOutcome } {
  switch (status) {
    case 'passed':
      return { status: 'completed', result: 'pass' };
    case 'skipped':
      return { status: 'completed', result: 'skipped' };
    case 'timedout':
    case 'timedOut':
      return { status: 'timed_out', result: 'fail' };
    case 'interrupted':
      return { status: 'cancelled', result: 'fail' };
    case 'failed':
    default:
      return { status: 'completed', result: 'fail' };
  }
}

/** Tallies of records by their canonical result, plus lifecycle/stage rollups. */
export interface ResultCounts {
  total: number;
  pass: number;
  fail: number;
  healed: number;
  skipped: number;
  /** Runs that produced no trustworthy verdict ("I don't know"). */
  inconclusive: number;
  /** Records still in flight (no terminal result yet). */
  inFlight: number;
}

/**
 * Summarize a set of records by result. Used for the parity check: the aggregated
 * record counts must reconcile with the legacy job totals (totalTests / healed /
 * failed) so we can prove the canonical store hasn't lost or invented executions.
 */
export function summarizeResultCounts(records: ReadonlyArray<Pick<ExecutionRecord, 'result'>>): ResultCounts {
  const counts: ResultCounts = { total: 0, pass: 0, fail: 0, healed: 0, skipped: 0, inconclusive: 0, inFlight: 0 };
  for (const rec of records) {
    counts.total++;
    switch (rec.result) {
      case 'pass':
        counts.pass++;
        break;
      case 'fail':
        counts.fail++;
        break;
      case 'healed':
        counts.healed++;
        break;
      case 'skipped':
        counts.skipped++;
        break;
      case 'inconclusive':
        counts.inconclusive++;
        break;
      default:
        counts.inFlight++;
    }
  }
  return counts;
}

/** A single violation of the one-record-per-test invariant. */
export interface InvariantViolation {
  kind: 'duplicate' | 'missing' | 'extra';
  testName: string;
  /** For duplicates: how many records referenced the same test. */
  count?: number;
}

/** Result of checking the one-record-per-test invariant. */
export interface InvariantResult {
  ok: boolean;
  violations: InvariantViolation[];
}

/**
 * Assert the core invariant: against the run universe (every test that ran), there
 * is EXACTLY ONE ExecutionRecord per test — none missing, none duplicated, and no
 * record for a test that never ran.
 *
 * Returns a structured result rather than throwing, so callers can decide whether
 * to fail hard (tests) or merely log (runtime guard).
 */
export function assertOneRecordPerTest(
  records: ReadonlyArray<Pick<ExecutionRecord, 'testName'>>,
  universe: ReadonlyArray<Pick<EnumeratedTest, 'testName'>>,
): InvariantResult {
  const violations: InvariantViolation[] = [];

  // Count records per test name.
  const recordCounts = new Map<string, number>();
  for (const rec of records) {
    recordCounts.set(rec.testName, (recordCounts.get(rec.testName) ?? 0) + 1);
  }

  const universeNames = new Set<string>();
  for (const t of universe) universeNames.add(t.testName);

  // Every test in the universe must have exactly one record.
  for (const name of universeNames) {
    const count = recordCounts.get(name) ?? 0;
    if (count === 0) {
      violations.push({ kind: 'missing', testName: name });
    } else if (count > 1) {
      violations.push({ kind: 'duplicate', testName: name, count });
    }
  }

  // Any record for a test NOT in the universe is an extra (or a duplicate of a
  // name already flagged). Duplicates among extras are still surfaced once.
  for (const [name, count] of recordCounts) {
    if (!universeNames.has(name)) {
      violations.push({ kind: 'extra', testName: name, count });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * The canonical stage order. Exposed so UIs and guards can reason about progress
 * monotonically (e.g. never move a record "backwards" through the pipeline).
 */
export const STAGE_ORDER: ExecutionStage[] = [
  'queued',
  'cloning',
  'installing',
  'building',
  'executing',
  'collecting_evidence',
  'diagnosing',
  'healing',
  'validating',
  'learning',
  'completed',
];

/** Numeric index of a stage in the canonical order (−1 if unknown). */
export function stageIndex(stage: ExecutionStage | undefined): number {
  return stage ? STAGE_ORDER.indexOf(stage) : -1;
}

// ---------------------------------------------------------------------------
// Display stages — a USER-FACING PROJECTION of the internal stage.
//
// The internal `ExecutionStage` is intentionally granular for orchestration
// (cloning/installing/building are distinct operations). The UI should NOT leak
// that infrastructure detail. `toDisplayStage` collapses the internal stages
// into the clean, product-level labels users actually care about (à la
// BrowserStack). This is a DERIVED view — it is never persisted on the record.
// ---------------------------------------------------------------------------

/** Clean, user-facing stage label shown in the dashboard. */
export type DisplayStage =
  | 'Queued'
  | 'Preparing Environment'
  | 'Running Tests'
  | 'Collecting Evidence'
  | 'Diagnosing'
  | 'Healing'
  | 'Validating'
  | 'Learning'
  | 'Completed';

/** The user-facing display stages in order (for progress bars / steppers). */
export const DISPLAY_STAGE_ORDER: DisplayStage[] = [
  'Queued',
  'Preparing Environment',
  'Running Tests',
  'Collecting Evidence',
  'Diagnosing',
  'Healing',
  'Validating',
  'Learning',
  'Completed',
];

/** Map each internal stage to its user-facing display label. */
const STAGE_DISPLAY: Record<ExecutionStage, DisplayStage> = {
  queued: 'Queued',
  // Infrastructure prep is collapsed into one user-facing step.
  cloning: 'Preparing Environment',
  installing: 'Preparing Environment',
  building: 'Preparing Environment',
  executing: 'Running Tests',
  collecting_evidence: 'Collecting Evidence',
  diagnosing: 'Diagnosing',
  healing: 'Healing',
  validating: 'Validating',
  learning: 'Learning',
  completed: 'Completed',
};

/**
 * Project an internal stage onto its clean, user-facing label. Returns
 * `undefined` for an unknown/undefined stage so the UI can omit the chip.
 */
export function toDisplayStage(stage: ExecutionStage | undefined): DisplayStage | undefined {
  return stage ? STAGE_DISPLAY[stage] : undefined;
}
