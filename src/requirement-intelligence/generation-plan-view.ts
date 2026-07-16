/**
 * Generation Plan — the CUSTOMER-FACING view over the frozen intelligence contract.
 *
 * This module owns NO intelligence. It is a pure, deterministic PRESENTATION
 * adapter that turns the (frozen) `ScriptGenerationPlan` + `RequirementIntelligence`
 * + the repository `CoverageModel` into the exact shape the "Generation Plan"
 * screen renders:
 *
 *     Requirement Intelligence (frozen)          Generation Plan (customer)
 *     ─────────────────────────────────          ──────────────────────────
 *     decision / analysis / generatedBecause  →  Decision · Confidence · savings
 *     coverage.coveredFlows                    →  "Existing Automation" list
 *     coverage.missingFlows                    →  "Automation to Generate" list
 *     CoverageModel.flows[].testFiles          →  per-flow repo assets
 *     CoverageModel.pageObjects / helpers      →  "Repository Assets Reused"
 *
 * WHY IT LIVES HERE (architecture): the frozen backend answers the three
 * questions every AI feature must — what did I analyze, what did I decide, why.
 * This adapter only *renders* those answers; it never re-derives a decision,
 * never matches, never calls an LLM. It reads the assets that are ALREADY
 * associated with the covered flows in the Coverage Model — it is NOT a new
 * reuse engine. Because it is presentation-only, extending it (new sections,
 * new copy) never touches a frozen module.
 */

import { GenerationDecision } from '../coverage-intelligence/types';
import type { CoverageModel, CoverageFlow } from '../context/types';
import type { RequirementIntelligence } from './types';
import type { ScriptGenerationPlan } from './script-generation-consumer';
import { ESTIMATED_TOKENS_PER_FLOW } from './script-generation-consumer';

/** One flow row on the plan, with the repository assets already associated with it. */
export interface GenerationPlanFlow {
  /** The behavior/flow label, e.g. "Login Success". */
  flow: string;
  /**
   * Repository assets that already implement this flow (test files that the
   * Coverage Model attributes to the flow). Empty for flows to be generated.
   */
  assets: string[];
}

/**
 * A "without vs with intelligence" side of the savings comparison card.
 * `estimatedTokens` is an ESTIMATE (ESTIMATED_TOKENS_PER_FLOW × scripts), never
 * a measured value — surfaced clearly as such in the UI.
 */
export interface GenerationPlanComparisonSide {
  scripts: number;
  estimatedTokens: number;
}

export interface GenerationPlanComparison {
  /** Naive path: regenerate every required flow. */
  withoutIntelligence: GenerationPlanComparisonSide;
  /** LevelUp path: generate only the missing flows. */
  withIntelligence: GenerationPlanComparisonSide;
  /** % fewer tokens the intelligent path spends (0-100). */
  reductionPercent: number;
}

/**
 * The complete, render-ready Generation Plan. Everything the customer screen
 * needs, already computed — the frontend does presentation only.
 */
export interface GenerationPlanView {
  /** SKIP · EXTEND · GENERATE — the (frozen) decision, echoed for the header badge. */
  decision: GenerationDecision;
  /** Repository coverage %, 0-100. */
  repositoryCoverage: number;
  /** Coverage-verdict confidence %, 0-100. */
  confidence: number;
  /** ESTIMATED tokens saved by not regenerating covered flows. */
  estimatedTokenSavings: number;
  /** ESTIMATED savings as a % of the naive (regenerate-all) cost, 0-100. */
  savingsPercent: number;
  /** Flows the repository ALREADY automates, each with its repo assets. */
  existingAutomation: GenerationPlanFlow[];
  /** Flows that WILL be generated (the missing slice). */
  toGenerate: GenerationPlanFlow[];
  /**
   * Distinct repository assets (page objects + helper methods) already used by
   * the covered flows — the "Repository Assets Reused" section. Reinforces that
   * LevelUp respects the existing repository. Empty when nothing is covered.
   */
  assetsReused: string[];
  /** The savings comparison card (without vs with intelligence). */
  comparison: GenerationPlanComparison;
  /**
   * WHY generation happens when it does — the policy's override reasons (from
   * the frozen `generatedBecause`). Kept machine-readable; the UI may show it as
   * a subtle footnote, NOT as the primary "Decision" prose.
   */
  generatedBecause: string[];
  /**
   * The customer-facing "Decision" prose. Answers "what is your plan?" — never
   * "why". Derived from the decision + flow counts, not from `generatedBecause`.
   */
  decisionNarrative: string;
  /** Whether a Coverage Model was available to analyze against. */
  hasCoverageModel: boolean;
}

/**
 * Build the render-ready Generation Plan from the frozen intelligence contract.
 *
 * @param plan       The frozen ScriptGenerationConsumer plan (decision + telemetry).
 * @param intelligence The composed RequirementIntelligence (coverage facts).
 * @param models     The repository Coverage Model(s) — used ONLY to look up the
 *                   assets already associated with covered flows. Pass [] when
 *                   none is available (URL-only generation): the plan still
 *                   renders, just without asset detail.
 * @param tokensPerFlow Estimate override (defaults to ESTIMATED_TOKENS_PER_FLOW).
 */
