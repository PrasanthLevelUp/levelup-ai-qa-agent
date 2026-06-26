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
import {
  coerceLegacyRecord,
  type ExecutionRecord,
  type ExecutionStage,
  type AdvisorOutcome,
} from './execution-record';


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

// ---------------------------------------------------------------------------
// Decision Trail — a DERIVED view of the advisor waterfall (never stored as a
// projection). The record already carries the AUTHORITATIVE trail captured from
// the orchestrator at heal time (`healing.decisionTrail`); this projection only
// reshapes it for the dashboard: confidence as an integer %, and a stable view
// type the UI renders verbatim. The UI NEVER infers which advisors ran — the
// backend told it exactly. Returns `[]` for runs that never healed.
// ---------------------------------------------------------------------------

/**
 * One advisor's verdict, ready for the dashboard's Decision Trail card. This is
 * the ENTIRE decision: the raw orchestrator outcome + the reason + confidence +
 * duration. The only transformation vs. the stored entry is confidence 0..1 →
 * integer %; everything else passes through verbatim so the UI is near-zero
 * logic and the customer sees exactly WHY each layer hit / missed / skipped.
 */
export interface AdvisorDecisionView {
  /** Advisor / layer name, e.g. "App Profile", "DOM Memory", "AI". */
  advisor: string;
  /** Raw orchestrator outcome: hit · miss · skipped · not_reached · error. */
  status: AdvisorOutcome;
  /** Human-readable reason for the outcome, when known. */
  reason?: string;
  /** Confidence as an integer percentage (0..100), when known. */
  confidence?: number;
  /** Time this advisor spent, in ms, when known (usually absent). */
  durationMs?: number;
}

/**
 * Project the record's authoritative advisor waterfall onto the dashboard view.
 * Confidence is converted from the stored 0..1 scale to an integer percentage so
 * the UI just renders. Everything else (status, reason) passes through verbatim.
 * Returns `[]` for legacy / non-healed records.
 */
export function deriveDecisionTrail(input: ExecutionRecord): AdvisorDecisionView[] {
  const record = coerceLegacyRecord(input);
  const trail = record.healing?.decisionTrail;
  if (!trail || trail.length === 0) return [];
  return trail.map((e) => {
    const view: AdvisorDecisionView = { advisor: e.advisor, status: e.status };
    if (e.reason) view.reason = e.reason;
    if (typeof e.confidence === 'number') view.confidence = Math.round(e.confidence * 100);
    if (typeof e.durationMs === 'number') view.durationMs = e.durationMs;
    return view;
  });
}

// ---------------------------------------------------------------------------
// Execution event feed — a DERIVED, SEMANTIC narration of the execution's
// append-only `events` log. Customers don't think in raw backend event names
// ("stage_changed"); they want a readable story:
//   09:10:14  Execution started
//   09:10:17  Collected browser evidence
//   09:10:18  Diagnosed timing failure
//   09:10:20  Applied wait strategy
//   09:10:22  Validation passed
//   09:10:23  Learning stored
//
// CRITICAL separation of concerns: the backend emits SEMANTIC kinds + structured
// data ONLY — never human-facing text. The UI owns all labels/icons/colour, so
// adding another language later changes only the UI. (e.g. backend emits
// { kind: 'diagnosis_completed', data: { category: 'timing_failure' } }; the UI
// renders "🩺 Diagnosed Timing Failure" or its localized equivalent.) No new data
// is stored — this reads the existing events log. Returns `[]` for legacy records
// with no captured events.
// ---------------------------------------------------------------------------

/**
 * Semantic kind of a feed entry. Each maps 1:1 to a label template in the UI, so
 * the backend never carries display text. Fine-grained (e.g. healing_applied vs
 * healing_report_only vs healing_failed) so the UI needs zero branching logic.
 */
export type ExecutionFeedKind =
  | 'execution_started'
  | 'preparing_environment'
  | 'running_tests'
  | 'evidence_collected'
  | 'diagnosis_completed'
  | 'healing_applied'
  | 'healing_report_only'
  | 'healing_failed'
  | 'validation_passed'
  | 'validation_failed'
  | 'learning_stored'
  | 'learning_skipped'
  | 'execution_passed'
  | 'execution_healed'
  | 'execution_failed'
  | 'execution_timed_out'
  | 'execution_skipped';

