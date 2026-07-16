/**
 * Unit tests for the QA-Architect scorer — the PURE grading layer.
 *
 * These use a hand-built fake benchmark + fake generated suite so the maths is
 * fully deterministic and independent of the planner or any live model. They
 * lock the contract: per-category %, overall %, weight-aware %, and the exact
 * missing list.
 */

import {
  scoreBenchmark,
  buildLeaderboard,
  BenchmarkScore,
} from '../../scripts/qa-architect-scorer';
import { GoldBenchmark } from '../../scripts/gold-benchmarks';

/** A tiny synthetic benchmark: 2 Functional, 2 Validation, 1 Security. */
const fakeBenchmark: GoldBenchmark = {
  id: 'fake',
  label: 'Fake Feature',
  expectedCategory: 'crud',
  requirement: {
    title: 'Fake',
    description: 'A fake requirement for testing the scorer.',
  } as any,
  expected: [
    { category: 'Functional', name: 'Happy path', match: ['create widget', 'successfully'], weight: 'critical' },
    { category: 'Functional', name: 'Minimum fields', match: ['minimum required'], weight: 'medium' },
    { category: 'Validation', name: 'Blank name', match: ['name blank', 'name required'], weight: 'high' },
    { category: 'Validation', name: 'Invalid format', match: ['invalid format'], weight: 'high' },
    { category: 'Security', name: 'Injection blocked', match: ['sql injection', 'injection blocked'], weight: 'critical' },
  ],
};

describe('scoreBenchmark (pure)', () => {
  it('scores a suite that fully covers Functional, half of Validation, and zero Security', () => {
    // Covers: Happy path, Minimum fields, Blank name.  Misses: Invalid format, Injection.
    const suite = [
      'Create widget successfully with valid data',
      'Create widget with minimum required fields only',
      'Submit with name blank shows required error',
    ];

    const score = scoreBenchmark(fakeBenchmark, suite);

    const byCat = Object.fromEntries(score.byCategory.map((c) => [c.category, c]));
    expect(byCat['Functional'].percent).toBe(100); // 2/2
    expect(byCat['Validation'].percent).toBe(50); //  1/2
    expect(byCat['Security'].percent).toBe(0); //    0/1

    // Overall: 3 of 5 covered = 60%.
    expect(score.coveredCount).toBe(3);
    expect(score.totalCount).toBe(5);
    expect(score.overallPercent).toBe(60);

    // Weighted: have = crit(3)+med(1)+high(2)=6 ; all = 3+1+2+2+3 = 11 → 55%.
    expect(score.weightedPercent).toBe(55);

    // Missing = Invalid format (high) + Injection (critical), critical first.
    expect(score.missing.map((m) => m.name)).toEqual(['Injection blocked', 'Invalid format']);
    expect(score.missing[0].weight).toBe('critical');
  });

  it('gives 100% overall and weighted when everything is covered', () => {
    const suite = [
      'create widget successfully',
      'minimum required fields',
      'name required when blank',
      'invalid format rejected',
      'sql injection blocked',
    ];
    const score = scoreBenchmark(fakeBenchmark, suite);
    expect(score.overallPercent).toBe(100);
    expect(score.weightedPercent).toBe(100);
    expect(score.missing).toHaveLength(0);
  });

  it('gives 0% when nothing matches', () => {
    const score = scoreBenchmark(fakeBenchmark, ['totally unrelated text about weather']);
    expect(score.overallPercent).toBe(0);
    expect(score.weightedPercent).toBe(0);
    expect(score.missing).toHaveLength(5);
    // categories still reported with 0%
    expect(score.byCategory.every((c) => c.percent === 0)).toBe(true);
  });

  it('only reports categories the benchmark actually defines, in canonical order', () => {
    const score = scoreBenchmark(fakeBenchmark, []);
    expect(score.byCategory.map((c) => c.category)).toEqual(['Functional', 'Validation', 'Security']);
  });
});

describe('buildLeaderboard', () => {
  it('sorts by overall desc and averages overall + weighted', () => {
    const rows: BenchmarkScore[] = [
      { id: 'a', label: 'A', byCategory: [], coveredCount: 4, totalCount: 10, overallPercent: 40, weightedPercent: 50, missing: [] },
      { id: 'b', label: 'B', byCategory: [], coveredCount: 8, totalCount: 10, overallPercent: 80, weightedPercent: 90, missing: [] },
    ];
    const board = buildLeaderboard(rows);
    expect(board.rows.map((r) => r.id)).toEqual(['b', 'a']); // sorted desc
    expect(board.averageOverall).toBe(60); // (40+80)/2
    expect(board.averageWeighted).toBe(70); // (50+90)/2
  });
});
