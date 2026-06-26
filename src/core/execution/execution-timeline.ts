/**
 * Execution Timeline — derives an ordered, human-readable lifecycle timeline
 * from a canonical {@link ExecutionRecord}.
 *
 * This adds NO new intelligence: it only PRESENTS what the record already
 * captured (execution → evidence → diagnosis → healing → validation → learning).
 * The dashboard's Execution Details page renders this directly.
 *
 * Note on timestamps: this human-readable timeline surfaces ORDER + outcome and
 * carries clock times only where the record reliably knows them (start/end). For
 * TRUE per-stage timing, use {@link deriveStageHistory} below — it derives exact
 * start/end/duration for every stage straight from the record's append-only
 * `events` log (no invented timestamps).
 */
import { coerceLegacyRecord, type ExecutionRecord, type ExecutionStage } from './execution-record';

/** Outcome marker for a timeline event (drives the icon/colour in the UI). */
export type TimelineEventStatus = 'done' | 'failed' | 'skipped' | 'info';

export interface TimelineEvent {
  /** Stable key for the stage (stable across records — good for React keys). */
  key: string;
  /** Short human label, e.g. "Diagnosis". */
  label: string;
  /** Outcome marker. */
  status: TimelineEventStatus;
  /** Optional one-line detail (e.g. the diagnosis category or applied strategy). */
  detail?: string;
  /** ISO time when truthfully known (first/last stage only). */
  time?: string;
}

/**
 * Build the lifecycle timeline for one execution record. Stages only appear when
 * the record actually has data for them, so an un-diagnosed/un-healed run yields
 * a shorter, honest timeline.
 */
export function buildExecutionTimeline(input: ExecutionRecord): TimelineEvent[] {
  // Normalize legacy (v2) records so we can reason about the {status, result}
  // split uniformly. v3+ records pass through unchanged.
  const record = coerceLegacyRecord(input);
  const events: TimelineEvent[] = [];

  // 1) Execution started.
  events.push({
    key: 'execution_started',
    label: 'Execution started',
    status: 'info',
    detail: record.artifacts?.metadata?.browserInfo || undefined,
    time: record.startTime,
  });

  // 2) Outcome of the run itself — driven by RESULT (the test outcome), not the
  // lifecycle status. A record still in flight (no terminal result) shows as
  // "running" rather than a misleading pass/fail.
  const result = record.result ?? null;
  const timedOut = record.status === 'timed_out';
  const runEvent: TimelineEvent = (() => {
    const detail = record.artifacts?.metadata?.locator
      ? `at ${record.artifacts.metadata.locator}`
      : undefined;
    if (result === null) {
      return { key: 'run_result', label: 'Test running', status: 'info' as const, detail };
    }
    if (result === 'skipped') {
      return { key: 'run_result', label: 'Test skipped', status: 'skipped' as const, detail };
    }
    if (result === 'fail') {
      return {
        key: 'run_result',
        label: timedOut ? 'Test timed out' : 'Test failed',
        status: 'failed' as const,
        detail,
      };
    }
    // pass or healed
    return {
      key: 'run_result',
      label: result === 'healed' ? 'Test healed' : 'Test passed',
      status: 'done' as const,
      detail,
    };
  })();
  events.push(runEvent);

  // 3) Evidence collected (evidence present).
  if (record.evidence) {
    const ls = record.evidence.locatorState;
    const detail = ls
      ? `locator ${ls.exists ? 'exists' : 'missing'}` +
        (ls.interceptedBy ? `, intercepted by ${ls.interceptedBy}` : '')
      : (record.evidence.summary?.[0] ?? undefined);
    events.push({
      key: 'evidence',
      label: 'Evidence collected',
      status: 'done',
      detail,
    });
  }

  // 4) Diagnosis (classifier verdict present).
  if (record.diagnosis) {
    const conf = typeof record.diagnosis.confidence === 'number'
      ? ` (${Math.round(record.diagnosis.confidence * 100)}%)`
      : '';
    events.push({
      key: 'diagnosis',
      label: 'Diagnosis',
      status: 'done',
      detail: `${record.diagnosis.category}${conf}`,
    });
  }

  // 5) Healing decision.
  if (record.healing) {
    const h = record.healing;
    if (h.reportOnly) {
      events.push({
        key: 'healing',
        label: 'Healing',
        status: 'skipped',
        detail: 'Report only — no auto-fix applied',
      });
    } else if (h.appliedStrategy) {
      events.push({
        key: 'healing',
        label: 'Healing',
        status: 'done',
        detail: `Applied ${h.appliedStrategy}` +
          (h.newLocator ? ` → ${h.newLocator}` : ''),
      });
    } else {
      events.push({
        key: 'healing',
        label: 'Healing',
        status: 'failed',
        detail: 'No fix applied',
      });
    }
  }

  // 6) Validation (rerun after healing).
  if (record.validation?.reran) {
    const passed = record.validation.passedAfterHealing;
    events.push({
      key: 'validation',
      label: 'Validation',
      status: passed ? 'done' : 'failed',
      detail: passed ? 'Passed on rerun' : 'Failed on rerun',
    });
  }

  // 7) Learning (written back to memory).
  if (record.learning) {
    events.push({
      key: 'learning',
      label: 'Learning',
      status: record.learning.recorded ? 'done' : 'skipped',
      detail: record.learning.recorded
        ? (record.learning.domMemoryUpdated ? 'Stored + DOM memory updated' : 'Stored')
        : 'Nothing to store',
    });
  }

  // 8) Execution finished (carries the real end time + total duration).
  events.push({
    key: 'execution_finished',
    label: 'Execution finished',
    status: 'info',
    detail: `${(record.durationMs / 1000).toFixed(1)}s total`,
    time: record.endTime,
  });

  return events;
}

