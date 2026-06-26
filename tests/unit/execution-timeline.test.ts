/**
 * Tests for the Execution Timeline builder — derives an ordered lifecycle
 * timeline purely from a canonical ExecutionRecord (no new intelligence).
 */
import {
  buildExecutionTimeline,
  deriveStageHistory,
  deriveDecisionTrail,
  deriveEventFeed,
  deriveExecutionHealth,
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

  it('passes the ENTIRE decision (raw status + reason) through verbatim and converts confidence 0..1 → integer %', () => {
    const rec = recordHealingDecision(baseRecord(), {
      decisionTrail: [
        { advisor: 'App Profile', status: 'hit', confidence: 0.96, reason: 'Resolved #login-button from cached DOM' },
        { advisor: 'DOM Memory', status: 'miss', confidence: 0.5, reason: 'No prior successful heal for this failure' },
        { advisor: 'AI', status: 'skipped', reason: 'Higher layer already resolved' },
        { advisor: 'Crawl', status: 'not_reached' },
      ],
    });
    const view = deriveDecisionTrail(rec);
    expect(view).toEqual([
      { advisor: 'App Profile', status: 'hit', reason: 'Resolved #login-button from cached DOM', confidence: 96 },
      { advisor: 'DOM Memory', status: 'miss', reason: 'No prior successful heal for this failure', confidence: 50 },
      { advisor: 'AI', status: 'skipped', reason: 'Higher layer already resolved' },
      { advisor: 'Crawl', status: 'not_reached' },
    ]);
  });

  it('omits confidence when not provided and carries durationMs when present', () => {
    const rec = recordHealingDecision(baseRecord(), {
      decisionTrail: [{ advisor: 'Rule Engine', status: 'hit', durationMs: 42 }],
    });
    const view = deriveDecisionTrail(rec);
    expect(view[0]).toEqual({ advisor: 'Rule Engine', status: 'hit', durationMs: 42 });
    expect(view[0].confidence).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// deriveEventFeed — narrates the append-only events log into a SEMANTIC feed
// (kind + structured data ONLY; the UI owns all labels/icons/colour for i18n).
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

  it('narrates the full healed lifecycle into an ordered sequence of semantic kinds', () => {
    const feed = deriveEventFeed(healedRecordWithEvents());
    const kinds = feed.map((f) => f.kind);
    expect(kinds).toEqual([
      'execution_started',
      'preparing_environment',
      'running_tests',
      'evidence_collected',
      'diagnosis_completed',
      'healing_applied',
      'validation_passed',
      'learning_stored',
      'execution_healed',
    ]);
  });

  it('carries raw structured data (never display text) for diagnosis + healing kinds', () => {
    const feed = deriveEventFeed(healedRecordWithEvents());
    const byKind = (k: string) => feed.find((f) => f.kind === k)!;
    expect(byKind('diagnosis_completed').data).toEqual({ category: 'timing_failure' });
    expect(byKind('healing_applied').data).toEqual({ strategy: 'wait_strategy' });
    // Milestone kinds without params carry no data blob.
    expect(byKind('evidence_collected').data).toBeUndefined();
    expect(byKind('execution_healed').data).toBeUndefined();
  });

  it('collapses the cloning/installing/building prep stages into one "preparing_environment" kind', () => {
    const feed = deriveEventFeed(healedRecordWithEvents());
    expect(feed.filter((f) => f.kind === 'preparing_environment')).toHaveLength(1);
  });

  it('every entry carries an ISO timestamp and a kind (no human-facing text)', () => {
    const feed = deriveEventFeed(healedRecordWithEvents());
    for (const f of feed) {
      expect(typeof f.timestamp).toBe('string');
      expect(Number.isNaN(Date.parse(f.timestamp))).toBe(false);
      expect(typeof f.kind).toBe('string');
      expect(f).not.toHaveProperty('label');
      expect(f).not.toHaveProperty('tone');
    }
  });

  it('emits "healing_report_only" when healing is report-only', () => {
    let rec = createExecutionRecord({
      executionId: 'exec_ro', testName: 't', status: 'failed', result: 'fail',
      durationMs: 1000, startTime: '2026-06-26T09:00:00.000Z', endTime: '2026-06-26T09:00:01.000Z', profile: 'healing',
    });
    rec = recordHealingDecision(rec, { reportOnly: true });
    rec = appendEvent(rec, { type: 'healing_completed', stage: 'healing', timestamp: '2026-06-26T09:00:00.500Z' });
    const feed = deriveEventFeed(rec);
    expect(feed.some((f) => f.kind === 'healing_report_only')).toBe(true);
  });

  it('emits "validation_failed" and "execution_failed" for a failed run', () => {
    let rec = createExecutionRecord({
      executionId: 'exec_fail', testName: 't', status: 'failed', result: 'fail',
      durationMs: 1000, startTime: '2026-06-26T09:00:00.000Z', endTime: '2026-06-26T09:00:01.000Z', profile: 'healing',
    });
    rec = recordValidation(rec, { reran: true, passedAfterHealing: false });
    rec = appendEvent(rec, { type: 'validation_completed', stage: 'validating', note: 'failed', timestamp: '2026-06-26T09:00:00.500Z' });
    rec = appendEvent(rec, { type: 'execution_finalized', stage: 'completed', timestamp: '2026-06-26T09:00:00.900Z' });
    rec = setLifecycle(rec, { status: 'completed', result: 'fail', stage: 'completed' });
    const feed = deriveEventFeed(rec);
    expect(feed.some((f) => f.kind === 'validation_failed')).toBe(true);
    expect(feed.some((f) => f.kind === 'execution_failed')).toBe(true);
  });

  it('drops stage_changed entries for post-run milestone stages (no duplication)', () => {
    let rec = createExecutionRecord({
      executionId: 'exec_dup', testName: 't', status: 'completed', result: 'pass',
      durationMs: 1000, startTime: '2026-06-26T09:00:00.000Z', endTime: '2026-06-26T09:00:01.000Z', profile: 'healing',
    });
    // A diagnosing stage_changed should NOT add a feed line (milestone covers it).
    rec = appendEvent(rec, { type: 'stage_changed', stage: 'diagnosing', timestamp: '2026-06-26T09:00:00.300Z' });
    const feed = deriveEventFeed(rec);
    expect(feed.some((f) => f.kind === 'diagnosis_completed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deriveExecutionHealth — an at-a-glance per-phase verdict (semantic only).
// Always returns all six phases in canonical order; the UI owns labels/icons.
// ---------------------------------------------------------------------------

describe('deriveExecutionHealth', () => {
  const phases = (rec: ExecutionRecord) => deriveExecutionHealth(rec).map((h) => h.phase);
  const statusOf = (rec: ExecutionRecord, phase: string) =>
    deriveExecutionHealth(rec).find((h) => h.phase === phase)!.status;

  it('always returns all six phases in canonical order', () => {
    expect(phases(baseRecord())).toEqual([
      'execution', 'evidence', 'diagnosis', 'healing', 'validation', 'learning',
    ]);
  });

  it('reads a never-run record as not_run for every phase except the (failed) execution', () => {
    const health = deriveExecutionHealth(baseRecord());
    expect(health).toEqual([
      { phase: 'execution', status: 'failed' },
      { phase: 'evidence', status: 'not_run' },
      { phase: 'diagnosis', status: 'not_run' },
      { phase: 'healing', status: 'not_run' },
      { phase: 'validation', status: 'not_run' },
      { phase: 'learning', status: 'not_run' },
    ]);
  });

  it('reads a fully-healed record as passed across every phase', () => {
    let rec = baseRecord();
    rec = recordObservations(rec, {
      locatorState: {
        exists: true, visible: true, enabled: true, receivesPointerEvents: false,
        clickable: false, interceptedBy: '.overlay', source: 'dom_snapshot',
      },
    });
    rec = recordDiagnosis(rec, { category: 'timing', confidence: 0.97, recommendedStrategy: 'wait' });
    rec = recordHealingDecision(rec, { appliedStrategy: 'rule_based', newLocator: '#login-btn' });
    rec = recordValidation(rec, { reran: true, passedAfterHealing: true });
    rec = recordLearning(rec, { recorded: true, domMemoryUpdated: true });
    rec = { ...rec, status: 'completed', result: 'healed' };
    expect(deriveExecutionHealth(rec)).toEqual([
      { phase: 'execution', status: 'passed' },
      { phase: 'evidence', status: 'passed' },
      { phase: 'diagnosis', status: 'passed' },
      { phase: 'healing', status: 'passed' },
      { phase: 'validation', status: 'passed' },
      { phase: 'learning', status: 'passed' },
    ]);
  });

  it('marks a low-confidence diagnosis as partial', () => {
    const rec = recordDiagnosis(baseRecord(), { category: 'timing', confidence: 0.3, recommendedStrategy: 'wait' });
    expect(statusOf(rec, 'diagnosis')).toBe('partial');
  });

  it('marks report-only healing as partial', () => {
    const rec = recordHealingDecision(baseRecord(), { reportOnly: true });
    expect(statusOf(rec, 'healing')).toBe('partial');
  });

  it('marks an applied heal that failed validation as failed healing + failed validation', () => {
    let rec = recordHealingDecision(baseRecord(), { appliedStrategy: 'rule_based', newLocator: '#x' });
    rec = recordValidation(rec, { reran: true, passedAfterHealing: false });
    expect(statusOf(rec, 'healing')).toBe('failed');
    expect(statusOf(rec, 'validation')).toBe('failed');
  });

  it('marks an applied-but-unverified heal as partial healing', () => {
    const rec = recordHealingDecision(baseRecord(), { appliedStrategy: 'rule_based', newLocator: '#x' });
    expect(statusOf(rec, 'healing')).toBe('partial');
  });

  it('marks learning that recorded nothing as skipped', () => {
    const rec = recordLearning(baseRecord(), { recorded: false });
    expect(statusOf(rec, 'learning')).toBe('skipped');
  });
});
