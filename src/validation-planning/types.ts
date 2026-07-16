/**
 * Validation Planning — public types.
 *
 * The engine's internal unit is a VALIDATION OBLIGATION, not a Positive /
 * Negative / Edge test. An obligation is a thing that MUST be validated for the
 * business to be safe — "reject a duplicate email", "block an unauthorized
 * user", "preserve unicode names". It is discovered from business risk, carries
 * the risk it addresses, and is deduplicated by INTENT (two obligations that
 * assert the same validation of the same concept are one obligation).
 *
 * Positive / Negative / Edge is NOT how the engine reasons. It is a
 * presentation-layer classification applied at the very end, purely so the
 * output speaks the vocabulary the Quality Validator and a human reviewer
 * already know. Internally the engine only ever asks: "what validation
 * obligation does the business have here, and is it already met?"
 *
 * Pipeline position (unchanged):
 *
 *   Requirement → Requirement Understanding (BusinessModel)
 *              → VALIDATION PLANNER (obligations)  ← here
 *              → Scenario Planner → GPT
 *
 * Deterministic and LLM-free. The planner discovers WHAT must be validated; the
 * Scenario Planner turns one obligation into one scenario; GPT only writes prose.
 */

import type { CoverageFamily } from '../engines/generation-quality-engine';
import type { EvidenceSource } from '../requirement-understanding/types';

/**
 * A validation DIMENSION — the risk lens an obligation is discovered through.
 * These are NOT mandatory categories to be filled to a quota; they are the
 * questions a senior QA lead asks, and a dimension contributes obligations only
 * when it actually APPLIES to the requirement (a form with no auth rule yields
 * no authorization obligations). Reserved dimensions are declared so extending
 * the engine is registering a discoverer, never re-shaping the core loop.
 */
export type ValidationDimension =
  | 'functional'        // can the business capability be completed?
  | 'business_rule'     // can a domain rule be violated?
  | 'input_validation'  // can invalid data enter the system?
  | 'boundary'          // can limits be exceeded?
  | 'authorization'     // can an unauthorized user perform the action?
  | 'security'          // can malicious input damage the application?
  | 'data_integrity'    // can the application corrupt or lose data?
  | 'integration'       // reserved: can integrations fail?
  | 'recovery'          // reserved: can it recover after failure?
  | 'accessibility'     // reserved: can users with disabilities use it?
  | 'localization'      // reserved: can multiple languages / locales work?
  | 'performance';      // reserved: can it survive production load?

/** The order dimensions are discovered and grouped — a QA lead's reading order. */
export const DIMENSION_ORDER: readonly ValidationDimension[] = [
  'functional',
  'business_rule',
  'input_validation',
  'boundary',
  'authorization',
  'security',
  'data_integrity',
  'integration',
  'recovery',
  'accessibility',
  'localization',
  'performance',
] as const;

/** What an obligation is anchored to, for grouping and downstream scenario shaping. */
export type ObligationTarget = 'capability' | 'field' | 'rule';

/**
 * Whether an obligation still needs a scenario generated for it. Repository
 * intelligence can mark an obligation `covered` when existing tests already
 * satisfy its intent — the planner then reports it but does not ask for
 * regeneration. Everything not known-covered is a `gap`.
 */
export type ObligationStatus = 'gap' | 'covered';

/**
 * One validation obligation — the atomic unit of coverage INTENT. Not a test
 * case, not a scenario. Carries no Positive/Negative/Edge label; that is
 * derived later (see CoveragePresentation).
 */
export interface ValidationObligation {
  /** Stable id: `${concept}::${intent}` — also the intent signature used for dedup and reuse. */
  id: string;
  /**
   * The business CONCEPT being validated — the dedup grouping. Many obligations
   * share a concept ("email" has validity, uniqueness, length obligations); the
   * engine prefers one scenario that covers several where honest, and never
   * emits two obligations with the same (concept, intent).
   */
  concept: string;
  /** The specific NEW validation this obligation provides (e.g. 'reject-duplicate'). */
  intent: string;
  /** The risk lens it was discovered through. */
  dimension: ValidationDimension;
  /** Business-readable statement — e.g. 'Reject a duplicate Email'. */
  statement: string;
  /** The business RISK this obligation guards against — why it is worth a scenario. */
  riskAddressed: string;
  /** What this obligation is anchored to. */
  target: ObligationTarget;
  /** Normalized name of the primary field/rule/capability it concerns. */
  appliesTo: string;
  /** When one obligation validates several fields at once (injection across all free-text inputs). */
  appliesToFields?: string[];
  /** Evidence source of the underlying element (inherited, not re-decided here). */
  source: EvidenceSource;
  /** True when the obligation rests on best-practice assumption rather than stated/observed fact. */
  assumption: boolean;
  /** gap = needs a scenario; covered = repository already satisfies it. */
  status: ObligationStatus;
}

