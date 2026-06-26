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
import { toDisplayStage } from './execution-lifecycle';

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

/** One advisor's verdict, ready for the dashboard's Decision Trail card. */
export interface AdvisorDecisionView {
  /** Advisor / layer name, e.g. "App Profile", "DOM Memory", "AI". */
  advisor: string;
  /** Won (applied) · consulted (ran, lost) · skipped (never ran). */
  status: 'won' | 'consulted' | 'skipped';
  /** Confidence as an integer percentage (0..100), when known. */
  confidence?: number;
  /** Short human-readable reason it won / lost / was skipped. */
  reasoning?: string;
  /** Time this advisor spent, in ms, when known (usually absent). */
  durationMs?: number;
}

/**
 * Project the record's authoritative advisor waterfall onto the dashboard view.
 * Confidence is converted from the stored 0..1 scale to an integer percentage so
 * the UI just renders. Returns `[]` for legacy / non-healed records.
 */
export function deriveDecisionTrail(input: ExecutionRecord): AdvisorDecisionView[] {
  const record = coerceLegacyRecord(input);
  const trail = record.healing?.decisionTrail;
  if (!trail || trail.length === 0) return [];
  return trail.map((e) => {
    const view: AdvisorDecisionView = { advisor: e.advisor, status: e.status };
    if (typeof e.confidence === 'number') view.confidence = Math.round(e.confidence * 100);
    if (e.reasoning) view.reasoning = e.reasoning;
    if (typeof e.durationMs === 'number') view.durationMs = e.durationMs;
    return view;
  });
}

// ---------------------------------------------------------------------------
// Friendly event feed — a DERIVED, customer-facing narration of the execution's
// append-only `events` log. Customers don't think in backend event names
// ("stage_changed", "diagnosis_completed"); they want a readable story:
//   09:10:14  Execution Started
//   09:10:17  Collected Browser Evidence
//   09:10:18  Diagnosed Timing Failure
//   09:10:20  Applied Wait Strategy
//   09:10:22  Validation Passed
//   09:10:23  Learning Stored
// The BACKEND owns the labels + tone so the UI only renders. No new data is
// stored — this reads the existing events log. Returns `[]` for legacy records
// with no captured events.
// ---------------------------------------------------------------------------

/** Tone drives the colour the UI shows for a feed entry. */
export type FriendlyEventTone = 'positive' | 'negative' | 'neutral' | 'info';

/** Semantic kind drives the icon the UI shows (mirrors the lifecycle milestone). */
export type FriendlyEventKind =
  | 'started'
  | 'preparing'
  | 'running'
  | 'evidence'
  | 'diagnosis'
  | 'healing'
  | 'validation'
  | 'learning'
  | 'finished';

/** One narrated step in the customer-facing event feed. */
export interface FriendlyEvent {
  /** ISO timestamp the event occurred. */
  timestamp: string;
  /** User-facing narrative label, e.g. "Diagnosed Timing Failure". */
  label: string;
  /** Semantic kind — the UI picks an icon from this. */
  kind: FriendlyEventKind;
  /** Tone for colour: positive (green), negative (red), neutral (grey), info (blue). */
  tone: FriendlyEventTone;
}

/** Title-case a snake/space string: "timing_failure" → "Timing Failure". */
function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Internal stages that map to user-visible PREP/RUN feed entries. */
const PREP_RUN_STAGES: ReadonlyArray<ExecutionStage> = [
  'queued', 'cloning', 'installing', 'building', 'executing',
];

/**
 * Narrate the record's `events` log into a clean, customer-facing feed. Milestone
 * events (evidence/diagnosis/healing/validation/learning/finalize) carry their own
 * friendly labels; `stage_changed` entries are surfaced ONLY for the prep/run
 * stages (and de-duplicated, since cloning/installing/building collapse to one
 * "Preparing Environment" line) so later milestones aren't doubled up.
 */
export function deriveEventFeed(input: ExecutionRecord): FriendlyEvent[] {
  const record = coerceLegacyRecord(input);
  const events = record.events ?? [];
  if (events.length === 0) return [];

  const feed: FriendlyEvent[] = [];
  const pushDeduped = (entry: FriendlyEvent) => {
    const prev = feed[feed.length - 1];
    if (prev && prev.label === entry.label) return; // collapse consecutive duplicates
    feed.push(entry);
  };

  for (const ev of events) {
    switch (ev.type) {
      case 'execution_created':
        pushDeduped({ timestamp: ev.timestamp, label: 'Execution Started', kind: 'started', tone: 'info' });
        break;
      case 'stage_changed': {
        if (!ev.stage || !PREP_RUN_STAGES.includes(ev.stage)) break;
        const display = toDisplayStage(ev.stage);
        if (!display) break;
        const kind: FriendlyEventKind =
          ev.stage === 'executing' ? 'running' : ev.stage === 'queued' ? 'started' : 'preparing';
        pushDeduped({ timestamp: ev.timestamp, label: display, kind, tone: 'neutral' });
        break;
      }
      case 'evidence_collected':
        pushDeduped({ timestamp: ev.timestamp, label: 'Collected Browser Evidence', kind: 'evidence', tone: 'info' });
        break;
      case 'diagnosis_completed': {
        const cat = record.diagnosis?.category;
        pushDeduped({
          timestamp: ev.timestamp,
          label: cat ? `Diagnosed ${titleCase(cat)}` : 'Diagnosis Completed',
          kind: 'diagnosis',
          tone: 'info',
        });
        break;
      }
      case 'healing_completed': {
        const h = record.healing;
        let label = 'No Fix Applied';
        let tone: FriendlyEventTone = 'negative';
        if (h?.appliedStrategy) {
          label = `Applied ${titleCase(h.appliedStrategy)}`;
          tone = 'positive';
        } else if (h?.reportOnly) {
          label = 'Flagged for Review';
          tone = 'neutral';
        }
        pushDeduped({ timestamp: ev.timestamp, label, kind: 'healing', tone });
        break;
      }
      case 'validation_completed': {
        const passed = ev.note ? ev.note === 'passed' : record.validation?.passedAfterHealing === true;
        pushDeduped({
          timestamp: ev.timestamp,
          label: passed ? 'Validation Passed' : 'Validation Failed',
          kind: 'validation',
          tone: passed ? 'positive' : 'negative',
        });
        break;
      }
      case 'learning_completed': {
        const recorded = record.learning?.recorded === true;
        pushDeduped({
          timestamp: ev.timestamp,
          label: recorded ? 'Learning Stored' : 'Nothing Stored',
          kind: 'learning',
          tone: recorded ? 'positive' : 'neutral',
        });
        break;
      }
      case 'execution_finalized': {
        const result = record.result ?? null;
        let label = 'Execution Finished';
        let tone: FriendlyEventTone = 'info';
        if (result === 'healed') { label = 'Passed after Healing'; tone = 'positive'; }
        else if (result === 'pass') { label = 'Execution Passed'; tone = 'positive'; }
        else if (result === 'fail') { label = record.status === 'timed_out' ? 'Execution Timed Out' : 'Execution Failed'; tone = 'negative'; }
        else if (result === 'skipped') { label = 'Execution Skipped'; tone = 'neutral'; }
        pushDeduped({ timestamp: ev.timestamp, label, kind: 'finished', tone });
        break;
      }
    }
  }
  return feed;
}
