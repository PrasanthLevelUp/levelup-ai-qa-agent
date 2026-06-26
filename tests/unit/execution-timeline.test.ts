/**
 * Tests for the Execution Timeline builder — derives an ordered lifecycle
 * timeline purely from a canonical ExecutionRecord (no new intelligence).
 */
import { buildExecutionTimeline } from '../../src/core/execution/execution-timeline';
import {
  createExecutionRecord,
  recordObservations,
  recordDiagnosis,
  recordHealingDecision,
  recordValidation,
  recordLearning,
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
