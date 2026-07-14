/**
 * Per-stage token telemetry helpers (Sprint 6.x).
 *
 * These guard the "measure before optimizing" contract:
 *  - deterministic stages report a truthful ZERO, never null and never estimated;
 *  - unknown token dimensions stay null (provider didn't report) and never get
 *    silently coerced to 0;
 *  - summarizeStages sums null-awarely and computes each stage's % of the total.
 */
import { stageMetric, summarizeStages } from '../../src/ai/generation-metrics';

describe('stageMetric', () => {
  it('defaults a deterministic stage (no llm calls) to zero tokens', () => {
    const s = stageMetric({ stage: 'Scenario Planning', durationMs: 5 });
    expect(s.deterministic).toBe(true);
    expect(s.llmCalls).toBe(0);
    expect(s.promptTokens).toBe(0);
    expect(s.completionTokens).toBe(0);
    expect(s.totalTokens).toBe(0);
    expect(s.durationMs).toBe(5);
  });

  it('defaults an LLM stage with unreported tokens to null (not 0)', () => {
    const s = stageMetric({ stage: 'Generation', llmCalls: 1, durationMs: 100 });
    expect(s.deterministic).toBe(false);
    expect(s.promptTokens).toBeNull();
    expect(s.completionTokens).toBeNull();
    expect(s.totalTokens).toBeNull();
  });

  it('respects explicit token values', () => {
    const s = stageMetric({
      stage: 'Generation', llmCalls: 1,
      promptTokens: 3000, completionTokens: 5000, totalTokens: 8000, durationMs: 200,
    });
    expect(s.totalTokens).toBe(8000);
    expect(s.promptTokens).toBe(3000);
    expect(s.completionTokens).toBe(5000);
  });
});

describe('summarizeStages', () => {
  it('sums tokens/time and computes each stage % share', () => {
    const summary = summarizeStages([
      stageMetric({ stage: 'Analysis', llmCalls: 1, promptTokens: 1500, completionTokens: 500, totalTokens: 2000, durationMs: 1000 }),
      stageMetric({ stage: 'Planning', durationMs: 10 }), // deterministic, 0 tokens
      stageMetric({ stage: 'Generation', llmCalls: 1, promptTokens: 3000, completionTokens: 5000, totalTokens: 8000, durationMs: 4000 }),
    ]);
    expect(summary.totalTokens).toBe(10000);
    expect(summary.promptTokens).toBe(4500);
    expect(summary.completionTokens).toBe(5500);
    expect(summary.totalDurationMs).toBe(5010);
    expect(summary.llmCalls).toBe(2);

    const byStage = Object.fromEntries(summary.stages.map(s => [s.stage, s.pctOfTokens]));
    expect(byStage['Analysis']).toBe(20);
    expect(byStage['Planning']).toBe(0);
    expect(byStage['Generation']).toBe(80);
  });

  it('keeps the total null when every LLM stage has unknown tokens', () => {
    const summary = summarizeStages([
      stageMetric({ stage: 'Generation', llmCalls: 1, durationMs: 100 }), // all null
      stageMetric({ stage: 'Gap Analysis', llmCalls: 1, durationMs: 50 }), // all null
    ]);
    // Nothing known → total stays null (we never fabricate a number).
    expect(summary.totalTokens).toBeNull();
    // pct share falls back to 0 when the denominator is unknown.
    expect(summary.stages.every(s => s.pctOfTokens === 0)).toBe(true);
  });

  it('does not let an unknown (null) stage erase a known contribution', () => {
    const summary = summarizeStages([
      stageMetric({ stage: 'Generation', llmCalls: 1, durationMs: 100 }),        // null
      stageMetric({ stage: 'Analysis', llmCalls: 1, totalTokens: 2000, durationMs: 50 }),
    ]);
    // null is skipped, the known 2000 survives.
    expect(summary.totalTokens).toBe(2000);
  });

  it('handles an all-zero (fully deterministic) run without dividing by zero', () => {
    const summary = summarizeStages([
      stageMetric({ stage: 'Planning', durationMs: 5 }),
      stageMetric({ stage: 'Builder', durationMs: 3 }),
    ]);
    expect(summary.totalTokens).toBe(0);
    expect(summary.stages.every(s => s.pctOfTokens === 0)).toBe(true);
  });
});
