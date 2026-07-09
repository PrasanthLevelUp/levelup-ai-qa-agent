/**
 * Scenario Graph Intelligence Provider
 * ============================================================================
 *
 * Provides **ScenarioContext** (NOT the raw graph) to the Orchestrator.
 * Consumers (Script Gen, Healing, RTM) never see nodes/edges/fingerprints —
 * they receive a domain-friendly view: scenarios, dependencies, variants,
 * precedence.
 *
 * This provider is the ONLY module that imports the graph. All other modules
 * consume ScenarioContext from the unified Intelligence Bundle. This isolation
 * means we can completely redesign the graph internals without breaking
 * consumers.
 *
 * ── ScenarioContext stays ONE flat type (Phase 2 review) ─────────────────────
 * dependencies / variants / precedence fit together well today, and no consumer
 * yet reveals a natural split. Per YAGNI, we keep a single context and will
 * split it later based on *real* usage (once Healing / RTM / Impact consume it),
 * not on prediction.
 *
 * ── Confidence (Phase 2 review) ──────────────────────────────────────────────
 * This provider does NOT compute confidence. It emits standardized, normalized
 * quality `signals` (grounding, coverage — each 0-1). The centralized scorer
 * (`intelligence-confidence.ts`) combines them generically into a number. The
 * provider owns the domain facts; the orchestrator owns quality → confidence.
 *
 * Discipline:
 *   • Fail-open: errors return `available: false`, never throw.
 *   • Feature-flagged: `SCENARIO_GRAPH_PROVIDER` (default false) via `enabled()`.
 *   • Advisory only initially — weight 0 in grounding.
 */

import { logger } from '../utils/logger';
import {
  type IntelligenceProvider,
  type IntelligenceQuery,
  type IntelligenceResult,
  type QualitySignals,
} from './intelligence-provider';
import { getOrBuildScenarioGraph } from '../graph/scenario-graph-service';
import type { ScenarioGraph, ScenarioSemantics } from '../graph/scenario-graph';

const MOD = 'ScenarioGraphProvider';

/** Provider revision — bump when behavior or emitted signals change. */
const SCENARIO_GRAPH_VERSION = 1;

/**
 * Priority for the Scenario Graph source. Higher than foundational sources
 * (repository, app profile) because it's a derived, advisory layer that ideally
 * runs after primary context is available. See ProviderRegistry ordering.
 */
const SCENARIO_GRAPH_PRIORITY = 70;

/**
 * Default coverage types requested when building a graph. Also the denominator
 * for the normalized `coverage` quality signal.
 */
const DEFAULT_COVERAGE_TYPES = ['positive', 'negative', 'edge_cases', 'security'] as const;

/* ================================================================== */
/*  Scenario Context — the public interface consumers receive          */
/* ================================================================== */

/**
 * A single scenario in the context (simplified from ScenarioNode).
 */
export interface ScenarioSummary {
  id: string;
  title: string;
  objective: string;
  coverageType: string;
  priority: string;
  severity: string;
  riskArea: string;
  automationReady: boolean;
  automationComplexity: string;
  /** True when grounded in real App Profile / Test Data. */
  grounded: boolean;
  /**
   * The scenario's application-neutral semantics (variable under test / valid
   * preconditions / single variation / expected behavior / required data role).
   * Present for freshly built graphs; may be undefined for older persisted
   * graphs built before semantics were carried on the node.
   */
  semantics?: ScenarioSemantics;
}

/**
 * Execution dependency (from `precedes` edges): scenario X must run before Y.
 */
export interface ScenarioDependency {
  scenarioId: string;
  /** Scenario IDs that must complete successfully before this one runs. */
  dependsOn: string[];
  /** Human-readable reason (e.g., "requires a successful login first"). */
  reason?: string;
}

/**
 * Variant relationship (from `variant_of` edges): scenario Y is a variant of X.
 */
export interface ScenarioVariant {
  scenarioId: string;
  /** The canonical happy-path scenario this is a variant of. */
  variantOf: string;
  /** Human-readable reason (e.g., "negative variant of the happy path"). */
  reason?: string;
}

/**
 * Scenario Context — the domain-friendly view the Orchestrator provides.
 * Consumers never see the raw graph (nodes/edges/fingerprint).
 *
 * Kept as a single flat type on purpose (see file header): we'll split it later
 * if/when real consumers reveal natural boundaries.
 */
