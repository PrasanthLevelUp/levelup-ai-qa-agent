/**
 * Validation Planning — public types.
 *
 * The Validation Planner answers the single question that was actually missing
 * when the engine returned 11 Positive / 1 Negative / 0 Edge:
 *
 *     "For every field and rule we discovered, what validations SHOULD exist?"
 *
 * It sits directly after the Requirement Understanding Engine and directly
 * before the Scenario Planner:
 *
 *     Requirement → Understanding (BusinessModel) → VALIDATION PLANNER → Scenario Planner → GPT
 *
 * It is deterministic and LLM-free. It does not write test cases; it enumerates
 * the validation POINTS a balanced suite must cover, each attributed and
 * categorized. The Scenario Planner turns one point into one scenario; GPT only
 * turns a scenario into prose. Discovery of *what to test* stops being GPT's
 * job — which is exactly why the positive/negative/edge balance stops being a
 * lottery.
 */

import type { CoverageFamily } from '../engines/generation-quality-engine';
import type { EvidenceSource } from '../requirement-understanding/types';

/**
 * The kind of check a validation point expresses. This is the granular label a
 * QA engineer thinks in; `family` (below) is the coarse bucket the Quality
 * Validator grades on, so the planner and the auditor speak the same language.
 */
export type ValidationCategory =
  | 'positive'    // the happy path — valid input is accepted
  | 'negative'    // invalid input is rejected (empty, wrong format, duplicate…)
  | 'boundary'    // limits — min/max length, range edges
  | 'edge'        // unusual-but-legal-to-attempt input (unicode, spaces, input-safety)
  | 'permission'; // authorization — who may / may not perform the action

/**
 * What a validation point is attached to. Lets a consumer group the plan by
 * field ("everything we check about Email") or reason about entity/action-level
 * happy paths separately from field-level checks.
 */
export type ValidationTarget = 'field' | 'rule' | 'entity' | 'action';

/**
 * One planned validation — a single thing a balanced suite should verify. It is
 * NOT a test case and NOT a scenario; it is the unit of *coverage intent*. The
 * Scenario Planner will expand exactly one scenario per point.
 */
export interface ValidationPoint {
  /** Stable, human-readable slug — e.g. 'email:negative:invalid-format'. */
  id: string;
  category: ValidationCategory;
  /** The coarse family the Quality Validator grades on (positive/negative/edge/advanced). */
  family: CoverageFamily;
  /** Business-readable title — e.g. 'Reject invalid Email format'. */
  title: string;
  /** What this point is attached to. */
  target: ValidationTarget;
  /** Normalized name of the field/rule/entity/action this point concerns. */
  appliesTo: string;
  /** WHY this validation exists — the knowledge rationale (auditable, no invention). */
  rationale: string;
  /**
   * The evidence source of the TARGET this point hangs off (carried from the
   * BusinessModel element's provenance). A validation for a domain-inferred
   * field is itself only as trustworthy as that field — so tier admissibility
   * is inherited, not re-decided here.
   */
  source: EvidenceSource;
  /**
   * True when the point rests on assumption rather than stated/observed fact —
   * i.e. the target was not `repository`/`requirement` evidence, or the check is
   * a best-practice expectation the requirement never spelled out. Surfaced so a
   * suite can visibly separate "verified expectation" from "prudent assumption".
   */
  assumption: boolean;
}

/** Options that tune how aggressive the planner is. All default to the safe choice. */
export interface ValidationPlanOptions {
  /**
   * Include input-safety edge checks (leading/trailing spaces, unicode/emoji,
   * SQL-ish and XSS-ish payloads) for free-text fields. These are universal for
   * any user-editable text input, but they blur into "security", so they are a
   * single switch rather than silently always-on. Default: true.
   */
  includeInputSafetyEdges?: boolean;
  /**
   * Cap on edge points emitted per field, to keep a suite proportionate on
   * wide forms. Default: unlimited (0).
   */
  maxEdgePerField?: number;
}

/** Per-family tallies of a plan — the intended coverage mix, before generation. */
export interface PlannedCoverageMix {
  positive: number;
  negative: number;
  edge: number;      // boundary + edge categories both map to the edge family
  advanced: number;  // permission and other advanced families
  total: number;
  /** Human-readable, same vocabulary the Quality Validator uses. */
  label: string;
}

/**
 * The Validation Plan — the planner's whole output. `points` is the coverage
 * intent; `mix` is what that intent will produce when each point becomes one
 * scenario, so a caller can SEE the balance before a single token is spent.
 */
export interface ValidationPlan {
  requirementId: string;
  entity: string | null;
  points: ValidationPoint[];
  mix: PlannedCoverageMix;
}
