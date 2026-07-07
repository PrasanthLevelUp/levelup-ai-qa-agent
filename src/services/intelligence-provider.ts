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
 * 2. `version` lives on the provider. Bump it when a provider's behavior /
 *    signal shape changes. It's echoed into metadata so production diagnostics
 *    can attribute results to a specific provider revision.
 *
 * 3. Metadata is STANDARDIZED (`provider`, `providerVersion`, `durationMs`,
 *    `cacheHit`, `items`, `warnings`, `signals`). Every provider reports the
 *    same diagnostics, so the dashboard can render provider telemetry uniformly.
 *
 * 4. Confidence is NOT computed by the provider. Providers emit standardized,
 *    NORMALIZED quality `signals` (grounding, coverage, freshness … each 0-1).
 *    The orchestration layer computes a single confidence from those signals
 *    *generically* (see `intelligence-confidence.ts`) — it does NOT branch per
 *    provider. Providers own their domain facts (only Scenario Graph knows what
 *    "grounded" means); the orchestrator owns how quality → confidence, so
 *    scoring stays consistent and the orchestrator never becomes a per-source
 *    scoring engine.
 *
 * Discipline:
 *   • Pure interface — no implementation here.
 *   • Providers return domain-specific context types (RepositoryContext,
 *     ScenarioContext, etc.) — NOT raw internal structures.
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
 * Standardized, NORMALIZED quality signals a provider emits about its result.
 *
 * These are *facts about quality*, each in the range **0-1**, NOT a confidence
 * score. The centralized scorer combines whichever dimensions are present into
 * a final confidence — generically, without knowing which provider produced
 * them. Providers set only the dimensions they can honestly measure; the rest
 * stay `undefined` and are simply ignored by the scorer.
 *
 * Standard dimensions (extend deliberately, keep them normalized 0-1):
 *   • grounding    — fraction of the result backed by real evidence
 *                    (e.g., scenarios grounded in App Profile / Test Data).
 *   • coverage     — how completely the result covers the requested space.
 *   • freshness    — how recent the underlying data is (1 = just built).
 *   • completeness — how fully the source answered (vs. partial/degraded).
 *
 * The index signature allows a provider to attach extra normalized dimensions
 * without a contract change; the scorer only scores known weighted dimensions.
 */
export interface QualitySignals {
  grounding?: number;
  coverage?: number;
  freshness?: number;
  completeness?: number;
  [dimension: string]: number | undefined;
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
  /** Provider revision (mirrors `IntelligenceProvider.version`). */
  providerVersion: number;
  /** Wall-clock time to gather this source (ms). */
  durationMs: number;
  /** Whether the result was served from cache / reused (operational telemetry). */
  cacheHit: boolean;
  /** Number of items gathered (scenarios, elements, patterns, …). */
  items: number;
  /** Non-fatal issues encountered during gathering. */
  warnings: string[];
  /** Standardized normalized quality signals for the centralized scorer. */
  signals: QualitySignals;
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
  /** Domain-specific context (RepositoryContext, ScenarioContext, …). */
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
   * Provider revision. Bump when behavior or emitted signal shape changes.
   * Surfaced in metadata for production diagnostics / A-B attribution.
   */
  readonly version: number;

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
   * populate `metadata.signals` with normalized quality facts but do NOT
   * compute `confidence`.
   */
  gather(query: IntelligenceQuery): Promise<IntelligenceResult<TContext>>;
}

/**
 * Small helper for providers/registry to build a standardized "unavailable"
 * result with consistent metadata — avoids hand-rolling the empty shape.
 */
export function unavailableResult(
  provider: string,
  providerVersion: number,
  warning: string,
  durationMs = 0,
): IntelligenceResult<never> {
  return {
    available: false,
    context: null,
    metadata: {
      provider,
      providerVersion,
      durationMs,
      cacheHit: false,
      items: 0,
      warnings: warning ? [warning] : [],
      signals: {},
    },
  };
}
