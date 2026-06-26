/**
 * Healing Trail — concise, honest observability for the 3-layer self-healing engine.
 *
 * The healing worker historically only surfaced SUCCESSFUL heals. When a failure
 * was an assertion / environment / functional issue (nothing a locator swap can
 * fix), or when all three layers tried and gave up, the UI just said
 * "N failures — healing unsuccessful" with zero insight into *what was tried*.
 *
 * This module builds a compact per-failure trail describing:
 *   • how the failure was classified (broken-locator vs assertion/env/navigation)
 *   • which of the 3 healing layers ran (Rule → Pattern/DB → AI), the candidate
 *     locator each proposed, its confidence, and why it was accepted/rejected
 *   • a one-line human summary per failure
 *
 * Plus a job-level summary string that tells the honest story across all failures
 * (e.g. "7 failures: 0 broken-locator issues, 7 assertion/environment failures —
 * nothing to heal"). Pure functions + a small builder, fully unit-testable and
 * with NO side effects.
 */

import type { FailureDiagnosis, FailureCategory } from './failure-classifier';

/** The three healing layers (matches HealingStrategy in healing-orchestrator). */
export type HealingLayerName =
  | 'rule_based'
  | 'database_pattern'
  | 'ai_reasoning'
  | string;

/** What happened to a single layer's candidate. */
export type LayerDecision =
  | 'applied'       // candidate applied AND the test passed on rerun → heal succeeded
  | 'rejected'      // candidate rejected by acceptance pre-check or validation layer
  | 'rerun_failed'  // candidate applied but the test still failed on rerun
  | 'no_candidate'  // the layer (or all layers) produced no candidate locator
  | 'skipped';      // healing not attempted for this failure class

/** How a failure was classified for healing purposes. */
export type FailureClass =
  | 'healable_locator' // broken/changed locator — the kind of failure healing targets
  | 'assertion'        // element found but assertion mismatch (functional/data issue)
  | 'timeout'          // generic timeout not tied to a specific locator
  | 'navigation'       // network/navigation error (env/infra, out of scope)
  | 'unknown';         // could not be classified confidently

export interface HealingLayerAttempt {
  layer: HealingLayerName;
  candidate?: string;   // candidate locator the layer proposed
  confidence?: number;  // 0..1
  decision: LayerDecision;
  reason: string;       // short, human-readable reason
}

export interface HealingTrail {
  testName: string;
  failureType: string;        // raw FailureType from the analyzer
  classification: FailureClass;
  healable: boolean;          // did we attempt locator healing for this failure?
  attempts: HealingLayerAttempt[];
  outcome: 'healed' | 'not_healed';
  summary: string;            // one-line human summary for this failure
  /** Structured diagnosis-first classification, when available. */
  diagnosis?: FailureDiagnosis;
}

/** Map a diagnosis-first category onto the trail's healing classification. */
export function classificationFromDiagnosis(category: FailureCategory): FailureClass {
  switch (category) {
    case 'locator':
      return 'healable_locator';
    case 'assertion':
      return 'assertion';
    case 'timing':
      return 'timeout';
    case 'navigation':
      return 'navigation';
    default:
      // api / environment / framework / unknown have no dedicated bucket yet.
      return 'unknown';
  }
}

/** Map the analyzer's raw failureType to a healing classification + healability. */
export function classifyFailure(failureType: string): {
  classification: FailureClass;
  healable: boolean;
} {
  switch (failureType) {
    case 'locator':
    case 'locator_timeout':
      return { classification: 'healable_locator', healable: true };
    case 'assertion':
      return { classification: 'assertion', healable: false };
    case 'timeout':
      return { classification: 'timeout', healable: false };
    case 'navigation':
      return { classification: 'navigation', healable: false };
    default:
      // 'unknown' still enters the locator healing loop, so treat as healable.
      return { classification: 'unknown', healable: true };
  }
}

/** Human label for a failure class (used in summaries / UI). */
export function classLabel(c: FailureClass): string {
  switch (c) {
    case 'healable_locator': return 'broken locator';
    case 'assertion':        return 'assertion / functional';
    case 'timeout':          return 'timeout';
    case 'navigation':       return 'navigation / environment';
    default:                 return 'unclassified';
  }
}

/**
 * Builder that accumulates per-layer attempts for ONE failure and finalizes a
 * HealingTrail with a sensible default one-line summary.
 */
export class HealingTrailBuilder {
  private readonly attempts: HealingLayerAttempt[] = [];
  private readonly classification: FailureClass;
  private readonly healable: boolean;
  private readonly diagnosis?: FailureDiagnosis;

  constructor(
    private readonly testName: string,
    private readonly failureType: string,
    diagnosis?: FailureDiagnosis,
  ) {
    // Prefer the diagnosis-first classification when available — it is richer and
    // correctly marks non-locator failures (and locator failures with no
    // resolvable selector) as NOT healable, instead of the old failureType-only
    // default that treated 'unknown' as healable.
    if (diagnosis) {
      this.diagnosis = diagnosis;
      this.classification = classificationFromDiagnosis(diagnosis.category);
      this.healable = diagnosis.healableByLocatorSwap;
    } else {
      const c = classifyFailure(failureType);
      this.classification = c.classification;
      this.healable = c.healable;
    }
  }

