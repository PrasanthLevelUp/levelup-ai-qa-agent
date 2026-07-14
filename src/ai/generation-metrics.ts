/**
 * Generation Metrics — the single source of truth for "what did this generation
 * cost?", captured from the PROVIDER's returned `usage`, never estimated.
 *
 * Design rules (do not violate):
 *  1. NEVER estimate tokens from text length (chars/4, words, bytes). The only
 *     valid source is the `usage` object an LLM API returns.
 *  2. `null` ≠ `0`. `0` means "the LLM genuinely consumed zero tokens" (e.g. a
 *     fully deterministic, no-LLM generation). `null` means "unknown" — a call
 *     was made but the provider did not return usage. Conflating them lies to
 *     the reader.
 *  3. Store TOKENS, not cost. Pricing changes; historical token counts do not.
 *     Cost is derived later (in the UI/reporting layer) from tokens × current
 *     pricing.
 *  4. Aggregate across ALL LLM calls in one generation (plan + review + repair …)
 *     — a per-generation total is far more useful than a single opaque number.
 *  5. This is reusable. Every AI feature (Script Gen, Test Case Lab, Healing,
 *     Coverage, Migration) can populate the same shape so History shows usage
 *     and performance consistently.
 */

/** One LLM call's usage, exactly as the provider reported it. */
export interface TokenUsage {
  /** Input/prompt tokens; `null` when the provider did not report it. */
  promptTokens: number | null;
  /** Output/completion tokens; `null` when the provider did not report it. */
  completionTokens: number | null;
  /** Total tokens; `null` when the provider did not report it. */
  totalTokens: number | null;
  /** The model that produced this call (e.g. "gpt-4o", "claude-3-5-sonnet"). */
  model: string;
}

/**
 * Aggregated metrics for ONE generation. Intentionally extensible — new fields
 * (retryCount, temperature, …) can be added without breaking consumers, which
 * is why this is a dedicated object rather than a bare `tokenCount`.
 */
export interface GenerationMetrics {
  /** Number of LLM calls made. `0` for a fully deterministic generation. */
  llmCalls: number;
  /** Summed prompt tokens across all calls; `null` if none reported usage. */
  promptTokens: number | null;
  /** Summed completion tokens across all calls; `null` if none reported usage. */
  completionTokens: number | null;
  /** Summed total tokens across all calls; `null` if none reported usage. */
  totalTokens: number | null;
  /** Wall-clock duration of the generation, in milliseconds. */
  durationMs: number;
  /** True when the result was served from cache / a deterministic no-LLM path. */
  cacheHit: boolean;
  /** Provider that served the generation (e.g. "openai", "anthropic", "deterministic"). */
  provider: string;
  /** Primary model used (the last/most-significant call's model). */
  model: string;
}

/**
 * A deterministic (no-LLM) generation. It genuinely consumed ZERO LLM tokens, so
 * the token fields are `0` (a known quantity), NOT `null` (unknown) — and
 * `cacheHit` is true so the UI can show a "Deterministic" / "Cached" badge
 * instead of a misleading bare "0 tokens".
 */
export function deterministicMetrics(opts: {
  model: string;
  durationMs?: number;
  provider?: string;
}): GenerationMetrics {
  return {
    llmCalls: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    durationMs: opts.durationMs ?? 0,
    cacheHit: true,
    provider: opts.provider ?? 'deterministic',
    model: opts.model,
  };
}

/** Start an empty aggregate for an LLM-backed generation (before any call). */
export function newGenerationMetrics(opts: { provider: string; model: string }): GenerationMetrics {
  return {
    llmCalls: 0,
    promptTokens: null,
    completionTokens: null,
    totalTokens: null,
    durationMs: 0,
    cacheHit: false,
    provider: opts.provider,
    model: opts.model,
  };
}

/** null-aware addition: unknown (`null`) contributions are skipped, not zeroed. */
function addToken(acc: number | null, next: number | null): number | null {
  if (next == null) return acc; // unknown → leave the running total unchanged
  return (acc ?? 0) + next;
}

/**
 * Fold one provider `usage` into an aggregate (mutates and returns it). Increments
 * `llmCalls`, sums each token dimension with null-aware semantics, and adopts the
 * call's model as the primary model.
 */
