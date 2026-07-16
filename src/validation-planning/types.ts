/**
 * Validation Planning — public types.
 *
 * The Validation Planner answers the single question that was actually missing
 * when the engine returned 11 Positive / 1 Negative / 0 Edge:
 *
 *     "What should a QA lead test about this requirement?"
 *
 * It sits directly after the Requirement Understanding Engine and directly
 * before the Scenario Planner:
 *
 *     Requirement → Understanding (BusinessModel) → VALIDATION PLANNER → Scenario Planner → GPT
 *
 * It is deterministic and LLM-free. It does not write test cases; it enumerates
 * the validation POINTS a balanced suite must cover, each attributed and
 * categorized. The Scenario Planner turns one point into one scenario; GPT only
 * turns a scenario into prose.
 *
 * The organizing principle is a QA TAXONOMY, not the field list. Experienced QA
 * engineers do not think "for each field, generate validations" — that makes
 * the suite size a function of field count, which is exactly why positives
 * exploded. They think in categories ("can it be created? what if not? who? how
 * far? is it safe?") and then discover which rules/fields each category touches.
 * So the planner walks the taxonomy top-down:
 *
 *     Category → applicable Rules/Fields → Validation Point
 *
 * Positives become a property of the CAPABILITY (one or two per action), not of
 * the field count. Cross-field concerns (security, data integrity) become a few
 * category-level points that list the fields they touch, instead of repeating
 * per field.
 */

import type { CoverageFamily } from '../engines/generation-quality-engine';
import type { EvidenceSource } from '../requirement-understanding/types';

/**
 * The QA taxonomy — the top-level lens a validation is discovered through. This
 * is the DRIVER of planning: the planner iterates these in order and asks each
 * "which rules/fields of this model do you apply to?". New concerns (security,
 * accessibility, localization, …) are added by registering a category, never by
 * touching field logic.
 *
 * `family` (below, on a point) is a separate, coarser axis — the bucket the
 * Quality Validator grades on. One category can yield points of several
 * families (Input Validation → negative; Boundary → edge; Functional →
 * positive), so the two axes must not be conflated.
 */
export type ValidationCategory =
  | 'functional'        // can the capability be exercised successfully?
  | 'business_rule'     // are domain rules enforced (uniqueness, dependencies, …)?
  | 'input_validation'  // is invalid per-field input rejected (empty, wrong format)?
  | 'boundary'          // are limits enforced (min/max length, ranges)?
  | 'permission'        // who may / may not perform the action?
  | 'security'          // is malicious input neutralized (injection, script)?
  | 'data_integrity'    // is unusual-but-legal data preserved (unicode, spaces)?
  | 'integration'       // reserved: cross-system side effects
  | 'recovery'          // reserved: failure / rollback behaviour
  | 'accessibility'     // reserved: keyboard, focus, ARIA, contrast
  | 'localization'      // reserved: language, currency, timezone, date format
  | 'performance';      // reserved: latency / load characteristics

/**
 * The order the planner walks the taxonomy — also the order points are grouped
 * in the plan, so a reviewer reads it the way a QA lead would write a test plan
 * (functional first, safety last). Reserved categories are registered but yield
 * no points until knowledge is added for them; they exist so extending the
 * planner never means re-shaping the core loop.
 */
export const TAXONOMY_ORDER: readonly ValidationCategory[] = [
  'functional',
  'business_rule',
  'input_validation',
  'boundary',
  'permission',
  'security',
  'data_integrity',
  'integration',
  'recovery',
  'accessibility',
  'localization',
  'performance',
] as const;

/**
 * What a validation point is attached to. Lets a consumer group the plan by
 * field, or reason about entity/action-level happy paths separately from
 * field-level checks.
 */
export type ValidationTarget = 'field' | 'rule' | 'entity' | 'action';

/**
 * One planned validation — a single thing a balanced suite should verify. It is
 * NOT a test case and NOT a scenario; it is the unit of *coverage intent*. The
 * Scenario Planner will expand exactly one scenario per point.
 */
export interface ValidationPoint {
  /** Stable, human-readable slug — e.g. 'email:input_validation:invalid-format'. */
  id: string;
  /** The QA taxonomy lens this point was discovered through. */
  category: ValidationCategory;
  /** The coarse family the Quality Validator grades on (positive/negative/edge/advanced). */
  family: CoverageFamily;
  /** Business-readable title — e.g. 'Reject invalid Email format'. */
  title: string;
  /** What this point is attached to. */
  target: ValidationTarget;
  /** Normalized name of the primary field/rule/entity/action this point concerns. */
  appliesTo: string;
  /**
   * For a category-level point that spans MANY fields (a single "reject SQL
   * injection" that covers every free-text input), the normalized names of all
   * fields it touches. Absent for single-target points. This is the mechanism
   * that stops cross-field concerns from repeating per field.
   */
  appliesToFields?: string[];
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
   * Include the Security and Data-Integrity categories (injection/script
   * payloads, unicode/emoji/whitespace) for free-text fields. Universal for any
   * user-editable text, but they blur into "security", so they are a single
   * switch rather than silently always-on. Default: true.
   */
  includeInputSafetyEdges?: boolean;
  /**
   * Cap on boundary points emitted per field, to keep a suite proportionate on
   * very wide forms. Default: unlimited (0). Security/data-integrity points are
   * already category-level (one per payload, not per field) so they need no cap.
   */
  maxEdgePerField?: number;
}

/** Per-family tallies of a plan — the intended coverage mix, before generation. */
export interface PlannedCoverageMix {
  positive: number;
  negative: number;
  edge: number;      // boundary + edge + security + data-integrity all map to the edge family
  advanced: number;  // permission and other advanced families
  total: number;
  /** Human-readable, same vocabulary the Quality Validator uses. */
  label: string;
  /**
   * Per-category tallies — how the plan reads as a QA test plan (Functional: 2,
   * Input Validation: 4, …). Only categories that produced points appear.
   */
  byCategory: Partial<Record<ValidationCategory, number>>;
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
