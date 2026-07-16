/**
 * Requirement Intelligence — public types.
 *
 * Requirement Intelligence is the single, composed answer to the question a
 * consumer actually has about a requirement: "what do we know, and what should
 * we do about it?" It is produced by the RequirementIntelligenceService, which
 * orchestrates the small single-responsibility engines behind one object so
 * that consumers (Script Generation, RTM, Release Center) never wire those
 * engines together themselves.
 *
 * The object composes the outputs of two layers that already exist:
 *   • coverage   — the FACT: how well the repo already covers this requirement
 *                  (Requirement Coverage Engine — a measurement).
 *   • generation — the DECISION: what Script Generation should do about it
 *                  (Generation Policy — a routing policy over the coverage).
 *
 * `reuse` and `risk` are RESERVED for future brains (the Reuse Engine finds
 * reusable code; the Risk Engine scores blast radius). They are intentionally
 * optional and are NOT populated today — declared here only so consumers can
 * grow into them without a breaking shape change.
 */

import type { RequirementInput, RequirementCoverage } from '../requirement-coverage/types';
import type { GenerationDecision } from '../coverage-intelligence/types';

// Re-exported for consumer convenience so callers can import the whole
// Requirement Intelligence surface from one module.
export type {
  RequirementInput,
  RequirementCoverage,
  ExpectedBehavior,
  CoverageSlice,
} from '../requirement-coverage/types';
export { GenerationDecision } from '../coverage-intelligence/types';

export interface RequirementIntelligence {
  /** The requirement this intelligence was computed for (echoed back for consumers). */
  requirement: RequirementInput;
  /** FACT: how well the repository already covers the requirement. */
  coverage: RequirementCoverage;
  /** DECISION: what Script Generation should do — SKIP · EXTEND · GENERATE. */
  generation: GenerationDecision;
  /**
   * RESERVED — future Reuse Engine output (reusable code found for this
   * requirement). Not populated in the current sprint.
   */
  reuse?: unknown;
  /**
   * RESERVED — future Risk Engine output (blast radius / risk score). Not
   * populated in the current sprint.
   */
  risk?: unknown;
}
