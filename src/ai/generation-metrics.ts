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