/** Structured params the UI interpolates into a label — raw, never pre-formatted. */
export interface ExecutionFeedData {
  /** Raw diagnosis category, e.g. "timing_failure" (the UI title-cases it). */
  category?: string;
  /** Raw applied healing strategy, e.g. "wait_strategy" (the UI title-cases it). */
  strategy?: string;
}

/** One step in the semantic event feed. Carries NO display text — only meaning. */
export interface ExecutionFeedEvent {
  /** ISO timestamp the event occurred. */
  timestamp: string;
  /** Semantic kind — the UI maps this to label + icon + colour. */
  kind: ExecutionFeedKind;
  /** Structured params for label interpolation, when relevant. */
  data?: ExecutionFeedData;
}

/** Internal stages that map to user-visible PREP/RUN feed entries. */
const PREP_RUN_STAGES: ReadonlyArray<ExecutionStage> = [
  'queued', 'cloning', 'installing', 'building', 'executing',
];

/**
 * Narrate the record's `events` log into a SEMANTIC feed. Milestone events
 * (evidence/diagnosis/healing/validation/learning/finalize) each emit a precise
 * kind; `stage_changed` entries are surfaced ONLY for the prep/run stages (and
 * de-duplicated, since cloning/installing/building collapse to one
 * 'preparing_environment' kind) so later milestones aren't doubled up.
 */
export function deriveEventFeed(input: ExecutionRecord): ExecutionFeedEvent[] {
  const record = coerceLegacyRecord(input);
  const events = record.events ?? [];
  if (events.length === 0) return [];

  const feed: ExecutionFeedEvent[] = [];
  const push = (entry: ExecutionFeedEvent) => {
    const prev = feed[feed.length - 1];
    if (prev && prev.kind === entry.kind) return; // collapse consecutive duplicate kinds
    feed.push(entry);
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'execution_created':
        push({ timestamp: ev.timestamp, kind: 'execution_started' });
        break;
      case 'stage_changed': {
        if (!ev.stage || !PREP_RUN_STAGES.includes(ev.stage)) break;
        const kind: ExecutionFeedKind =
          ev.stage === 'executing' ? 'running_tests'
            : ev.stage === 'queued' ? 'execution_started'
            : 'preparing_environment';
        push({ timestamp: ev.timestamp, kind });
        break;
      }
      case 'evidence_collected':
        push({ timestamp: ev.timestamp, kind: 'evidence_collected' });
        break;
      case 'diagnosis_completed': {
        const category = record.diagnosis?.category;
        push({
          timestamp: ev.timestamp,
          kind: 'diagnosis_completed',
          ...(category ? { data: { category } } : {}),
        });
        break;
      }
      case 'healing_completed': {
        const h = record.healing;
        if (h?.appliedStrategy) {
          push({ timestamp: ev.timestamp, kind: 'healing_applied', data: { strategy: h.appliedStrategy } });
        } else if (h?.reportOnly) {
          push({ timestamp: ev.timestamp, kind: 'healing_report_only' });
        } else {
          push({ timestamp: ev.timestamp, kind: 'healing_failed' });
        }
        break;
      }
      case 'validation_completed': {
        const passed = ev.note ? ev.note === 'passed' : record.validation?.passedAfterHealing === true;
        push({ timestamp: ev.timestamp, kind: passed ? 'validation_passed' : 'validation_failed' });
        break;
      }
      case 'learning_completed': {
        const recorded = record.learning?.recorded === true;
        push({ timestamp: ev.timestamp, kind: recorded ? 'learning_stored' : 'learning_skipped' });
        break;
      }
      case 'execution_finalized': {
        const result = record.result ?? null;
        let kind: ExecutionFeedKind = 'execution_passed';
        if (result === 'healed') kind = 'execution_healed';
        else if (result === 'pass') kind = 'execution_passed';
        else if (result === 'fail') kind = record.status === 'timed_out' ? 'execution_timed_out' : 'execution_failed';
        else if (result === 'skipped') kind = 'execution_skipped';
        push({ timestamp: ev.timestamp, kind });
        break;
      }
    }
  }
  return feed;
}