export interface ScenarioContext {
  available: boolean;
  /** Total scenario count. */
  scenarioCount: number;
  /** How many scenarios are grounded in real intelligence. */
  groundedCount: number;
  /** Simplified scenario summaries. */
  scenarios: ScenarioSummary[];
  /** Execution dependencies (precedes edges). */
  dependencies: ScenarioDependency[];
  /** Variant relationships (variant_of edges). */
  variants: ScenarioVariant[];
  /**
   * Suggested execution order (topologically sorted scenario IDs).
   * Falls back to original order if there are no dependencies / a cycle.
   */
  precedence: string[];
}

/* ================================================================== */
/*  Provider Implementation                                            */
/* ================================================================== */

/**
 * ScenarioGraphProvider — gathers canonical scenario intelligence for a
 * requirement and returns it as ScenarioContext.
 */
export class ScenarioGraphProvider implements IntelligenceProvider<ScenarioContext> {
  readonly name = 'scenarioGraph';
  readonly version = SCENARIO_GRAPH_VERSION;
  readonly priority = SCENARIO_GRAPH_PRIORITY;

  /** Feature flag — default false for backwards compatibility. */
  enabled(): boolean {
    return process.env.SCENARIO_GRAPH_PROVIDER === 'true';
  }

  async gather(query: IntelligenceQuery): Promise<IntelligenceResult<ScenarioContext>> {
    const startMs = Date.now();

    // Guard: feature flag off → unavailable immediately.
    // (Registry also checks enabled(); this keeps the provider safe if called directly.)
    if (!this.enabled()) {
      return this.unavailable('Feature flag SCENARIO_GRAPH_PROVIDER is off', 0);
    }

    // Guard: no requirementId → can't build/fetch a graph
    if (!query.requirementId) {
      return this.unavailable(
        'No requirementId provided — Scenario Graph unavailable',
        Date.now() - startMs,
      );
    }

    try {
      // Build or fetch the canonical Scenario Graph (internal detail)
      const { graph, origin } = await getOrBuildScenarioGraph(
        {
          title: query.intent, // Best-effort; ideally pass full requirement
          description: '',
        },
        [...DEFAULT_COVERAGE_TYPES],
        undefined, // Knowledge context (TODO: wire from orchestrator if available)
        { requirementId: query.requirementId },
      );

      if (!graph || graph.nodes.length === 0) {
        return this.unavailable(
          'Scenario Graph returned no scenarios for this requirement',
          Date.now() - startMs,
        );
      }

      logger.info(MOD, `Scenario Graph ${origin}`, {
        requirementId: query.requirementId,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        fingerprint: graph.fingerprint,
      });

      // Project the internal graph into the public ScenarioContext
      const context = this.projectToContext(graph);

      return {
        available: true,
        context,
        // NOTE: no `confidence` here — the registry fills it from `signals`.
        metadata: {
          provider: this.name,
          providerVersion: this.version,
          durationMs: Date.now() - startMs,
          cacheHit: origin === 'reused',
          items: context.scenarioCount,
          warnings: [],
          signals: this.qualitySignals(graph, context),
          version: {
            fingerprint: graph.fingerprint,
            timestamp: graph.builtAt,
          },
        },
      };
    } catch (err: any) {
      logger.warn(MOD, 'Scenario Graph gather failed (fail-open)', { error: err?.message });
      return this.unavailable(
        `Scenario Graph provider error: ${err?.message || 'unknown'}`,
        Date.now() - startMs,
      );
    }
  }

  /** Build a standardized unavailable result with consistent, empty signals. */
  private unavailable(warning: string, durationMs: number): IntelligenceResult<ScenarioContext> {
    return {
      available: false,
      context: null,
      metadata: {
        provider: this.name,
        providerVersion: this.version,
        durationMs,
        cacheHit: false,
        items: 0,
        warnings: [warning],
        signals: {},
      },
    };
  }

