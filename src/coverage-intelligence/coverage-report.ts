/**
 * Coverage Intelligence · Sprint CI-2 — Coverage Report
 * ============================================================================
 *
 * THE JOB (and ONLY this job for CI-2):
 *   Aggregate per-scenario coverage decisions into a single summary report.
 *
 * Input: N × ScenarioCoverage (from CI-1).
 * Output:
 *
 *     12 Planned
 *      8 Existing
 *      2 Extend
 *      2 Generate
 *
 * This is NOT:
 *   • a coverage score (82%)
 *   • a coverage health metric
 *   • a reuse %
 *
 * It is a simple count so Script Generation (CI-3) can see the breakdown before
 * deciding what to generate. No reports, no UI yet — that's CI-4.
 */

import type { ScenarioCoverage } from './existing-test-discovery';
import { GenerationDecision, GENERATION_DECISION_LABEL } from './types';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/**
 * The aggregate coverage report — CI-2 deliverable.
 * A simple count of planned scenarios and their coverage decisions.
 */
export interface CoverageReport {
  /** Total number of planned scenarios analyzed. */
  planned: number;
  /** Count by decision — how many scenarios fall into each bucket. */
  breakdown: {
    [GenerationDecision.REUSE]: number;
    [GenerationDecision.EXTEND]: number;
    [GenerationDecision.GENERATE]: number;
  };
}

/* ------------------------------------------------------------------ */
/*  Aggregator                                                         */
/* ------------------------------------------------------------------ */

/**
 * AGGREGATE the per-scenario coverage decisions into a single report.
 * This is the CI-2 entry point.
 */
export function aggregateCoverageReport(
  scenarioCoverage: ScenarioCoverage[],
): CoverageReport {
  const breakdown = {
    [GenerationDecision.REUSE]: 0,
    [GenerationDecision.EXTEND]: 0,
    [GenerationDecision.GENERATE]: 0,
  };

  for (const sc of scenarioCoverage) {
    breakdown[sc.recommendation] += 1;
  }

  return {
    planned: scenarioCoverage.length,
    breakdown,
  };
}

/* ------------------------------------------------------------------ */
/*  Formatter (log / debug — no UI, per direction)                     */
/* ------------------------------------------------------------------ */

/**
 * Render the aggregate report as a simple text block (for logs/CLI).
 *
 * Output format:
 *
 *     Coverage Report
 *       12 Planned
 *        8 Existing
 *        2 Extend
 *        2 Generate
 */
export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = ['Coverage Report'];
  const pad = (n: number) => n.toString().padStart(3);

  lines.push(`  ${pad(report.planned)} Planned`);
  lines.push(`  ${pad(report.breakdown[GenerationDecision.REUSE])} ${GENERATION_DECISION_LABEL[GenerationDecision.REUSE]}`);
  lines.push(`  ${pad(report.breakdown[GenerationDecision.EXTEND])} ${GENERATION_DECISION_LABEL[GenerationDecision.EXTEND]}`);
  lines.push(`  ${pad(report.breakdown[GenerationDecision.GENERATE])} ${GENERATION_DECISION_LABEL[GenerationDecision.GENERATE]}`);

  return lines.join('\n');
}
