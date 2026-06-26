/**
 * Tests for the execution lifecycle helpers — the PURE functions that translate
 * raw Playwright outcomes into the canonical {status, result} split and enforce
 * the platform's core invariant:
 *
 *      ONE test execution  ==  exactly ONE ExecutionRecord
 *
 * These are the parity/invariant tests requested for Phase 1: they prove that a
 * run's records reconcile 1:1 with the tests that actually ran, and that the
 * aggregated record counts match the legacy job totals (totalTests / healed /
 * failed) so the canonical store can't silently lose or invent executions.
 */
import {
  deriveResult,
  summarizeResultCounts,
  assertOneRecordPerTest,
  stageIndex,
  STAGE_ORDER,
  toDisplayStage,
  type EnumeratedTest,
} from '../../src/core/execution/execution-lifecycle';
import {
  createExecutionRecord,
  setLifecycle,
  makeSectionTiming,
  type ExecutionRecord,
  type TestOutcome,
} from '../../src/core/execution/execution-record';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rec(testName: string, result: TestOutcome | null): ExecutionRecord {
  const r = createExecutionRecord({
    executionId: `exec_${testName}`,
    testName,
    durationMs: 100,
    startTime: '2026-06-26T09:00:00.000Z',
    endTime: '2026-06-26T09:00:00.100Z',
    profile: 'healing',
  });
  return setLifecycle(r, {
    status: result === null ? 'running' : 'completed',
    result,
    stage: result === null ? 'executing' : 'completed',
  });
}

function test(testName: string, status: EnumeratedTest['status']): EnumeratedTest {
  return { testName, status };
}

// ---------------------------------------------------------------------------
// deriveResult — raw Playwright outcome → canonical {status, result}
// ---------------------------------------------------------------------------

describe('deriveResult', () => {
  it('maps a passed test to completed/pass', () => {
    expect(deriveResult('passed')).toEqual({ status: 'completed', result: 'pass' });
  });

  it('maps a skipped test to completed/skipped', () => {
    expect(deriveResult('skipped')).toEqual({ status: 'completed', result: 'skipped' });
  });

  it('maps a failed test to completed/fail', () => {
    expect(deriveResult('failed')).toEqual({ status: 'completed', result: 'fail' });
  });

  it('maps a timed-out test to timed_out/fail (both spellings)', () => {
    expect(deriveResult('timedout')).toEqual({ status: 'timed_out', result: 'fail' });
    expect(deriveResult('timedOut')).toEqual({ status: 'timed_out', result: 'fail' });
  });

  it('maps an interrupted test to cancelled/fail', () => {
    expect(deriveResult('interrupted')).toEqual({ status: 'cancelled', result: 'fail' });
  });
});

// ---------------------------------------------------------------------------
// summarizeResultCounts — parity rollups
// ---------------------------------------------------------------------------

describe('summarizeResultCounts', () => {
  it('tallies every result bucket plus in-flight records', () => {
    const records = [
      rec('a', 'pass'),
      rec('b', 'pass'),
      rec('c', 'fail'),
      rec('d', 'healed'),
      rec('e', 'skipped'),
      rec('f', null), // still running
    ];
    expect(summarizeResultCounts(records)).toEqual({
      total: 6,
      pass: 2,
      fail: 1,
      healed: 1,
      skipped: 1,
      inFlight: 1,
    });
  });

  it('returns all-zero counts for an empty set', () => {
    expect(summarizeResultCounts([])).toEqual({
      total: 0, pass: 0, fail: 0, healed: 0, skipped: 0, inFlight: 0,
    });
  });

  it('reconciles with the legacy job totals (parity check)', () => {
    // A run of 5 tests: 2 passed, 1 healed, 2 failed — as the legacy job would
    // have summarized it (totalTests=5, healed=1, failed=2, passed counts the
    // healed as a success on rerun is NOT assumed here — we compare raw buckets).
    const records = [
      rec('t1', 'pass'),
      rec('t2', 'pass'),
      rec('t3', 'healed'),
      rec('t4', 'fail'),
      rec('t5', 'fail'),
    ];
    const counts = summarizeResultCounts(records);

    // Legacy job totals derived independently from the same run.
    const legacyTotalTests = 5;
    const legacyHealed = 1;
    const legacyFailed = 2;

    // The canonical record store must reconcile exactly with the job totals.
    expect(counts.total).toBe(legacyTotalTests);
    expect(counts.healed).toBe(legacyHealed);
    expect(counts.fail).toBe(legacyFailed);
    // No execution is unaccounted for (no in-flight leftovers after a finished run).
    expect(counts.inFlight).toBe(0);
    expect(counts.pass + counts.fail + counts.healed + counts.skipped).toBe(counts.total);
  });
});

// ---------------------------------------------------------------------------
// assertOneRecordPerTest — THE core invariant
// ---------------------------------------------------------------------------

