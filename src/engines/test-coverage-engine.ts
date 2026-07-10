/**
 * AI Test Coverage Intelligence Engine
 * Transforms requirements into senior-QA-level test scenarios & cases
 * with business awareness, coverage gap analysis, and automation readiness scoring.
 */

import OpenAI from 'openai';
import { logger } from '../utils/logger';
import { ModelSelector } from '../ai/model-selector';
import { AnthropicClient, resolveAnthropicModel, isAnthropicConfigured } from '../ai/anthropic-client';
import { CostTracker } from '../ai/cost-tracker';
import { KnowledgeOptimizer, type KnowledgeItem as OptimizerKnowledgeItem } from '../ai/knowledge-optimizer';
import {
  IntelligenceOrchestrator,
  getIntelligenceOrchestrator,
  type OrchestratorSource,
  type IntelligenceScore,
} from '../services/intelligence-orchestrator';
import {
  planScenarios,
  buildScenarioPlanBlock,
  type ScenarioPlan,
  type ScenarioEvidence,
  type EvidenceSource,
} from './scenario-planner';
import {
  buildDraftTestCases,
  buildDraftBlock,
  buildFormatterPrompt,
  buildFormatterInputs,
  buildRepairPrompt,
  buildDeterministicOutput,
  buildScenariosFromDrafts,
  applyPolish,
  type DraftTestCase,
  type FormatterTestCase,
  type FormatterInput,
  type StepGrounding,
  type StructuredExpected,
} from './scenario-builder';
import type { Dataset } from './dataset-resolver';
import { validateCanonicalTestCases } from './canonical-validator';
import { validateQaStandard, violationsToInstructions } from './qa-standard-validator';
import type { ScenarioSemantics } from './qa-knowledge-engine';
import { assembleScenarioGraph } from '../graph/scenario-graph-builder';
import { toTestCaseLab } from '../graph/scenario-graph-adapters';
import type { ScenarioGraph } from '../graph/scenario-graph';
import { classifyQACategory, getScenarioSemantics } from './qa-knowledge-engine';
import {
  optimizeKnowledgeForCategory,
  buildPromptBreakdown,
  estimateCostUsd,
  type PromptSectionBreakdown,
  type OptimizeStats,
} from './prompt-optimizer';

const MOD = 'test-coverage-engine';

/**
 * Confidence weight per evidence source. Scoring lives HERE, in the orchestrator
 * — NOT in the Planner. The Planner emits facts (structured evidence); the
 * orchestrator turns those facts into a score. Centralising it means every
 * consumer (this engine today; Script Gen, Healing, RCA, Impact Analysis
 * tomorrow) inherits one consistent scoring model instead of each re-deriving it.
 */
const EVIDENCE_CONFIDENCE_WEIGHT: Record<EvidenceSource, number> = {
  acceptanceCriteria: 1.0,
  requirement: 0.9,
  appKnowledge: 0.8,
  testData: 0.7,
};

/**
 * Compute a deterministic 0–1 confidence for a scenario from its evidence. The
 * score is the strongest evidence source present (Acceptance Criteria beats a
 * Requirement mention beats App Knowledge beats Test Data). Empty evidence ⇒ 0
 * (the Planner never emits such a scenario, but the function is total). Pure and
 * reusable across the platform.
 */
export function computeConfidence(evidence: ScenarioEvidence[]): number {
  if (!evidence || evidence.length === 0) return 0;
  return Math.max(...evidence.map(e => EVIDENCE_CONFIDENCE_WEIGHT[e.source] ?? 0));
}

/**
 * Prompt version identifier — increment when the generation prompt logic changes.
 * Tracked in every generation so we can correlate quality with prompt evolution and
 * quickly diagnose "last week was better" reports by identifying which version ran.
 */
const PROMPT_VERSION = 'v4.0-canonical-validator';

/**
 * Engine architecture version — increment when the pipeline or core algorithm changes
 * (e.g. dedup logic, grounding approach, evaluation reconciliation).
 */
const ENGINE_VERSION = 'test-coverage-v2';

/**
 * Adaptive generation tiers. Resource budget is made PROPORTIONAL to the work
 * requested instead of paying the full 8K-token + separate-analysis tax for every
 * requirement. Names are expectation-oriented (FAST/STANDARD/COMPREHENSIVE) — users
 * care about the experience, not the internal heuristic.
 *
 *   FAST          ≈ small requirement   — single generation call, lean budget
 *   STANDARD      ≈ medium requirement  — single generation call, mid budget
 *   COMPREHENSIVE ≈ large requirement / epic — analysis call + generation call, full budget
 *
 * Quality is NOT reduced: the generation prompt is identical across tiers. We only
 * scale the output/prompt token budget and whether the separate analysis round-trip
 * runs. Token caps are env-overridable so thresholds can be tuned from real telemetry.
 */
export type ComplexityTier = 'FAST' | 'STANDARD' | 'COMPREHENSIVE';

interface TierConfig {
  /** Max output tokens requested from the model for the generation call. */
  maxOutputTokens: number;
  /** Max prompt characters before truncation (keeps rich context + JSON schema intact). */
  maxPromptChars: number;
  /** Whether to run the separate LLM requirement-analysis round-trip. Only the
   *  COMPREHENSIVE tier does — FAST/STANDARD derive a heuristic analysis instead,
   *  saving one full network round-trip (~5-6s) for common requirements. */
  runAnalysis: boolean;
}