// ---------------------------------------------------------------------------
// Execution Health — a DERIVED, at-a-glance verdict for each lifecycle phase.
// Within ~2 seconds a viewer sees whether Execution / Evidence / Diagnosis /
// Healing / Validation / Learning each did its job. Like every projection here
// it is SEMANTIC ONLY (phase key + status) — the UI owns labels, icons, colour —
// and reads straight off the record (no new intelligence, nothing stored).
// ---------------------------------------------------------------------------

/** The six lifecycle phases shown in the health bar (semantic keys, UI labels them). */
export type ExecutionPhase =
  | 'execution'
  | 'evidence'
  | 'diagnosis'
  | 'healing'
  | 'validation'
  | 'learning';

/**
 * Per-phase health verdict:
 *   passed  — phase ran and succeeded
 *   partial — phase ran but with a caveat (low-confidence, report-only, unverified)
 *   failed  — phase ran and did not succeed
 *   skipped — phase deliberately did nothing (e.g. nothing to learn)
 *   not_run — phase never executed for this record
 */
export type PhaseStatus = 'passed' | 'partial' | 'failed' | 'skipped' | 'not_run';

/** One phase's health verdict. */
export interface ExecutionHealthEntry {
  phase: ExecutionPhase;
  status: PhaseStatus;
}

/** Threshold below which a diagnosis is shown as a lower-confidence (partial) verdict. */
const DIAGNOSIS_CONFIDENCE_FLOOR = 0.5;

/**
 * Derive the per-phase health verdicts for one execution. Always returns all six
 * phases in canonical order so the bar is stable across records (a phase that
 * never ran reads as `not_run`, not omitted). Pure projection off the record.
 */
export function deriveExecutionHealth(input: ExecutionRecord): ExecutionHealthEntry[] {
  const record = coerceLegacyRecord(input);
  const result = record.result ?? null;
  const evidence = record.evidence;
  const d = record.diagnosis;
  const h = record.healing;
  const v = record.validation;
  const l = record.learning;

  // Execution — did the test run reach a successful terminal state?
  const executionStatus: PhaseStatus =
    result === 'pass' || result === 'healed' ? 'passed'
      : result === 'fail' ? 'failed'
      : result === 'skipped' ? 'skipped'
      : 'not_run';

  // Evidence — were any observed facts captured?
  const hasEvidence = !!evidence && (
    !!evidence.locatorState
    || !!evidence.summary?.length
    || !!evidence.consoleErrors?.length
    || !!evidence.networkErrors?.length
  );
  const evidenceStatus: PhaseStatus = hasEvidence ? 'passed' : 'not_run';

  // Diagnosis — a verdict was reached (partial when low-confidence).
  const diagnosisStatus: PhaseStatus = !d
    ? 'not_run'
    : (typeof d.confidence === 'number' && d.confidence < DIAGNOSIS_CONFIDENCE_FLOOR ? 'partial' : 'passed');

  // Healing — did we apply a fix, and did it hold?
  let healingStatus: PhaseStatus = 'not_run';
  if (h) {
    if (h.reportOnly) {
      healingStatus = 'partial';                                   // surfaced to humans, no auto-fix
    } else if (h.appliedStrategy) {
      healingStatus = v?.passedAfterHealing === true ? 'passed'    // applied + verified
        : v?.passedAfterHealing === false ? 'failed'               // applied but didn't hold
        : 'partial';                                               // applied but unverified
    } else if ((h.attemptedStrategies?.length ?? 0) > 0) {
      healingStatus = 'failed';                                    // tried, nothing applied
    } else {
      healingStatus = 'not_run';
    }
  }

  // Validation — did the rerun confirm the fix?
  const validationStatus: PhaseStatus = !v?.reran
    ? 'not_run'
    : v.passedAfterHealing === true ? 'passed'
      : v.passedAfterHealing === false ? 'failed'
      : 'partial';

  // Learning — was anything written back to memory?
  const learningStatus: PhaseStatus = !l
    ? 'not_run'
    : l.recorded ? 'passed' : 'skipped';

  return [
    { phase: 'execution', status: executionStatus },
    { phase: 'evidence', status: evidenceStatus },
    { phase: 'diagnosis', status: diagnosisStatus },
    { phase: 'healing', status: healingStatus },
    { phase: 'validation', status: validationStatus },
    { phase: 'learning', status: learningStatus },
  ];
}