  /**
   * Derive standardized, NORMALIZED quality signals (0-1) from the graph.
   * The centralized scorer turns these into a confidence number — this provider
   * never scores itself.
   *
   *   • grounding — fraction of scenarios backed by real App Profile / Test Data.
   *   • coverage  — distinct coverage types present / requested coverage types.
   */
  private qualitySignals(graph: ScenarioGraph, context: ScenarioContext): QualitySignals {
    const grounding = context.scenarioCount > 0
      ? context.groundedCount / context.scenarioCount
      : 0;

    const distinctCoverage = new Set(graph.nodes.map(n => n.coverageType)).size;
    const coverage = Math.min(1, distinctCoverage / DEFAULT_COVERAGE_TYPES.length);

    return { grounding, coverage };
  }

  /**
   * Project the internal ScenarioGraph into the public ScenarioContext.
   * This is the isolation layer: consumers never see nodes/edges/fingerprint.
   */
  private projectToContext(graph: ScenarioGraph): ScenarioContext {
    // Scenarios (simplified)
    const scenarios: ScenarioSummary[] = graph.nodes.map(n => ({
      id: n.id,
      title: n.title,
      objective: n.objective,
      coverageType: n.coverageType,
      priority: n.priority,
      severity: n.severity,
      riskArea: n.riskArea,
      automationReady: n.automationReady,
      automationComplexity: n.automationComplexity,
      grounded: n.grounded,
      ...(n.semantics ? { semantics: n.semantics } : {}),
    }));

    const groundedCount = scenarios.filter(s => s.grounded).length;

    // Dependencies (from precedes edges)
    const dependencies: ScenarioDependency[] = [];
    for (const node of graph.nodes) {
      const deps = graph.edges
        .filter(e => e.type === 'precedes' && e.to === node.id)
        .map(e => e.from);
      if (deps.length > 0) {
        dependencies.push({
          scenarioId: node.id,
          dependsOn: deps,
          reason: graph.edges.find(e => e.type === 'precedes' && e.to === node.id)?.reason,
        });
      }
    }

    // Variants (from variant_of edges)
    const variants: ScenarioVariant[] = graph.edges
      .filter(e => e.type === 'variant_of')
      .map(e => ({
        scenarioId: e.from,
        variantOf: e.to,
        reason: e.reason,
      }));

    // Precedence (topological sort of dependencies)
    const precedence = this.topologicalSort(graph.nodes.map(n => n.id), dependencies);

    return {
      available: true,
      scenarioCount: scenarios.length,
      groundedCount,
      scenarios,
      dependencies,
      variants,
      precedence,
    };
  }

  /**
   * Topological sort (Kahn's algorithm) to compute execution order.
   * Returns sorted scenario IDs. If a cycle exists, breaks it and logs a warning.
   */
  private topologicalSort(scenarioIds: string[], dependencies: ScenarioDependency[]): string[] {
    if (dependencies.length === 0) return scenarioIds.slice(); // No dependencies → original order

    const graph = new Map<string, string[]>();
    const inDegree = new Map<string, number>();

    // Initialize
    for (const id of scenarioIds) {
      graph.set(id, []);
      inDegree.set(id, 0);
    }

    // Build adjacency list + in-degrees
    for (const dep of dependencies) {
      inDegree.set(dep.scenarioId, dep.dependsOn.length);
      for (const prereq of dep.dependsOn) {
        if (graph.has(prereq)) {
          graph.get(prereq)!.push(dep.scenarioId);
        }
      }
    }

    // Kahn's algorithm
    const queue: string[] = [];
    const sorted: string[] = [];

    for (const [id, deg] of inDegree) {
      if (deg === 0) queue.push(id);
    }

    while (queue.length > 0) {
      const curr = queue.shift()!;
      sorted.push(curr);

      for (const neighbor of graph.get(curr) || []) {
        const deg = inDegree.get(neighbor)! - 1;
        inDegree.set(neighbor, deg);
        if (deg === 0) queue.push(neighbor);
      }
    }

    // Cycle detection: if sorted.length < scenarioIds.length, a cycle exists
    if (sorted.length < scenarioIds.length) {
      logger.warn(MOD, 'Dependency cycle detected in scenario graph — falling back to original order');
      return scenarioIds.slice();
    }

    return sorted;
  }
}

/**
 * Singleton provider instance (matches orchestrator pattern).
 */
let providerInstance: ScenarioGraphProvider | undefined;

export function getScenarioGraphProvider(): ScenarioGraphProvider {
  if (!providerInstance) {
    providerInstance = new ScenarioGraphProvider();
  }
  return providerInstance;
}
