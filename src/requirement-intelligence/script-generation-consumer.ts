/**
 * Script Generation Consumer.
 *
 * The thin adapter that sits BETWEEN Requirement Intelligence and the existing
 * Script Generation engine. It answers one question — "given this requirement's
 * intelligence, WHAT should generation do?" — and produces a deterministic,
 * side-effect-free plan:
 *
 *     RequirementIntelligence
 *            │
 *            ▼
 *     ScriptGenerationConsumer.plan()
 *            │
 *            ├── SKIP     → do not call the engine at all
 *            ├── EXTEND   → call the engine with ONLY the missing test cases
 *            └── GENERATE → call the engine with everything (today's behavior)
 *
 * Crucially it does NOT generate anything and does NOT touch ScriptGenEngine.
 * The engine (a large, mature component) stays exactly as-is; the caller reads
 * this plan and decides whether/how to invoke the engine. The consumer never
 * re-derives the decision from coverage — it EXECUTES `intelligence.generation`
 * (the decision the Generation Policy already made). It never asks "why".
 *
 * It also emits per-request telemetry (the decision, flows skipped/generated,
 * estimated token savings) so the intelligence pipeline can be measured on real
 * traffic — the whole point of the shadow rollout mode.
 *
 * Deterministic — no LLM, no DB, no I/O.
 */

import { GenerationDecision } from '../coverage-intelligence/types';
import type { RequirementIntelligence, DecisionReason } from './types';

/**
 * A rough, HONEST estimate of the tokens one generated spec would cost. Used
 * only to quantify would-be savings for skipped/extended generations — it is an
 * ESTIMATE, never a measured value, and is clearly labelled as such wherever it
 * surfaces. Tunable via the constructor.
 */
export const ESTIMATED_TOKENS_PER_FLOW = 1500;

/**
 * Structured telemetry for ONE generation decision. Logged by the route (and,
 * later, aggregated into pipeline KPIs: skip rate, extend rate, token savings).
 * `llmCalled` and `durationMs` are runtime facts the ROUTE fills in after it
 * acts on the plan — the consumer cannot know them.
 */
export interface GenerationDecisionTelemetry {
  requirementId: string;
  /** Repository coverage verdict (COVERED / PARTIAL / MISSING) — distinct from automation progress. */
  coverageStatus: RequirementIntelligence['coverage']['status'];
  /** Repository coverage %, 0-100. */
  repositoryCoverage: number;
  /** The decision being executed (skip / extend / generate). */
  generationDecision: GenerationDecision;
  /**
   * Confidence in the coverage verdict, 0-100 (mirror of `reason.confidence`,
   * surfaced at the top level so every consumer reads it at one stable path —
   * it is the signal that gated the SKIP decision).
   */
  confidence: number;
  /** Total expected behaviors on the requirement. */
  flowsTotal: number;
  /** Behaviors already covered by the repo (i.e. NOT generated). */
  flowsSkipped: number;
  /** Behaviors that WILL be generated. */
  flowsGenerated: number;
  /** ESTIMATED tokens saved by not regenerating covered flows (see ESTIMATED_TOKENS_PER_FLOW). */
  estimatedTokenSavings: number;
  /**
   * The structured, human-facing explanation of this decision — the SHARED
   * DecisionReason object (covered vs missing flows + confidence). This is the
   * frozen explainability contract every surface renders.
   */
  reason: DecisionReason;
  /**
   * WHY generation happened when it did — the policy's override reasons (e.g.
   * `['Low confidence']` when a weak COVERED was downgraded to EXTEND). Empty
   * when the decision followed coverage status directly. An array so future
   * override rules append without changing this frozen contract.
   */
  generatedBecause: string[];
}

/**
 * The deterministic plan the route acts on. It says WHETHER to call the engine
 * and, for EXTEND, WHICH test cases to pass — nothing about HOW to generate.
 */
export interface ScriptGenerationPlan {
  /** The decision executed (mirrors intelligence.generation). */
  decision: GenerationDecision;
  /** False only for SKIP — the engine must not be called. */
  shouldGenerate: boolean;
  /**
   * Which of the requirement's test cases to generate:
   *   • null  → generate ALL (GENERATE path — today's behavior)
   *   • []    → generate NONE (SKIP path)
   *   • [ids] → generate exactly this subset (EXTEND path — the missing slices)
   */
  testCaseIdsToGenerate: string[] | null;
  /** Per-decision telemetry (route fills in runtime fields separately). */
  telemetry: GenerationDecisionTelemetry;
  /**
   * The structured, human-facing explanation — the SHARED DecisionReason object.
   * Surfaced directly on the plan (not just inside telemetry) so a caller can
   * render the customer "Generate Script" panel without reaching into telemetry.
   */
  reason: DecisionReason;
  /** WHY generation happened (policy override reasons); mirrors telemetry.generatedBecause. */
  generatedBecause: string[];
  /** Human-readable one-liner for logs / a future UI panel. */
  summary: string;
  /**
   * Non-fatal warnings. Notably: an EXTEND whose missing slices carry NO test
   * case ids (caller supplied plain `expectedFlows`, not bound `behaviors`) —
   * we cannot slice safely, so we fall back to generating ALL and say so here
   * rather than silently generating the wrong (empty) subset.
   */
  warnings: string[];
}