const intEnv = (name: string, fallback: number): number => {
  const v = parseInt(process.env[name] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

// ── ROLLED BACK (user directive): output token budget is NO LONGER a lever to
// reduce the number of generated test cases. Coverage is the product; the
// Scenario Planner + Coverage Engine decide how many scenarios/cases exist, and
// the output budget must be generous enough to emit ALL of them without
// truncation. The previous "lower STANDARD 5000→3500 so it makes ~6-8 cases,
// not 13" coupling has been removed. `maxOutputTokens` here is now only a HARD
// SAFETY CEILING (guards against runaway generation), not a case-count target —
// and it is further raised at runtime to a coverage-driven floor (see
// coverageDrivenOutputBudget). The tier still scales the INPUT prompt budget and
// whether the separate analysis round-trip runs; that is about input cost and
// does not cap coverage.
const TIER_CONFIGS: Record<ComplexityTier, TierConfig> = {
  FAST: {
    // Raised 2500 → 6000: a "small" requirement can still legitimately require
    // many negative/edge cases. Never let the ceiling truncate coverage.
    maxOutputTokens: intEnv('GEN_FAST_MAX_TOKENS', 6000),
    maxPromptChars: intEnv('GEN_FAST_MAX_PROMPT_CHARS', 24000),
    runAnalysis: false,
  },
  STANDARD: {
    // Restored 3500 → 8000 (matches COMPREHENSIVE). Output budget must never be
    // the reason coverage shrinks. Input cost is optimized via the Prompt
    // Optimizer + instruction compression, NOT by capping output cases.
    maxOutputTokens: intEnv('GEN_STANDARD_MAX_TOKENS', 8000),
    maxPromptChars: intEnv('GEN_STANDARD_MAX_PROMPT_CHARS', 40000),
    runAnalysis: false,
  },
  COMPREHENSIVE: {
    maxOutputTokens: intEnv('GEN_COMPREHENSIVE_MAX_TOKENS', 8000),
    maxPromptChars: intEnv('GEN_COMPREHENSIVE_MAX_PROMPT_CHARS', 60000),
    runAnalysis: true,
  },
};

/**
 * Coverage-driven output budget (user directive: "the Scenario Planner and
 * Coverage Engine should determine coverage first and produce the complete
 * scenario set"). Given the number of scenarios the deterministic planner
 * expects and the number of coverage types the user selected, compute a floor
 * for output tokens so the model is NEVER forced to drop scenarios/cases to fit
 * a fixed tier budget. Pure, zero-token. The tier's `maxOutputTokens` acts only
 * as an additional hard safety ceiling above this floor.
 */
const OUTPUT_TOKENS_PER_SCENARIO = intEnv('GEN_OUTPUT_TOKENS_PER_SCENARIO', 750);
const OUTPUT_TOKENS_HARD_CEILING = intEnv('GEN_OUTPUT_TOKENS_HARD_CEILING', 16000);
function coverageDrivenOutputBudget(plannedScenarios: number, coverageTypeCount: number, tierCeiling: number): number {
  // Each planned scenario yields one or more cases; budget generously per
  // scenario. Also ensure at least a few scenarios' worth per selected coverage
  // type so a multi-type selection is never starved.
  const byScenario = Math.max(0, plannedScenarios) * OUTPUT_TOKENS_PER_SCENARIO;
  const byCoverageType = Math.max(1, coverageTypeCount) * 2 * OUTPUT_TOKENS_PER_SCENARIO;
  const floor = Math.max(byScenario, byCoverageType);
  // The budget is the LARGER of the tier ceiling and the coverage-driven floor,
  // capped only by an absolute hard ceiling to prevent pathological runaway.
  return Math.min(OUTPUT_TOKENS_HARD_CEILING, Math.max(tierCeiling, floor));
}

/** Complexity scoring weights — env-overridable so they can be tuned from telemetry.
 *  These define how much each signal contributes to the composite complexity score.
 *  Sum should ideally be 1.0 but code normalizes if not. Default weights favor the
 *  INTRINSIC size of the requirement (text length, acceptance criteria, business
 *  flow) over coverage-type count, because the number of coverage types the user
 *  selected reflects INTENT, not how complex the underlying feature is. */
interface ComplexityWeights {
  requirementChars: number;
  acceptanceCriteria: number;
  coverageTypes: number;
  businessFlow: number;
  intelligenceSources: number;
}

const floatEnv = (name: string, fallback: number): number => {
  const v = parseFloat(process.env[name] || '');
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

// Complexity is driven by INTRINSIC requirement characteristics (how much real
// product surface the requirement describes), NOT by how many coverage types the
// user ticked. Selecting positive/negative/edge is USER INTENT — it does not make
// a login as complex as an enterprise banking flow. So requirement SIZE and the
// number of ACCEPTANCE CRITERIA / BUSINESS-FLOW steps dominate the score, while
// coverage-type count and intelligence-source count contribute only lightly.
//   Requirement size    40%  — the strongest signal of intrinsic scope
//   Acceptance criteria  25%  — each criterion is a distinct obligation to test
//   Business flow        15%  — multi-step flows are genuinely harder
//   Coverage types       10%  — user INTENT, not complexity (deliberately light)
//   Intelligence sources 10%  — richer grounding, only a nudge
const COMPLEXITY_WEIGHTS: ComplexityWeights = {
  requirementChars: floatEnv('GEN_WEIGHT_REQ_CHARS', 0.40),
  acceptanceCriteria: floatEnv('GEN_WEIGHT_AC', 0.25),
  businessFlow: floatEnv('GEN_WEIGHT_FLOW', 0.15),
  coverageTypes: floatEnv('GEN_WEIGHT_COVERAGE_TYPES', 0.10),
  intelligenceSources: floatEnv('GEN_WEIGHT_SOURCES', 0.10),
};

/** Composite score ranges for tier classification — env-overridable. */
const FAST_THRESHOLD = floatEnv('GEN_FAST_THRESHOLD', 25);
// Raised 40 → 45 so only genuinely large requirements (long text, many AC,
// multi-step flows) reach COMPREHENSIVE. A simple login (short text, a few AC,
// default coverage types) now lands in STANDARD, keeping it on the lean budget.
const STANDARD_THRESHOLD = floatEnv('GEN_STANDARD_THRESHOLD', 45);

/**
 * Gap-analysis complexity gate (Test Case Lab fix — Priority 3 / "D").
 * Gap analysis is a whole extra LLM round-trip. For simple, solved-problem
 * requirements (login, logout, forgot-password, search) it adds latency + cost
 * without finding real gaps. Skip it below this composite-complexity score;
 * gap analysis then only runs for genuinely complex flows (banking, insurance,
 * multi-step checkout, approval workflows). Env-overridable.
 */
const GAP_ANALYSIS_MIN_COMPLEXITY = floatEnv('GEN_GAP_ANALYSIS_MIN_COMPLEXITY', 35);

/**
 * Scenario Planner (QA-first architecture). When enabled, a deterministic,
 * LLM-free planner (see scenario-planner.ts + qa-knowledge-engine.ts) decides
 * the baseline scenarios a requirement should cover and injects them into the
 * generation prompt as a plan to EXPAND. The LLM becomes the enrichment step,
 * not the inventor — improving consistency and letting us run a tighter output
 * budget. Default ON; set GEN_SCENARIO_PLANNER=false to fall back to the legacy
 * plan-free prompt. Grounding is never overridden — planned scenarios are
 * candidates the LLM keeps only if the requirement/context supports them.
 */
const SCENARIO_PLANNER_ENABLED = (process.env.GEN_SCENARIO_PLANNER || 'true').toLowerCase() !== 'false';

/**
 * Prompt Optimizer — deterministic, ZERO-token trimming of the grounding
 * context (application profile pages/forms/elements + test-data sets) down to
 * what the requirement's QA category actually needs. The dominant token cost is
 * the INPUT prompt, not the output; sending the entire crawled app profile for
 * a "User Login" requirement is pure waste. Default ON; set
 * GEN_PROMPT_OPTIMIZER=false to send the full context (legacy behaviour).
 * Fail-open: for `generic`/low-confidence categories or small profiles the
 * context is passed through unchanged, so the prompt is byte-for-byte legacy.
 */
const PROMPT_OPTIMIZER_ENABLED = (process.env.GEN_PROMPT_OPTIMIZER || 'true').toLowerCase() !== 'false';
/** Minimum classification confidence before the optimizer trims context. */
const PROMPT_OPTIMIZER_MIN_CONFIDENCE = parseFloat(process.env.GEN_PROMPT_OPTIMIZER_MIN_CONFIDENCE || '0.5');

/**
 * Deterministic Scenario Builder (Phase 2 of the QA-first architecture). When
 * enabled, after the planner decides WHAT to test and the retriever scopes the
 * context, the builder (see scenario-builder.ts) ASSEMBLES a concrete, grounded
 * DRAFT test case for every planned scenario — real selectors from the App
 * Profile, real dataset references from Test Data, concrete steps — so the LLM
 * only REFINES the wording instead of re-inventing coverage from scratch. This
 * both raises the scenario/case COUNT off the weak "5 scenarios" floor (drafts
 * are a floor, never a ceiling) and makes generation deterministic + grounded.
 * Default ON; set GEN_SCENARIO_BUILDER=false to fall back to the plan-only
 * prompt (LLM expands the plan itself). Requires the planner to be enabled.
 */
const SCENARIO_BUILDER_ENABLED = (process.env.GEN_SCENARIO_BUILDER || 'true').toLowerCase() !== 'false';

/**
 * Formatter Mode (the token-reduction payoff of the QA-first architecture).
 * When the deterministic builder has produced COMPLETE drafts, we stop asking
 * the LLM to reason at all: instead of the full generation prompt (requirement +
 * app profile + knowledge + test data + coverage essay + plan + drafts +
 * instructions + schema), the model receives ONLY the finished test-case objects
 * and a short "polish the wording, don't change logic or count" instruction. The
 * deterministic layer decided WHAT to test and assembled the steps/selectors/
 * data; the LLM only edits English. This is what actually cuts INPUT tokens (the
 * previous draft-block approach ADDED tokens; this REPLACES the whole prompt).
 *
 * Guaranteed coverage: the builder's deterministic output is the FALLBACK — if
 * the formatter LLM errors, returns invalid JSON, or drops/duplicates cases, we
 * ship the deterministic test cases unchanged. Coverage never depends on the
 * model. Scoped to STANDARD mode (Gap Analysis still uses the reasoning prompt,
 * since assumptions genuinely require the model to think beyond the drafts).
 * Default ON; set GEN_FORMATTER_MODE=false to keep the full reasoning prompt.
 */
const FORMATTER_MODE_ENABLED = (process.env.GEN_FORMATTER_MODE || 'true').toLowerCase() !== 'false';

/**
 * Canonical Validator — asserts + deterministically repairs the canonical test
 * cases (unique scenarioId, non-empty expected, no duplicate steps, real
 * selectors/datasets/pages) BEFORE the LLM formatter is called, so the model
 * cannot break structurally-sound objects. Never drops a case (coverage is
 * sacred). Default ON; set GEN_CANONICAL_VALIDATOR=false to bypass.
 */
const CANONICAL_VALIDATOR_ENABLED = (process.env.GEN_CANONICAL_VALIDATOR || 'true').toLowerCase() !== 'false';

/**
 * QA Standard Validator — enforces the machine-checkable subset of the QA
 * Artifact Standard on the polished cases (atomic steps, business language,
 * observable results, title formula). The standard lives in CODE
 * (qa-standard-validator.ts), not in the prompt, so it never drifts and costs
 * zero prompt tokens. Default ON; set GEN_QA_STANDARD_VALIDATOR=false to bypass.
 */
const QA_STANDARD_VALIDATOR_ENABLED = (process.env.GEN_QA_STANDARD_VALIDATOR || 'true').toLowerCase() !== 'false';

/**
 * QA Standard Repair — a SINGLE, bounded, targeted re-ask for ONLY the cases the
 * QA Standard validator flagged, carrying ONLY their specific violations (not the
 * whole standard). If repair is disabled, fails, or does not clear the errors,
 * the previous (already-shipped-quality) wording is kept — coverage is never at
 * risk.
 *
 * DEFAULT OFF (opt-in via GEN_QA_STANDARD_REPAIR=true). Rationale: repair can
 * MASK a weak generator. We want to first MEASURE the validator's pass-rate on
 * the deterministic + formatter output and drive that up by improving the
 * formatter itself; a high baseline pass-rate is the goal. Repair is a band-aid
 * we enable only once we have real pass-rate metrics and a deliberate reason —
 * never as a substitute for a strong generator. The code stays behind the flag,
 * fully implemented, so turning it on later is a one-line env change.
 */
const QA_STANDARD_REPAIR_ENABLED = (process.env.GEN_QA_STANDARD_REPAIR || 'false').toLowerCase() === 'true';

/**
 * Persistent Scenario Graph — the ONE intelligence source. When ON (default),
 * Test Case Lab sources its deterministic output FROM the canonical scenario
 * graph (assembled from the same validated cases), rather than treating the
 * validated case list as an ad-hoc artifact. This makes Test Case Lab the
 * reference consumer of the shared graph that Script Gen / Healing / RTM /
 * Impact Analysis also read (via the graph service + adapters). The output is
 * identical — the graph is assembled from the SAME cases — so this is a
 * zero-risk seam. Set GEN_SCENARIO_GRAPH=false to bypass.
 */
const SCENARIO_GRAPH_ENABLED = (process.env.GEN_SCENARIO_GRAPH || 'true').toLowerCase() !== 'false';

/** Signals used to classify requirement complexity — all cheap to compute, ZERO LLM calls. */
export interface ComplexitySignals {
  requirementChars: number;
  acceptanceCriteriaCount: number;
  businessFlowSteps: number;
  coverageTypeCount: number;
  intelligenceSourceCount: number;
  /** Weighted composite score (0-100) used for tier classification. Recorded for
   *  telemetry so weights + thresholds can be tuned from real data. */
  complexityScore: number;
}

export interface ComplexityEstimate {
  tier: ComplexityTier;
  signals: ComplexitySignals;
  /** Human-readable reason(s) the tier was chosen — surfaced for telemetry/tuning. */
  reason: string;
}

/** Cosine similarity between two equal-length numeric vectors (0..1 for embeddings). */
function cosineSimilarity(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type CoverageType =
  | 'positive' | 'negative' | 'edge_cases' | 'boundary'
  | 'security' | 'api' | 'ui' | 'mobile' | 'accessibility'
  | 'performance' | 'integration' | 'regression'
  | 'cross_browser' | 'data_validation' | 'role_based' | 'localization';

/**
 * Semantic meaning of each Coverage Type.
 *
 * The selected Coverage Types are the user's EXPLICIT testing intent, so the
 * model is given the GOAL of each selected type (not just its name). This is the
 * single biggest lever for getting comprehensive, well-organised output: Claude
 * follows an explicit objective far better than a bare label like "negative".
 *
 * `label`     — human title used for the per-type section header in the prompt.
 * `goal`      — what a senior QA engineer is trying to achieve with this type.
 * `lookFor`   — concrete, grounded angles to consider (kept requirement-relative,
 *               never a mandate to invent unsupported functionality).
 *
 * To add a future coverage type, add an entry here following the same pattern.
 */
export const COVERAGE_TYPE_GOALS: Record<CoverageType, { label: string; goal: string; lookFor: string }> = {
  positive: {
    label: 'Positive',
    goal: 'Verify the requirement works correctly for valid inputs and successful, expected user flows.',
    lookFor: 'happy paths, every valid variation of the main flow, alternate valid entry points, successful state transitions, and each distinct valid role/option the requirement supports.',
  },
  negative: {
    label: 'Negative',
    goal: 'Verify the requirement correctly REJECTS invalid input and handles incorrect user behaviour gracefully.',
    lookFor: 'invalid inputs, incorrect user actions, validation failures, business-rule violations, missing required data, wrong credentials/permissions, and clear error handling/messaging for each.',
  },
  edge_cases: {
    label: 'Edge Cases',
    goal: 'Verify the requirement behaves correctly in uncommon, corner and boundary-adjacent situations.',
    lookFor: 'empty values, whitespace (leading/trailing), maximum/long lengths, special characters, unicode/emoji, null/undefined, unusual sequences, repeated/rapid actions, and unexpected-but-possible user behaviour.',
  },
  boundary: {
    label: 'Boundary',
    goal: 'Verify behaviour exactly at, just below, and just above every defined limit.',
    lookFor: 'minimum and maximum values, character/length limits, zero and one, off-by-one (limit ±1), and numeric overflow/underflow for any limit the requirement states or implies.',
  },
  security: {
    label: 'Security',
    goal: 'Verify the requirement is resilient to abuse and unauthorised access.',
    lookFor: 'authentication/authorization bypass, injection (SQL/script), XSS, CSRF, session handling, and exposure of sensitive data — only where the requirement involves such a surface.',
  },
  api: {
    label: 'API',
    goal: 'Verify the API contract behind the requirement behaves correctly.',
    lookFor: 'endpoint contracts, status/response codes, request/response payload validation, required vs optional fields, and error responses for each documented endpoint.',
  },
  ui: {
    label: 'UI',
    goal: 'Verify the user interface for the requirement renders and behaves correctly.',
    lookFor: 'layout, inline form validation, loading/empty/error states, enabled/disabled controls, and visible feedback for user actions.',
  },
  mobile: {
    label: 'Mobile',
    goal: 'Verify the requirement works correctly on mobile form factors.',
    lookFor: 'touch interactions, responsive layout, orientation changes, and on-screen keyboard behaviour relevant to the requirement.',
  },
  accessibility: {
    label: 'Accessibility',
    goal: 'Verify the requirement is usable with assistive technology.',
    lookFor: 'screen-reader labels, keyboard-only navigation, focus order, ARIA roles, and colour-contrast for the elements involved.',
  },
  performance: {
    label: 'Performance',
    goal: 'Verify the requirement performs acceptably under realistic conditions.',
    lookFor: 'response/load time of the main flow, behaviour with large datasets, and concurrent requests where the requirement implies scale.',
  },
  integration: {
    label: 'Integration',
    goal: 'Verify the requirement works correctly end-to-end across modules and dependencies.',
    lookFor: 'cross-module flows, data consistency across steps, and interactions with the dependencies/APIs the requirement names.',
  },
  regression: {
    label: 'Regression',
    goal: 'Verify previously-working behaviour related to the requirement still holds after change.',
    lookFor: 'critical paths impacted by the change and any behaviour the requirement/release notes flag as previously broken.',
  },
  cross_browser: {
    label: 'Cross-Browser',
    goal: 'Verify the requirement renders and behaves consistently across browsers.',
    lookFor: 'rendering and interaction differences across Chrome, Firefox, Safari and Edge for the elements involved.',
  },
  data_validation: {
    label: 'Data Validation',
    goal: 'Verify all input data for the requirement is validated and sanitised correctly.',
    lookFor: 'format validation, type checking, required-field enforcement, input sanitisation, and acceptance of valid formats / rejection of invalid ones.',
  },
  role_based: {
    label: 'Role-Based',
    goal: 'Verify the requirement enforces the correct behaviour per user role/permission.',
    lookFor: 'each role the requirement names, permitted vs denied actions per role, role transitions, and unauthorized-access handling.',
  },
  localization: {
    label: 'Localization',
    goal: 'Verify the requirement works correctly across locales.',
    lookFor: 'language switching, RTL layout, and date/number/currency formatting where the requirement involves localised content.',
  },
};

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export interface RequirementInput {
  title: string;
  description: string;
  jiraId?: string;
  businessFlow?: string;
  acceptanceCriteria?: string;
  apiDocs?: string;
  releaseNotes?: string;
  module?: string;
}

export interface RequirementAnalysis {
  featureType: string;
  riskLevel: RiskLevel;
  businessCriticality: string;
  impactedModules: string[];
  userRolesAffected: string[];
  apiDependencies: string[];
  dbImpact: string;
  workflowSteps: string[];
  summary: string;
}

export interface TestScenario {
  scenario: string;
  /**
   * What this scenario sets out to PROVE — the senior-QA "objective" of the
   * scenario, distinct from the title. Enterprise reviewers read the objective
   * first to decide whether the scenario is worth running. Example:
   * "Confirm a standard user with valid credentials reaches the Inventory page
   *  and the session is established." Defaults to the scenario text if omitted.
   */
  objective?: string;
  coverageType: CoverageType;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  riskArea: string;
}

/**
 * Where a test case's coverage comes from — for traceability (RTM) and trust.
 *  - requirement: directly traces to the requirement / acceptance criteria.
 *  - knowledge:   grounded in provided App Knowledge / business rules.
 *  - test_data:   driven by a real project dataset (e.g. valid_users).
 *  - app_profile: grounded in the crawled application structure.
 *  - assumption:  AI-extrapolated beyond any provided evidence (e.g. a boundary
 *                 limit not stated anywhere). Surfaced explicitly so users can
 *                 trust or prune it instead of mistaking it for requirement coverage.
 */
export type TestCaseSource = 'requirement' | 'knowledge' | 'test_data' | 'app_profile' | 'gap_analysis' | 'assumption';

export interface TestCase {
  /**
   * Schema version of the canonical scenario representation. v2 = business/technical
   * projections separated (Phase A). Increment when steps/grounding/expected evolve.
   * Renderers check this for migrations.
   */
  schemaVersion?: 2;
  title: string;
  /**
   * The single, specific thing this test case verifies — the case-level
   * objective a senior QA writes before the steps. Sharper than the title and
   * sharper than the scenario objective (which is about the whole scenario).
   * Example: "Reject login when the password is correct but the account status
   * is 'locked', and show the account-locked message." Optional; the UI/export
   * falls back to the title when absent.
   */
  objective?: string;
  preconditions: string;
  /** Business-readable action steps ONLY (no selectors/URLs). */
  steps: string[];
  /**
   * Per-step technical grounding (selector / page / control), aligned to `steps`
   * by 1-based `stepIndex`. Hidden from manual QA; consumed by Script-Gen and the
   * Validator. This is the "technical projection" of the scenario — the selectors
   * that used to be crammed into step prose now live here as typed data.
   */
  grounding?: StepGrounding[];
  /**
   * Structured expected outcome. `observable` is the human-checkable result shown
   * to manual QA; `business` restates the objective; `technical` carries an
   * automation post-condition (selector/page). `expectedResult` below mirrors
   * `observable` for back-compat.
   */
  expected?: StructuredExpected;
  expectedResult: string;
  testData: string;
  /**
   * The risk this case guards against, expressed in product terms (e.g.
   * "Unauthorized access", "Revenue loss on failed checkout", "Data corruption").
   * Lets reviewers prioritise by business risk, not just by P0/P1. Optional.
   */
  riskArea?: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  severity: 'critical' | 'major' | 'minor' | 'trivial';
  tags: string[];
  automationReady: boolean;
  automationComplexity: 'low' | 'medium' | 'high';
  selectorAvailability: 'high' | 'medium' | 'low' | 'unknown';
  /** Primary provenance of this case (defaults to 'requirement' if the model omits it). */
  source?: TestCaseSource;
  /** Short, human-readable justification for the source tag (e.g. "AC: valid login"). */
  sourceEvidence?: string;
}

export interface CoverageGap {
  area: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  suggestion: string;
}

/**
 * An open question the requirement leaves unanswered. Instead of fabricating an
 * "Assumption-Based" test case (e.g. a 255-char username limit nobody specified),
 * we surface the gap as a question for the author to resolve. This is more
 * honest and more valuable than a guessed test case.
 */
export interface MissingRequirement {
  /** The concrete question to ask the requirement author. */
  question: string;
  /** Functional area the question relates to (e.g. "Input validation"). */
  area: string;
  /** Why this matters / what's missing. */
  rationale: string;
}

/**
 * Generation mode.
 *  - 'strict'   : ONLY test cases that trace directly to the requirement.
 *                 Knowledge / Test Data / Profile are CONTEXT (they enrich a
 *                 requirement-derived case) — they never spawn new cases.
 *                 Assumptions become MissingRequirements, not test cases.
 *  - 'expanded' : strict coverage PLUS a separate set of suggested additional
 *                 cases (negative paths, security, etc. the requirement implies
 *                 but doesn't state). Only used when Coverage Gap Analysis is on.
 */
export type GenerationMode = 'strict' | 'expanded';

/**
 * Per-coverage-type evaluation record. Every Coverage Type the user selected is
 * processed and reported here — so a type is NEVER silently dropped. When a type
 * legitimately yields no grounded tests, `status` is 'not_applicable' and
 * `reason` explains why (e.g. "Requirement defines no numeric limits, so no
 * boundary tests apply"), instead of the UI just showing nothing.
 */
export interface CoverageTypeEvaluation {
  coverageType: string;
  /** 'covered' — produced grounded scenarios/cases; 'not_applicable' — none apply. */
  status: 'covered' | 'not_applicable';
  /** How many scenarios were produced for this type. */
  scenarioCount: number;
  /** How many test cases were produced for this type. */
  testCaseCount: number;
  /** Required when status is 'not_applicable' — why no grounded test was possible. */
  reason?: string;
}

export interface GenerationResult {
  requirementAnalysis: RequirementAnalysis;
  scenarios: TestScenario[];
  testCases: TestCase[];
  /** Expansion cases (only populated in 'expanded' mode) — kept SEPARATE from
   *  the requirement-derived testCases so reviewers never confuse the two. */
  suggestedTestCases: TestCase[];
  /** Open questions raised instead of generating assumption-based test cases. */
  missingRequirements: MissingRequirement[];
  coverageGaps: CoverageGap[];
  /** Per-selected-type evaluation — proves every Coverage Type was processed. */
  coverageTypeEvaluations: CoverageTypeEvaluation[];
  /** Which mode produced this result. */
  mode: GenerationMode;
  /**
   * Signature transparency metric — how much of this generation was grounded in
   * real intelligence vs produced by the raw model. Present only when the
   * Intelligence Orchestrator ran (flag on + scope provided); undefined on the
   * legacy path. Surfaced to the API + dashboard.
   */
  intelligenceScore?: IntelligenceScore;
  stats: {
    totalScenarios: number;
    totalTestCases: number;
    coverageTypes: string[];
    automationReadyCount: number;
    gapsFound: number;
    tokensUsed: number;
    /** Prompt (input) tokens summed across every LLM call this run. */
    promptTokens?: number;
    /** Completion (output) tokens summed across every LLM call this run. */
    completionTokens?: number;
    /** Rough USD cost estimate for the run (input+output at configured rates). */
    estimatedCostUsd?: number;
    /** How many near-duplicate cases the semantic dedup pass removed. */
    duplicatesRemoved?: number;
    /** Count of separate suggested (expansion) cases. */
    suggestedCount?: number;
    /** Count of open questions raised instead of assumption test cases. */
    missingRequirementsCount?: number;
    /** Size of the generation prompt sent to the model — lets us correlate
     *  prompt size with output volume and cost over time (measure, don't just
     *  keep raising the budget). */
    promptChars?: number;
    /** Generated cases produced per 1,000 prompt chars — a cheap density signal
     *  for "are we getting more output for more context, or just paying more?". */
    casesPerKChars?: number;
    /** Generation versioning + telemetry — tracks which prompt/engine/model/tier
     *  produced this run plus timing & token breakdown, so quality regressions
     *  ("last week was better") can be correlated with code changes AND thresholds
     *  can be tuned from real engineering data instead of assumptions. */
    generationMetadata?: {
      promptVersion: string;
      engineVersion: string;
      model: string;
      timestamp: string;
      /** Adaptive complexity tier selected for this run. */
      complexityTier?: ComplexityTier;
      /** Cheap heuristic signals that drove the tier selection. */
      complexitySignals?: ComplexitySignals;
      /** Why this tier was chosen (for telemetry/tuning). */
      complexityReason?: string;
      /** Wall-clock time spent in the separate analysis LLM call (0 when skipped). */
      analysisMs?: number;
      /** Wall-clock time spent in the generation LLM call (+ dedup/gap as applicable). */
      generationMs?: number;
      /** Total wall-clock time for the full pipeline. */
      totalMs?: number;
      /** Tokens (prompt + completion) for the analysis call (0 when skipped). */
      analysisTokens?: number;
      /** Tokens (prompt + completion) for the generation call. */
      generationTokens?: number;
      /** Total tokens across every LLM call in this run. */
      totalTokens?: number;
      /** Prompt (input) tokens summed across every LLM call — the dominant cost. */
      promptTokens?: number;
      /** Completion (output) tokens summed across every LLM call. */
      completionTokens?: number;
      /** Rough USD cost estimate for this run (input+output at configured rates). */
      estimatedCostUsd?: number;
      /** Deterministic per-section breakdown of the generation prompt (chars +
       *  estimated tokens) — shows WHERE input tokens go. Zero LLM cost. */
      promptBreakdown?: PromptSectionBreakdown;
      /** What the Prompt Optimizer trimmed from the grounding context (before/after). */
      promptOptimization?: OptimizeStats;
      /** Number of scenarios produced. */
      scenarioCount?: number;
      /** Number of committed test cases produced. */
      testCaseCount?: number;
    };
  };
}

export interface EnterpriseKnowledgeItem {
  id: number;
  category: string;
  title: string;
  description: string;
  tags: string[];
  relatedModules: string[];
  priority: string;
  metadata?: Record<string, any>;
}

export interface RepositoryIntelligence {
  repoId: string;
  techStack?: string[];
  architecture?: Record<string, any>;
  patterns?: string[];
  testingFrameworks?: string[];
  summary?: string;
}

export interface KnowledgeContext {
  modules?: Array<{ name: string; workflows?: string; businessRules?: string; apis?: string; }>;
  historicalBugs?: string[];
  existingTestCases?: string[];
  automationCoverage?: string[];
  enterpriseKnowledge?: EnterpriseKnowledgeItem[];
  repositoryContext?: RepositoryIntelligence;
  /**
   * Real application structure captured by the crawler (application_profiles.crawl_data).
   * When present, generation is grounded in REAL selectors, forms, flows and
   * credentials instead of generic guesses. Issue #2 fix.
   */
  applicationProfile?: ApplicationProfileContext;
  /**
   * Token-safe summaries of the project's Test Data sets (names, environments,
   * record counts, and a small sample of KEYS only — never values/secrets).
   * When present, generation references REAL project datasets (e.g. valid_users,
   * checkout_data) instead of inventing placeholder credentials/products.
   */
  testData?: Array<{ name: string; environment: string; recordCount: number; sampleKeys: string[] }>;
  /**
   * The REAL, rich project datasets (dataset + records + role tags + values)
   * used by the Dataset Resolver to turn a scenario's required data role into a
   * concrete record at Scenario Graph build time. Unlike `testData` (token-safe
   * summaries that dropped the role tags and values), these are the actual
   * dataset objects from the Test Data Store, so Sprint 2C resolves against the
   * source of truth. Values are used internally only and are always masked before
   * any prompt/display boundary. Absent when the project has no datasets.
   */
  datasets?: Dataset[];
  /**
   * Optional scope for intent-scoped retrieval via the shared
   * IntelligenceOrchestrator (Phase 2). When present AND the orchestrator flag
   * is on, generation uses a single orchestrated intelligence block in place of
   * the legacy flat repo / app-profile / test-data blocks (the rich enterprise
   * knowledge block is preserved). Absent / flag-off → legacy behaviour is
   * byte-for-byte unchanged.
   */
  orchestratorScope?: {
    companyId: number;
    projectId?: number;
    repoContextId?: number;
    targetUrl?: string;
  };
}

/** Compact, token-budgeted projection of an application profile for prompts. */
export interface ApplicationProfileContext {
  baseUrl?: string;
  name?: string;
  pageCount?: number;
  totalElements?: number;
  totalForms?: number;
  loginUrl?: string;
  username?: string;          // real username; password is NEVER included
  pages?: Array<{ url?: string; title?: string; pageType?: string; elementCount?: number; formCount?: number }>;
  forms?: Array<{
    page?: string;
    action?: string;
    method?: string;
    fields?: Array<{ name?: string; type?: string; required?: boolean; selector?: string; label?: string }>;
    submitSelector?: string;
  }>;
  keyElements?: Array<{ label?: string; tag?: string; selector?: string; role?: string }>;
}

/* ------------------------------------------------------------------ */
/*  Engine                                                             */
/* ------------------------------------------------------------------ */

export class TestCoverageEngine {
  private openai: OpenAI;
  private modelSelector: ModelSelector;
  private costTracker: CostTracker;
  // Phase 1 — optional Claude provider for Test Generation. When
  // TEST_PROVIDER=anthropic and a key is configured, callLLM routes to Claude
  // and transparently falls back to OpenAI on ANY error.
  private anthropic: AnthropicClient | null;
  private testProvider: string;
  private testModel: string;

  constructor() {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY required for TestCoverageEngine');
    this.openai = new OpenAI({ apiKey });
    this.modelSelector = new ModelSelector();
    this.costTracker = new CostTracker();

    this.testProvider = (process.env['TEST_PROVIDER'] || 'openai').toLowerCase();
    this.testModel = resolveAnthropicModel(process.env['TEST_MODEL']);
    this.anthropic =
      this.testProvider === 'anthropic' && isAnthropicConfigured()
        ? new AnthropicClient({ model: this.testModel })
        : null;
  }

  /* ---- Build Enterprise Knowledge Block (uses KnowledgeOptimizer for smart selection) ---- */
  private buildEnterpriseKnowledgeBlock(knowledge?: KnowledgeContext, input?: RequirementInput): string {
    if (!knowledge?.enterpriseKnowledge?.length) return '';

    const items = knowledge.enterpriseKnowledge;

    // Use KnowledgeOptimizer for smart selection and formatting
    const optimizer = new KnowledgeOptimizer();
    const optimizerItems: OptimizerKnowledgeItem[] = items.map(i => ({
      id: i.id,
      category: i.category,
      title: i.title,
      description: i.description,
      tags: i.tags || [],
      related_modules: i.relatedModules || [],
      priority: i.priority,
      metadata: i.metadata,
    }));

    const optimized = optimizer.selectRelevantKnowledge(optimizerItems, {
      module: input?.module,
      testDescription: input ? `${input.title} ${input.description}` : undefined,
      tags: input?.businessFlow ? [input.businessFlow] : undefined,
    }, {
      maxTokens: 2000,
      maxItems: 10,
      format: 'test-case-lab',
    });

    if (!optimized.formattedContext) return '';

    logger.info(MOD, 'Enterprise knowledge optimized for test case lab', {
      totalItems: items.length,
      selectedItems: optimized.stats.selectedCount,
      estimatedTokens: optimized.stats.estimatedTokens,
      avgRelevance: optimized.stats.avgRelevanceScore,
    });

    return `\n\nCOMPANY-SPECIFIC KNOWLEDGE (${optimized.stats.selectedCount} of ${items.length} items — smart-selected by relevance):\n\n${optimized.formattedContext}

IMPORTANT: Use the above company-specific knowledge to:
1. Create test cases that validate business rules explicitly
2. Include regression tests for known bug patterns
3. Test workflow transitions and edge cases specific to this company
4. Verify integration points and dependencies
5. Avoid duplicating existing automation/manual test coverage`;
  }

  /* ---- Build Repository Intelligence Block ---- */
  private buildRepoIntelligenceBlock(knowledge?: KnowledgeContext): string {
    if (!knowledge?.repositoryContext) return '';
    const rc = knowledge.repositoryContext;
    const parts: string[] = [];

    if (rc.summary) parts.push(`Summary: ${rc.summary}`);
    if (rc.techStack?.length) parts.push(`Tech Stack: ${rc.techStack.join(', ')}`);
    if (rc.testingFrameworks?.length) parts.push(`Testing Frameworks: ${rc.testingFrameworks.join(', ')}`);
    if (rc.patterns?.length) parts.push(`Code Patterns: ${rc.patterns.join(', ')}`);
    if (rc.architecture && Object.keys(rc.architecture).length > 0) {
      parts.push(`Architecture: ${JSON.stringify(rc.architecture)}`);
    }

    if (parts.length === 0) return '';

    return `\n\nREPOSITORY INTELLIGENCE (analyzed from codebase):\n${parts.join('\n')}

Use this repository context to:
1. Align test scenarios with the actual tech stack and patterns used
2. Reference appropriate testing frameworks for test automation suggestions
3. Consider architectural boundaries and service interactions`;
  }

  /* ---- Build Application Profile Block (REAL crawled app structure — Issue #2) ---- */
  private buildApplicationProfileBlock(knowledge?: KnowledgeContext): string {
    const ap = knowledge?.applicationProfile;
    if (!ap) return '';
    const parts: string[] = [];

    const summary: string[] = [];
    if (ap.name) summary.push(`App: ${ap.name}`);
    if (ap.baseUrl) summary.push(`Base URL: ${ap.baseUrl}`);
    if (ap.pageCount != null) summary.push(`Pages crawled: ${ap.pageCount}`);
    if (ap.totalElements != null) summary.push(`Elements: ${ap.totalElements}`);
    if (ap.totalForms != null) summary.push(`Forms: ${ap.totalForms}`);
    if (summary.length) parts.push(summary.join(' | '));

    if (ap.loginUrl || ap.username) {
      parts.push(`\nAUTHENTICATION:\n  Login URL: ${ap.loginUrl || 'N/A'}\n  Username: ${ap.username || 'N/A'}\n  Password: use the placeholder <password> (never a real secret)`);
    }

    if (ap.pages?.length) {
      const pageLines = ap.pages.slice(0, 12).map(p =>
        `  - ${p.title || p.url || 'page'} [${p.pageType || 'unknown'}] (${p.elementCount ?? 0} elements, ${p.formCount ?? 0} forms)`
      );
      parts.push(`\nSITE MAP (real pages — reference these in navigation steps):\n${pageLines.join('\n')}`);
    }

    if (ap.forms?.length) {
      const formLines = ap.forms.slice(0, 8).map((f, i) => {
        const fields = (f.fields || []).slice(0, 10).map(fd =>
          `      • ${fd.label || fd.name || 'field'} (type=${fd.type || 'text'}${fd.required ? ', REQUIRED' : ''}) selector=${fd.selector || 'n/a'}`
        ).join('\n');
        return `  Form ${i + 1}${f.page ? ` on ${f.page}` : ''} [${f.method || 'GET'} ${f.action || ''}]:\n${fields}${f.submitSelector ? `\n      • submit selector=${f.submitSelector}` : ''}`;
      });
      parts.push(`\nFORMS (real fields + recommended selectors — use these EXACT selectors):\n${formLines.join('\n')}`);
    }

    if (ap.keyElements?.length) {
      const elLines = ap.keyElements.slice(0, 20).map(e =>
        `  - ${e.label || e.tag || 'element'}${e.role ? ` (role=${e.role})` : ''} selector=${e.selector || 'n/a'}`
      );
      parts.push(`\nKEY INTERACTIVE ELEMENTS (real selectors):\n${elLines.join('\n')}`);
    }

    if (parts.length === 0) return '';

    return `\n\nAPPLICATION PROFILE (REAL crawled application structure):\n${parts.join('\n')}

CRITICAL — Because this application has been crawled, you MUST:
1. Use the REAL selectors and field names above instead of generic placeholders.
2. Ground every navigation step in the real pages listed in the site map.
3. Write validation/negative tests against the actual REQUIRED form fields.
4. Set "selectorAvailability" to "high" for cases that use a real selector above.
5. Use the real login URL + username (with <password> placeholder) for auth steps.
Do NOT invent selectors or pages that are not present above.`;
  }

  /* ---- Build Test Data Block (REAL project datasets — token-safe summaries) ---- */
  private buildTestDataBlock(knowledge?: KnowledgeContext): string {
    const sets = knowledge?.testData;
    if (!sets?.length) return '';

    const lines = sets.slice(0, 12).map(ds => {
      const keys = ds.sampleKeys?.length ? ` — sample keys: ${ds.sampleKeys.slice(0, 5).join(', ')}` : '';
      return `  - ${ds.name} [${ds.environment}] (${ds.recordCount} record${ds.recordCount === 1 ? '' : 's'})${keys}`;
    });

    return `\n\nAVAILABLE TEST DATA (real datasets defined for this project):\n${lines.join('\n')}

Because these datasets exist, you MUST:
1. Reference the REAL dataset names and keys above (e.g. "log in using the standard_user record from valid_users") instead of inventing emails/passwords/products.
2. Use the actual keys as the data behind positive AND negative cases (e.g. a locked/invalid user from the data above for negative login).
3. Keep credentials and other secret values abstract — refer to the dataset/key, never embed a real password.
Do NOT invent placeholder data (john@test.com, password123, ABC Product) when a matching dataset above can supply it.`;
  }

  /* ---- Phase 2: Requirement Understanding ---- */
  /* ---- Adaptive complexity classification (heuristic, ZERO LLM calls) ---- */
  /**
   * Classify a requirement into FAST / STANDARD / COMPREHENSIVE using cheap,
   * observable signals — never spend model tokens deciding whether to spend model
   * tokens. The budget then becomes proportional to the work requested.
   *
   * Philosophy: complexity is an INTRINSIC property of the requirement (how much
   * real testable surface it describes), NOT of how many coverage types the user
   * happened to tick. Requirement size and acceptance-criteria density dominate the
   * score; coverage-type count and intelligence-source count are minor signals (they
   * express user intent / available grounding, not inherent complexity).
   *
   * The score is a WEIGHTED COMPOSITE (not single-trigger promotion): each signal is
   * normalized to 0-100, multiplied by its weight (see COMPLEXITY_WEIGHTS), and summed.
   * Default weights: requirementChars 0.40, acceptanceCriteria 0.25, businessFlow 0.15,
   * coverageTypes 0.10, intelligenceSources 0.10.
   *
   * Tier thresholds (env-overridable):
   *   FAST          — composite < 25   (e.g. "User Login", small password reset)
   *   STANDARD      — 25 ≤ composite < 45 (typical single-feature requirement)
   *   COMPREHENSIVE — composite ≥ 45   (large multi-step flows: detailed checkout,
   *                   epic requirements with many AC / flow steps)
   * A short requirement can no longer be forced to COMPREHENSIVE just by selecting
   * many coverage types — those only nudge the score by up to 10%.
   */
  estimateComplexity(
    input: RequirementInput,
    coverageTypes: CoverageType[],
    knowledge?: KnowledgeContext
  ): ComplexityEstimate {
    const countLines = (s?: string): number =>
      (s || '')
        .split(/\r?\n|(?<=[.;])\s+(?=[A-Z0-9])/)
        .map(l => l.trim())
        .filter(l => l.length > 0).length;

    // ---- Raw signal extraction (cheap, zero LLM) ----
    const requirementChars =
      (input.title?.length || 0) +
      (input.description?.length || 0) +
      (input.acceptanceCriteria?.length || 0) +
      (input.businessFlow?.length || 0) +
      (input.apiDocs?.length || 0) +
      (input.releaseNotes?.length || 0);

    const acceptanceCriteriaCount = countLines(input.acceptanceCriteria);
    const businessFlowSteps = countLines(input.businessFlow);
    const coverageTypeCount = coverageTypes.length;
    const intelligenceSourceCount =
      (knowledge?.modules?.length ? 1 : 0) +
      (knowledge?.enterpriseKnowledge?.length ? 1 : 0) +
      (knowledge?.applicationProfile ? 1 : 0) +
      (knowledge?.testData?.length ? 1 : 0) +
      (knowledge?.repositoryContext ? 1 : 0);

    // ---- Weighted scoring: normalize each signal to 0-100, then composite ----
    // Normalization caps chosen so that COMPREHENSIVE-tier complexity hits ~100%.
    // These represent the threshold where a requirement becomes objectively complex:
    //   • requirementChars: 1200 chars ≈ epic-sized text (title + long desc + many AC)
    //   • AC: 8 criteria ≈ detailed/epic requirement
    //   • coverage types: 5 types ≈ comprehensive testing (positive+negative+edge+boundary+security)
    //   • flow steps: 6 steps ≈ multi-step workflow
    //   • sources: 4 ≈ heavy intelligence use (modules + enterprise + profile + testData)
    // With these caps + the size-driven weights (0.40 chars, 0.25 AC, 0.15 flow,
    // 0.10 coverage, 0.10 sources), the tier is dominated by how much the requirement
    // actually describes. A short requirement stays FAST/STANDARD even with many
    // coverage types selected; only genuinely large/detailed requirements (long prose,
    // many AC, multi-step flows) reach COMPREHENSIVE. Tune from telemetry over time.
    const charScore = Math.min(100, (requirementChars / 1200) * 100);
    const acScore = Math.min(100, (acceptanceCriteriaCount / 8) * 100);
    const coverageScore = Math.min(100, (coverageTypeCount / 5) * 100);
    const flowScore = Math.min(100, (businessFlowSteps / 6) * 100);
    const sourceScore = Math.min(100, (intelligenceSourceCount / 4) * 100);

    // Weighted composite (env-overridable). Normalize weights to sum=1.0 for stability.
    const w = COMPLEXITY_WEIGHTS;
    const weightSum = w.requirementChars + w.acceptanceCriteria + w.coverageTypes + w.businessFlow + w.intelligenceSources;
    const normalizedWeights = {
      chars: w.requirementChars / weightSum,
      ac: w.acceptanceCriteria / weightSum,
      coverage: w.coverageTypes / weightSum,
      flow: w.businessFlow / weightSum,
      sources: w.intelligenceSources / weightSum,
    };

    const complexityScore =
      charScore * normalizedWeights.chars +
      acScore * normalizedWeights.ac +
      coverageScore * normalizedWeights.coverage +
      flowScore * normalizedWeights.flow +
      sourceScore * normalizedWeights.sources;

    // ---- Tier classification by composite score ----
    let tier: ComplexityTier;
    let reason: string;
    if (complexityScore < FAST_THRESHOLD) {
      tier = 'FAST';
      reason = `Low complexity score ${Math.round(complexityScore)} < ${FAST_THRESHOLD} (${coverageTypeCount} types, ${acceptanceCriteriaCount} AC, ${requirementChars} chars)`;
    } else if (complexityScore < STANDARD_THRESHOLD) {
      tier = 'STANDARD';
      reason = `Medium complexity score ${Math.round(complexityScore)} (${FAST_THRESHOLD}–${STANDARD_THRESHOLD}) — ${coverageTypeCount} types, ${acceptanceCriteriaCount} AC, ${requirementChars} chars`;
    } else {
      tier = 'COMPREHENSIVE';
      reason = `High complexity score ${Math.round(complexityScore)} ≥ ${STANDARD_THRESHOLD} (${coverageTypeCount} types, ${acceptanceCriteriaCount} AC, ${requirementChars} chars)`;
    }

    return {
      tier,
      signals: {
        requirementChars,
        acceptanceCriteriaCount,
        businessFlowSteps,
        coverageTypeCount,
        intelligenceSourceCount,
        complexityScore: Math.round(complexityScore * 10) / 10, // 1 decimal precision for telemetry
      },
      reason,
    };
  }

  /**
   * Derive a RequirementAnalysis WITHOUT an LLM call, for the FAST/STANDARD tiers
   * that skip the separate analysis round-trip. The generation prompt already
   * carries the full requirement text + AC + flow, so a lightweight heuristic
   * analysis is sufficient context — this is the latency saving, not a quality cut.
   */
  private heuristicAnalysis(
    input: RequirementInput,
    estimate: ComplexityEstimate
  ): RequirementAnalysis {
    const hay = `${input.title} ${input.description} ${input.module || ''}`.toLowerCase();
    const featureType =
      /login|auth|password|sign[\s-]?in|credential|lock/.test(hay) ? 'authentication' :
      /pay|checkout|billing|invoice|card|transaction/.test(hay) ? 'payment' :
      /search|filter|query/.test(hay) ? 'search' :
      /report|dashboard|analytic|export/.test(hay) ? 'reporting' :
      /form|input|register|submit|create|edit|update/.test(hay) ? 'data_entry' :
      'general';
    // Risk: critical-sounding domains skew higher even without the analysis call.
    const riskLevel: RequirementAnalysis['riskLevel'] =
      featureType === 'authentication' || featureType === 'payment' ? 'high' : 'medium';

    const workflowSteps = (input.businessFlow || '')
      .split(/\r?\n|(?<=[.;])\s+(?=[A-Z0-9])/)
      .map(s => s.trim())
      .filter(Boolean)
      .slice(0, 20);

    return {
      featureType,
      riskLevel,
      businessCriticality: 'Derived heuristically (analysis call skipped for this tier)',
      impactedModules: [input.module || 'unknown'],
      userRolesAffected: ['end_user'],
      apiDependencies: [],
      dbImpact: 'Unknown',
      workflowSteps,
      summary: (input.description || input.title || '').slice(0, 200),
    };
  }

  async analyzeRequirement(
    input: RequirementInput,
    knowledge?: KnowledgeContext
  ): Promise<{ analysis: RequirementAnalysis; tokensUsed: number; promptTokens?: number; completionTokens?: number }> {
    const knowledgeBlock = knowledge?.modules?.length
      ? `\n\nAPPLICATION KNOWLEDGE:\n${knowledge.modules.map(m =>
          `Module: ${m.name}\n  Workflows: ${m.workflows || 'N/A'}\n  Business Rules: ${m.businessRules || 'N/A'}\n  APIs: ${m.apis || 'N/A'}`
        ).join('\n')}\n\nHistorical Bugs: ${(knowledge.historicalBugs || []).join('; ') || 'None'}\nExisting Tests: ${(knowledge.existingTestCases || []).join('; ') || 'None'}`
      : '';
    const enterpriseBlock = this.buildEnterpriseKnowledgeBlock(knowledge, input);
    // NOTE: Repository Intelligence is intentionally NOT injected here. Requirement
    // analysis (featureType/riskLevel/impactedModules) does not benefit from
    // code-level tech-stack/pattern details — sending it here only burns tokens
    // and latency. Repo intelligence is injected ONLY into the test-case
    // generation prompt below, where it can actually influence output.
    const appProfileBlock = this.buildApplicationProfileBlock(knowledge);
    const testDataBlock = this.buildTestDataBlock(knowledge);

    const prompt = `You are a senior QA architect analyzing a software requirement.

REQUIREMENT:
Title: ${input.title}
Description: ${input.description}
${input.acceptanceCriteria ? `Acceptance Criteria: ${input.acceptanceCriteria}` : ''}
${input.businessFlow ? `Business Flow: ${input.businessFlow}` : ''}
${input.module ? `Module: ${input.module}` : ''}
${input.apiDocs ? `API Documentation: ${input.apiDocs}` : ''}
${input.releaseNotes ? `Release Notes: ${input.releaseNotes}` : ''}${knowledgeBlock}${enterpriseBlock}${appProfileBlock}${testDataBlock}

Analyze this requirement and return a JSON object with:
- featureType: string (e.g. "authentication", "payment", "search", "data_entry", "reporting")
- riskLevel: "critical" | "high" | "medium" | "low"
- businessCriticality: brief explanation of business impact
- impactedModules: string[] of modules/components affected
- userRolesAffected: string[] of user roles impacted
- apiDependencies: string[] of API endpoints involved
- dbImpact: brief description of database changes
- workflowSteps: string[] ordered steps in the user workflow
- summary: 2-3 sentence executive summary

Return ONLY valid JSON, no markdown fences.`;

    const resp = await this.callLLM(prompt, 800);
    let analysis: RequirementAnalysis;
    try {
      analysis = JSON.parse(resp.content);
    } catch {
      analysis = {
        featureType: 'general',
        riskLevel: 'medium',
        businessCriticality: 'Standard feature',
        impactedModules: [input.module || 'unknown'],
        userRolesAffected: ['end_user'],
        apiDependencies: [],
        dbImpact: 'Unknown',
        workflowSteps: [],
        summary: input.description.slice(0, 200),
      };
    }
    return { analysis, tokensUsed: resp.tokensUsed, promptTokens: resp.promptTokens, completionTokens: resp.completionTokens };
  }

  /**
   * Derive a short, keyword-friendly intent from the requirement to seed the
   * orchestrator's intent-scoped retrieval. Title + business flow are the
   * strongest signals; falls back to acceptance criteria / description.
   */
  private deriveIntent(input: RequirementInput): string {
    const base =
      [input.title, input.businessFlow].filter(Boolean).join(' ') ||
      input.acceptanceCriteria ||
      input.description ||
      '';
    return base.split(/\s+/).slice(0, 12).join(' ').trim();
  }

  /**
   * Phase 2 — build the intent-scoped orchestrated intelligence block for Test
   * Case generation, mirroring Script Gen's integration. Gathers reuse
   * candidates (repository graph), app-profile structure, project datasets and
   * learned patterns for the requirement's intent, and returns a compact,
   * confidence-annotated block plus the signature Intelligence Score.
   *
   * Knowledge is intentionally NOT requested from the orchestrator here — Test
   * Case Lab already builds a richer, KnowledgeOptimizer-selected enterprise
   * knowledge block which is preserved alongside this block.
   *
   * Fully gated: returns an empty block unless INTELLIGENCE_ORCHESTRATOR is on
   * AND an orchestrator scope (companyId) is provided. Any failure degrades to
   * an empty block so generation is never blocked.
   */
  private async buildOrchestratedIntelligenceBlock(
    input: RequirementInput,
    knowledge?: KnowledgeContext,
  ): Promise<{ block: string; intelligenceScore?: IntelligenceScore }> {
    if (!IntelligenceOrchestrator.isEnabled()) return { block: '' };
    const scope = knowledge?.orchestratorScope;
    if (!scope || scope.companyId == null) return { block: '' };

    const intent = this.deriveIntent(input);
    if (!intent) return { block: '' };

    const sources: OrchestratorSource[] = ['repository', 'appProfile', 'testData', 'patterns'];

    try {
      const orchestrator = getIntelligenceOrchestrator();
      const intel = await orchestrator.gatherIntelligence({
        intent,
        repoContextId: scope.repoContextId,
        companyId: scope.companyId,
        projectId: scope.projectId,
        targetUrl: scope.targetUrl,
        caller: 'test-case-lab',
        sources,
      });

      if (!intel.available) {
        return { block: '', intelligenceScore: intel.metadata.intelligenceScore };
      }

      const promptBlock = orchestrator.buildPromptContext(intel);
      if (!promptBlock || promptBlock.startsWith('(No intelligence')) {
        return { block: '', intelligenceScore: intel.metadata.intelligenceScore };
      }

      logger.info(MOD, 'Injecting orchestrated intelligence into test-case prompt', {
        intent,
        sourcesUsed: intel.metadata.sourcesUsed,
        confidenceScore: intel.metadata.confidenceScore,
        intelligenceScore: intel.metadata.intelligenceScore,
      });

      return {
        block: `\n--- ORCHESTRATED INTELLIGENCE (INTENT-SCOPED) ---\n${promptBlock}\n--- END ORCHESTRATED INTELLIGENCE ---`,
        intelligenceScore: intel.metadata.intelligenceScore,
      };
    } catch (err: any) {
      logger.warn(MOD, 'Orchestrated intelligence failed (non-blocking)', { error: err?.message });
      return { block: '' };
    }
  }

  /* ---- Phase 5: Test Case Generation ---- */
  async generateTestCoverage(
    input: RequirementInput,
    analysis: RequirementAnalysis,
    coverageTypes: CoverageType[],
    knowledge?: KnowledgeContext,
    mode: GenerationMode = 'strict',
    // Adaptive generation: token + prompt budgets scale with requirement
    // complexity. Defaults preserve the pre-adaptive COMPREHENSIVE behavior so
    // existing callers are unaffected. NOTE: only the *budgets* change per tier —
    // the prompt itself is identical across tiers (quality is not reduced).
    maxOutputTokens: number = 8000,
    maxPromptChars: number = 60000,
    // Priority 1 ("A"): only broaden the committed coverage beyond the user's
    // selection when this explicit opt-in is set. Default FALSE → generate
    // EXACTLY the selected types.
    aiCoverageExpansion = false
  ): Promise<{
    scenarios: TestScenario[];
    testCases: TestCase[];
    suggestedTestCases: TestCase[];
    missingRequirements: MissingRequirement[];
    coverageTypeEvaluations: CoverageTypeEvaluation[];
    tokensUsed: number;
    /** Prompt (input) tokens for the generation call. */
    promptTokens: number;
    /** Completion (output) tokens for the generation call. */
    completionTokens: number;
    /** Size of the generation prompt actually sent — for measurability
     *  (prompt size → output volume → tokens/cost), per the "measure, don't
     *  just keep raising the budget" principle. */
    promptChars: number;
    /** Deterministic per-section breakdown of the generation prompt (chars +
     *  estimated tokens), so we can SEE where prompt tokens go instead of
     *  guessing. Zero LLM cost — computed from the assembled block strings. */
    promptBreakdown?: PromptSectionBreakdown;
    /** What the Prompt Optimizer trimmed (before/after per grounding section). */
    promptOptimization?: OptimizeStats;
    /** Intelligence Score from the orchestrator (undefined on the legacy path). */
    intelligenceScore?: IntelligenceScore;
  }> {
    // ── Priority 1 ("A") — respect the user's coverage selection ──
    // Previously EXPANDED (gap-analysis) mode silently added a
    // positive/negative/edge/boundary/integration baseline, turning a 3-type
    // request into 5. That broke user trust and inflated tokens/cases. We now
    // only broaden the committed coverage when the caller explicitly enables
    // "AI Coverage Expansion". Otherwise we generate EXACTLY the selected types.
    // NOTE: `expand` (the assumption-based suggestions bucket) is still driven by
    // mode — that bucket is kept SEPARATE from committed coverage, so it never
    // changes which types the user asked for.
    const expand = mode === 'expanded';
    if (aiCoverageExpansion) {
      const baselineTypes: CoverageType[] = ['positive', 'negative', 'edge_cases', 'boundary', 'integration'];
      const before = coverageTypes.length;
      coverageTypes = Array.from(new Set([...coverageTypes, ...baselineTypes]));
      logger.info(MOD, 'AI Coverage Expansion ON — broadened committed coverage types', {
        from: before, to: coverageTypes.length,
      });
    } else if (coverageTypes.length === 0) {
      // No explicit types — default to positive (happy path).
      coverageTypes = ['positive'];
    }

    // ── Deterministic Scenario Plan (QA-first) — computed FIRST ──
    // The plan decides WHAT to test (zero tokens) BEFORE we retrieve context, so
    // its scenario titles/objectives/risk-areas can steer retrieval toward the
    // pages/forms/fields/datasets the planned scenarios actually reference. The
    // rendered block is injected into the prompt later (as a set to EXPAND).
    let scenarioPlanBlock = '';
    let scenarioPlan: ScenarioPlan | undefined;
    if (SCENARIO_PLANNER_ENABLED) {
      scenarioPlan = planScenarios(input, coverageTypes, analysis.featureType, knowledge);
      scenarioPlanBlock = buildScenarioPlanBlock(scenarioPlan);
      // The orchestrator (not the Planner) scores the evidence. Average evidence
      // confidence is a cheap, honest signal of how well-grounded the plan is.
      const confidences = scenarioPlan.scenarios.map(s => computeConfidence(s.provenance.evidence));
      const avgEvidenceConfidence = confidences.length
        ? Math.round((confidences.reduce((a, b) => a + b, 0) / confidences.length) * 100) / 100
        : 0;
      logger.info(MOD, 'Scenario plan built', {
        category: scenarioPlan.classification.category,
        confidence: scenarioPlan.classification.confidence,
        planned: scenarioPlan.scenarios.length,
        justified: scenarioPlan.justifiedCount,
        avgEvidenceConfidence,
        knowledgeVersion: scenarioPlan.knowledgeVersion,
        applied: scenarioPlanBlock.length > 0,
      });
    }

    // ── Prompt Optimizer (QA-first, ZERO tokens) — scenario-aware retrieval ──
    // Retrieve the grounding context (app profile pages/forms/elements + test-
    // data sets) relevant to WHAT the planned scenarios test, BEFORE any block is
    // assembled. The INPUT prompt — not the output — is the dominant token cost,
    // and shipping the entire crawled app profile for a "User Login" requirement
    // is pure waste. This is real top-K retrieval: items are ranked by relevance
    // to the requirement + the scenario plan, and only the most relevant are kept
    // (see GEN_RETRIEVE_MAX_* caps). Fail-open: generic/low-confidence
    // requirements pass through unchanged (byte-for-byte legacy prompt). Only
    // scopes the LEGACY grounding blocks; the orchestrated path already scopes by
    // intent and is left untouched. Coverage/scenario count is NEVER affected.
    let genKnowledge = knowledge;
    let optimizeStats: OptimizeStats | undefined;
    if (PROMPT_OPTIMIZER_ENABLED && knowledge) {
      const cls = classifyQACategory(input, analysis.featureType);
      const reqText = `${input.title} ${input.description} ${input.acceptanceCriteria || ''} ${input.businessFlow || ''}`;
      // Scenario-aware query: fold the planned scenario titles/objectives/risk
      // areas into the retrieval query so ranking targets what will be tested.
      // One query string PER planned scenario — this makes the retrieval unit
      // "the elements a scenario needs" (forms/elements are pulled round-robin
      // across scenarios) rather than a single global ranking.
      const scenarioQueries = scenarioPlan
        ? scenarioPlan.scenarios.map(s => `${s.title || ''} ${s.objective || ''} ${s.riskArea || ''}`)
        : [];
      // Flattened query is still used for the page/test-data (coarser) ranking.
      const planQuery = scenarioQueries.join(' ');
      const optimized = optimizeKnowledgeForCategory(knowledge, reqText, {
        category: cls.category,
        confidence: cls.confidence,
        minConfidence: PROMPT_OPTIMIZER_MIN_CONFIDENCE,
        queryText: planQuery,
        scenarioQueries,
      });
      genKnowledge = optimized.knowledge;
      optimizeStats = optimized.stats;
      logger.info(MOD, 'Prompt optimizer', {
        applied: optimizeStats.applied,
        category: optimizeStats.category,
        confidence: optimizeStats.confidence,
        scenarioAware: planQuery.length > 0,
        perScenarioUnits: scenarioQueries.length,
        pages: `${optimizeStats.pages.before}→${optimizeStats.pages.after}`,
        forms: `${optimizeStats.forms.before}→${optimizeStats.forms.after}`,
        elements: `${optimizeStats.elements.before}→${optimizeStats.elements.after}`,
        testData: `${optimizeStats.testData.before}→${optimizeStats.testData.after}`,
        reason: optimizeStats.reason,
      });
    }

    // ── Deterministic Scenario Builder (QA-first, ZERO tokens) ──
    // The plan decided WHAT to test; the retriever produced the SCOPED context
    // (real selectors/URLs/datasets). Instead of asking the LLM to re-discover
    // all of that and (as observed) under-generate to a weak 5-scenario floor,
    // we ASSEMBLE a concrete, grounded DRAFT test case for every planned
    // scenario — plus conditional ones the requirement/context supports — from
    // the real App Profile + Test Data. The LLM then only REFINES the wording.
    // Pure/deterministic/fail-open: no drafts ⇒ empty block ⇒ legacy behaviour.
    let draftBlock = '';
    let draftDrafts: DraftTestCase[] = [];
    if (SCENARIO_BUILDER_ENABLED && SCENARIO_PLANNER_ENABLED && scenarioPlan) {
      const built = buildDraftTestCases(scenarioPlan, genKnowledge, input);
      draftDrafts = built.drafts;
      draftBlock = buildDraftBlock(built.drafts);
      logger.info(MOD, 'Scenario builder', {
        planned: scenarioPlan.scenarios.length,
        drafts: built.drafts.length,
        grounded: built.groundedCount,
        applied: draftBlock.length > 0,
      });
    }

    // ── Formatter Mode decision ──
    // When the builder produced COMPLETE drafts, switch the LLM from "generate"
    // to "format": it will receive ONLY the finished test-case objects (no
    // requirement/app-profile/knowledge/coverage/reasoning), cutting the input
    // prompt to the drafts + a short polish instruction. Scoped to STANDARD mode
    // (Gap Analysis still reasons over assumptions).
    //
    // ARCHITECTURAL BOUNDARY: the Scenario Planner is the SINGLE SOURCE OF TRUTH
    // for scenario existence. If a selected coverage type has NO justified
    // scenario (e.g. "security" selected on a bare "user can log in" with no
    // evidence of lockout/injection behaviour), that is a DELIBERATE, correct
    // outcome — the type is intentionally empty because nothing in the
    // requirement / acceptance criteria / app knowledge / test data justifies a
    // scenario for it. We must NOT fall back to the full-reasoning prompt to
    // "fill the gap", because that path re-invents ungrounded scenarios — the
    // exact quality-over-quantity regression this refactor removes. So formatter
    // mode now engages whenever the planner produced ANY drafts, regardless of
    // whether every selected type is covered. Uncovered selected types are
    // logged for transparency, never back-filled by invention.
    const draftCoverageTypes = new Set(draftDrafts.map(d => d.coverageType));
    const uncoveredSelectedTypes = coverageTypes.filter(ct => !draftCoverageTypes.has(ct));
    const formatterMode =
      FORMATTER_MODE_ENABLED && !expand && draftDrafts.length > 0;
    if (formatterMode && uncoveredSelectedTypes.length > 0) {
      logger.info(MOD, 'Selected coverage types with no justified scenario (intentionally empty — no invention)', {
        selected: coverageTypes.join(','),
        uncovered: uncoveredSelectedTypes.join(','),
        justifiedTypes: Array.from(draftCoverageTypes).join(','),
      });
    }

    // ── Canonical Validator (QA-first, ZERO tokens) ──
    // Before the LLM ever sees the drafts, assert + deterministically repair the
    // canonical invariants (unique scenarioId, non-empty expected, no duplicate
    // steps, real selectors/datasets/pages). This runs on the VALIDATED cases so
    // the formatter can only ever touch wording — the structure is already sound.
    // Never drops a case; coverage stays exactly what the builder produced.
    let deterministicOutput:
      | { scenarios: ReturnType<typeof buildScenariosFromDrafts>; testCases: FormatterTestCase[] }
      | undefined;
    let scenarioGraph: ScenarioGraph | undefined;
    // KB-authored semantics per scenarioId — the source of the FormatterInput
    // contract (variation / expectedBehavior / requiredDataRole). Resolved ONCE
    // here so both the scenario graph and the formatter inputs read the same
    // canonical answer. This is what lets the formatter prompt stay tiny: the
    // structural decisions travel as DATA, not as prompt instructions.
    let semanticsById: Map<string, ScenarioSemantics> | undefined;
    if (formatterMode) {
      semanticsById = new Map(
        (scenarioPlan?.scenarios ?? []).map(s => [s.id, getScenarioSemantics(s)] as const),
      );
      const built = buildDeterministicOutput(draftDrafts);
      let cases = built.testCases;
      if (CANONICAL_VALIDATOR_ENABLED) {
        const validated = validateCanonicalTestCases(cases, genKnowledge);
        cases = validated.cases;
        logger.info(MOD, 'Canonical validator', {
          checked: validated.report.checked,
          ok: validated.report.ok,
          errors: validated.report.errors,
          warnings: validated.report.warnings,
          repaired: validated.report.repaired,
          checks: validated.report.issues.slice(0, 8).map(i => `${i.scenarioId}:${i.check}`).join(' '),
        });
      }

      // ── Persistent Scenario Graph (the one intelligence source) ──
      // Assemble the canonical graph from the SAME validated cases and source
      // Test Case Lab's deterministic output from it. This makes Test Case Lab
      // the reference consumer of the shared graph (Script Gen / Healing / RTM /
      // Impact Analysis read the same structure via the graph service). Output
      // is identical — assembled from the same cases — so it is zero-risk.
      if (SCENARIO_GRAPH_ENABLED) {
        // Graph nodes carry the SAME KB-authored semantics resolved above.
        scenarioGraph = assembleScenarioGraph({
          input,
          coverageTypes,
          cases,
          meta: draftDrafts.map((d, i) => ({
            coverageType: built.scenarios[i]?.coverageType ?? d.coverageType,
            grounded: d.grounded,
            objective: d.objective,
            semantics: semanticsById?.get(d.scenarioId),
          })),
          knowledgeVersion: scenarioPlan?.knowledgeVersion ?? '',
          category: scenarioPlan?.classification.category ?? 'generic',
          // The REAL project datasets — role resolution runs ONCE here, at graph
          // build, and the winning record is carried on each node (then masked by
          // the Test Case Lab projection). Absent → nodes carry no resolved record.
          availableDatasets: genKnowledge?.datasets,
        });
        const projection = toTestCaseLab(scenarioGraph);
        logger.info(MOD, 'Scenario graph assembled (Test Case Lab consuming)', {
          nodes: scenarioGraph.nodes.length,
          edges: scenarioGraph.edges.length,
          category: scenarioGraph.category,
          fingerprint: scenarioGraph.fingerprint.slice(0, 12),
        });
        deterministicOutput = {
          scenarios: projection.scenarios as ReturnType<typeof buildScenariosFromDrafts>,
          testCases: projection.testCases as unknown as FormatterTestCase[],
        };
      } else {
        deterministicOutput = { scenarios: built.scenarios, testCases: cases };
      }
    }

    const knowledgeBugs = genKnowledge?.historicalBugs?.length
      ? `\nHistorical bugs to consider: ${genKnowledge.historicalBugs.join('; ')}`
      : '';
    const knowledgeTests = genKnowledge?.existingTestCases?.length
      ? `\nExisting test coverage: ${genKnowledge.existingTestCases.join('; ')}`
      : '';
    const enterpriseBlock = this.buildEnterpriseKnowledgeBlock(genKnowledge, input);
    // Phase 2 — intent-scoped orchestrated intelligence. When available, it
    // REPLACES the legacy flat repo / app-profile / test-data blocks (the rich
    // enterprise-knowledge block is always kept). Fully additive: '' when the
    // flag is off or no scope/intelligence is present → legacy blocks are used.
    const orchestrated = await this.buildOrchestratedIntelligenceBlock(input, genKnowledge);
    const useOrchestrated = orchestrated.block.length > 0;
    const orchestratedBlock = orchestrated.block;
    const repoBlock = useOrchestrated ? '' : this.buildRepoIntelligenceBlock(genKnowledge);
    const appProfileBlock = useOrchestrated ? '' : this.buildApplicationProfileBlock(genKnowledge);
    const testDataBlock = useOrchestrated ? '' : this.buildTestDataBlock(genKnowledge);

    // ── Per-type coverage objectives ──
    // Each SELECTED coverage type is an INDEPENDENT objective with its own goal and
    // the signals to look for. Passing the semantic MEANING (not just the name) is
    // what drives Claude to produce a dedicated, comprehensive section per type
    // instead of collapsing everything into a single positive scenario.
    const coverageObjectives = coverageTypes.map((ct, i) => {
      const g = COVERAGE_TYPE_GOALS[ct];
      if (!g) return `  ${i + 1}. ${ct}  (use coverageType: "${ct}") — generate every grounded scenario and test case this coverage type implies for the requirement.`;
      return `  ${i + 1}. ${g.label}  (use coverageType: "${ct}")\n       Goal: ${g.goal}\n       Look for: ${g.lookFor}`;
    }).join('\n');

    // (Scenario Plan was computed earlier so it could steer scenario-aware
    // retrieval; scenarioPlanBlock is injected into the prompt below.)

    // ── Mode-specific scope guidance ──
    // STANDARD (default): committed coverage grounded in requirement + context
    //   (App Knowledge, App Profile, Test Data). No assumptions.
    // GAP ANALYSIS (expanded): grounded coverage + a separate assumption-based
    //   suggestions bucket + missing-requirement questions.
    const scopeBlock = expand
      ? `GENERATION MODE: GAP ANALYSIS (Coverage Gap Analysis is ON)
  Produce THREE outputs:
    1) "testCases" — GROUNDED coverage (see GROUNDED SCOPE below) derived from the REQUIREMENT and the PROVIDED CONTEXT (App Knowledge, App Profile, Test Data), organised by the coverage objectives below. This is the same committed coverage you would produce in Standard mode.
    2) "suggestedTestCases" — ADDITIONAL, ASSUMPTION-BASED coverage a senior QA would still consider (negative paths, security, edge/boundary, role/permission, concurrency, timeouts) that is NOT grounded in the requirement or context. Keep these OUT of "testCases".
    3) "missingRequirements" — open questions for unstated values/limits/behaviours (see the ASSUMPTIONS rule).`
      : `GENERATION MODE: STANDARD COVERAGE (Coverage Gap Analysis is OFF)
  Produce "testCases" GROUNDED in the REQUIREMENT and the PROVIDED CONTEXT, organised by the coverage objectives below. App Knowledge, App Profile and Test Data are FIRST-CLASS inputs by default — use them to drive AND enrich real, committed test cases (see GROUNDED SCOPE below).
  "suggestedTestCases" MUST be an empty array [] and "missingRequirements" MUST be an empty array [] — assumptions are surfaced only when Gap Analysis is ON.`;

    // ── Reasoning block (adaptive, QA-first) ──
    // When the deterministic Scenario Planner produced a plan, it REPLACES the
    // generic "enumerate every situation" reasoning: the plan already lists the
    // baseline scenarios this category requires, so the model EXPANDS the plan
    // instead of re-deriving it (the user's point — the plan must replace the
    // reasoning, not stack on top of it). With no plan (generic category), the
    // model does the full enumeration itself. Either way the block is a few
    // hundred chars, not the ~1.4K-char phase essay it replaces.
    const hasPlan = scenarioPlanBlock.trim().length > 0;
    const hasDrafts = draftBlock.trim().length > 0;
    const reasoningBlock = hasDrafts
      ? `REASONING (do this INTERNALLY; output ONLY the final JSON):
  1. Extract every obligation from the Acceptance Criteria as precondition → action → expected → risk. EACH obligation must be verified by ≥1 test case (missing one is the worst failure).
  2. REFINE THE PRE-BUILT DRAFTS below — they were assembled DETERMINISTICALLY from the scenario plan and the REAL app structure (selectors/URLs/datasets). Do NOT re-derive coverage or re-discover the app: produce one polished test case per draft (keeping its scenarioIndex, real selectors, dataset references, priority, riskArea and source), then ADD any further cases the requirement/context clearly implies. The drafts are a FLOOR — never emit fewer cases than drafts.
  3. Cover EVERY selected coverage type on its own — never collapse to a single happy path, never merge types into one scenario. No upper cap; the requirement + context decide depth. Never pad with reworded repetition or ungrounded guesses, and never invent selectors/pages/datasets absent from the drafts/context.`
      : hasPlan
      ? `REASONING (do this INTERNALLY; output ONLY the final JSON):
  1. Extract every obligation from the Acceptance Criteria as precondition → action → expected → risk. EACH obligation must be verified by ≥1 test case (missing one is the worst failure).
  2. EXPAND THE SCENARIO PLAN above — it is the baseline set of scenarios this feature category requires. Keep every planned scenario that applies, then ADD any further scenarios the requirement, business flow, App Knowledge, App Profile or Test Data imply. Do NOT re-derive what the plan already lists; enrich and ground it.
  3. Cover EVERY selected coverage type on its own — never collapse to a single happy path, never merge types into one scenario. No fixed count and no upper cap; the requirement + context decide depth. Never pad with reworded repetition or ungrounded guesses.`
      : `REASONING (do this INTERNALLY; output ONLY the final JSON):
  1. Extract every obligation from the Acceptance Criteria as precondition → action → expected → risk. EACH obligation must be verified by ≥1 test case (missing one is the worst failure).
  2. Infer scenarios from the Business Flow beyond the happy path where relevant — interrupted/resumed flow, session timeout, navigation (back/forward/deep-link/refresh), and state carried between steps.
  3. Enumerate EVERY distinct situation worth testing, THEN bucket each into the selected coverage type it belongs to. Cover EVERY selected type on its own — never collapse to a single happy path, never merge types. No fixed count and no upper cap; the requirement + context decide depth. Never pad with reworded repetition or ungrounded guesses.`;

    // Output JSON schema — kept as a discrete string so the prompt breakdown can
    // measure the SCHEMA cost separately from the reasoning/instruction scaffold
    // (they are the two big fixed-overhead sections and are tuned differently).
    const outputSchema = `{
  "scenarios": [{ "scenario": string, "objective": string, "coverageType": string, "priority": "P0"|"P1"|"P2"|"P3", "riskArea": string }],
  "testCases": [{
    "title": string, "objective": string, "scenarioIndex": number, "riskArea": string,
    "preconditions": string, "steps": string[],
    "expectedResult": string, "testData": string,
    "priority": "P0"|"P1"|"P2"|"P3", "severity": "critical"|"major"|"minor"|"trivial",
    "tags": string[], "automationReady": boolean,
    "automationComplexity": "low"|"medium"|"high", "selectorAvailability": "high"|"medium"|"low"|"unknown",
    "source": "requirement"|"knowledge"|"test_data"|"app_profile", "sourceEvidence": string
  }],
  "coverageTypeEvaluations": [{ "coverageType": string, "status": "covered"|"not_applicable", "reason": string }],
  "suggestedTestCases": [ /* same shape as a testCase; source "gap_analysis". MUST be [] in Standard mode. */ ],
  "missingRequirements": [{ "question": string, "area": string, "rationale": string }]
}`;

    const fullPrompt = `You are a principal QA engineer writing an enterprise-grade test design. Understand the requirement deeply, then cover EACH selected coverage type thoroughly — never let positive crowd out the others.

REQUIREMENT:
Title: ${input.title}
Description: ${input.description}
${input.acceptanceCriteria ? `Acceptance Criteria: ${input.acceptanceCriteria}` : ''}
${input.businessFlow ? `Business Flow: ${input.businessFlow}` : ''}

ANALYSIS:
Feature Type: ${analysis.featureType}
Risk Level: ${analysis.riskLevel}
Impacted Modules: ${analysis.impactedModules.join(', ')}
Workflow: ${analysis.workflowSteps.join(' → ')}
User Roles: ${analysis.userRolesAffected.join(', ')}${knowledgeBugs}${knowledgeTests}${enterpriseBlock}${orchestratedBlock}${repoBlock}${appProfileBlock}${testDataBlock}

${scopeBlock}

COVERAGE OBJECTIVES — the user explicitly selected these. Treat EACH as a separate, independent objective; every one MUST be addressed in the output:
${coverageObjectives}
${scenarioPlanBlock}
${draftBlock}
${reasoningBlock}

OUTPUT RULES:
  - Every scenario sets "coverageType" (exact id, e.g. "positive"), "objective" (one sentence: what it PROVES), "priority", "riskArea". Group scenarios by coverage type.
  - Every test case sets "scenarioIndex" (0-based) to its scenario, plus its own "objective" (the single thing it verifies) and "riskArea" (the product risk it guards against).
  - "coverageTypeEvaluations": exactly ONE entry per selected coverage type — status "covered", or "not_applicable" with a one-line "reason". NEVER silently skip a selected type.

GROUNDED SCOPE (defines what belongs in "testCases") — a case is GROUNDED if it traces to any of:
  • REQUIREMENT (title/description/acceptance criteria/business flow) — stated or directly implied;
  • APP KNOWLEDGE — a documented business rule relevant to this feature (e.g. "accounts lock after 3 failed logins" makes a lockout case grounded, not an assumption);
  • APP PROFILE — real pages/forms/elements/selectors;
  • TEST DATA — a RELEVANT dataset (use its real records as the case's test data, and cover what that dataset exercises).
  These four are FIRST-CLASS inputs: use them to DRIVE and ENRICH committed cases. The ONLY thing excluded from "testCases" is an ASSUMPTION — a value/limit/behaviour absent from BOTH the requirement AND all context. Do NOT test an UNRELATED dataset just because it exists (e.g. a "locked_users" set when nothing mentions lockout). ${expand ? 'Assumptions go to suggestedTestCases / missingRequirements.' : 'Omit assumptions (they appear only when Gap Analysis is ON).'}
${expand ? `  ASSUMPTIONS (Gap Analysis ON): ungrounded ideas go in "suggestedTestCases" (source "gap_analysis"), NEVER in "testCases". If an idea needs an unstated value/limit (max length, lockout threshold, session timeout), do NOT invent a test — add a "missingRequirements" question instead. Never emit source "assumption".`
  : `  ASSUMPTIONS (Gap Analysis OFF): "suggestedTestCases" and "missingRequirements" MUST both be []. Staying grounded does NOT mean under-generating — produce every case the requirement + context genuinely support.`}

QA WRITING RULES (concise — the full QA Artifact Standard is enforced in code by the QA Standard validator, not restated here):
  • Title: "Verify <expected behavior> when <condition>." One objective per case.
  • Steps: ONE user action each (never combine with "and"); business language, not automation ("Enter the registered username" / "Click the Login button", never "Fill"/"Trigger"/selectors); verification is its OWN step; consistent verbs (Open/Enter/Click/Select/Verify); data ROLES not values ("registered username", never "standard_user").
  • Expected results: concrete, observable outcomes ("Home page is displayed" + "Logout button is available"), never abstract ("Login successful"/"works correctly"); one assertion per bullet.
  • NO TRIVIAL DUPLICATES: different input/role/state/error are DISTINCT — keep them all; reworded restatements of one behavior are forbidden.

SOURCE TAGGING: every case sets "source" ("requirement" | "knowledge" | "test_data" | "app_profile"; "gap_analysis" ONLY in suggestedTestCases) and "sourceEvidence" (short exact evidence, e.g. "AC: valid login", "standard_user dataset"). Never use source "assumption".

Return JSON (use [] for empty buckets):
${outputSchema}

Return ONLY valid JSON. Address EVERY selected coverage type, organise scenarios by coverageType, and be comprehensive while staying grounded. ${expand ? 'Keep grounded coverage and assumption-based suggestions in SEPARATE buckets.' : 'Use ALL provided context to ground committed coverage; keep suggestedTestCases and missingRequirements empty.'}`;

    // ── Active prompt selection ──
    // In FORMATTER MODE the model only re-words the deterministic drafts, so the
    // prompt is the minimal "polish these test cases" payload — NOT the full
    // generation prompt. This is the actual token cut: the whole requirement/
    // app-profile/knowledge/coverage/reasoning scaffold is DROPPED from the call.
    // The FormatterInput contract folds the KB-authored semantics into each
    // case, so the prompt itself stays tiny (structural decisions travel as
    // DATA, not instructions). Kept in scope so the QA-Standard repair pass can
    // reuse the exact same inputs for the cases it needs to re-ask.
    const formatterInputs: FormatterInput[] | undefined =
      formatterMode && deterministicOutput
        ? // Resolution already ran at graph build; the resolved record rides on
          // deterministicOutput.testCases (from the Test Case Lab projection), so
          // buildFormatterInputs just reads it — no datasets passed here.
          buildFormatterInputs(deterministicOutput.testCases, semanticsById)
        : undefined;
    const formatterPrompt = formatterInputs ? buildFormatterPrompt(formatterInputs) : '';
    const prompt = formatterMode ? formatterPrompt : fullPrompt;

    // ── Deterministic prompt breakdown (analytics, ZERO tokens) ──
    // Attribute the assembled prompt to named sections so we can SEE where the
    // INPUT tokens actually go instead of reporting one opaque number. Formatter
    // mode has just two sections: the finished drafts (the payload) and the tiny
    // polish instruction — this is what makes the reduction visible in History.
    let promptBreakdown: PromptSectionBreakdown;
    if (formatterMode && deterministicOutput) {
      // Measure the ACTUAL editable-only payload as it appears in the prompt
      // (the canonical formatter sends only the wording fields, not the full
      // 16-field objects), so the breakdown reflects the real, smaller payload.
      const marker = 'TEST CASES:\n';
      const idx = prompt.lastIndexOf(marker);
      const draftsPayloadChars = idx >= 0
        ? prompt.length - (idx + marker.length)
        : JSON.stringify(deterministicOutput.testCases).length;
      const formatterInstructionChars = Math.max(0, prompt.length - draftsPayloadChars);
      promptBreakdown = buildPromptBreakdown([
        { key: 'draftTestCases', label: 'Canonical Cases (editable payload)', text: 'x'.repeat(draftsPayloadChars) },
        { key: 'instructions', label: 'Formatter Instructions', text: 'x'.repeat(formatterInstructionChars) },
      ]);
    } else {
      const requirementSectionChars =
        input.title.length + input.description.length +
        (input.acceptanceCriteria?.length || 0) + (input.businessFlow?.length || 0);
      const knowledgeSectionChars = enterpriseBlock.length + repoBlock.length + orchestratedBlock.length;
      const accountedChars =
        requirementSectionChars + knowledgeSectionChars + appProfileBlock.length +
        testDataBlock.length + coverageObjectives.length + scopeBlock.length +
        scenarioPlanBlock.length + draftBlock.length + outputSchema.length;
      // "instructions" = the static reasoning/rules scaffold (everything not
      // attributed to a grounding block or the JSON schema). Schema is measured on
      // its own so the two big FIXED-overhead sections are visible separately.
      const instructionsChars = Math.max(0, prompt.length - accountedChars);
      promptBreakdown = buildPromptBreakdown([
        { key: 'requirement', label: 'Requirement + Analysis', text: 'x'.repeat(requirementSectionChars) },
        { key: 'appProfile', label: 'App Profile', text: appProfileBlock },
        { key: 'knowledge', label: 'App Knowledge', text: 'x'.repeat(knowledgeSectionChars) },
        { key: 'testData', label: 'Test Data', text: testDataBlock },
        { key: 'coverageObjectives', label: 'Coverage Objectives', text: coverageObjectives },
        { key: 'scenarioPlan', label: 'Scenario Plan', text: scenarioPlanBlock },
        { key: 'draftTestCases', label: 'Draft Test Cases', text: draftBlock },
        { key: 'instructions', label: 'Instructions', text: 'x'.repeat(instructionsChars) },
        { key: 'schema', label: 'Output Schema', text: outputSchema },
      ]);
    }
    logger.info(MOD, 'Prompt breakdown', {
      mode: formatterMode ? 'formatter' : 'generation',
      totalChars: promptBreakdown.totalChars,
      estTokens: promptBreakdown.totalEstimatedTokens,
      sections: promptBreakdown.sections.map(s => `${s.key}:${s.estimatedTokens}(${s.pctOfPrompt}%)`).join(' '),
    });

    // Exhaustive, multi-type coverage with a rich grounding context: request the
    // full output budget and a generous prompt-char budget so neither the input
    // context nor the JSON schema at the end of the prompt is truncated.
    const resp = await this.callLLM(prompt, maxOutputTokens, { complexity: 'complex', maxPromptChars });
    let parsed: {
      scenarios?: TestScenario[];
      testCases?: TestCase[];
      suggestedTestCases?: TestCase[];
      missingRequirements?: MissingRequirement[];
      coverageTypeEvaluations?: CoverageTypeEvaluation[];
    };
    try {
      parsed = JSON.parse(resp.content);
    } catch {
      logger.error(MOD, 'Failed to parse test generation response', { raw: resp.content.slice(0, 300) });
      parsed = { scenarios: [], testCases: [] };
    }

    let scenarios = parsed.scenarios || [];
    let testCases = parsed.testCases || [];

    // ── Formatter-mode reconciliation (coverage guaranteed by the builder) ──
    // The scenarios array is ALWAYS the deterministic one (the LLM was not asked
    // to produce it). The polished test cases are accepted ONLY if the model
    // honoured the contract (same count, valid JSON); otherwise we ship the
    // deterministic test cases unchanged. Either way coverage == the builder's
    // output — it never depends on the model.
    if (formatterMode && deterministicOutput) {
      scenarios = deterministicOutput.scenarios as unknown as TestScenario[];
      // The formatter returns ONLY the editable wording fields (keyed by
      // canonical id). applyPolish overlays that wording onto the deterministic
      // (already-validated) canonical objects — invariants are preserved by
      // construction because the model never received them. If the model broke
      // the contract (wrong count), the validated deterministic cases ship as-is.
      const { cases: reconciled, contractOk } = applyPolish(deterministicOutput.testCases, parsed);
      let polishedCases = reconciled;
      if (contractOk) {
        logger.info(MOD, 'Formatter mode applied (polished wording, deterministic logic)', {
          cases: polishedCases.length,
        });
      } else {
        logger.warn(MOD, 'Formatter contract violated — shipping validated deterministic cases', {
          expected: deterministicOutput.testCases.length,
          got: Array.isArray((parsed as any)?.cases) ? (parsed as any).cases.length : 0,
        });
      }

      // ── QA Standard Validator (the standard as CONTRACT, not prompt) ──
      // The 20 principles are NOT in the prompt; they are enforced HERE, in
      // deterministic code. We validate the polished wording, and — if enabled —
      // run ONE bounded, TARGETED repair pass for only the cases that failed,
      // carrying only their specific violations. Coverage is never at risk: if
      // repair is off, errors, or does not help, we keep the prior wording.
      if (QA_STANDARD_VALIDATOR_ENABLED) {
        const report = validateQaStandard(polishedCases);
        logger.info(MOD, 'QA Standard validator', {
          checked: report.checked, passed: report.passed, score: report.score,
          errors: report.errors, warnings: report.warnings,
          principlesViolated: report.principlesViolated.join(' '),
          violations: report.violations.slice(0, 8).map(v => `${v.scenarioId}:${v.principle}`).join(' '),
        });

        const errorIds = new Set(
          report.violations.filter(v => v.severity === 'error').map(v => v.scenarioId),
        );
        if (QA_STANDARD_REPAIR_ENABLED && errorIds.size > 0 && formatterInputs) {
          const failing = polishedCases.filter(c => errorIds.has(c.scenarioId));
          // Same as above — the resolved record already rides on each case; no
          // datasets passed, no re-resolution.
          const repairInputs = buildFormatterInputs(failing, semanticsById);
          const fixesById: Record<string, string[]> = {};
          for (const c of failing) {
            fixesById[c.scenarioId] = violationsToInstructions(report.byId.get(c.scenarioId) ?? []);
          }
          try {
            const repairResp = await this.callLLM(
              buildRepairPrompt(repairInputs, fixesById), maxOutputTokens,
              { complexity: 'standard', maxPromptChars },
            );
            const repairParsed = JSON.parse(repairResp.content);
            // Overlay ONLY the failing subset (applyPolish enforces the subset
            // count contract); then splice the repaired cases back by id.
            const { cases: repairedSubset, contractOk: repairOk } = applyPolish(failing, repairParsed);
            if (repairOk) {
              const beforeErrors = report.errors;
              const merged = polishedCases.map(c => {
                const fixed = repairedSubset.find(r => r.scenarioId === c.scenarioId);
                return fixed ?? c;
              });
              const after = validateQaStandard(merged);
              // Only accept the repair if it strictly REDUCES error-severity
              // violations; otherwise keep the prior wording (never regress).
              if (after.errors < beforeErrors) {
                polishedCases = merged;
                logger.info(MOD, 'QA Standard repair applied', {
                  repairedCases: failing.length, errorsBefore: beforeErrors, errorsAfter: after.errors,
                });
              } else {
                logger.info(MOD, 'QA Standard repair did not reduce errors — kept prior wording', {
                  errorsBefore: beforeErrors, errorsAfter: after.errors,
                });
              }
            }
          } catch (err) {
            logger.warn(MOD, 'QA Standard repair failed — kept prior wording', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      testCases = polishedCases as unknown as TestCase[];
    }
    // Assumptions (suggestions + missing-requirement questions) are surfaced ONLY
    // when Gap Analysis is ON. In Standard mode both buckets are forced empty so
    // committed coverage stays grounded in the requirement + provided context.
    let suggestedTestCases = expand ? (parsed.suggestedTestCases || []) : [];
    const missingRequirements = expand ? (parsed.missingRequirements || []) : [];

    // ── Safety net — enforce the strict/expanded contract even if the model
    //    misclassifies. Any case the model tagged "assumption" or "gap_analysis"
    //    is NOT requirement coverage: move it out of testCases.
    const isExpansionCase = (tc: TestCase) =>
      (tc as any).source === 'assumption' || (tc as any).source === 'gap_analysis';
    const misplaced = testCases.filter(isExpansionCase);
    if (misplaced.length > 0) {
      testCases = testCases.filter(tc => !isExpansionCase(tc));
      if (expand) {
        // Relocate genuine expansion cases into the suggestions bucket (drop pure assumptions).
        suggestedTestCases = [
          ...suggestedTestCases,
          ...misplaced.filter(tc => (tc as any).source !== 'assumption'),
        ];
      }
      logger.info(MOD, 'Strict-scope safety net relocated misclassified cases', {
        mode, relocated: misplaced.length, keptStrict: testCases.length,
      });
    }

    // ── Per-type evaluation — guarantees EVERY selected coverage type is accounted
    //    for. We trust the model's "not_applicable" reasons but always reconcile the
    //    counts against what was actually produced, and synthesise any entry the
    //    model forgot so the UI can show "covered (N scenarios / M cases)" or an
    //    explicit "not applicable — <reason>" for each type the user selected.
    const coverageTypeEvaluations = this.buildCoverageTypeEvaluations(
      coverageTypes,
      scenarios,
      testCases,
      parsed.coverageTypeEvaluations
    );

    return {
      scenarios, testCases, suggestedTestCases, missingRequirements, coverageTypeEvaluations,
      tokensUsed: resp.tokensUsed,
      promptTokens: resp.promptTokens,
      completionTokens: resp.completionTokens,
      promptChars: prompt.length,
      promptBreakdown,
      promptOptimization: optimizeStats,
      intelligenceScore: orchestrated.intelligenceScore,
    };
  }

  /**
   * Reconcile per-coverage-type evaluations. For each SELECTED coverage type we
   * compute how many scenarios/cases were actually produced and merge that with
   * the model's self-reported evaluation. Guarantees one entry per selected type
   * (no silent skips): a type with produced coverage is "covered"; a type with
   * none is "not_applicable" carrying the model's reason when available.
   */
  private buildCoverageTypeEvaluations(
    coverageTypes: CoverageType[],
    scenarios: TestScenario[],
    testCases: TestCase[],
    modelEvaluations?: CoverageTypeEvaluation[]
  ): CoverageTypeEvaluation[] {
    const byType = new Map<string, CoverageTypeEvaluation>();
    (modelEvaluations || []).forEach(ev => {
      if (ev && ev.coverageType) byType.set(ev.coverageType, ev);
    });

    return coverageTypes.map((ct): CoverageTypeEvaluation => {
      // Scenarios tagged with this coverage type, and the cases linked to them.
      const typeScenarioIdx = new Set<number>();
      scenarios.forEach((s, i) => {
        if (s.coverageType === ct) typeScenarioIdx.add(i);
      });
      const scenarioCount = typeScenarioIdx.size;
      const testCaseCount = testCases.filter(tc => {
        const idx = (tc as any).scenarioIndex;
        return typeof idx === 'number' && typeScenarioIdx.has(idx);
      }).length;

      const modelEv = byType.get(ct);
      if (scenarioCount > 0 || testCaseCount > 0) {
        return { coverageType: ct, status: 'covered', scenarioCount, testCaseCount };
      }
      // Nothing produced for this type — surface WHY rather than silently dropping it.
      return {
        coverageType: ct,
        status: 'not_applicable',
        scenarioCount: 0,
        testCaseCount: 0,
        reason:
          modelEv?.reason ||
          (modelEv?.status === 'not_applicable'
            ? 'Not applicable to this requirement given the available context.'
            : 'No grounded scenarios applied for this coverage type given the requirement and provided context.'),
      };
    });
  }

  /* ---- Phase 6: Coverage Gap Analysis ---- */
  async analyzeCoverageGaps(
    input: RequirementInput,
    analysis: RequirementAnalysis,
    scenarios: TestScenario[],
    knowledge?: KnowledgeContext
  ): Promise<{ gaps: CoverageGap[]; tokensUsed: number; promptTokens?: number; completionTokens?: number }> {
    const existingCoverage = knowledge?.existingTestCases?.length
      ? `\nExisting Test Cases: ${knowledge.existingTestCases.join('; ')}`
      : '';
    const enterpriseBlock = this.buildEnterpriseKnowledgeBlock(knowledge, input);
    // Repository Intelligence is NOT injected into gap analysis — gaps are about
    // what CANNOT be automated, which is unrelated to the codebase's tech stack.
    // Skipping it here saves tokens with zero loss of quality.

    const prompt = `You are a QA coverage analyst reviewing an ALREADY-COMPREHENSIVE automated test suite. The scenarios below represent extensive, release-ready automated coverage (positive, negative, edge cases, boundary, integration, security, etc.). Your ONLY job is to flag the small number of items that genuinely CANNOT or SHOULD NOT be covered by this automated test suite.

REQUIREMENT:
Title: ${input.title}
Description: ${input.description}
Feature Type: ${analysis.featureType}
Risk Level: ${analysis.riskLevel}
Workflow: ${analysis.workflowSteps.join(' → ')}
Impacted Modules: ${analysis.impactedModules.join(', ')}${existingCoverage}${enterpriseBlock}

CURRENT AUTOMATED SCENARIOS (already comprehensive):
${scenarios.map((s, i) => `${i + 1}. [${s.coverageType}] ${s.scenario}`).join('\n')}

CRITICAL RULES — read carefully:
1. The automated suite above is intended to be COMPREHENSIVE. Do NOT list anything that a normal automated functional, negative, edge-case, boundary, integration, security, performance, or API test could reasonably cover — those belong in the test suite, NOT in gaps. Assume they are already covered.
2. ONLY report a gap if it is genuinely IMPRACTICAL or IMPOSSIBLE to automate in a standard CI test suite. Valid gap categories are STRICTLY limited to:
   - Manual / exploratory verification that requires human judgment (e.g., subjective UX quality, visual design polish, real-user usability sessions).
   - Physical devices or hardware that cannot be virtualized (e.g., specific biometric scanners, printers, IoT hardware, real mobile device farms).
   - Third-party / external systems outside your control that cannot be reliably stubbed (e.g., live payment gateways in production, external regulatory bodies, real SMS/email delivery to carriers).
   - Extreme-scale or destructive conditions needing dedicated infrastructure (e.g., true production-scale load testing, chaos/disaster-recovery drills, data-center failover).
   - Real-money, legal, or irreversible operations that are unsafe to automate against production.
3. Concurrency, data boundaries, error recovery, cross-module interactions, security, standard performance, accessibility, and rollback/undo are ALL automatable — DO NOT list them as gaps. They must be assumed covered by the suite.
4. If the automated coverage is comprehensive and nothing genuinely falls into the categories above, return an EMPTY array []. An empty array is the EXPECTED and CORRECT result for most well-covered requirements.
5. Return AT MOST 3 gaps, and only if they truly qualify. Quality over quantity. Fewer is better.

Return JSON array (empty array if no genuine non-automatable gaps exist):
[{ "area": string, "description": string, "severity": "critical"|"high"|"medium"|"low", "suggestion": string }]

Return ONLY valid JSON array.`;

    const resp = await this.callLLM(prompt, 1500);
    let gaps: CoverageGap[];
    try {
      gaps = JSON.parse(resp.content);
    } catch {
      gaps = [];
    }
    return { gaps, tokensUsed: resp.tokensUsed, promptTokens: resp.promptTokens, completionTokens: resp.completionTokens };
  }

  /* ---- Full Pipeline ---- */
  async generateFullCoverage(
    input: RequirementInput,
    coverageTypes: CoverageType[],
    knowledge?: KnowledgeContext,
    options?: {
      includeCoverageGaps?: boolean;
      deduplicate?: boolean;
      mode?: GenerationMode;
      /**
       * Test Case Lab fix — Priority 1 ("A"). When TRUE, the engine may broaden
       * the committed coverage beyond the user's selected types (adds the
       * positive/negative/edge/boundary/integration baseline). Default FALSE:
       * we generate EXACTLY the coverage types the user selected — no silent
       * 3→5 expansion. Only an explicit "AI Coverage Expansion" opt-in widens it.
       */
      aiCoverageExpansion?: boolean;
    }
  ): Promise<GenerationResult> {
    // The "Coverage Gap Analysis" toggle drives the separate assumption-based
    // suggestions bucket + the gap-analysis LLM call. It NO LONGER silently
    // expands the committed coverage types — that is now a distinct, explicit
    // opt-in ("aiCoverageExpansion", Priority 1) so the generator always
    // respects the user's selection.
    //   • Gap Analysis OFF → STANDARD mode: committed coverage GROUNDED in the
    //           requirement + provided context. No assumptions, no gap call.
    //   • Gap Analysis ON  → EXPANDED mode: same grounded coverage + a separate
    //           assumption-based "suggested additional coverage" bucket +
    //           missing-requirement questions + the non-automatable gap pass.
    const includeCoverageGaps = options?.includeCoverageGaps !== false;
    const aiCoverageExpansion = options?.aiCoverageExpansion === true;

    // Pipeline wall-clock start — used for the end-to-end totalMs telemetry.
    const pipelineStart = Date.now();

    // Adaptive generation: classify the requirement's complexity with a pure
    // HEURISTIC (zero LLM tokens — we never spend a model call to decide how
    // big the budget should be) and route to a FAST / STANDARD / COMPREHENSIVE
    // tier. The tier only scales token + prompt budgets and whether the separate
    // analysis round-trip runs — the generation prompt itself is identical, so
    // quality is preserved.
    const complexity = this.estimateComplexity(input, coverageTypes, knowledge);
    const tierCfg = TIER_CONFIGS[complexity.tier];
    logger.info(MOD, 'Complexity classified', {
      tier: complexity.tier,
      reason: complexity.reason,
      signals: complexity.signals,
      maxOutputTokens: tierCfg.maxOutputTokens,
      maxPromptChars: tierCfg.maxPromptChars,
      runAnalysis: tierCfg.runAnalysis,
    });

    // ── Priority 3 ("D") — skip gap analysis for simple requirements ──
    // Gap analysis is a whole extra LLM round-trip. For solved-problem flows
    // (login, logout, forgot-password, search) it adds cost + latency without
    // finding real gaps. Only run it when the caller asked for it AND the
    // requirement is complex enough to warrant it.
    const gapComplexityMet = complexity.signals.complexityScore >= GAP_ANALYSIS_MIN_COMPLEXITY;
    const runGapAnalysis = includeCoverageGaps && gapComplexityMet;
    // Mode drives the assumption-based suggestions bucket in the generation
    // prompt — keep it aligned with whether gap analysis actually runs, so a
    // simple requirement stays fully grounded (strict) with no suggestions.
    const mode: GenerationMode = options?.mode ?? (runGapAnalysis ? 'expanded' : 'strict');
    if (includeCoverageGaps && !gapComplexityMet) {
      logger.info(MOD, 'Gap analysis auto-skipped — requirement below complexity gate', {
        complexityScore: Math.round(complexity.signals.complexityScore),
        gate: GAP_ANALYSIS_MIN_COMPLEXITY,
        tier: complexity.tier,
      });
    }
    logger.info(MOD, 'Generation plan', {
      title: input.title, coverageTypes, aiCoverageExpansion, includeCoverageGaps,
      runGapAnalysis, mode,
    });

    // Phase 2: Analyze requirement.
    // COMPREHENSIVE tier runs the dedicated analysis LLM call; FAST/STANDARD
    // skip it and derive an equivalent analysis heuristically — saving a full
    // Claude round-trip (~2 Claude calls + ~8K tokens) on small requirements.
    const analysisStart = Date.now();
    let analysis: RequirementAnalysis;
    let t1 = 0;
    let p1 = 0, c1 = 0; // analysis prompt/completion split
    if (tierCfg.runAnalysis) {
      const analyzed = await this.analyzeRequirement(input, knowledge);
      analysis = analyzed.analysis;
      t1 = analyzed.tokensUsed;
      p1 = analyzed.promptTokens ?? 0;
      c1 = analyzed.completionTokens ?? 0;
    } else {
      analysis = this.heuristicAnalysis(input, complexity);
    }
    const analysisMs = Date.now() - analysisStart;
    logger.info(MOD, 'Requirement analysis complete', {
      featureType: analysis.featureType, riskLevel: analysis.riskLevel,
      tier: complexity.tier, analyzedViaLLM: tierCfg.runAnalysis, analysisMs,
    });

    // Phase 5: Generate tests (mode-aware — strict vs expanded). The INPUT prompt
    // budget comes from the tier, but the OUTPUT budget is COVERAGE-DRIVEN — it
    // scales with the number of scenarios the deterministic planner expects and
    // the number of coverage types selected, so the model is never forced to
    // drop scenarios/cases to fit a fixed budget (user directive). Zero-token:
    // planScenarios is pure/deterministic.
    const plannedForBudget = SCENARIO_PLANNER_ENABLED
      ? planScenarios(input, coverageTypes, analysis.featureType, knowledge).scenarios.length
      : 0;
    const outputBudget = coverageDrivenOutputBudget(
      plannedForBudget, coverageTypes.length, tierCfg.maxOutputTokens,
    );
    logger.info(MOD, 'Coverage-driven output budget', {
      plannedScenarios: plannedForBudget,
      coverageTypes: coverageTypes.length,
      tierCeiling: tierCfg.maxOutputTokens,
      outputBudget,
    });
    const generationStart = Date.now();
    const gen = await this.generateTestCoverage(
      input, analysis, coverageTypes, knowledge, mode,
      outputBudget, tierCfg.maxPromptChars, aiCoverageExpansion,
    );
    const generationMs = Date.now() - generationStart;
    const { scenarios, testCases: rawTestCases, missingRequirements, coverageTypeEvaluations, tokensUsed: t2, promptChars, intelligenceScore } = gen;
    const p2 = gen.promptTokens ?? 0;      // generation prompt tokens
    const c2 = gen.completionTokens ?? 0;  // generation completion tokens
    const promptBreakdown = gen.promptBreakdown;
    const promptOptimization = gen.promptOptimization;
    let rawSuggested = gen.suggestedTestCases || [];
    logger.info(MOD, 'Test generation complete', {
      scenarios: scenarios.length, testCases: rawTestCases.length,
      suggested: rawSuggested.length, missingRequirements: missingRequirements.length, mode,
    });

    // ── Priority 4 ("C") — parallelize independent post-generation work ──
    // Both phases below consume the just-generated output and are independent of
    // each other: de-dup reads the test-case buckets; gap analysis reads the
    // scenarios. Running them sequentially wasted wall-clock. Kick both off and
    // await together (Promise.all) for a meaningful latency cut. Each fails open
    // internally, so a Promise.all rejection is not expected, but we still guard.

    // Phase 5b: Semantic de-duplication — drop near-identical cases (e.g. three
    // variants of the same happy-path login). Cheap batched embeddings call; fails
    // open. Can be disabled via options.deduplicate=false. Applied to both buckets.
    const dedupWork = async (): Promise<{
      testCases: TestCase[]; suggestedTestCases: TestCase[]; removed: number;
    }> => {
      if (options?.deduplicate === false) {
        return { testCases: rawTestCases, suggestedTestCases: rawSuggested, removed: 0 };
      }
      let kept = rawTestCases;
      let keptSuggested = rawSuggested;
      let removed = 0;
      if (rawTestCases.length > 1) {
        const dedup = await this.deduplicateTestCases(rawTestCases);
        kept = dedup.kept;
        removed += dedup.removed;
      }
      if (rawSuggested.length > 1) {
        const dedupS = await this.deduplicateTestCases(rawSuggested);
        keptSuggested = dedupS.kept;
        removed += dedupS.removed;
      }
      return { testCases: kept, suggestedTestCases: keptSuggested, removed };
    };

    // Phase 6: Gap analysis — only when the caller asked for it AND the
    // requirement cleared the complexity gate (Priority 3). Saves a full LLM
    // call for simple requirements.
    const gapWork = async (): Promise<{ gaps: CoverageGap[]; tokensUsed: number; promptTokens?: number; completionTokens?: number }> => {
      if (!runGapAnalysis) {
        logger.info(MOD, 'Gap analysis skipped — not requested or below complexity gate');
        return { gaps: [], tokensUsed: 0 };
      }
      const gapResult = await this.analyzeCoverageGaps(input, analysis, scenarios, knowledge);
      logger.info(MOD, 'Gap analysis complete', { gaps: gapResult.gaps.length });
      return gapResult;
    };

    const [dedupResult, gapResult] = await Promise.all([dedupWork(), gapWork()]);
    const testCases = dedupResult.testCases;
    const suggestedTestCases = dedupResult.suggestedTestCases;
    const duplicatesRemoved = dedupResult.removed;
    const gaps = gapResult.gaps;
    const t3 = gapResult.tokensUsed;
    const p3 = gapResult.promptTokens ?? 0;      // gap-analysis prompt tokens
    const c3 = gapResult.completionTokens ?? 0;  // gap-analysis completion tokens

    const totalTokens = t1 + t2 + t3;
    // Prompt (input) vs completion (output) totals across every LLM call. This
    // is what makes token analytics honest: the UI can now show WHERE tokens go
    // (big input prompt vs small output) instead of one opaque total.
    const promptTokensTotal = p1 + p2 + p3;
    const completionTokensTotal = c1 + c2 + c3;
    const estimatedCostUsd = estimateCostUsd(promptTokensTotal, completionTokensTotal);
    const result: GenerationResult = {
      requirementAnalysis: analysis,
      scenarios,
      testCases,
      suggestedTestCases,
      missingRequirements,
      coverageGaps: gaps,
      coverageTypeEvaluations,
      mode,
      intelligenceScore,
      stats: {
        totalScenarios: scenarios.length,
        totalTestCases: testCases.length,
        coverageTypes,
        automationReadyCount: testCases.filter(tc => tc.automationReady).length,
        gapsFound: gaps.length,
        tokensUsed: totalTokens,
        promptTokens: promptTokensTotal,
        completionTokens: completionTokensTotal,
        estimatedCostUsd,
        duplicatesRemoved,
        suggestedCount: suggestedTestCases.length,
        missingRequirementsCount: missingRequirements.length,
        promptChars,
        casesPerKChars: promptChars > 0
          ? Math.round((testCases.length / promptChars) * 1000 * 100) / 100
          : 0,
        generationMetadata: {
          promptVersion: PROMPT_VERSION,
          engineVersion: ENGINE_VERSION,
          model: this.testModel || 'unknown',
          timestamp: new Date().toISOString(),
          // Adaptive generation telemetry — persisted in the requirement's
          // `analysis` JSONB and surfaced in History. Captured so tier
          // thresholds can be tuned from real data (not guesses).
          complexityTier: complexity.tier,
          complexitySignals: complexity.signals,
          complexityReason: complexity.reason,
          analysisMs,
          generationMs,
          totalMs: Date.now() - pipelineStart,
          analysisTokens: t1,
          generationTokens: t2,
          totalTokens,
          promptTokens: promptTokensTotal,
          completionTokens: completionTokensTotal,
          estimatedCostUsd,
          promptBreakdown,
          promptOptimization,
          scenarioCount: scenarios.length,
          testCaseCount: testCases.length,
        },
      },
    };
    logger.info(MOD, 'Generation complete', {
      promptVersion: PROMPT_VERSION,
      engineVersion: ENGINE_VERSION,
      model: this.testModel,
      tier: complexity.tier,
      promptChars,
      totalTestCases: testCases.length,
      scenarioCount: scenarios.length,
      tokensUsed: totalTokens,
      analysisTokens: t1,
      generationTokens: t2,
      analysisMs,
      generationMs,
      totalMs: result.stats.generationMetadata!.totalMs,
      casesPerKChars: result.stats.casesPerKChars,
      timestamp: result.stats.generationMetadata!.timestamp,
    });
    return result;
  }

  /* ---- Semantic de-duplication of generated test cases ---- */
  /**
   * Removes near-duplicate test cases using embedding cosine similarity.
   * Two cases above `threshold` similarity are treated as duplicates; the
   * stronger one is kept (higher priority, then more detailed steps). This is a
   * single batched embeddings call (cheap + fast — text-embedding-3-small) and
   * FAILS OPEN: any error returns the original list unchanged so generation is
   * never blocked. Returns the kept cases plus how many were removed.
   */
  async deduplicateTestCases(
    testCases: TestCase[],
    threshold = 0.9
  ): Promise<{ kept: TestCase[]; removed: number }> {
    if (testCases.length < 2) return { kept: testCases, removed: 0 };

    try {
      // Embed a compact signature for each case: title + expected result carry the
      // semantic intent; including them keeps "same behaviour, different wording"
      // cases close in vector space.
      const signatures = testCases.map(tc =>
        `${tc.title || ''}. ${tc.expectedResult || ''}`.trim().slice(0, 500)
      );

      const modelConfig = this.modelSelector.selectModel('similarity');
      const resp = await this.openai.embeddings.create({
        model: modelConfig.model,
        input: signatures,
      });
      const vectors = resp.data.map(d => d.embedding as number[]);
      if (vectors.length !== testCases.length) {
        // Defensive: provider returned an unexpected count — skip dedup.
        return { kept: testCases, removed: 0 };
      }

      const priorityRank = (p?: string) => ({ P0: 0, P1: 1, P2: 2, P3: 3 }[p || 'P2'] ?? 2);
      // Prefer the "stronger" case to survive a duplicate pair.
      const isStronger = (a: TestCase, b: TestCase) => {
        const pr = priorityRank(a.priority) - priorityRank(b.priority);
        if (pr !== 0) return pr < 0;                       // higher priority wins
        const stepsDiff = (a.steps?.length || 0) - (b.steps?.length || 0);
        if (stepsDiff !== 0) return stepsDiff > 0;          // more detailed wins
        return (a.expectedResult?.length || 0) >= (b.expectedResult?.length || 0);
      };

      // Scenario-aware survivor tracking. A test case belongs to a scenario
      // (scenarioIndex). We must NEVER remove the last surviving case of a
      // scenario — otherwise that scenario is orphaned ("No test cases linked")
      // and the total case count drops below the scenario count. Cases without a
      // numeric scenarioIndex share a single bucket (-1).
      const scenarioKey = (tc: TestCase): number => {
        const idx = (tc as any).scenarioIndex;
        return typeof idx === 'number' ? idx : -1;
      };
      const survivorsPerScenario = new Map<number, number>();
      for (const tc of testCases) {
        const k = scenarioKey(tc);
        survivorsPerScenario.set(k, (survivorsPerScenario.get(k) || 0) + 1);
      }

      const removedIdx = new Set<number>();
      const tryRemove = (idx: number): boolean => {
        const k = scenarioKey(testCases[idx]);
        // Protect the last surviving case of its scenario.
        if ((survivorsPerScenario.get(k) || 0) <= 1) return false;
        removedIdx.add(idx);
        survivorsPerScenario.set(k, (survivorsPerScenario.get(k) || 0) - 1);
        return true;
      };

      for (let i = 0; i < testCases.length; i++) {
        if (removedIdx.has(i)) continue;
        for (let j = i + 1; j < testCases.length; j++) {
          if (removedIdx.has(j)) continue;
          const sim = cosineSimilarity(vectors[i], vectors[j]);
          if (sim >= threshold) {
            // Drop the weaker of the pair — but only if doing so does not orphan
            // its scenario. If the preferred loser is protected, try the other;
            // if both are last-of-scenario, keep both (distinct coverage).
            const preferredLoser = isStronger(testCases[i], testCases[j]) ? j : i;
            const otherCandidate = preferredLoser === j ? i : j;
            const removed = tryRemove(preferredLoser) || tryRemove(otherCandidate);
            if (removed && removedIdx.has(i)) break; // i is gone — stop comparing it
          }
        }
      }

      if (removedIdx.size === 0) return { kept: testCases, removed: 0 };
      const kept = testCases.filter((_, idx) => !removedIdx.has(idx));
      logger.info(MOD, 'Semantic dedup removed near-duplicate test cases', {
        before: testCases.length, after: kept.length, removed: removedIdx.size, threshold,
      });
      return { kept, removed: removedIdx.size };
    } catch (err: any) {
      logger.warn(MOD, 'Dedup failed (continuing with full set)', { error: err.message });
      return { kept: testCases, removed: 0 };
    }
  }

  /* ---- LLM Call Helper (cost-optimized) ---- */
  private async callLLM(
    prompt: string,
    maxTokens: number,
    opts?: { complexity?: 'simple' | 'standard' | 'complex'; maxPromptChars?: number }
  ): Promise<{ content: string; tokensUsed: number; promptTokens: number; completionTokens: number }> {
    // Use ModelSelector for intelligent model selection
    const modelConfig = this.modelSelector.selectModel('test_generation', opts?.complexity || 'standard');
    const effectiveMaxTokens = Math.min(maxTokens, modelConfig.maxTokens);

    // Truncate prompt to avoid excessive token usage (token optimization).
    // Callers that build long, structured prompts where the OUTPUT SCHEMA sits at
    // the END (e.g. test generation) pass an explicit, larger budget so the JSON
    // contract is never truncated away — silently dropping it would make the model
    // emit malformed output. Default keeps the historical cost-safety behaviour.
    const maxPromptChars = opts?.maxPromptChars
      ?? parseInt(process.env['MAX_TOKENS_PER_REQUEST'] || '4000', 10) * 4;
    const truncatedPrompt = prompt.length > maxPromptChars
      ? prompt.slice(0, maxPromptChars) + '\n\n[Context truncated for cost optimization]'
      : prompt;

    const systemPrompt = 'You are a senior QA architect and test engineer. Always return valid JSON only — no markdown, no explanation, no code fences.';

    let content = '';
    let tokensUsed = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let usedModel = modelConfig.model;

    // Provider routing — Claude when TEST_PROVIDER=anthropic + configured;
    // transparent fallback to OpenAI on ANY error so a request never fails
    // because of the new provider.
    let routed = false;
    if (this.anthropic) {
      try {
        const r = await this.anthropic.createChatCompletion({
          model: this.testModel,
          temperature: modelConfig.temperature,
          maxTokens: effectiveMaxTokens,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: truncatedPrompt },
          ],
          jsonMode: true,
        });
        content = r.content || '{}';
        tokensUsed = r.tokensUsed;
        // Anthropic usage split when available; fall back to attributing all to prompt.
        promptTokens = r.promptTokens ?? Math.max(0, tokensUsed - (r.completionTokens ?? 0));
        completionTokens = r.completionTokens ?? Math.max(0, tokensUsed - promptTokens);
        usedModel = r.model;
        routed = true;
      } catch (err) {
        logger.warn(MOD, 'Anthropic test generation failed; falling back to OpenAI', {
          error: (err as Error).message,
        });
      }
    }

    if (!routed) {
      const resp = await this.openai.chat.completions.create({
        model: modelConfig.model,
        temperature: modelConfig.temperature,
        max_tokens: effectiveMaxTokens,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: truncatedPrompt },
        ],
      });
      content = resp.choices[0]?.message?.content || '{}';
      promptTokens = resp.usage?.prompt_tokens || 0;
      completionTokens = resp.usage?.completion_tokens || 0;
      tokensUsed = promptTokens + completionTokens;
      usedModel = modelConfig.model;
    }

    // Strip markdown code fences that models sometimes wrap around JSON
    content = content.trim();
    if (content.startsWith('```')) {
      content = content.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
    }

    // Track cost (fire-and-forget to avoid blocking). Records the model that
    // actually served the request so cost attribution stays accurate.
    this.costTracker.trackRequest({
      model: usedModel,
      tokensUsed,
      feature: 'test_coverage',
      taskType: 'test_generation',
    }).catch((err) => {
      logger.warn(MOD, 'Cost tracking failed (non-blocking)', { error: (err as Error).message });
    });

    return { content: content.trim(), tokensUsed, promptTokens, completionTokens };
  }
}
