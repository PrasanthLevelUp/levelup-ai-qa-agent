/**
 * Coverage Intelligence · Sprint CI-2 — Coverage Report
 * Unit tests. Deterministic aggregation and formatting.
 */

import {
  aggregateCoverageReport,
  formatCoverageReport,
  CoverageReport,
} from '../../src/coverage-intelligence/coverage-report';
import { GenerationDecision } from '../../src/coverage-intelligence/types';
import type { ScenarioCoverage } from '../../src/coverage-intelligence/existing-test-discovery';

/* ------------------------------------------------------------------ */
/*  aggregateCoverageReport                                            */
/* ------------------------------------------------------------------ */

describe('aggregateCoverageReport', () => {
  it('returns zero counts for an empty input', () => {
    const report = aggregateCoverageReport([]);
    expect(report.planned).toBe(0);
    expect(report.breakdown[GenerationDecision.REUSE]).toBe(0);
    expect(report.breakdown[GenerationDecision.EXTEND]).toBe(0);
    expect(report.breakdown[GenerationDecision.GENERATE]).toBe(0);
  });

  it('aggregates a mix of decisions correctly', () => {
    const scenarios: ScenarioCoverage[] = [
      // 3 reuse
      { scenarioId: 's1', scenario: 'A', status: 'existing', confidence: 85, existingTest: 'a', recommendation: GenerationDecision.REUSE, matchedOn: [], reason: '', alternatives: [] },
      { scenarioId: 's2', scenario: 'B', status: 'existing', confidence: 80, existingTest: 'b', recommendation: GenerationDecision.REUSE, matchedOn: [], reason: '', alternatives: [] },
      { scenarioId: 's3', scenario: 'C', status: 'existing', confidence: 90, existingTest: 'c', recommendation: GenerationDecision.REUSE, matchedOn: [], reason: '', alternatives: [] },
      // 2 extend
      { scenarioId: 's4', scenario: 'D', status: 'partial', confidence: 50, existingTest: 'd', recommendation: GenerationDecision.EXTEND, matchedOn: [], reason: '', alternatives: [] },
      { scenarioId: 's5', scenario: 'E', status: 'partial', confidence: 55, existingTest: 'e', recommendation: GenerationDecision.EXTEND, matchedOn: [], reason: '', alternatives: [] },
      // 4 generate
      { scenarioId: 's6', scenario: 'F', status: 'missing', confidence: 0, existingTest: null, recommendation: GenerationDecision.GENERATE, matchedOn: [], reason: '', alternatives: [] },
      { scenarioId: 's7', scenario: 'G', status: 'missing', confidence: 0, existingTest: null, recommendation: GenerationDecision.GENERATE, matchedOn: [], reason: '', alternatives: [] },
      { scenarioId: 's8', scenario: 'H', status: 'missing', confidence: 0, existingTest: null, recommendation: GenerationDecision.GENERATE, matchedOn: [], reason: '', alternatives: [] },
      { scenarioId: 's9', scenario: 'I', status: 'missing', confidence: 0, existingTest: null, recommendation: GenerationDecision.GENERATE, matchedOn: [], reason: '', alternatives: [] },
    ];

    const report = aggregateCoverageReport(scenarios);
    expect(report.planned).toBe(9);
    expect(report.breakdown[GenerationDecision.REUSE]).toBe(3);
    expect(report.breakdown[GenerationDecision.EXTEND]).toBe(2);
    expect(report.breakdown[GenerationDecision.GENERATE]).toBe(4);
  });

  it('aggregates all-same-decision correctly', () => {
    const scenarios: ScenarioCoverage[] = [
      { scenarioId: 's1', scenario: 'A', status: 'missing', confidence: 0, existingTest: null, recommendation: GenerationDecision.GENERATE, matchedOn: [], reason: '', alternatives: [] },
      { scenarioId: 's2', scenario: 'B', status: 'missing', confidence: 0, existingTest: null, recommendation: GenerationDecision.GENERATE, matchedOn: [], reason: '', alternatives: [] },
      { scenarioId: 's3', scenario: 'C', status: 'missing', confidence: 0, existingTest: null, recommendation: GenerationDecision.GENERATE, matchedOn: [], reason: '', alternatives: [] },
    ];

    const report = aggregateCoverageReport(scenarios);
    expect(report.planned).toBe(3);
    expect(report.breakdown[GenerationDecision.REUSE]).toBe(0);
    expect(report.breakdown[GenerationDecision.EXTEND]).toBe(0);
    expect(report.breakdown[GenerationDecision.GENERATE]).toBe(3);
  });

  it('planned count equals the sum of all breakdown buckets', () => {
    const scenarios: ScenarioCoverage[] = [
      { scenarioId: 's1', scenario: 'A', status: 'existing', confidence: 85, existingTest: 'a', recommendation: GenerationDecision.REUSE, matchedOn: [], reason: '', alternatives: [] },
      { scenarioId: 's2', scenario: 'B', status: 'partial', confidence: 50, existingTest: 'b', recommendation: GenerationDecision.EXTEND, matchedOn: [], reason: '', alternatives: [] },
      { scenarioId: 's3', scenario: 'C', status: 'missing', confidence: 0, existingTest: null, recommendation: GenerationDecision.GENERATE, matchedOn: [], reason: '', alternatives: [] },
    ];

    const report = aggregateCoverageReport(scenarios);
    const sum =
      report.breakdown[GenerationDecision.REUSE] +
      report.breakdown[GenerationDecision.EXTEND] +
      report.breakdown[GenerationDecision.GENERATE];
    expect(report.planned).toBe(sum);
  });
});

/* ------------------------------------------------------------------ */
/*  formatCoverageReport                                               */
/* ------------------------------------------------------------------ */

describe('formatCoverageReport', () => {
  it('renders the simple summary format', () => {
    const report: CoverageReport = {
      planned: 12,
      breakdown: {
        [GenerationDecision.REUSE]: 8,
        [GenerationDecision.EXTEND]: 2,
        [GenerationDecision.GENERATE]: 2,
      },
    };

    const text = formatCoverageReport(report);
    expect(text).toContain('Coverage Report');
    expect(text).toContain(' 12 Planned');
    expect(text).toContain('  8 Reuse');
    expect(text).toContain('  2 Extend');
    expect(text).toContain('  2 Generate');
  });

  it('renders zeros for an empty report', () => {
    const report: CoverageReport = {
      planned: 0,
      breakdown: {
        [GenerationDecision.REUSE]: 0,
        [GenerationDecision.EXTEND]: 0,
        [GenerationDecision.GENERATE]: 0,
      },
    };

    const text = formatCoverageReport(report);
    expect(text).toContain('  0 Planned');
    expect(text).toContain('  0 Reuse');
    expect(text).toContain('  0 Extend');
    expect(text).toContain('  0 Generate');
  });
});
