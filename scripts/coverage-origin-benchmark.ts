/**
 * ============================================================================
 * COVERAGE-ORIGIN BENCHMARK  —  "where is the 11/1/0 born?"
 * ============================================================================
 *
 * Prasanth's question, settled with evidence instead of assumption:
 *
 *   The customer saw  11 Positive / 1 Negative / 0 Edge.
 *   That can happen for TWO completely different reasons:
 *     Case 1 — the planner produced a balanced suite and the LLM/resolveType()
 *              collapsed it  → the Sprint-1 fix addresses it.
 *     Case 2 — the planner ITSELF produced 11/1/0  → the fix changes nothing
 *              and the root cause is upstream, in the planner.
 *
 * This harness runs the REAL production `planScenarios()` for the exact
 * "Add Employee" requirement and prints the coverage distribution at the
 * checkpoints we can execute deterministically here (no API key / DB in this
 * environment). It does NOT re-implement anything — it calls shipping code.
 *
 * Honesty contract (printed in the output too):
 *   • PLANNER  — executed live. This is the decisive number.
 *   • LLM      — NOT executed (no OPENAI key here). The live prompt instructs
 *                the model to return every planned scenarioId and to neither add
 *                nor drop scenarios, so the planner distribution is the ceiling.
 *   • FINAL    — with the Sprint-1 fix, resolveType() maps each case back to its
 *                planner scenarioId (never a silent Positive), so FINAL mirrors
 *                PLANNER. We show the planner distribution as the FINAL proxy and
 *                label it as such — the live-LLM confirmation is a separate step
 *                that needs the running app.
 * ============================================================================
 */

import { getBenchmark } from './gold-benchmarks';
import { planScenarios } from '../src/engines/scenario-planner';
import { coverageFamily } from '../src/engines/generation-quality-engine';
import type { CoverageType } from '../src/engines/test-coverage-engine';

type FamilyCounts = { positive: number; negative: number; edge: number; advanced: number };

function tally(types: string[]): FamilyCounts {
  const c: FamilyCounts = { positive: 0, negative: 0, edge: 0, advanced: 0 };
  for (const t of types) c[coverageFamily(t)]++;
  return c;
}

function block(title: string, c: FamilyCounts, total: number): string {
  return [
    title,
    `  Positive : ${c.positive}`,
    `  Negative : ${c.negative}`,
    `  Edge     : ${c.edge}`,
    c.advanced > 0 ? `  (Advanced/other: ${c.advanced})` : undefined,
    `  ── total : ${total}`,
  ].filter(Boolean).join('\n');
}

function run(label: string, coverageTypes: CoverageType[], deep: boolean) {
  const bench = getBenchmark('employee')!;
  const plan = planScenarios(bench.requirement, coverageTypes, undefined, undefined, deep);
  const types = plan.scenarios.map(s => s.coverageType);
  const counts = tally(types);

  console.log('\n' + '='.repeat(72));
  console.log(`SCENARIO: Add Employee   |   selected: [${coverageTypes.join(', ')}]   |   mode: ${deep ? 'DEEP' : 'STANDARD'}`);
  console.log('='.repeat(72));
  console.log(block('PLANNER  (live — planScenarios())', counts, plan.scenarios.length));
  console.log('\n' + block('LLM      (NOT run here — see note; ceiling = planner)', counts, plan.scenarios.length));
  console.log('\n' + block('FINAL    (resolveType proxy — maps to planner scenarioId)', counts, plan.scenarios.length));

  // Per-type breakdown so the mix is fully transparent (no hidden bucketing).
  const byType = new Map<string, number>();
  for (const t of types) byType.set(t, (byType.get(t) || 0) + 1);
  console.log('\n  Planner per-type breakdown:');
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${t.padEnd(18)} ${n}  → family: ${coverageFamily(t)}`);
  }

  // The verdict for THIS run.
  const balanced = counts.negative > 0 && counts.edge > 0;
  console.log('\n  VERDICT:');
  if (!balanced) {
    console.log('    ⚠ Planner itself is skewed (negative or edge = 0). The 11/1/0 shape');
    console.log('      would originate UPSTREAM, in the planner — resolveType() is not the');
    console.log('      root cause for this requirement. Investigate the planner (Case 2).');
  } else {
    console.log('    ✓ Planner produces a balanced suite (negative AND edge > 0). If the live');
    console.log('      output still collapses to 11/1/0, the loss is AFTER the planner');
    console.log('      (LLM / resolveType) — which the Sprint-1 fix addresses (Case 1).');
  }
  return counts;
}

(function main() {
  console.log('\nCOVERAGE-ORIGIN BENCHMARK — Add Employee');
  console.log('Purpose: locate where the coverage distribution is decided, with evidence.');

  // The customer-facing scenario: all three core families selected.
  run('all-core', ['positive', 'negative', 'edge_cases'] as CoverageType[], false);
  // Deep mode — the broader requirement-aware set, for completeness.
  run('all-core-deep', ['positive', 'negative', 'edge_cases'] as CoverageType[], true);
  // Positive-only — sanity check that selection is actually honoured.
  run('positive-only', ['positive'] as CoverageType[], false);

  console.log('\n' + '='.repeat(72));
  console.log('NOTE ON CHECKPOINT 2 (LLM): this environment has no OPENAI key or DB, so the');
  console.log('live model round-trip is not executed here. The planner numbers above are the');
  console.log('deterministic, reproducible ceiling. Confirming the LLM stage end-to-end needs');
  console.log('the running app with GEN_QUALITY_ENGINE=true; the new trace logs');
  console.log('("Coverage classification trace" + "Coverage Loss metric") will print the exact');
  console.log('planner→LLM→final numbers in that environment.');
  console.log('='.repeat(72) + '\n');
})();