export class ScriptGenerationConsumer {
  constructor(private readonly tokensPerFlow: number = ESTIMATED_TOKENS_PER_FLOW) {}

  plan(intelligence: RequirementIntelligence): ScriptGenerationPlan {
    const { coverage, generation } = intelligence;
    const flowsTotal = coverage.coveredSlices.length + coverage.missingSlices.length;
    const flowsCovered = coverage.coveredSlices.length;
    const warnings: string[] = [];

    // The SHARED explanation object — built ONCE from coverage facts and the
    // policy's override reasons, then threaded through every path so telemetry,
    // logs, and any future UI all render the identical explanation.
    const reason: DecisionReason = {
      coveredFlows: coverage.coveredFlows,
      missingFlows: coverage.missingFlows,
      confidence: coverage.confidence,
    };
    // The consumer FORWARDS the policy's reasons; it never re-derives "why".
    const generatedBecause = intelligence.generationReasons ?? [];

    const baseTelemetry = {
      requirementId: coverage.requirementId,
      coverageStatus: coverage.status,
      repositoryCoverage: coverage.coverage,
      generationDecision: generation,
      confidence: coverage.confidence,
      flowsTotal,
      reason,
      generatedBecause,
    };

    switch (generation) {
      case GenerationDecision.SKIP: {
        // Fully covered — generate nothing. Every flow is a would-be saving.
        return {
          decision: generation,
          shouldGenerate: false,
          testCaseIdsToGenerate: [],
          telemetry: {
            ...baseTelemetry,
            flowsSkipped: flowsTotal,
            flowsGenerated: 0,
            estimatedTokenSavings: flowsTotal * this.tokensPerFlow,
          },
          reason,
          generatedBecause,
          summary: `SKIP — requirement already covered (${coverage.coverage}% repository coverage, ${flowsTotal} flow(s)); no generation required.`,
          warnings,
        };
      }

      case GenerationDecision.EXTEND: {
        // Generate ONLY the missing flows' test cases, sliced by id (no title
        // matching). If the caller bound no ids, fall back to generating all and
        // flag it — never silently ship an empty/incorrect subset.
        const ids = uniqueIds(coverage.missingSlices.flatMap(s => s.testCaseIds));
        const flowsGenerated = coverage.missingSlices.length;
        if (ids.length === 0) {
          warnings.push(
            'EXTEND requested but the missing flows carry no test case ids ' +
              '(requirement supplied plain expectedFlows, not bound behaviors) — ' +
              'cannot slice safely; falling back to generating all test cases.',
          );
          return {
            decision: generation,
            shouldGenerate: true,
            testCaseIdsToGenerate: null, // generate all — safe fallback
            telemetry: {
              ...baseTelemetry,
              flowsSkipped: flowsCovered,
              flowsGenerated,
              // No safe slice → we regenerate everything → no saving claimed.
              estimatedTokenSavings: 0,
            },
            reason,
            generatedBecause,
            summary: `EXTEND — ${flowsGenerated} missing flow(s) but unbound; generating all (see warnings).`,
            warnings,
          };
        }
        return {
          decision: generation,
          shouldGenerate: true,
          testCaseIdsToGenerate: ids,
          telemetry: {
            ...baseTelemetry,
            flowsSkipped: flowsCovered,
            flowsGenerated,
            estimatedTokenSavings: flowsCovered * this.tokensPerFlow,
          },
          reason,
          generatedBecause,
          summary: `EXTEND — generate ${flowsGenerated} missing flow(s) (${ids.length} test case(s)); ${flowsCovered} already covered.`,
          warnings,
        };
      }

      case GenerationDecision.GENERATE:
      default: {
        // No coverage — generate everything, exactly as today.
        return {
          decision: GenerationDecision.GENERATE,
          shouldGenerate: true,
          testCaseIdsToGenerate: null,
          telemetry: {
            ...baseTelemetry,
            flowsSkipped: 0,
            flowsGenerated: flowsTotal,
            estimatedTokenSavings: 0,
          },
          reason,
          generatedBecause,
          summary: `GENERATE — no existing coverage; generate all ${flowsTotal} flow(s).`,
          warnings,
        };
      }
    }
  }
}

/** Stable de-dupe preserving first-seen order. */
function uniqueIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