export function recordLlmCall(metrics: GenerationMetrics, usage: TokenUsage): GenerationMetrics {
  metrics.llmCalls += 1;
  metrics.promptTokens = addToken(metrics.promptTokens, usage.promptTokens);
  metrics.completionTokens = addToken(metrics.completionTokens, usage.completionTokens);
  metrics.totalTokens = addToken(metrics.totalTokens, usage.totalTokens);
  if (usage.model) metrics.model = usage.model;
  return metrics;
}

/**
 * Format a token total for display, e.g. `1720` → `"1.7K tokens"`, `420` →
 * `"420 tokens"`, `0` → `"0 tokens"`, `null` → `"Unknown"`. Presentation only —
 * never feed this back into metrics.
 */
export function formatTokens(total: number | null): string {
  if (total == null) return 'Unknown';
  if (total < 1000) return `${total.toLocaleString('en-US')} tokens`;
  return `${(total / 1000).toFixed(1)}K tokens`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Per-stage breakdown — "measure before optimizing".
 *
 * A single opaque total ("22,382 tokens") hides WHERE cost is spent. A stage
 * breakdown itemizes every pipeline stage — deterministic (zero-LLM) ones too —
 * with its own tokens + wall-clock, so we can see which stage dominates before
 * touching anything. This is intentionally generic so any AI pipeline (Test
 * Case Lab, Script Gen, Healing) can emit the same shape.
 * ──────────────────────────────────────────────────────────────────────────── */

/** One pipeline stage's cost. `null` tokens = unknown; `0` = genuinely zero. */
export interface StageMetric {
  /** Human-readable stage name, e.g. "Requirement Analysis", "Generation". */
  stage: string;
  /** LLM round-trips this stage made. `0` for a deterministic (code-only) stage. */
  llmCalls: number;
  /** Input tokens; `null` when unknown, `0` for deterministic stages. */
  promptTokens: number | null;
  /** Output tokens; `null` when unknown, `0` for deterministic stages. */
  completionTokens: number | null;
  /** Total tokens; `null` when unknown, `0` for deterministic stages. */
  totalTokens: number | null;
  /** Wall-clock spent in this stage, in milliseconds. */
  durationMs: number;
  /** True when the stage runs entirely in code (no LLM tokens spent). */
  deterministic: boolean;
  /** Optional short note, e.g. "skipped (below complexity gate)", "embeddings". */
  note?: string;
}

/** Build a StageMetric, defaulting the token dimensions sanely. */
export function stageMetric(opts: {
  stage: string;
  llmCalls?: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  durationMs?: number;
  deterministic?: boolean;
  note?: string;
}): StageMetric {
  const deterministic = opts.deterministic ?? (opts.llmCalls ?? 0) === 0;
  return {
    stage: opts.stage,
    llmCalls: opts.llmCalls ?? 0,
    promptTokens: opts.promptTokens ?? (deterministic ? 0 : null),
    completionTokens: opts.completionTokens ?? (deterministic ? 0 : null),
    totalTokens: opts.totalTokens ?? (deterministic ? 0 : null),
    durationMs: opts.durationMs ?? 0,
    deterministic,
    note: opts.note,
  };
}

/** A stage plus its share of the run's total tokens (for "where did it go?"). */
export interface StageShare extends StageMetric {
  /** This stage's percentage of the run's total tokens (0–100, rounded). */
  pctOfTokens: number;
}

/** Roll a list of stages into run totals + each stage's % of total tokens. */
export function summarizeStages(stages: StageMetric[]): {
  stages: StageShare[];
  totalTokens: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalDurationMs: number;
  llmCalls: number;
} {
  let totalTokens: number | null = null;
  let promptTokens: number | null = null;
  let completionTokens: number | null = null;
  let totalDurationMs = 0;
  let llmCalls = 0;
  for (const s of stages) {
    totalTokens = addToken(totalTokens, s.totalTokens);
    promptTokens = addToken(promptTokens, s.promptTokens);
    completionTokens = addToken(completionTokens, s.completionTokens);
    totalDurationMs += s.durationMs;
    llmCalls += s.llmCalls;
  }
  const denom = totalTokens ?? 0;
  const withShare: StageShare[] = stages.map(s => ({
    ...s,
    pctOfTokens: denom > 0 ? Math.round(((s.totalTokens ?? 0) / denom) * 100) : 0,
  }));
  return { stages: withShare, totalTokens, promptTokens, completionTokens, totalDurationMs, llmCalls };
}
