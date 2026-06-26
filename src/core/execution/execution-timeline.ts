/**
 * Execution Timeline — derives an ordered, human-readable lifecycle timeline
 * from a canonical {@link ExecutionRecord}.
 *
 * This adds NO new intelligence: it only PRESENTS what the record already
 * captured (execution → evidence → diagnosis → healing → validation → learning).
 * The dashboard's Execution Details page renders this directly.
 *
 * Note on timestamps: a record only knows its own `startTime`/`endTime`, so the
 * first event carries `startTime`, the last carries `endTime`, and intermediate
 * lifecycle stages intentionally omit a clock time (we surface ORDER + outcome,
 * not invented per-step timestamps). Capturing true per-action timing would need
 * richer execution instrumentation, which is deliberately out of scope here.
 */
import type { ExecutionRecord } from './execution-record';

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
export function buildExecutionTimeline(record: ExecutionRecord): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // 1) Execution started.
  events.push({
    key: 'execution_started',
    label: 'Execution started',
    status: 'info',
    detail: record.artifacts?.metadata?.browserInfo || undefined,
    time: record.startTime,
  });

  // 2) Outcome of the run itself.
  const failed = record.status === 'failed' || record.status === 'timedout';
  events.push({
    key: 'run_result',
    label: failed
      ? (record.status === 'timedout' ? 'Test timed out' : 'Test failed')
      : (record.status === 'skipped' ? 'Test skipped' : 'Test passed'),
    status: failed ? 'failed' : (record.status === 'skipped' ? 'skipped' : 'done'),
    detail: record.artifacts?.metadata?.locator
      ? `at ${record.artifacts.metadata.locator}`
      : undefined,
  });

  // 3) Evidence collected (observations present).
  if (record.observations) {
    const ls = record.observations.locatorState;
    const detail = ls
      ? `locator ${ls.exists ? 'exists' : 'missing'}` +
        (ls.interceptedBy ? `, intercepted by ${ls.interceptedBy}` : '')
      : (record.observations.summary?.[0] ?? undefined);
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