describe('assertOneRecordPerTest', () => {
  it('passes when every test that ran has exactly one record', () => {
    const universe = [test('a', 'passed'), test('b', 'failed'), test('c', 'skipped')];
    const records = [rec('a', 'pass'), rec('b', 'fail'), rec('c', 'skipped')];
    const result = assertOneRecordPerTest(records, universe);
    expect(result.ok).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('detects a MISSING record (a test ran but produced no record)', () => {
    // 'b' ran but was never recorded — exactly the Phase 1 gap (failures-only).
    const universe = [test('a', 'passed'), test('b', 'failed')];
    const records = [rec('a', 'pass')];
    const result = assertOneRecordPerTest(records, universe);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({ kind: 'missing', testName: 'b' });
  });

  it('detects a DUPLICATE record (same test recorded twice)', () => {
    const universe = [test('a', 'passed')];
    const records = [rec('a', 'pass'), rec('a', 'healed')];
    const result = assertOneRecordPerTest(records, universe);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({ kind: 'duplicate', testName: 'a', count: 2 });
  });

  it('detects an EXTRA record (a record for a test that never ran)', () => {
    const universe = [test('a', 'passed')];
    const records = [rec('a', 'pass'), rec('ghost', 'fail')];
    const result = assertOneRecordPerTest(records, universe);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({ kind: 'extra', testName: 'ghost', count: 1 });
  });

  it('surfaces multiple distinct violations at once', () => {
    const universe = [test('a', 'passed'), test('b', 'failed'), test('c', 'passed')];
    const records = [
      rec('a', 'pass'),
      rec('a', 'pass'), // duplicate of a
      rec('b', 'fail'),
      // c missing
      rec('ghost', 'fail'), // extra
    ];
    const result = assertOneRecordPerTest(records, universe);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual({ kind: 'duplicate', testName: 'a', count: 2 });
    expect(result.violations).toContainEqual({ kind: 'missing', testName: 'c' });
    expect(result.violations).toContainEqual({ kind: 'extra', testName: 'ghost', count: 1 });
  });

  it('holds for a realistic mixed run (pass + fail + heal + skip), one record each', () => {
    const universe = [
      test('login works', 'passed'),
      test('checkout flow', 'failed'),
      test('search returns results', 'passed'),
      test('legacy promo banner', 'skipped'),
    ];
    // The worker records: passes/skips as finalized, the failure healed on rerun.
    const records = [
      rec('login works', 'pass'),
      rec('checkout flow', 'healed'),
      rec('search returns results', 'pass'),
      rec('legacy promo banner', 'skipped'),
    ];
    const inv = assertOneRecordPerTest(records, universe);
    expect(inv.ok).toBe(true);

    // And the parity rollup matches the universe size exactly.
    const counts = summarizeResultCounts(records);
    expect(counts.total).toBe(universe.length);
    expect(counts.inFlight).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stage ordering
// ---------------------------------------------------------------------------

describe('stage ordering', () => {
  it('exposes the canonical monotonic stage order', () => {
    expect(STAGE_ORDER[0]).toBe('queued');
    expect(STAGE_ORDER[STAGE_ORDER.length - 1]).toBe('completed');
  });

  it('orders stages monotonically (executing precedes healing precedes completed)', () => {
    expect(stageIndex('executing')).toBeLessThan(stageIndex('healing'));
    expect(stageIndex('healing')).toBeLessThan(stageIndex('completed'));
  });

  it('returns -1 for an unknown/undefined stage', () => {
    expect(stageIndex(undefined)).toBe(-1);
  });

  it('places collecting_evidence between executing and diagnosing', () => {
    expect(stageIndex('executing')).toBeLessThan(stageIndex('collecting_evidence'));
    expect(stageIndex('collecting_evidence')).toBeLessThan(stageIndex('diagnosing'));
  });
});

// ---------------------------------------------------------------------------
// toDisplayStage — DERIVED user-facing labels (infra stages are never leaked)
// ---------------------------------------------------------------------------

describe('toDisplayStage', () => {
  it('collapses all environment-prep infra stages to a single user label', () => {
    expect(toDisplayStage('cloning')).toBe('Preparing Environment');
    expect(toDisplayStage('installing')).toBe('Preparing Environment');
    expect(toDisplayStage('building')).toBe('Preparing Environment');
  });

  it('maps the test/evidence/diagnosis/heal stages to friendly labels', () => {
    expect(toDisplayStage('queued')).toBe('Queued');
    expect(toDisplayStage('executing')).toBe('Running Tests');
    expect(toDisplayStage('collecting_evidence')).toBe('Collecting Evidence');
    expect(toDisplayStage('diagnosing')).toBe('Diagnosing');
    expect(toDisplayStage('healing')).toBe('Healing');
    expect(toDisplayStage('validating')).toBe('Validating');
    expect(toDisplayStage('learning')).toBe('Learning');
    expect(toDisplayStage('completed')).toBe('Completed');
  });

  it('returns undefined for an unknown/undefined stage (no guessing)', () => {
    expect(toDisplayStage(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// makeSectionTiming — per-section timing helper (durationMs is derived)
// ---------------------------------------------------------------------------

describe('makeSectionTiming', () => {
  it('computes durationMs as end - start and stamps ISO boundaries', () => {
    const start = Date.parse('2026-06-26T09:00:00.000Z');
    const end = Date.parse('2026-06-26T09:00:12.500Z');
    const timing = makeSectionTiming(start, end);
    expect(timing.startedAt).toBe('2026-06-26T09:00:00.000Z');
    expect(timing.completedAt).toBe('2026-06-26T09:00:12.500Z');
    expect(timing.durationMs).toBe(12500);
  });

  it('clamps a negative duration to 0 (never reports negative time)', () => {
    const start = Date.parse('2026-06-26T09:00:05.000Z');
    const end = Date.parse('2026-06-26T09:00:00.000Z');
    const timing = makeSectionTiming(start, end);
    expect(timing.durationMs).toBe(0);
  });
});
