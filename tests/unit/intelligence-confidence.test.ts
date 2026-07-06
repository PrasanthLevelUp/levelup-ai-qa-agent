/**
 * Unit tests for the centralized confidence scorer.
 *
 * Confidence lives here (orchestration layer), NOT in providers. These tests
 * lock the scoring model and the "unavailable → 0" invariant.
 *
 * Run with: npx jest tests/unit/intelligence-confidence.test.ts
 */

import { computeConfidence, scoreResult } from '../../src/services/intelligence-confidence';
import type { IntelligenceMetadata, IntelligenceResult } from '../../src/services/intelligence-provider';

function meta(partial: Partial<IntelligenceMetadata>): IntelligenceMetadata {
  return {
    provider: 'scenarioGraph',
    durationMs: 1,
    cacheHit: false,
    items: 0,
    warnings: [],
    signals: {},
    ...partial,
  };
}

describe('computeConfidence', () => {
  it('scores scenarioGraph as 60 + 5 per grounded scenario', () => {
    expect(computeConfidence(meta({ signals: { groundedCount: 1 } }))).toBe(65);
    expect(computeConfidence(meta({ signals: { groundedCount: 3 } }))).toBe(75);
  });

  it('caps scenarioGraph confidence at 100', () => {
    expect(computeConfidence(meta({ signals: { groundedCount: 50 } }))).toBe(100);
  });

  it('returns 0 for scenarioGraph when nothing is grounded', () => {
    expect(computeConfidence(meta({ signals: { groundedCount: 0, scenarioCount: 5 } }))).toBe(0);
    expect(computeConfidence(meta({ signals: {} }))).toBe(0);
  });

  it('returns 0 for unknown providers (advisory, no guessing)', () => {
    expect(computeConfidence(meta({ provider: 'someFutureSource', signals: { x: 9 } }))).toBe(0);
  });

  it('ignores non-numeric signals safely', () => {
    expect(computeConfidence(meta({ signals: { groundedCount: 'lots' as any } }))).toBe(0);
  });
});

describe('scoreResult', () => {
  it('fills confidence from signals when available', () => {
    const result: IntelligenceResult = {
      available: true,
      context: {},
      metadata: meta({ signals: { groundedCount: 2 } }),
    };
    expect(scoreResult(result).confidence).toBe(70);
  });

  it('forces confidence to 0 for unavailable results regardless of signals', () => {
    const result: IntelligenceResult = {
      available: false,
      context: null,
      metadata: meta({ signals: { groundedCount: 9 } }),
    };
    expect(scoreResult(result).confidence).toBe(0);
  });
});
