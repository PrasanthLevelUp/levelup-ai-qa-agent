/**
 * Intelligence Provider Interface
 * ============================================================================
 *
 * Every intelligence source in LevelUp AI implements this contract:
 * Repository, DOM Memory, App Profile, Test Data, Knowledge, Similarity,
 * Patterns, Scenario Graph, and any future source (Jira, Azure DevOps, SAP…).
 *
 * This standardization lets the Orchestrator iterate over a Provider Registry
 * instead of hardcoding source-specific `if (repository) … if (dom) …` logic.
 * Adding a new source becomes "implement + register", not "edit orchestrator
 * internals".
 *
 * ── Design decisions (from Phase 2 architecture review) ──────────────────────
 *
 * 1. `priority` lives on the provider, NOT hardcoded in the Orchestrator.
 *    Providers declare when they should run relative to others; the registry
 *    orders execution. No source-specific ordering baked into the orchestrator.
 *
 * 2. Metadata is STANDARDIZED (`provider`, `durationMs`, `cacheHit`, `items`,
 *    `warnings`, `signals`). Every provider reports the same diagnostics, so the
 *    dashboard can render provider telemetry uniformly without special-casing.
 *
 * 3. Confidence is NOT computed by the provider. Providers emit raw `signals`
 *    (facts: counts, grounded ratios, freshness). The orchestration layer
 *    computes a single, consistent confidence from those signals
 *    (see `intelligence-confidence.ts`). This prevents every provider from
 *    inventing its own scoring model that drifts over time.
 *
 * Discipline:
 *   • Pure interface — no implementation here.
 *   • Providers return domain-specific context types (RepositoryContext,
 *     ScenarioContextBundle, etc.) — NOT raw internal structures.
 *   • Consumers (Script Gen, Healing, RTM) never import providers directly;
 *     they only read the unified Intelligence Bundle the Orchestrator produces.
 */

/**
 * Query describing what intelligence to gather. Providers receive this from
 * the Orchestrator and decide what data (if any) is relevant.
 */
export interface IntelligenceQuery {
  /** User intent / test scenario (e.g., "Login", "Add to cart"). */
  intent: string;
  /** Company/project scope. */
  companyId: number;
  projectId?: number;
  /** Repository context ID (for graph queries). */
  repoContextId?: number;
  /** Target URL (for App Profile, DOM Memory). */
  targetUrl?: string;
  /** Feature calling (for telemetry / conditional logic). */
  caller: 'script-gen' | 'healing' | 'ai-review' | 'test-case-lab' | 'rca' | 'impact-analysis';
  /** Requirement ID (for Scenario Graph). */
  requirementId?: number;
}

/**
 * Version/snapshot identity of the data a provider used (fingerprint, crawl
 * timestamp, etc.). Optional — not every source is versioned.
 */
export interface IntelligenceVersion {
  id?: string | number;
  fingerprint?: string;
  timestamp?: string;
}

/**
 * Raw, provider-emitted facts used by the centralized confidence scorer.
 *
 * Providers put *facts* here (e.g., `{ scenarioCount: 8, groundedCount: 5 }`),
 * NOT scores. The orchestration layer turns signals into a confidence number.
 * Keep keys stable — the scorer switches on `metadata.provider` + these keys.
 */
export interface IntelligenceSignals {
  [key: string]: number | boolean | string | null | undefined;
}

/**
 * Standardized per-gather metadata. Identical shape across all providers so the
 * dashboard can display provider diagnostics uniformly.
 *
 * Note: `confidence` is intentionally NOT here — it is computed centrally by the
 * orchestration layer from `signals` and attached to `IntelligenceResult`.
 */
export interface IntelligenceMetadata {
  /** Provider name (mirrors `IntelligenceProvider.name`). */
  provider: string;
  /** Wall-clock time to gather this source (ms). */
  durationMs: number;
  /** Whether the result was served from cache / reused (vs. freshly built). */
  cacheHit: boolean;
  /** Number of items gathered (scenarios, elements, patterns, …). */
  items: number;
  /** Non-fatal issues encountered during gathering. */
  warnings: string[];
  /** Raw facts for centralized confidence scoring (NOT a score). */
  signals: IntelligenceSignals;
  /** Which snapshot of the source was used (fingerprint, crawledAt, etc.). */
  version?: IntelligenceVersion;
}

/**
 * Result of gathering intelligence from one source. The Orchestrator merges
 * these into the unified Intelligence Bundle.
 */
export interface IntelligenceResult<TContext = unknown> {
  /** Whether this source returned usable data. */
  available: boolean;
  /** Domain-specific context (RepositoryContext, ScenarioContextBundle, …). */
  context: TContext | null;
  /** Standardized per-gather diagnostics. */
  metadata: IntelligenceMetadata;
  /**
   * Confidence 0-100. **Set by the orchestration layer**, not the provider.
   * A provider always leaves this `undefined`; the registry fills it in via the
   * centralized scorer. Consumers read the filled value.
   */
  confidence?: number;
}

/**
 * Standard intelligence provider contract. Every source implements this.
 *
 * Example usage via the Provider Registry:
 * ```typescript
 * registry.register(scenarioGraphProvider);
 * registry.register(repositoryProvider);
 * const bundle = await registry.gatherAll(query); // priority-ordered, fail-open
 * ```
 */
export interface IntelligenceProvider<TContext = unknown> {
  /** Unique source name (e.g., 'repository', 'scenarioGraph'). */
  readonly name: string;

  /**
   * Execution priority. **Lower runs first.** Lets the registry order sources
   * deterministically without the orchestrator hardcoding sequence.
   * Convention: foundational/context sources (repository, app profile) use
   * low numbers; derived/advisory sources (scenario graph) use higher numbers.
   */
  readonly priority: number;

  /**
   * Whether this provider is currently active (feature flag, config, env).
   * The registry skips disabled providers cheaply, before calling `gather`.
   */
  enabled(): boolean;

  /**
   * Gather intelligence for the given query. Fail-open: errors are caught and
   * returned as `available: false` with a warning — never thrown. Providers
   * populate `metadata.signals` with facts but do NOT compute `confidence`.
   */
  gather(query: IntelligenceQuery): Promise<IntelligenceResult<TContext>>;
}

/**
 * Small helper for providers to build a standardized "unavailable" result with
 * consistent metadata — avoids each provider hand-rolling the empty shape.
 */
export function unavailableResult(
  provider: string,
  warning: string,
  durationMs = 0,
): IntelligenceResult<never> {
  return {
    available: false,
    context: null,
    metadata: {
      provider,
      durationMs,
      cacheHit: false,
      items: 0,
      warnings: warning ? [warning] : [],
      signals: {},
    },
  };
}
