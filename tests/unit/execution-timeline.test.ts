/**
 * Tests for the Execution Timeline builder — derives an ordered lifecycle
 * timeline purely from a canonical ExecutionRecord (no new intelligence).
 */
import {
  buildExecutionTimeline,
  deriveStageHistory,
  deriveDecisionTrail,
  deriveEventFeed,
} from '../../src/core/execution/execution-timeline';
import {
  createExecutionRecord,
  recordObservations,
  recordDiagnosis,
  recordHealingDecision,
  recordValidation,
  recordLearning,
  setLifecycle,
  appendEvent,
  type ExecutionRecord,
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

// ---------------------------------------------------------------------------
// deriveDecisionTrail — projects the record's authoritative advisor waterfall
// (healing.decisionTrail) onto the dashboard view (confidence → integer %).
// ---------------------------------------------------------------------------

describe('deriveDecisionTrail', () => {
  it('returns [] for a record that never healed', () => {
    expect(deriveDecisionTrail(baseRecord())).toEqual([]);
  });

  it('returns [] when healing has no decisionTrail (legacy)', () => {
    const rec = recordHealingDecision(baseRecord(), { appliedStrategy: 'rule_based' });
    expect(deriveDecisionTrail(rec)).toEqual([]);
  });

  it('passes advisor + status through verbatim and converts confidence 0..1 → integer %', () => {
    const rec = recordHealingDecision(baseRecord(), {
      decisionTrail: [
        { advisor: 'App Profile', status: 'won', confidence: 0.96, reasoning: 'profile match' },
        { advisor: 'DOM Memory', status: 'consulted', confidence: 0.5 },
        { advisor: 'AI', status: 'skipped' },
      ],
    });
    const view = deriveDecisionTrail(rec);
    expect(view).toEqual([
      { advisor: 'App Profile', status: 'won', confidence: 96, reasoning: 'profile match' },
      { advisor: 'DOM Memory', status: 'consulted', confidence: 50 },
      { advisor: 'AI', status: 'skipped' },
    ]);
  });

  it('omits confidence when not provided and carries durationMs when present', () => {
    const rec = recordHealingDecision(baseRecord(), {
      decisionTrail: [{ advisor: 'Rule Engine', status: 'won', durationMs: 42 }],
    });
    const view = deriveDecisionTrail(rec);
    expect(view[0]).toEqual({ advisor: 'Rule Engine', status: 'won', durationMs: 42 });
    expect(view[0].confidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deriveEventFeed — narrates the append-only events log into a clean,
// customer-facing story (friendly labels + tone + icon kind).
// ---------------------------------------------------------------------------

/** Build a fully-healed record whose events log mirrors what the worker stamps. */
function healedRecordWithEvents(): ExecutionRecord {
  let rec = createExecutionRecord({
    executionId: 'exec_feed',
    testName: 'checkout works',
    status: 'completed',
    result: 'healed',
    durationMs: 9000,
    startTime: '2026-06-26T09:10:00.000Z',
    endTime: '2026-06-26T09:10:09.000Z',
    profile: 'healing',
  });
  rec = recordDiagnosis(rec, { category: 'timing_failure', confidence: 0.97, recommendedStrategy: 'wait' });
  rec = recordHealingDecision(rec, { appliedStrategy: 'wait_strategy', newLocator: '#pay' });
  rec = recordValidation(rec, { reran: true, passedAfterHealing: true });
  rec = recordLearning(rec, { recorded: true, domMemoryUpdated: true });
  // Mirror the worker's event sequence (createExecutionRecord already stamped created).
  rec = appendEvent(rec, { type: 'stage_changed', stage: 'cloning', timestamp: '2026-06-26T09:10:01.000Z' });
  rec = appendEvent(rec, { type: 'stage_changed', stage: 'installing', timestamp: '2026-06-26T09:10:02.000Z' });
  rec = appendEvent(rec, { type: 'stage_changed', stage: 'executing', timestamp: '2026-06-26T09:10:03.000Z' });
  rec = appendEvent(rec, { type: 'evidence_collected', stage: 'collecting_evidence', timestamp: '2026-06-26T09:10:04.000Z' });
  rec = appendEvent(rec, { type: 'diagnosis_completed', stage: 'diagnosing', timestamp: '2026-06-26T09:10:05.000Z' });
  rec = appendEvent(rec, { type: 'healing_completed', stage: 'healing', timestamp: '2026-06-26T09:10:06.000Z' });
  rec = appendEvent(rec, { type: 'validation_completed', stage: 'validating', note: 'passed', timestamp: '2026-06-26T09:10:07.000Z' });
  rec = appendEvent(rec, { type: 'learning_completed', stage: 'learning', timestamp: '2026-06-26T09:10:08.000Z' });
  rec = setLifecycle(rec, { status: 'completed', result: 'healed', stage: 'completed' });
  return rec;
}

describe('deriveEventFeed', () => {
  it('returns [] for a record with no events', () => {
    const rec = { ...baseRecord(), events: [] };
    expect(deriveEventFeed(rec)).toEqual([]);
  });

  it('narrates the full healed lifecycle into friendly labels', () => {
    const feed = deriveEventFeed(healedRecordWithEvents());
    const labels = feed.map((f) => f.label);
    expect(labels).toEqual([
      'Execution Started',
      'Preparing Environment',
      'Running Tests',
      'Collected Browser Evidence',
      'Diagnosed Timing Failure',
      'Applied Wait Strategy',
      'Validation Passed',
      'Learning Stored',
      'Passed after Healing',
    ]);
  });

  it('collapses the cloning/installing/building prep stages into one "Preparing Environment" line', () => {
    const feed = deriveEventFeed(healedRecordWithEvents());
    expect(feed.filter((f) => f.label === 'Preparing Environment')).toHaveLength(1);
  });

  it('assigns icon kind + tone for each milestone', () => {
    const feed = deriveEventFeed(healedRecordWithEvents());
    const byLabel = (l: string) => feed.find((f) => f.label === l)!;
    expect(byLabel('Collected Browser Evidence').kind).toBe('evidence');
    expect(byLabel('Diagnosed Timing Failure').kind).toBe('diagnosis');
    expect(byLabel('Applied Wait Strategy')).toMatchObject({ kind: 'healing', tone: 'positive' });
    expect(byLabel('Validation Passed')).toMatchObject({ kind: 'validation', tone: 'positive' });
    expect(byLabel('Learning Stored')).toMatchObject({ kind: 'learning', tone: 'positive' });
    expect(byLabel('Passed after Healing')).toMatchObject({ kind: 'finished', tone: 'positive' });
  });

  it('shows "Flagged for Review" when healing is report-only', () => {
    let rec = createExecutionRecord({
      executionId: 'exec_ro', testName: 't', status: 'failed', result: 'fail',
      durationMs: 1000, startTime: '2026-06-26T09:00:00.000Z', endTime: '2026-06-26T09:00:01.000Z', profile: 'healing',
    });
    rec = recordHealingDecision(rec, { reportOnly: true });
    rec = appendEvent(rec, { type: 'healing_completed', stage: 'healing', timestamp: '2026-06-26T09:00:00.500Z' });
    const feed = deriveEventFeed(rec);
    expect(feed.find((f) => f.kind === 'healing')).toMatchObject({ label: 'Flagged for Review', tone: 'neutral' });
  });

  it('shows "Validation Failed" and "Execution Failed" for a failed run', () => {
    let rec = createExecutionRecord({
      executionId: 'exec_fail', testName: 't', status: 'failed', result: 'fail',
      durationMs: 1000, startTime: '2026-06-26T09:00:00.000Z', endTime: '2026-06-26T09:00:01.000Z', profile: 'healing',
    });
    rec = recordValidation(rec, { reran: true, passedAfterHealing: false });
    rec = appendEvent(rec, { type: 'validation_completed', stage: 'validating', note: 'failed', timestamp: '2026-06-26T09:00:00.500Z' });
    rec = setLifecycle(rec, { status: 'completed', result: 'fail', stage: 'completed' });
    const feed = deriveEventFeed(rec);
    expect(feed.find((f) => f.kind === 'validation')).toMatchObject({ label: 'Validation Failed', tone: 'negative' });
    expect(feed.find((f) => f.kind === 'finished')).toMatchObject({ label: 'Execution Failed', tone: 'negative' });
  });

  it('drops stage_changed entries for post-run milestone stages (no duplication)', () => {
    let rec = createExecutionRecord({
      executionId: 'exec_dup', testName: 't', status: 'completed', result: 'pass',
      durationMs: 1000, startTime: '2026-06-26T09:00:00.000Z', endTime: '2026-06-26T09:00:01.000Z', profile: 'healing',
    });
    // A diagnosing stage_changed should NOT add a feed line (milestone covers it).
    rec = appendEvent(rec, { type: 'stage_changed', stage: 'diagnosing', timestamp: '2026-06-26T09:00:00.300Z' });
    const feed = deriveEventFeed(rec);
    expect(feed.some((f) => f.kind === 'diagnosis')).toBe(false);
  });
});
