/**
 * Requirement Coverage — public types.
 *
 * The Requirement Coverage Engine has exactly ONE job: compare a single
 * requirement against the repository's Coverage Model (built by the Repository
 * Context Engine) and report how well that requirement is already covered.
 *
 * It does NOT decide what Script Generation should do (that is Generation
 * Intelligence), it does NOT find reusable code (that is the Reuse Engine), and
 * it does NOT generate anything. Comparison only — deterministic, no LLM.
 */

/**
 * The minimal requirement shape this engine needs. Callers (Requirements
 * module, Release Center, etc.) adapt their own richer requirement records down
 * to this. Only `id` and `title` are required; the optional hints sharpen the
 * match when available but the engine degrades gracefully without them.
 */
export interface RequirementInput {
  id: string;
  title: string;
  description?: string;
  /** Feature area the requirement belongs to, if known (e.g. 'Authentication'). */
  feature?: string;
  /**
   * Explicit behaviors the requirement expects to be covered. When provided,
   * these drive the per-behavior matching; otherwise the title is treated as a
   * single expected behavior.
   */
  expectedFlows?: string[];
  /** Pages/screens the requirement touches, if known. */
  pages?: string[];
  /** Free-form tags, if any. */
  tags?: string[];
}

/**
 * How a single expected behavior was matched (or not) against the Coverage
 * Model, in the engine's priority order. Surfaced so callers can see WHY a
 * requirement was classified the way it was, not just the verdict.
 */
export type CoverageMatchLevel =
  | 'FLOW'            // matched a covered flow by name (strongest)
  | 'BUSINESS_ACTION' // matched via canonical business-action synonyms
  | 'ASSERTION'       // matched assertions exercised by the feature
  | 'PAGE_OBJECT'     // matched a page/screen the feature exercises
  | 'KEYWORD'         // matched only by keyword overlap (weakest)
  | 'NONE';           // not matched

export interface BehaviorMatch {
  behavior: string;          // the requirement's expected-behavior label
  level: CoverageMatchLevel; // how it matched (NONE if unmatched)
  matchedFlow: string | null; // the covered flow it matched, if any
  score: number;             // 0-1 strength of this behavior's match
}

/**
 * The verdict for one requirement against the Coverage Model.
 */
export interface RequirementCoverage {
  requirementId: string;
  status: 'COVERED' | 'PARTIAL' | 'MISSING';
  /** Share of expected behaviors that are covered, 0-100 (rounded). */
  coverage: number;
  /** The requirement's expected behaviors that ARE covered. */
  coveredFlows: string[];
  /** The requirement's expected behaviors that are NOT covered. */
  missingFlows: string[];
  /**
   * Confidence in this classification, 0-100. High when matches are strong
   * (flow/business-action) or when a "missing" verdict is unambiguous; lower
   * when the engine had to fall back to keyword overlap.
   */
  confidence: number;
  /** The Coverage Model feature this requirement was compared against, if one matched. */
  matchedFeature: string | null;
  /** Per-behavior match detail, in the same order as the expected behaviors. */
  matches: BehaviorMatch[];
}
