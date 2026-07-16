/**
 * Coverage Intelligence · Sprint CI-3 — Generation Planning
 * ============================================================================
 *
 * THE JOB (and ONLY this job for CI-3):
 *   Route planned scenarios into the three buckets (skip, extend, generate)
 *   and produce the **Generation Plan** — the stable contract between Generation
 *   Intelligence and Script Generation.
 *
 * Input: Planned scenarios + Repository Profile
 * Output:
 *
 *     {
 *       "skip": [...],        // Existing tests fully cover these — nothing to do
 *       "extend": [...],      // Partial matches — extend existing tests
 *       "generate": [...],    // No matches — new coverage
 *       "generationQueue": [extend + generate]  // The work Script Gen must do
 *     }
 *
 * ARCHITECTURAL MILESTONE:
 *   After CI-3, Script Generation NEVER asks "Should I generate this?"
 *   Generation Intelligence owns that decision. Script Generation ONLY generates
 *   the work items in generationQueue. This is the routing layer that separates
 *   "what to generate" from "how to generate."
 *
 * This is NOT:
 *   • Script Generation integration (that's a future step)
 *   • Flow Discovery
 *   • Repository recommendations UI (that's CI-4, which we are NOT building)
 *
 * No LLM, no new intelligence — this is pure routing on top of CI-1.
 */

import {
  discoverExistingTests,
  type ScenarioLike,
  type ScenarioCoverage,
  type DiscoveryOptions,
} from './existing-test-discovery';
import { GenerationDecision } from './types';
import type { RepositoryProfile } from '../context/types';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * A scenario + its coverage decision — the item in each bucket of the plan.
 * Script Generation reads these to know what to do with each scenario.
 */
export interface GenerationPlanItem {
  /** The original planned scenario. */
  scenario: ScenarioLike;
  /** The coverage decision (from CI-1). */
  coverage: ScenarioCoverage;
}

/**
 * The Generation Plan — the CI-3 deliverable. The stable contract between
 * Coverage Intelligence and Script Generation.
 */
export interface GenerationPlan {
  /** Existing tests fully cover these scenarios → nothing to generate, skip. */
  skip: GenerationPlanItem[];
  /** Partial matches → extend the existing tests rather than duplicate. */
  extend: GenerationPlanItem[];
  /** No matching tests → this is new coverage, generate it. */
  generate: GenerationPlanItem[];
  /**
   * The work Script Generation must do = extend + generate.
   * Script Generation ONLY touches this queue. It never decides to skip on its own.
   */
  generationQueue: GenerationPlanItem[];
}

/* ------------------------------------------------------------------ */
/*  The routing engine                                                 */
/* ------------------------------------------------------------------ */

/**
 * BUILD THE GENERATION PLAN — the CI-3 entry point.
 *
 * Routes planned scenarios into the three buckets based on their coverage
 * decisions (from CI-1), and assembles the generationQueue (extend + generate).
 *
 * This is deterministic routing — no LLM, no new intelligence. It calls CI-1
 * (Existing Test Discovery), partitions by recommendation, and returns the plan.
 */
export function buildGenerationPlan(
  scenarios: ScenarioLike[],
  profile: RepositoryProfile | null | undefined,
  options?: DiscoveryOptions,
): GenerationPlan {
  // CI-1: discover coverage for every scenario
  const coverageResults = discoverExistingTests(scenarios, profile, options);

  // Build the index so we can look up coverage by scenario ID
  const coverageByScenarioId = new Map<string, ScenarioCoverage>();
  for (const cov of coverageResults) {
    coverageByScenarioId.set(cov.scenarioId, cov);
  }

  // Partition by recommendation
  const skip: GenerationPlanItem[] = [];
  const extend: GenerationPlanItem[] = [];
  const generate: GenerationPlanItem[] = [];

  for (const scenario of scenarios) {
    const coverage = coverageByScenarioId.get(scenario.id);
    if (!coverage) {
      // Should never happen if CI-1 works correctly, but defensive: treat as missing
      const fallback: ScenarioCoverage = {
        scenarioId: scenario.id,
        scenario: scenario.title,
        status: 'missing',
        confidence: 0,
        existingTest: null,
        recommendation: GenerationDecision.GENERATE,
        matchedOn: [],
        reason: 'No coverage decision available (internal error).',
        alternatives: [],
      };
      generate.push({ scenario, coverage: fallback });
      continue;
    }

    const item: GenerationPlanItem = { scenario, coverage };

    switch (coverage.recommendation) {
      case GenerationDecision.SKIP:
        skip.push(item);
        break;
      case GenerationDecision.EXTEND:
        extend.push(item);
        break;
      case GenerationDecision.GENERATE:
        generate.push(item);
        break;
    }
  }

  // The generation queue is extend + generate (the work Script Gen must do)
  const generationQueue = [...extend, ...generate];

  return { skip, extend, generate, generationQueue };
}

/* ------------------------------------------------------------------ */
/*  Formatter (log / debug — no UI, per direction)                     */
/* ------------------------------------------------------------------ */

/**
 * Render the Generation Plan as a simple text block (for logs/CLI).
 *
 * Output format:
 *
 *     Generation Plan
 *       12 Planned
 *        8 Skip
 *        2 Extend
 *        2 Generate
 *       ---
 *        4 In Generation Queue (Extend + Generate)
 */
export function formatGenerationPlan(plan: GenerationPlan): string {
  const lines: string[] = ['Generation Plan'];
  const pad = (n: number) => n.toString().padStart(3);

  const planned = plan.skip.length + plan.extend.length + plan.generate.length;
  lines.push(`  ${pad(planned)} Planned`);
  lines.push(`  ${pad(plan.skip.length)} Skip`);
  lines.push(`  ${pad(plan.extend.length)} Extend`);
  lines.push(`  ${pad(plan.generate.length)} Generate`);
  lines.push(`  ---`);
  lines.push(`  ${pad(plan.generationQueue.length)} In Generation Queue (Extend + Generate)`);

  return lines.join('\n');
}
