/**
 * Unit tests for the per-request execution profile resolution and the canonical
 * Execution Record accumulators (Priority 1 architectural refinements).
 */
import {
  resolveExecutionProfile,
  resolveCollectHealingArtifacts,
} from '../../src/core/execution/execution-settings';
import {
  createExecutionRecord,
  recordArtifacts,
  recordObservations,
  recordDiagnosis,
  recordHealingDecision,
  recordValidation,
  recordLearning,
  EXECUTION_RECORD_SCHEMA_VERSION,
  type ArtifactDescriptor,
  type ExecutionRecord,
} from '../../src/core/execution/execution-record';

describe('resolveExecutionProfile — defaults overridden per request', () => {
  it('uses the per-request override when provided', () => {
    expect(resolveExecutionProfile('debug', 'standard')).toBe('debug');
    expect(resolveExecutionProfile('fast', 'healing')).toBe('fast');
  });

  it('falls back to the project default when no request override', () => {
    expect(resolveExecutionProfile(undefined, 'healing')).toBe('healing');
    expect(resolveExecutionProfile(null, 'fast')).toBe('fast');
  });

  it('falls back to the system default when neither is set', () => {
    expect(resolveExecutionProfile(undefined, undefined)).toBe('standard');
    expect(resolveExecutionProfile(null, null)).toBe('standard');
  });
});

describe('resolveCollectHealingArtifacts — boolean precedence', () => {
  it('honours an explicit per-request false even when the default is true', () => {
    expect(resolveCollectHealingArtifacts(false, true)).toBe(false);
  });

  it('honours an explicit per-request true even when the default is false', () => {
    expect(resolveCollectHealingArtifacts(true, false)).toBe(true);
  });

  it('falls back to the project default, then the system default', () => {
    expect(resolveCollectHealingArtifacts(undefined, false)).toBe(false);
    expect(resolveCollectHealingArtifacts(undefined, undefined)).toBe(true);
  });
});

describe('Execution Record — canonical lifecycle accumulation', () => {
  function base(): ExecutionRecord {
    return createExecutionRecord({
      executionId: 'exec_1',
      testName: 'login should work',
      status: 'failed',
      durationMs: 1234,
      startTime: '2026-01-01T00:00:00.000Z',
      endTime: '2026-01-01T00:00:01.234Z',
      profile: 'healing',
    });
  }

  it('creates a record stamped with the current schema version and empty artifacts', () => {
    const rec = base();
    expect(rec.schemaVersion).toBe(EXECUTION_RECORD_SCHEMA_VERSION);
    expect(rec.artifacts).toEqual({});
    expect(rec.diagnosis).toBeUndefined();
  });

  it('accumulates observations → diagnosis → healing → validation → learning immutably', () => {
    const rec = base();

    const withObs = recordObservations(rec, {
      locatorState: {
        exists: true, visible: true, enabled: true,
        receivesPointerEvents: false, clickable: false,
        interceptedBy: '.overlay', source: 'dom_snapshot',
      },
      summary: ['element covered by overlay'],
    });
    // original is untouched (immutable merge)
    expect(rec.observations).toBeUndefined();
    expect(withObs.observations?.locatorState?.interceptedBy).toBe('.overlay');

    const withDiag = recordDiagnosis(withObs, {
      category: 'timing',
      confidence: 0.95,
      recommendedStrategy: 'wait_for_overlay',
      healableByLocatorSwap: false,
    });
    expect(withDiag.diagnosis?.category).toBe('timing');
    expect(withDiag.diagnosis?.confidence).toBe(0.95);
    // earlier section preserved
    expect(withDiag.observations?.summary).toContain('element covered by overlay');

    const withHeal = recordHealingDecision(withDiag, {
      remedy: 'inject_wait',
      attemptedStrategies: ['wait_for_overlay'],
      appliedStrategy: 'wait_for_overlay',
      reportOnly: false,
    });
    expect(withHeal.healing?.appliedStrategy).toBe('wait_for_overlay');

    const withVal = recordValidation(withHeal, { reran: true, passedAfterHealing: true, confirmationRuns: 2 });
    expect(withVal.validation?.passedAfterHealing).toBe(true);

    const withLearn = recordLearning(withVal, { recorded: true, domMemoryUpdated: true });
    expect(withLearn.learning?.recorded).toBe(true);

    // full lifecycle present on the final record
    expect(withLearn.observations).toBeDefined();
    expect(withLearn.diagnosis).toBeDefined();
    expect(withLearn.healing).toBeDefined();
    expect(withLearn.validation).toBeDefined();
    expect(withLearn.learning).toBeDefined();
  });

  it('merges repeated section writes rather than discarding earlier keys', () => {
    let rec = base();
    rec = recordValidation(rec, { reran: true });
    rec = recordValidation(rec, { passedAfterHealing: false });
    expect(rec.validation).toEqual({ reran: true, passedAfterHealing: false });
  });

  it('stores artifacts as storage-agnostic descriptors (id + storage, not bare paths)', () => {
    const trace: ArtifactDescriptor = {
      id: 'art_trace_1',
      type: 'trace',
      storage: 's3',
      path: 'tenants/42/exec_1/trace.zip',
      size: 240939,
      contentType: 'application/zip',
    };
    const rec = recordArtifacts(base(), { trace });
    expect(rec.artifacts.trace?.id).toBe('art_trace_1');
    expect(rec.artifacts.trace?.storage).toBe('s3');
    expect(rec.artifacts.trace?.size).toBe(240939);
    // The same schema supports swapping the backend without shape changes.
    const moved = recordArtifacts(rec, {
      trace: { ...trace, storage: 'browserstack', path: 'sessions/abc/trace.zip' },
    });
    expect(moved.artifacts.trace?.storage).toBe('browserstack');
  });

  it('keeps Tier-1 metadata inline while file artifacts are descriptors', () => {
    const rec = recordArtifacts(base(), {
      metadata: { url: 'https://app/login', locator: '#login', failedLine: 42 },
      screenshot: { id: 'art_s1', type: 'screenshot', storage: 'local', path: '/tmp/s.png' },
    });
    expect(rec.artifacts.metadata?.failedLine).toBe(42);
    expect(rec.artifacts.screenshot?.storage).toBe('local');
  });
});
