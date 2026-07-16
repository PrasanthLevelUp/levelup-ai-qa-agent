/**
 * Sprint 6.x — Generation Quality Engine.
 *
 * The Generation Quality Engine is a DETERMINISTIC, ZERO-LLM auditor that grades
 * a generated suite AFTER the fact. These tests pin the behaviour that motivated
 * the sprint using the exact failing suite the founder reported: the "Add New
 * Employee" requirement came back 11 Positive / 1 Negative / 0 Edge with
 * near-duplicate positives, and the engine must call that HIGH risk.
 *
 * Pure — NO LLM, NO DB, NO UI. Every assertion is on plain data in / data out.
 */

import {
  coverageFamily,
  CORE_FAMILIES,
  QUALITY_THRESHOLDS,
  analyzeCoverageMix,
  detectDuplicates,
  expectedFamiliesFor,
  detectMissingCategories,
  computeRiskScore,
  buildQualityReport,
  type QualityTestCase,
} from '../../src/engines/generation-quality-engine';
import type { CoverageType } from '../../src/engines/test-coverage-engine';

/* --------------------------------------------------------------------------
 * Fixtures — a faithful reconstruction of the reported REQ-002 suite.
 * ------------------------------------------------------------------------ */
function positive(n: number): QualityTestCase {
  return {
    coverageType: 'positive',
    title: `Add new employee with valid details ${n}`,
    objective: 'Verify a new employee can be added with valid mandatory fields',
    steps: ['Open Add Employee form', 'Enter valid details', 'Save', 'Confirm employee created'],
  };
}

/** The reported suite: 11 positive, 1 negative, 0 edge. */
const REPORTED_SUITE: QualityTestCase[] = [
  ...Array.from({ length: 11 }, (_, i) => positive(i + 1)),
  {
    coverageType: 'negative',
    title: 'Add employee with missing mandatory field',
    objective: 'Verify validation error when a mandatory field is blank',
    steps: ['Open Add Employee form', 'Leave name blank', 'Save', 'Expect validation error'],
  },
];

describe('coverageFamily — granular type → family mapping', () => {
  it('maps the three core types directly', () => {
    expect(coverageFamily('positive')).toBe('positive');
    expect(coverageFamily('negative')).toBe('negative');
    expect(coverageFamily('edge_cases')).toBe('edge');
  });

  it('treats boundary as a form of edge testing', () => {
    expect(coverageFamily('boundary')).toBe('edge');
    expect(coverageFamily('edge')).toBe('edge');
  });

  it('groups advanced types (security/integration/role/performance) as advanced', () => {
    expect(coverageFamily('security')).toBe('advanced');
    expect(coverageFamily('integration')).toBe('advanced');
    expect(coverageFamily('role_based')).toBe('advanced');
    expect(coverageFamily('performance')).toBe('advanced');
  });

  it('is case-insensitive and whitespace-tolerant; unknown → advanced', () => {
    expect(coverageFamily('  POSITIVE ')).toBe('positive');
    expect(coverageFamily('mystery')).toBe('advanced');
    expect(coverageFamily('')).toBe('advanced');
  });
});

describe('analyzeCoverageMix', () => {
  it('counts the reported suite as 11 positive / 1 negative / 0 edge', () => {
    const mix = analyzeCoverageMix(REPORTED_SUITE);
    expect(mix.total).toBe(12);
    expect(mix.byFamily.positive).toBe(11);
    expect(mix.byFamily.negative).toBe(1);
    expect(mix.byFamily.edge).toBe(0);
    expect(mix.familyPercent.positive).toBe(92); // 11/12 → 92%
    expect(mix.label).toBe('Positive: 11 · Negative: 1 · Edge: 0');
  });

  it('defaults an untagged case to positive (matches generator scenario mapping)', () => {
    const mix = analyzeCoverageMix([{ title: 'no type' }]);
    expect(mix.byFamily.positive).toBe(1);
    expect(mix.byType.positive).toBe(1);
  });

  it('handles an empty suite without dividing by zero', () => {
    const mix = analyzeCoverageMix([]);
    expect(mix.total).toBe(0);
    expect(mix.familyPercent.positive).toBe(0);
  });
});

describe('detectDuplicates — lexical safety net', () => {
  it('clusters the near-identical positive happy paths', () => {
    const clusters = detectDuplicates(REPORTED_SUITE);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    // The 11 positives share title/objective/steps almost entirely → one big cluster.
    expect(clusters[0].indices.length).toBeGreaterThanOrEqual(11);
    expect(clusters[0].similarity).toBeGreaterThanOrEqual(QUALITY_THRESHOLDS.DUPLICATE_SIMILARITY);
  });

  it('does not flag genuinely distinct cases', () => {
    const distinct: QualityTestCase[] = [
      { title: 'Create employee', objective: 'add record', steps: ['open', 'save'] },
      { title: 'Delete department budget', objective: 'remove allocation', steps: ['navigate', 'confirm removal'] },
    ];
    expect(detectDuplicates(distinct)).toHaveLength(0);
  });
});

describe('expectedFamiliesFor — what the user actually asked for', () => {
  it('derives core families from the selected coverage types', () => {
    const fams = expectedFamiliesFor(['positive', 'negative', 'edge_cases'] as CoverageType[]);
    expect(fams.has('positive')).toBe(true);
    expect(fams.has('negative')).toBe(true);
    expect(fams.has('edge')).toBe(true);
  });

  it('never expects advanced families to be graded against core balance', () => {
    const fams = expectedFamiliesFor(['positive', 'security'] as CoverageType[]);
    expect(fams.has('advanced')).toBe(false);
  });

  it('falls back to positive-only for an unspecified request', () => {
    const fams = expectedFamiliesFor(undefined);
    expect([...fams]).toEqual(['positive']);
  });
});