/**
 * A structural read of how much validation surface the requirement carries.
 * This DRIVES dynamic sizing: the number of obligations is not a target, it
 * emerges from which dimensions actually apply and how many elements each
 * touches. `complexity` is an honest heuristic label over the signals below,
 * not a precise score.
 */
export interface RiskProfile {
  businessRuleCount: number;
  inputCount: number;
  /** Free-text inputs a user can type into — the injection / data-integrity surface. */
  securityExposureFields: number;
  /** True when an authorization rule was discovered. */
  hasAuthorization: boolean;
  /** Dependency rules — a proxy for external/prerequisite coupling. */
  externalDependencyCount: number;
  /** The dimensions that actually apply to THIS requirement (drives what gets discovered). */
  applicableDimensions: ValidationDimension[];
  /** Honest heuristic label — 'simple' | 'moderate' | 'complex'. */
  complexity: 'simple' | 'moderate' | 'complex';
}

/**
 * Computable coverage metrics — the success measures that DON'T reduce to a raw
 * count. Deliberately omits any "production risk reduced" figure: that is not
 * honestly derivable from a static requirement + repo, so the engine does not
 * fabricate one.
 */
export interface PlanMetrics {
  /** Obligations that still need a scenario (status = gap). The real "size" of the work. */
  obligationsToGenerate: number;
  /** Applicable dimensions that produced at least one obligation ÷ applicable dimensions. */
  dimensionCoverage: number;
  /** Business rules with at least one obligation ÷ total business rules (1 when none exist). */
  businessRuleCoverage: number;
  /** Obligations removed because another obligation already asserted the same intent. */
  duplicationEliminated: number;
  /** Obligations marked covered by existing repository tests (not regenerated). */
  repositoryReuse: number;
}

/**
 * The PRESENTATION layer — and only here does Positive / Negative / Edge exist.
 * It is a projection of the obligations onto the CoverageFamily vocabulary the
 * Quality Validator grades on, so the loop still closes (plan → generate →
 * audit against the same buckets) without the engine ever having reasoned in
 * those buckets internally.
 */
export interface CoveragePresentation {
  positive: number;
  negative: number;
  edge: number;
  advanced: number;
  total: number;
  label: string;
  /** Obligation counts per dimension — how the plan reads as a QA test plan. */
  byDimension: Partial<Record<ValidationDimension, number>>;
}

/** Options that tune discovery. All default to the safe choice. */
export interface ValidationPlanOptions {
  /**
   * Include the Security and Data-Integrity dimensions (injection/script,
   * unicode/emoji/whitespace) for free-text inputs. Default: true.
   */
  includeInputSafetyEdges?: boolean;
  /**
   * Cap on boundary obligations emitted per field, to keep very wide forms
   * proportionate. Default: unlimited (0).
   */
  maxBoundaryPerField?: number;
  /**
   * Repository intelligence: intent signatures (`concept::intent`) already
   * covered by existing tests. Matching obligations are marked `covered` and
   * excluded from `obligationsToGenerate` — the engine never duplicates
   * repository knowledge. Default: none.
   */
  alreadyCovered?: string[];
}

/**
 * The Validation Plan — the planner's whole output.
 *
 * `obligations` is the coverage intent (the engine's real reasoning).
 * `riskProfile` explains WHY the plan is the size it is. `metrics` are the
 * count-free success measures. `presentation` is the derived Positive/Negative/
 * Edge view for humans and the auditor — explicitly a projection, not the source
 * of truth.
 */
export interface ValidationPlan {
  requirementId: string;
  capability: string | null;
  riskProfile: RiskProfile;
  obligations: ValidationObligation[];
  metrics: PlanMetrics;
  presentation: CoveragePresentation;
}

/** Maps a dimension onto the coarse family the Quality Validator grades on — PRESENTATION ONLY. */
export const DIMENSION_TO_FAMILY: Record<ValidationDimension, CoverageFamily> = {
  functional: 'positive',
  business_rule: 'negative',
  input_validation: 'negative',
  boundary: 'edge',
  authorization: 'advanced',
  security: 'edge',
  data_integrity: 'edge',
  integration: 'advanced',
  recovery: 'advanced',
  accessibility: 'edge',
  localization: 'edge',
  performance: 'advanced',
};