export function buildGenerationPlanView(
  plan: ScriptGenerationPlan,
  intelligence: RequirementIntelligence,
  models: CoverageModel[] = [],
  tokensPerFlow: number = ESTIMATED_TOKENS_PER_FLOW,
): GenerationPlanView {
  const { coverage } = intelligence;
  const { telemetry } = plan;

  // Locate the Coverage Model feature this requirement matched, so we can read
  // the assets (test files / page objects / helpers) already tied to its flows.
  const matchedModel =
    (coverage.matchedFeature
      ? models.find((m) => m.feature === coverage.matchedFeature)
      : undefined) ?? undefined;

  // flow-name → CoverageFlow, for per-flow test-file lookup.
  const flowByName = new Map<string, CoverageFlow>();
  if (matchedModel) {
    for (const f of matchedModel.flows) flowByName.set(normalize(f.name), f);
  }
  // behavior-label → matched flow name (from the coverage engine's own matches),
  // so a covered behavior maps to the repo flow that satisfied it.
  const matchedFlowByBehavior = new Map<string, string>();
  for (const m of coverage.matches) {
    if (m.matchedFlow) matchedFlowByBehavior.set(normalize(m.behavior), m.matchedFlow);
  }

  const assetsForFlow = (behaviorLabel: string): string[] => {
    const flowName =
      matchedFlowByBehavior.get(normalize(behaviorLabel)) ?? behaviorLabel;
    const cf = flowByName.get(normalize(flowName));
    return cf ? uniqueStrings(cf.testFiles) : [];
  };

  const existingAutomation: GenerationPlanFlow[] = coverage.coveredFlows.map((flow) => ({
    flow,
    assets: assetsForFlow(flow),
  }));

  const toGenerate: GenerationPlanFlow[] = coverage.missingFlows.map((flow) => ({
    flow,
    assets: [],
  }));

  // "Repository Assets Reused" — page objects + helper methods of the matched
  // feature. Only meaningful when something is actually covered.
  const assetsReused =
    matchedModel && coverage.coveredFlows.length > 0
      ? uniqueStrings([...matchedModel.pageObjects, ...matchedModel.helpers])
      : [];

  // Savings comparison. The naive path regenerates every required flow; the
  // intelligent path generates only the missing ones.
  const flowsTotal = telemetry.flowsTotal;
  const flowsGenerated = telemetry.flowsGenerated;
  const withoutTokens = flowsTotal * tokensPerFlow;
  const withTokens = flowsGenerated * tokensPerFlow;
  const reductionPercent =
    withoutTokens > 0
      ? Math.round(((withoutTokens - withTokens) / withoutTokens) * 100)
      : 0;

  const comparison: GenerationPlanComparison = {
    withoutIntelligence: { scripts: flowsTotal, estimatedTokens: withoutTokens },
    withIntelligence: { scripts: flowsGenerated, estimatedTokens: withTokens },
    reductionPercent,
  };

  const savingsPercent =
    withoutTokens > 0
      ? Math.round((telemetry.estimatedTokenSavings / withoutTokens) * 100)
      : 0;

  return {
    decision: plan.decision,
    repositoryCoverage: coverage.coverage,
    confidence: coverage.confidence,
    estimatedTokenSavings: telemetry.estimatedTokenSavings,
    savingsPercent,
    existingAutomation,
    toGenerate,
    assetsReused,
    comparison,
    generatedBecause: plan.generatedBecause,
    decisionNarrative: buildDecisionNarrative(
      plan.decision,
      coverage.coveredFlows.length,
      coverage.missingFlows.length,
      flowsTotal,
    ),
    hasCoverageModel: models.length > 0,
  };
}

/**
 * Customer-facing "Decision" prose. Deliberately answers "what is the plan?"
 * (not "why") — the WHY lives in `generatedBecause`. Kept plain and factual.
 */
function buildDecisionNarrative(
  decision: GenerationDecision,
  coveredCount: number,
  missingCount: number,
  total: number,
): string {
  switch (decision) {
    case GenerationDecision.SKIP:
      return (
        `Repository already contains automation for all ${total} required ` +
        `${plural(total, 'flow')}. No new automation needs to be generated.`
      );
    case GenerationDecision.EXTEND:
      return (
        `Repository already contains automation for ${coveredCount} of ${total} ` +
        `required ${plural(total, 'flow')}. Only the ${missingCount} missing ` +
        `${plural(missingCount, 'flow')} will be generated.`
      );
    case GenerationDecision.GENERATE:
    default:
      return (
        `No existing automation was found for this requirement. All ${total} ` +
        `${plural(total, 'flow')} will be generated.`
      );
  }
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}

function normalize(s: string): string {
  return String(s ?? '').trim().toLowerCase();
}

function uniqueStrings(arr: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of arr) {
    const v = String(s ?? '').trim();
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}