  get isHealable(): boolean {
    return this.healable;
  }

  /** Number of layer attempts recorded so far. */
  get attemptCount(): number {
    return this.attempts.length;
  }

  /** Whether an applied (successful) attempt has already been recorded. */
  get hasApplied(): boolean {
    return this.attempts.some((a) => a.decision === 'applied');
  }

  /** Record one layer attempt. Returns `this` for chaining. */
  record(attempt: HealingLayerAttempt): this {
    this.attempts.push(attempt);
    return this;
  }

  /** Mark that healing was skipped for this (non-healable) failure class. */
  skip(reason: string): this {
    this.attempts.push({
      layer: 'rule_based',
      decision: 'skipped',
      reason,
    });
    return this;
  }

  finalize(outcome: 'healed' | 'not_healed', summaryOverride?: string): HealingTrail {
    return {
      testName: this.testName,
      failureType: this.failureType,
      classification: this.classification,
      healable: this.healable,
      attempts: [...this.attempts],
      outcome,
      summary: summaryOverride ?? this.defaultSummary(outcome),
      diagnosis: this.diagnosis,
    };
  }

  private defaultSummary(outcome: 'healed' | 'not_healed'): string {
    const label = classLabel(this.classification);
    if (outcome === 'healed') {
      const applied = this.attempts.find((a) => a.decision === 'applied');
      const via = applied ? ` via ${layerLabel(applied.layer)}` : '';
      return `Healed${via} — test passed on rerun.`;
    }
    if (!this.healable) {
      // When we have a structured diagnosis, its root cause is the most honest,
      // specific one-liner — especially for api/environment/framework/unknown
      // categories that share the 'unknown' trail bucket.
      if (this.diagnosis) {
        return `${capitalize(this.diagnosis.category)} failure — ${this.diagnosis.rootCause} ${this.diagnosis.recommendedAction}`.trim();
      }
      if (this.classification === 'assertion') {
        return 'Assertion/functional failure — element was found but the assertion did not match. Not a locator issue, so nothing to heal (real product/data defect).';
      }
      if (this.classification === 'navigation') {
        return 'Navigation/environment error — page or network failed to load. Out of scope for locator healing (infra/env issue).';
      }
      if (this.classification === 'timeout') {
        return 'Generic timeout not tied to a specific locator — attempted wait injection only.';
      }
      return 'Not a locator failure — nothing to heal.';
    }
    // Healable but not healed → all 3 layers tried and failed.
    const tried = this.attempts.length;
    const rejected = this.attempts.filter((a) => a.decision === 'rejected').length;
    const rerunFailed = this.attempts.filter((a) => a.decision === 'rerun_failed').length;
    const noCandidate = this.attempts.some((a) => a.decision === 'no_candidate');
    if (tried === 0 || (noCandidate && rejected === 0 && rerunFailed === 0)) {
      return `Broken-locator failure, but none of the 3 healing layers could propose a viable candidate.`;
    }
    const bits: string[] = [];
    if (rejected) bits.push(`${rejected} rejected by validation`);
    if (rerunFailed) bits.push(`${rerunFailed} applied but rerun still failed`);
    return `Broken-locator failure — tried ${tried} candidate(s) across the 3 layers (${bits.join(', ') || 'no viable fix'}).`;
  }
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Friendly label for a healing layer. */
export function layerLabel(layer: HealingLayerName): string {
  switch (layer) {
    case 'rule_based':       return 'Rule Engine (Layer 1)';
    case 'database_pattern': return 'Pattern/DB (Layer 2)';
    case 'ai_reasoning':     return 'AI Reasoning (Layer 3)';
    default:                 return String(layer);
  }
}

/**
 * Build the honest job-level one-liner across all failure trails.
 * Example: "7 failures: 0 broken-locator issues healed; 7 assertion/environment
 * failures (nothing to heal)."
 */
export function summarizeHealingTrails(trails: HealingTrail[]): string {
  const total = trails.length;
  if (total === 0) return 'No failures to heal.';

  const healed = trails.filter((t) => t.outcome === 'healed').length;
  const healableNotHealed = trails.filter((t) => t.healable && t.outcome !== 'healed').length;
  const assertion = trails.filter((t) => t.classification === 'assertion').length;
  const navigation = trails.filter((t) => t.classification === 'navigation').length;
  const timeout = trails.filter((t) => t.classification === 'timeout').length;

  const parts: string[] = [];
  if (healed > 0) parts.push(`${healed} healed`);
  if (healableNotHealed > 0) parts.push(`${healableNotHealed} broken-locator unresolved`);

  const envBucket = assertion + navigation + timeout;
  if (envBucket > 0) {
    const detail: string[] = [];
    if (assertion) detail.push(`${assertion} assertion/functional`);
    if (navigation) detail.push(`${navigation} navigation/environment`);
    if (timeout) detail.push(`${timeout} timeout`);
    parts.push(`${envBucket} non-locator (${detail.join(', ')}) — nothing to heal`);
  }

  const headline = `${total} failure${total === 1 ? '' : 's'} analyzed across the 3 healing layers`;
  return parts.length > 0 ? `${headline}: ${parts.join('; ')}.` : `${headline}.`;
}
