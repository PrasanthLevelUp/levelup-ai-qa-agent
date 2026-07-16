/**
 * ============================================================================
 * QA-ARCHITECT SCORER — the "measurable QA quality" engine
 * ============================================================================
 *
 * Grades a set of generated test cases against the SEALED Senior-QA gold
 * benchmark (gold-benchmarks.ts) and produces the KPI that Test Case Lab
 * Excellence is built on:
 *
 *     "Your requirement achieved 91% QA coverage against our Senior QA
 *      Architect Benchmark — Boundary 100%, Validation 80%, Security 50%."
 *
 * TWO layers:
 *   1. `scoreBenchmark()` — a PURE function. Given a benchmark and the text of
 *      a generated suite, it returns per-category coverage %, an overall %, a
 *      weight-aware %, and the exact list of MISSING expectations. This is the
 *      unit-tested heart; it has no I/O and does not care where the cases came
 *      from (live LLM, planner, a paste-in). Wire real generated cases here.
 *   2. `buildLeaderboard()` — aggregates per-requirement scores + an average,
 *      the number that goes up as the generator improves, one KPI per release.
 *
 * ----------------------------------------------------------------------------
 * HONESTY (non-negotiable):
 *   This environment has NO live LLM and NO DB, so it CANNOT produce the real
 *   generated suite. The CLI below therefore scores the DETERMINISTIC PLANNER
 *   OUTPUT (planScenarios, all families + deep) as the "PLANNER CEILING" — the
 *   best coverage the model is permitted to reach, since the prompt forbids it
 *   from adding or dropping scenarios. It is a CEILING, not the live score:
 *   the live suite will score at or below these numbers. Run the very same
 *   `scoreBenchmark()` on real generated cases in the running app for the true
 *   leaderboard.
 * ============================================================================
 */

import {
  GOLD_BENCHMARKS,
  GoldBenchmark,
  GoldValidation,
  QA_CATEGORIES,
  QACategory,
  Weight,
} from './gold-benchmarks';
import { isCovered } from './coverage-match';
import { planScenarios } from '../src/engines/scenario-planner';
import type { CoverageType } from '../src/engines/test-coverage-engine';

/* -------------------------------------------------------------------------- */
/* Scoring model                                                              */
/* -------------------------------------------------------------------------- */

/** Weight → numeric cost of missing. Critical misses hurt the score most. */
const WEIGHT_VALUE: Record<Weight, number> = { critical: 3, high: 2, medium: 1 };

export interface CategoryScore {
  category: QACategory;
  covered: number;
  total: number;
  /** covered / total, 0..100, rounded. NaN-safe: categories with 0 expectations are omitted. */
  percent: number;
}

export interface MissingExpectation {
  category: QACategory;
  name: string;
  weight: Weight;
}

export interface BenchmarkScore {
  id: string;
  label: string;
  /** Only categories the benchmark actually defines expectations for. */
  byCategory: CategoryScore[];
  coveredCount: number;
  totalCount: number;
  /** Plain coverage: coveredCount / totalCount, 0..100. */
  overallPercent: number;
  /** Weight-aware coverage: Σ(weight of covered) / Σ(weight of all), 0..100. */
  weightedPercent: number;
  /** Every expectation the suite failed to cover, worst-weighted first. */
  missing: MissingExpectation[];
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 100);
}

/**
 * PURE scorer. `generatedHaystacks` is the lowercased searchable text of each
 * generated test case (title + objective + steps). An expectation is covered
 * when ANY generated case satisfies it (see coverage-match.ts).
 */
export function scoreBenchmark(
  benchmark: GoldBenchmark,
  generatedHaystacks: string[],
): BenchmarkScore {
  const hays = generatedHaystacks.map((h) => h.toLowerCase());
  const isExpectationCovered = (v: GoldValidation): boolean =>
    hays.some((h) => isCovered(v, h));

  // Per-category tallies (only categories this benchmark defines).
  const catTally = new Map<QACategory, { covered: number; total: number }>();
  const missing: MissingExpectation[] = [];
  let weightHave = 0;
  let weightAll = 0;

  for (const v of benchmark.expected) {
    const covered = isExpectationCovered(v);
    const t = catTally.get(v.category) ?? { covered: 0, total: 0 };
    t.total += 1;
    if (covered) t.covered += 1;
    catTally.set(v.category, t);

    weightAll += WEIGHT_VALUE[v.weight];
    if (covered) weightHave += WEIGHT_VALUE[v.weight];
    else missing.push({ category: v.category, name: v.name, weight: v.weight });
  }

  // Emit categories in the canonical taxonomy order (stable leaderboard axis).
  const byCategory: CategoryScore[] = QA_CATEGORIES.filter((c) => catTally.has(c)).map((c) => {
    const t = catTally.get(c)!;
    return { category: c, covered: t.covered, total: t.total, percent: pct(t.covered, t.total) };
  });

  const coveredCount = byCategory.reduce((s, c) => s + c.covered, 0);
  const totalCount = benchmark.expected.length;

  missing.sort((a, b) => WEIGHT_VALUE[b.weight] - WEIGHT_VALUE[a.weight]);

  return {
    id: benchmark.id,
    label: benchmark.label,
    byCategory,
    coveredCount,
    totalCount,
    overallPercent: pct(coveredCount, totalCount),
    weightedPercent: pct(weightHave, weightAll),
    missing,
  };
}

