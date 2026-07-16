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
 * A single expected behavior paired with the requirement's linked test case(s)
 * that specify it. This is how the caller binds a behavior label to its source
 * test case UP FRONT — at the boundary where both the label and the test case
 * id are already known — so no fuzzy title matching is ever needed later.
 */
export interface ExpectedBehavior {
  /** The behavior/flow label (same role as an entry in `expectedFlows`). */
  label: string;
  /**
   * The requirement's linked test case id(s) that specify this behavior. May be
   * empty when the caller has a label but no bound test case; the engine still
   * classifies the behavior, it just emits an empty-id slice for it.
   */
  testCaseIds?: string[];
}

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
  /**
   * Structured expected behaviors, each paired with the requirement's linked
   * test case id(s) that specify it. PREFERRED over `expectedFlows` when the
   * caller knows which test case backs each behavior (e.g. the Script Gen route,
   * which loads a requirement's linked test cases). When provided, the engine
   * carries those ids through into `coveredSlices` / `missingSlices`, so the
   * EXTEND path can slice generation down to exactly the MISSING behaviors'
   * test cases WITHOUT any title/string matching downstream.
   *
   * Fully backward compatible: when omitted, `expectedFlows` (or the title) is
   * used and the emitted slices simply carry empty `testCaseIds`. When both are
   * given, `behaviors` wins.
   */
  behaviors?: ExpectedBehavior[];
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
 * A flow bucketed by the coverage verdict, carrying the requirement's linked
 * test case id(s) that specify it. This is the structure the EXTEND path reads:
 * `missingSlices` gives it the EXACT test cases to generate, by id — no title
 * matching, no re-derivation. `testCaseIds` is empty when the caller provided
 * only `expectedFlows` (no test-case bindings).
 */
export interface CoverageSlice {
  /** The expected behavior label. */
  flow: string;
  /** The requirement's linked test case id(s) for this behavior. */
  testCaseIds: string[];
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
   * `coveredFlows`, each paired with its linked test case id(s). Same order as
   * `coveredFlows`; `flow` values are identical. Carries the bindings the EXTEND
   * path needs so it never has to re-match a flow to a test case by title.
   */
  coveredSlices: CoverageSlice[];
  /**
   * `missingFlows`, each paired with its linked test case id(s). The EXTEND path
   * generates EXACTLY these test cases. Same order as `missingFlows`.
   */
  missingSlices: CoverageSlice[];
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
