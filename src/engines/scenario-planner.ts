/**
 * Scenario Planner — the deterministic "what to test" stage.
 * ============================================================================
 *
 * This is the first half of the QA-first, AI-assisted architecture: BEFORE any
 * LLM call, the planner decides which baseline scenarios a requirement should
 * cover, using the QA Knowledge Engine. The generation prompt then instructs the
 * LLM to EXPAND this plan into concrete, grounded test cases rather than
 * inventing the scenario list from scratch.
 *
 * Why this matters:
 *   • Consistency  — "User Login" always gets the same senior-QA baseline
 *     (valid login, invalid password, locked user, empty fields, logout, …),
 *     regardless of prompt phrasing or model temperature.
 *   • Lower tokens — the LLM spends output on EXPANDING known scenarios, not on
 *     re-deriving the obvious ones; we can run a tighter output budget.
 *   • The moat     — deterministic QA intelligence is the differentiator; the
 *     LLM becomes the last enrichment step, not the first inventor.
 *
 * The planner is PURE + synchronous (ZERO LLM tokens) and never overrides
 * grounding: planned scenarios are CANDIDATES the LLM keeps only if the concrete
 * requirement/context supports them.
 */

import type { CoverageType, RequirementInput } from './test-coverage-engine';
import {
  classifyQACategory,
  getBaselineScenarios,
  QA_KNOWLEDGE_VERSION,
  type PlannedScenario,
  type QACategory,
  type QACategoryClassification,
} from './qa-knowledge-engine';

/** A planned scenario annotated with whether it looks conditionally relevant. */
export interface AnnotatedPlannedScenario extends PlannedScenario {
  /**
   * True when the scenario has `conditionalOnKeywords` but NONE of them appear
   * in the requirement/context. The scenario is still shown to the LLM, but
   * flagged so the LLM only expands it if the requirement genuinely supports it
   * — we surface knowledge without forcing invention.
   */
  conditional: boolean;
}

export interface ScenarioPlan {
  /** Detected QA category + confidence + the signals that drove it. */
  classification: QACategoryClassification;
  /** Planned scenarios, filtered to the user's SELECTED coverage types. */
  scenarios: AnnotatedPlannedScenario[];
  /** Count of scenarios that are directly relevant (not conditional). */
  groundedCount: number;
  /** Count flagged as conditional (shown but only-if-supported). */
  conditionalCount: number;
  /** KB version for telemetry correlation. */
  knowledgeVersion: string;
  /** Whether the plan is empty (generic category or no selected type overlap). */
  isEmpty: boolean;
}

/**
 * Build a deterministic scenario plan for a requirement.
 *
 * @param input          The requirement.
 * @param coverageTypes  The user's SELECTED coverage types (Priority 1 —
 *                       we only plan scenarios for types the user picked).
 * @param featureTypeHint Optional upstream analysis featureType hint.
 */
export function planScenarios(
  input: Pick<RequirementInput, 'title' | 'description' | 'module' | 'businessFlow' | 'acceptanceCriteria'>,
  coverageTypes: CoverageType[],
  featureTypeHint?: string,
): ScenarioPlan {
  const classification = classifyQACategory(input, featureTypeHint);
  const baseline = getBaselineScenarios(classification.category);

  // Respect the user's coverage selection: never plan a scenario for a type the
  // user did not select. If nothing is selected, fall back to positive so a plan
  // can still form (matches the engine's own default).
  const selected = new Set<CoverageType>(coverageTypes.length ? coverageTypes : ['positive']);

  const haystack = [
    input.title,
    input.description,
    input.module,
    input.businessFlow,
    input.acceptanceCriteria,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  const scenarios: AnnotatedPlannedScenario[] = baseline
    .filter(s => selected.has(s.coverageType))
    .map(s => {
      const conditional =
        Array.isArray(s.conditionalOnKeywords) &&
        s.conditionalOnKeywords.length > 0 &&
        !s.conditionalOnKeywords.some(k => haystack.includes(k.toLowerCase()));
      return { ...s, conditional };
    });

  const conditionalCount = scenarios.filter(s => s.conditional).length;
  const groundedCount = scenarios.length - conditionalCount;

  return {
    classification,
    scenarios,
    groundedCount,
    conditionalCount,
    knowledgeVersion: QA_KNOWLEDGE_VERSION,
    isEmpty: scenarios.length === 0,
  };
}

/**
 * Render a scenario plan into a compact prompt block. The block tells the LLM to
 * EXPAND the plan (not re-invent it) while staying grounded — conditional
 * scenarios are only expanded if the requirement/context supports them.
 *
 * Returns '' for an empty plan so the caller can cleanly fall back to the legacy
 * (plan-free) prompt with no dangling section.
 */
export function buildScenarioPlanBlock(plan: ScenarioPlan): string {
  if (plan.isEmpty) return '';

  // Group by coverage type for a clean, senior-QA-style checklist.
  const byType = new Map<CoverageType, AnnotatedPlannedScenario[]>();
  for (const s of plan.scenarios) {
    const arr = byType.get(s.coverageType) || [];
    arr.push(s);
    byType.set(s.coverageType, arr);
  }

  const lines: string[] = [];
  for (const [type, items] of byType) {
    lines.push(`  [${type}]`);
    for (const s of items) {
      const flag = s.conditional ? ' (CONDITIONAL — expand only if the requirement/context supports it)' : '';
      lines.push(`    • ${s.title} — ${s.objective}${flag}`);
    }
  }

  return `
--- DETERMINISTIC SCENARIO PLAN (QA Knowledge Engine — category: ${plan.classification.category}, confidence: ${plan.classification.confidence}) ---
A senior-QA baseline of scenarios for this feature category has ALREADY been planned deterministically. Your job is to EXPAND this plan into concrete, grounded test cases — NOT to re-derive what to test from scratch.

Rules for using the plan:
  • Treat each planned scenario below as a REQUIRED starting point for its coverage type. Expand each into one or more concrete, grounded test cases with real steps/data.
  • You MAY add further scenarios the concrete requirement or provided context implies — the plan is a floor, not a ceiling.
  • DROP or DE-PRIORITISE a planned scenario ONLY if the requirement/context clearly does not support it (grounding always wins). Never fabricate behaviour just to satisfy a planned line.
  • Items marked CONDITIONAL are included only if the requirement/context actually mentions the relevant behaviour — otherwise skip them.

PLANNED SCENARIOS (${plan.groundedCount} direct, ${plan.conditionalCount} conditional):
${lines.join('\n')}
--- END SCENARIO PLAN ---`;
}
