/**
 * Intelligence Provider Interface
 * ============================================================================
 *
 * Every intelligence source in LevelUp AI implements this contract:
 * Repository, DOM Memory, App Profile, Test Data, Knowledge, Similarity,
 * Patterns, Scenario Graph, and any future source.
 *
 * This standardization allows the Orchestrator to loop over `providers[]`
 * instead of having inline logic for each source. Adding a new provider
 * becomes ~20 lines instead of editing orchestrator internals.
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
 * Result of gathering intelligence from one source. The Orchestrator merges
 * these into the unified Intelligence Bundle.
 */
export interface IntelligenceResult<TContext = any> {
  /** Whether this source returned usable data. */
  available: boolean;
  /** Domain-specific context (RepositoryContext, ScenarioContext, etc.). */
  context: TContext | null;
  /** Metadata about the gathering process. */
  metadata: IntelligenceMetadata;
}

/**
 * Per-source metadata — timing, confidence, versioning, warnings.
 */
export interface IntelligenceMetadata {
  /** Wall-clock time to gather this source (ms). */
  timingMs: number;
  /** Confidence score 0-100 (how strongly this source supports the intent). */
  confidence: number;
  /** Which snapshot of the source was used (fingerprint, crawledAt, etc.). */
  version?: {
    id?: string | number;
    fingerprint?: string;
    timestamp?: string;
  };
  /** Warnings (non-fatal issues encountered). */
  warnings: string[];
}

/**
 * Standard intelligence provider contract. Every source implements this.
 *
 * Example usage in the Orchestrator:
 * ```typescript
 * const providers: IntelligenceProvider[] = [
 *   repositoryProvider,
 *   scenarioProvider,
 *   appProfileProvider,
 *   // … future providers
 * ];
 * for (const p of providers) {
 *   const result = await p.gather(query);
 *   merge(result);
 * }
 * ```
 */
export interface IntelligenceProvider<TContext = any> {
  /** Unique source name (e.g., 'repository', 'scenarioGraph'). */
  readonly name: string;

  /**
   * Gather intelligence for the given query. Fail-open: errors are caught and
   * returned as `available: false` with a warning — never thrown.
   */
  gather(query: IntelligenceQuery): Promise<IntelligenceResult<TContext>>;
}