/* -------------------------------------------------------------------------- */
/* Leaderboard                                                                */
/* -------------------------------------------------------------------------- */

export interface Leaderboard {
  rows: BenchmarkScore[];
  /** Simple mean of overallPercent across requirements. */
  averageOverall: number;
  /** Simple mean of weightedPercent across requirements. */
  averageWeighted: number;
}

export function buildLeaderboard(scores: BenchmarkScore[]): Leaderboard {
  const n = scores.length || 1;
  return {
    rows: [...scores].sort((a, b) => b.overallPercent - a.overallPercent),
    averageOverall: Math.round(scores.reduce((s, r) => s + r.overallPercent, 0) / n),
    averageWeighted: Math.round(scores.reduce((s, r) => s + r.weightedPercent, 0) / n),
  };
}

/* -------------------------------------------------------------------------- */
/* Haystack helpers (kept identical to the audit harness)                     */
/* -------------------------------------------------------------------------- */

/** Lowercased searchable text of a scenario: title + objective + risk area. */
function scenarioHaystack(s: { title: string; objective?: string; riskArea?: string }): string {
  return `${s.title} ${s.objective ?? ''} ${s.riskArea ?? ''}`.toLowerCase();
}

/** All coverage families + deep — the maximum the planner will ever emit. */
const ALL_FAMILIES: CoverageType[] = [
  'positive',
  'negative',
  'edge_cases',
  'boundary',
  'security',
  'integration',
  'role_based',
];

/**
 * PLANNER-CEILING suite for a benchmark: run the deterministic planner with
 * every family + deep and return each scenario as a haystack. This is NOT the
 * live LLM output — it is the ceiling the LLM is forbidden to exceed.
 */
export function plannerCeilingHaystacks(benchmark: GoldBenchmark): string[] {
  const plan = planScenarios(benchmark.requirement as any, ALL_FAMILIES, undefined, undefined, true);
  return plan.scenarios.map(scenarioHaystack);
}

/* -------------------------------------------------------------------------- */
/* CLI                                                                         */
/* -------------------------------------------------------------------------- */

const BAR_WIDTH = 20;
function bar(percent: number): string {
  const filled = Math.round((percent / 100) * BAR_WIDTH);
  return '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
}

function printBenchmark(score: BenchmarkScore): void {
  console.log(`\n━━━ ${score.label}  (${score.id}) ━━━`);
  console.log(
    `  Overall: ${score.overallPercent}%   Weighted: ${score.weightedPercent}%   ` +
      `(${score.coveredCount}/${score.totalCount} expectations)`,
  );
  for (const c of score.byCategory) {
    const label = c.category.padEnd(15);
    console.log(`    ${label} ${bar(c.percent)} ${String(c.percent).padStart(3)}%  (${c.covered}/${c.total})`);
  }
  if (score.missing.length) {
    const worst = score.missing.filter((m) => m.weight === 'critical');
    if (worst.length) {
      console.log(`  Critical gaps: ${worst.map((m) => `${m.category}/${m.name}`).join('; ')}`);
    }
  }
}

function main(): void {
  console.log('============================================================');
  console.log(' QA-ARCHITECT SCORER  —  PLANNER-CEILING baseline');
  console.log('============================================================');
  console.log(' NOTE: No live LLM/DB in this environment. These numbers are');
  console.log(' the DETERMINISTIC PLANNER CEILING (all families + deep) — the');
  console.log(' best the generator is permitted to reach, NOT the live score.');
  console.log(' Run scoreBenchmark() on real generated cases for the true KPI.');

  const scores = GOLD_BENCHMARKS.map((b) => scoreBenchmark(b, plannerCeilingHaystacks(b)));
  scores.forEach(printBenchmark);

  const board = buildLeaderboard(scores);
  console.log('\n============================================================');
  console.log(' LEADERBOARD  (planner ceiling — sorted by overall coverage)');
  console.log('============================================================');
  for (const r of board.rows) {
    console.log(
      `  ${r.label.padEnd(18)} ${bar(r.overallPercent)} ${String(r.overallPercent).padStart(3)}%  ` +
        `(weighted ${r.weightedPercent}%)`,
    );
  }
  console.log('  ' + '-'.repeat(52));
  console.log(
    `  ${'AVERAGE'.padEnd(18)} ${bar(board.averageOverall)} ${String(board.averageOverall).padStart(3)}%  ` +
      `(weighted ${board.averageWeighted}%)`,
  );
  console.log('\n(Planner ceiling. Live-output scores will be at or below these.)');
}

if (require.main === module) {
  main();
}
