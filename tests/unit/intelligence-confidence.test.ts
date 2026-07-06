/**
 * Unit tests for the centralized, GENERIC confidence scorer.
 *
 * Confidence lives here (orchestration layer), NOT in providers, and is computed
 * generically from standardized normalized quality signals — with NO per-provider
 * branching. These tests lock the scoring model and its invariants.
 *
 * Run with: npx jest tests/unit/intelligence-confidence.test.ts
 */

import { computeConfidence, scoreResult } from '../../src/services/intelligence-confidence';
import type { IntelligenceMetadata, IntelligenceResult, QualitySignals } from '../../src/services/intelligence-provider';

function meta(signals: QualitySignals): IntelligenceMetadata {
  return {
    provider: 'anySource',
    providerVersion: 1,
    durationMs: 1,
    cacheHit: false,
    items: 0,
    warnings: [],
    signals,
  };
}

describe('computeConfidence (generic, provider-agnostic)', () => {
  it('returns 0 when no recognized quality dimensions are present', () => {
    expect(computeConfidence({})).toBe(0);
    expect(computeConfidence(undefined)).toBe(0);
    expect(computeConfidence({ someUnknownDim: 0.9 })).toBe(0);
  });

  it('averages present dimensions and scales to 0-100', () => {
    // grounding 1.0 + coverage 0.5 → avg 0.75 → 75
    expect(computeConfidence({ grounding: 1, coverage: 0.5 })).toBe(75);
    // grounding 0.5 + coverage 0.25 → avg 0.375 → 38 (rounded)
    expect(computeConfidence({ grounding: 0.5, coverage: 0.25 })).toBe(38);
    // single dimension
    expect(computeConfidence({ coverage: 0.6 })).toBe(60);
  });

  it('applies the hard floor: zero grounding → 0 regardless of other dims', () => {
    expect(computeConfidence({ grounding: 0, coverage: 1, freshness: 1 })).toBe(0);
  });

  it('clamps out-of-range and ignores non-finite values', () => {
    expect(computeConfidence({ coverage: 5 })).toBe(100); // clamped to 1
    expect(computeConfidence({ grounding: 0.8, coverage: Number.NaN })).toBe(80); // NaN ignored
  });

  it('is genuinely provider-agnostic (same signals → same score)', () => {
    const signals = { grounding: 0.8, coverage: 0.8 };
    const a = computeConfidence(signals);
    // Identical signals must score identically no matter the source.
    expect(a).toBe(computeConfidence({ ...signals }));
    expect(a).toBe(80);
  });
});

describe('scoreResult', () => {
  it('fills confidence from signals when available', () => {
    const result: IntelligenceResult = {
      available: true,
      context: {},
      metadata: meta({ grounding: 1, coverage: 0.5 }),
    };
    expect(scoreResult(result).confidence).toBe(75);
  });

  it('forces confidence to 0 for unavailable results regardless of signals', () => {
    const result: IntelligenceResult = {
      available: false,
      context: null,
      metadata: meta({ grounding: 1, coverage: 1 }),
    };
    expect(scoreResult(result).confidence).toBe(0);
  });
});
