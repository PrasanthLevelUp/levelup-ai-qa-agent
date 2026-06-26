/**
 * Tests for the Execution Timeline builder — derives an ordered lifecycle
 * timeline purely from a canonical ExecutionRecord (no new intelligence).
 */
import { buildExecutionTimeline, deriveStageHistory } from '../../src/core/execution/execution-timeline';
import {
  createExecutionRecord,
  recordObservations,
  recordDiagnosis,
  recordHealingDecision,
  recordValidation,
  recordLearning,
  setLifecycle,
} from '../../src/core/execution/execution-record';

function baseRecord() {
  return createExecutionRecord({
    executionId: 'exec_1',
    testName: 'login works',
    status: 'failed',
    durationMs: 32000,
    startTime: '2026-06-26T09:10:00.000Z',
    endTime: '2026-06-26T09:10:32.000Z',
    profile: 'healing',
  });
}

describe('buildExecutionTimeline', () => {
  it('always brackets the timeline with start + finish carrying real times', () => {
    const tl = buildExecutionTimeline(baseRecord());
    expect(tl[0].key).toBe('execution_started');
    expect(tl[0].time).toBe('2026-06-26T09:10:00.000Z');
    expect(tl[tl.length - 1].key).toBe('execution_finished');
    expect(tl[tl.length - 1].time).toBe('2026-06-26T09:10:32.000Z');
    expect(tl[tl.length - 1].detail).toContain('32.0s');
  });

  it('marks a failed run as failed', () => {
    const tl = buildExecutionTimeline(baseRecord());
    const run = tl.find((e) => e.key === 'run_result')!;
    expect(run.status).toBe('failed');
    expect(run.label).toBe('Test failed');
  });

  it('only includes stages the record actually has', () => {
    const tl = buildExecutionTimeline(baseRecord());
    const keys = tl.map((e) => e.key);
    expect(keys).not.toContain('diagnosis');
    expect(keys).not.toContain('healing');
    expect(keys).not.toContain('validation');
  });

  it('renders a full healed lifecycle in order with correct statuses', () => {
    let rec = baseRecord();
    rec = recordObservations(rec, {
      locatorState: {
        exists: true, visible: true, enabled: true, receivesPointerEvents: false,
        clickable: false, interceptedBy: '.overlay', source: 'dom_snapshot',
      },
    });
    rec = recordDiagnosis(rec, { category: 'timing', confidence: 0.97, recommendedStrategy: 'wait_for_overlay' });
    rec = recordHealingDecision(rec, { appliedStrategy: 'rule_based', newLocator: '#login-btn' });
    rec = recordValidation(rec, { reran: true, passedAfterHealing: true });
    rec = recordLearning(rec, { recorded: true, domMemoryUpdated: true });
    rec = { ...rec, status: 'completed', result: 'healed' };

    const tl = buildExecutionTimeline(rec);
    const keys = tl.map((e) => e.key);
    expect(keys).toEqual([
      'execution_started', 'run_result', 'evidence', 'diagnosis',
      'healing', 'validation', 'learning', 'execution_finished',
    ]);
    expect(tl.find((e) => e.key === 'diagnosis')!.detail).toBe('timing (97%)');
    expect(tl.find((e) => e.key === 'healing')!.detail).toContain('rule_based');
    expect(tl.find((e) => e.key === 'validation')!.status).toBe('done');
    expect(tl.find((e) => e.key === 'learning')!.status).toBe('done');
  });

  it('marks report-only healing as skipped and failed validation as failed', () => {
    let rec = baseRecord();
    rec = recordHealingDecision(rec, { reportOnly: true });
    rec = recordValidation(rec, { reran: true, passedAfterHealing: false });
    const tl = buildExecutionTimeline(rec);
    expect(tl.find((e) => e.key === 'healing')!.status).toBe('skipped');
    expect(tl.find((e) => e.key === 'validation')!.status).toBe('failed');
  });
});

describe('deriveStageHistory — exact per-stage spans from the events log', () => {
  it('returns [] for a legacy record with no captured history', () => {
    const rec = { ...baseRecord(), events: [] };
    expect(deriveStageHistory(rec)).toEqual([]);
  });

  it('reconstructs ordered spans with start/end/duration from stage transitions', () => {
    // Construct an events log with controlled timestamps so durations are exact
    // (deriveStageHistory reads `events` straight through — no clock involved).
    const base = createExecutionRecord({
      executionId: 'exec_hist',
      testName: 'login works',
      status: 'running',
      stage: 'collecting_evidence',
      durationMs: 0,
      startTime: '2026-06-26T09:10:00.000Z',
      endTime: '2026-06-26T09:10:05.000Z',
      profile: 'healing',
    });
    const rec = {
      ...base,
      events: [
        { type: 'execution_created' as const, stage: 'collecting_evidence' as const, timestamp: '2026-06-26T09:10:00.000Z' },
        { type: 'stage_changed' as const, stage: 'diagnosing' as const, timestamp: '2026-06-26T09:10:01.000Z' },
        { type: 'stage_changed' as const, stage: 'healing' as const, timestamp: '2026-06-26T09:10:01.500Z' },
        { type: 'stage_changed' as const, stage: 'learning' as const, timestamp: '2026-06-26T09:10:04.300Z' },
      ],
    };

    const history = deriveStageHistory(rec);
    expect(history.map((h) => h.stage)).toEqual([
      'collecting_evidence', 'diagnosing', 'healing', 'learning',
    ]);
    // collecting_evidence: 09:10:00.000 -> 09:10:01.000 = 1000ms
    expect(history[0].durationMs).toBe(1000);
    // diagnosing: 1.0s -> 1.5s = 500ms
    expect(history[1].durationMs).toBe(500);
    // healing: 1.5s -> 4.3s = 2800ms (the bottleneck)
    expect(history[2].durationMs).toBe(2800);
    // learning: 4.3s -> record end (5.0s) = 700ms
    expect(history[3].completedAt).toBe('2026-06-26T09:10:05.000Z');
    expect(history[3].durationMs).toBe(700);

    // Bottleneck analysis becomes a trivial reduce over the derived history.
    const slowest = history.reduce((a, b) => ((b.durationMs ?? 0) > (a.durationMs ?? 0) ? b : a));
    expect(slowest.stage).toBe('healing');
  });

  it('merges a born-finalized record (created + finalized, same stage) into one span', () => {
    let rec = createExecutionRecord({
      executionId: 'exec_pass',
      testName: 'search works',
      status: 'completed',
      result: 'pass',
      stage: 'completed',
      durationMs: 800,
      startTime: '2026-06-26T09:00:00.000Z',
      endTime: '2026-06-26T09:00:00.800Z',
      profile: 'standard',
    });
    rec = setLifecycle(rec, { status: 'completed', result: 'pass' });
    const history = deriveStageHistory(rec);
    expect(history).toHaveLength(1);
    expect(history[0].stage).toBe('completed');
  });
});