// ---------------------------------------------------------------------------
// Stage history — a DERIVED view (never stored). Reconstructs each stage the
// execution passed through, with exact start/end/duration, straight from the
// record's append-only `events` log. This is the substrate for the dashboard's
// per-stage timing bar, bottleneck analysis ("Healing was the slowest stage at
// 2.8s") and replay scrubber — all without persisting anything extra.
// ---------------------------------------------------------------------------

/** One stage the execution occupied, with its measured span. */
export interface StageHistoryEntry {
  stage: ExecutionStage;
  /** ISO time the stage began. */
  startedAt: string;
  /** ISO time the stage ended (the next stage's start, or the record end). */
  completedAt?: string;
  /** Milliseconds spent in this stage (completedAt − startedAt), when known. */
  durationMs?: number;
}

function closeSpan(entry: StageHistoryEntry, endAt: string): void {
  if (Date.parse(endAt) >= Date.parse(entry.startedAt)) {
    entry.completedAt = endAt;
    entry.durationMs = Math.max(0, Date.parse(endAt) - Date.parse(entry.startedAt));
  }
}

/**
 * Derive the ordered stage history from the record's `events` log. Each distinct
 * stage opens a span that closes when the next distinct stage begins; the final
 * open span is closed by the record's end time. Consecutive duplicate stages are
 * merged. Returns `[]` for legacy records with no captured history.
 */
export function deriveStageHistory(input: ExecutionRecord): StageHistoryEntry[] {
  const record = coerceLegacyRecord(input);
  const stamps = (record.events ?? [])
    .filter((e) => e.stage !== undefined)
    .map((e) => ({ stage: e.stage as ExecutionStage, at: e.timestamp }));
  if (stamps.length === 0) return [];

  const history: StageHistoryEntry[] = [];
  for (const s of stamps) {
    const prev = history[history.length - 1];
    if (prev && prev.stage === s.stage) {
      // Same stage repeated (e.g. created + finalize both 'completed') — extend
      // the existing span's end marker rather than opening a duplicate.
      closeSpan(prev, s.at);
      continue;
    }
    if (prev && !prev.completedAt) closeSpan(prev, s.at);
    history.push({ stage: s.stage, startedAt: s.at });
  }
  // Close the final open span using the record's end time when sane.
  const last = history[history.length - 1];
  if (last && !last.completedAt && record.endTime) closeSpan(last, record.endTime);
  return history;
}