describe('detectMissingCategories', () => {
  it('flags negative + edge as missing for the reported suite when all three were selected', () => {
    const mix = analyzeCoverageMix(REPORTED_SUITE);
    const expected = expectedFamiliesFor(['positive', 'negative', 'edge_cases'] as CoverageType[]);
    const missing = detectMissingCategories(mix, expected);
    // Negative is 1/12 = 8% (< 20% floor); Edge is 0 → both missing. Positive present.
    expect(missing).toContain('negative');
    expect(missing).toContain('edge');
    expect(missing).not.toContain('positive');
  });

  it('does not penalise families the user never selected', () => {
    const mix = analyzeCoverageMix(REPORTED_SUITE);
    const expected = expectedFamiliesFor(['positive'] as CoverageType[]);
    expect(detectMissingCategories(mix, expected)).toEqual([]);
  });
});

describe('computeRiskScore — relative to the request', () => {
  it('scores the reported suite HIGH (edge selected, zero produced)', () => {
    const mix = analyzeCoverageMix(REPORTED_SUITE);
    const expected = expectedFamiliesFor(['positive', 'negative', 'edge_cases'] as CoverageType[]);
    const dupes = detectDuplicates(REPORTED_SUITE).length;
    const risk = computeRiskScore(mix, expected, dupes);
    expect(risk.score).toBe('HIGH');
    expect(risk.reasons.join(' ')).toMatch(/edge/i);
  });

  it('does NOT punish a positive-only request for lacking edge/negative', () => {
    // A modest, non-skewed positive-only suite (≤85% positive is impossible for
    // an all-positive set, so use a small suite where the skew signal is the ONLY
    // possible flag) must never be HIGH just because negative/edge are absent —
    // they were not requested. Skew alone caps the score at MEDIUM, never HIGH.
    const mix = analyzeCoverageMix(REPORTED_SUITE);
    const expected = expectedFamiliesFor(['positive'] as CoverageType[]);
    const risk = computeRiskScore(mix, expected, 0);
    expect(risk.score).not.toBe('HIGH');
    // The reasons must NOT mention a missing negative/edge — those weren't asked for.
    expect(risk.reasons.join(' ')).not.toMatch(/0 negative cases|0 edge cases/i);
  });

  it('scores a balanced, dupe-free suite LOW', () => {
    const balanced: QualityTestCase[] = [
      { coverageType: 'positive', title: 'happy path login', objective: 'valid creds', steps: ['enter creds', 'submit'] },
      { coverageType: 'positive', title: 'login remember me', objective: 'persist session', steps: ['check box', 'submit'] },
      { coverageType: 'negative', title: 'wrong password rejected', objective: 'bad creds error', steps: ['enter bad pw', 'expect error'] },
      { coverageType: 'edge_cases', title: 'max length username boundary', objective: 'boundary field', steps: ['enter 256 chars', 'expect handled'] },
    ];
    const mix = analyzeCoverageMix(balanced);
    const expected = expectedFamiliesFor(['positive', 'negative', 'edge_cases'] as CoverageType[]);
    const risk = computeRiskScore(mix, expected, detectDuplicates(balanced).length);
    expect(risk.score).toBe('LOW');
  });
});

describe('buildQualityReport — the single call the pipeline makes', () => {
  it('produces a failing report for the reported suite with actionable output', () => {
    const report = buildQualityReport(REPORTED_SUITE, {
      selectedTypes: ['positive', 'negative', 'edge_cases'] as CoverageType[],
    });
    expect(report.passed).toBe(false);
    expect(report.risk.score).toBe('HIGH');
    expect(report.missingCategories).toContain('edge');
    expect(report.missingTypes).toContain('edge_cases');
    expect(report.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(report.coverageMix.label).toBe('Positive: 11 · Negative: 1 · Edge: 0');
    expect(report.recommendations.some(r => /edge/i.test(r))).toBe(true);
  });

  it('passes a balanced, distinct suite', () => {
    const balanced: QualityTestCase[] = [
      { coverageType: 'positive', title: 'submit valid order', objective: 'checkout success', steps: ['add item', 'pay', 'confirm'] },
      { coverageType: 'negative', title: 'declined card blocks order', objective: 'payment failure path', steps: ['add item', 'use declined card', 'expect error'] },
      { coverageType: 'edge_cases', title: 'zero quantity boundary rejected', objective: 'quantity boundary', steps: ['set qty 0', 'expect validation'] },
    ];
    const report = buildQualityReport(balanced, {
      selectedTypes: ['positive', 'negative', 'edge_cases'] as CoverageType[],
    });
    expect(report.passed).toBe(true);
    expect(report.risk.score).toBe('LOW');
    expect(report.missingCategories).toEqual([]);
    expect(report.recommendations).toContain('Balanced suite — no regeneration required.');
  });

  it('is deterministic — same input yields identical verdict', () => {
    const a = buildQualityReport(REPORTED_SUITE, { selectedTypes: ['positive', 'negative', 'edge_cases'] as CoverageType[] });
    const b = buildQualityReport(REPORTED_SUITE, { selectedTypes: ['positive', 'negative', 'edge_cases'] as CoverageType[] });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('exposes CORE_FAMILIES as exactly positive/negative/edge', () => {
    expect([...CORE_FAMILIES]).toEqual(['positive', 'negative', 'edge']);
  });
});
