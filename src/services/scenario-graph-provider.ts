/**
 * Scenario Graph Intelligence Provider
 * ============================================================================
 *
 * Provides **ScenarioContext** (NOT the raw graph) to the Orchestrator.
 * Consumers (Script Gen, Healing, RTM) never see nodes/edges/fingerprints —
 * they receive a domain-friendly view: scenarios, dependencies, variants.
 *
 * This provider is the ONLY module that imports the graph. All other modules
 * consume ScenarioContext from the unified Intelligence Bundle. This isolation
 * means we can completely redesign the graph internals without breaking
 * consumers.
 *
 * ── Composable context (Phase 2 review) ──────────────────────────────────────
 * Instead of one ever-growing `ScenarioContext`, the graph exposes small,
 * composable slices:
 *   • ScenarioContext          — identity + scenario summaries (everyone)
 *   • ScenarioExecutionContext — dependencies + precedence   (Script Gen)
 *   • ScenarioCoverageContext  — variants + coverage-by-type (Test Case Lab/RTM)
 *   • ScenarioImpactContext    — affected modules            (Impact Analysis)
 * These are bundled into `ScenarioContextBundle`; a consumer destructures only
 * the slice it needs, and new needs add a new slice rather than bloating one type.
 *
 * ── Confidence (Phase 2 review) ──────────────────────────────────────────────
 * This provider does NOT compute confidence. It emits raw `signals`
 * (`scenarioCount`, `groundedCount`); the centralized scorer
 * (`intelligence-confidence.ts`) turns them into a number. That keeps scoring
 * consistent across all sources.
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
} from './intelligence-provider';
import { getOrBuildScenarioGraph } from '../graph/scenario-graph-service';
import type { ScenarioGraph } from '../graph/scenario-graph';

const MOD = 'ScenarioGraphProvider';

/**
 * Priority for the Scenario Graph source. Higher than foundational sources
 * (repository, app profile) because it's a derived, advisory layer that ideally
 * runs after primary context is available. See ProviderRegistry ordering.
 */
const SCENARIO_GRAPH_PRIORITY = 70;

/* ================================================================== */
/*  Scenario Context — composable slices consumers receive             */
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
 * Base context — scenario identity and summaries. The slice every consumer gets.
 */
export interface ScenarioContext {
  available: boolean;
  /** Total scenario count. */
  scenarioCount: number;
  /** How many scenarios are grounded in real intelligence. */
  groundedCount: number;
  /** Simplified scenario summaries. */
  scenarios: ScenarioSummary[];
}

/**
 * Execution slice — for Script Generation ordering (advisory `test.order.json`).
 */
export interface ScenarioExecutionContext {
  /** Execution dependencies (precedes edges). */
  dependencies: ScenarioDependency[];
  /**
   * Suggested execution order (topologically sorted scenario IDs).
   * Falls back to original order if there are no dependencies / a cycle.
   */
  precedence: string[];
}

/**
 * Coverage slice — for Test Case Lab / RTM to understand coverage shape.
 */
export interface ScenarioCoverageContext {
  /** Variant relationships (variant_of edges). */
  variants: ScenarioVariant[];
  /** Count of scenarios per coverage type (positive/negative/edge_cases/…). */
  coverageByType: Record<string, number>;
}

/**
 * Impact slice — for Impact Analysis. Placeholder for now (populated once the
 * graph carries module/selector-sharing signals); kept as its own type so it
 * can grow without touching the others.
 */
export interface ScenarioImpactContext {
  /** Modules/areas potentially affected (empty until wired). */
  affectedModules: string[];
}

/**
 * Composite the provider returns. Consumers destructure only the slice they
 * need (`bundle.execution`, `bundle.coverage`, …) so adding a future slice never
 * breaks existing consumers.
 */
export interface ScenarioContextBundle {
  base: ScenarioContext;
  execution: ScenarioExecutionContext;
  coverage: ScenarioCoverageContext;
  impact: ScenarioImpactContext;
}

/* ================================================================== */
/*  Provider Implementation                                            */
/* ================================================================== */

/**
 * ScenarioGraphProvider — gathers canonical scenario intelligence for a
 * requirement and returns it as a ScenarioContextBundle.
 */
export class ScenarioGraphProvider implements IntelligenceProvider<ScenarioContextBundle> {
  readonly name = 'scenarioGraph';
  readonly priority = SCENARIO_GRAPH_PRIORITY;

  /** Feature flag — default false for backwards compatibility. */
  enabled(): boolean {
    return process.env.SCENARIO_GRAPH_PROVIDER === 'true';
  }

  async gather(query: IntelligenceQuery): Promise<IntelligenceResult<ScenarioContextBundle>> {
    const startMs = Date.now();
    const warnings: string[] = [];

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
        ['positive', 'negative', 'edge_cases', 'security'], // Default coverage
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

      // Project the internal graph into the public bundle
      const bundle = this.projectToBundle(graph);
      const { scenarioCount, groundedCount } = bundle.base;

      return {
        available: true,
        context: bundle,
        // NOTE: no `confidence` here — the registry fills it from `signals`.
        metadata: {
          provider: this.name,
          durationMs: Date.now() - startMs,
          cacheHit: origin === 'reused',
          items: scenarioCount,
          warnings,
          signals: { scenarioCount, groundedCount },
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
  private unavailable(warning: string, durationMs: number): IntelligenceResult<ScenarioContextBundle> {
    return {
      available: false,
      context: null,
      metadata: {
        provider: this.name,
        durationMs,
        cacheHit: false,
        items: 0,
        warnings: [warning],
        signals: {},
      },
    };
  }

  /**
   * Project the internal ScenarioGraph into the public ScenarioContextBundle.
   * This is the isolation layer: consumers never see nodes/edges/fingerprint.
   */
  private projectToBundle(graph: ScenarioGraph): ScenarioContextBundle {
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

    // Coverage-by-type histogram
    const coverageByType: Record<string, number> = {};
    for (const s of scenarios) {
      coverageByType[s.coverageType] = (coverageByType[s.coverageType] || 0) + 1;
    }

    // Precedence (topological sort of dependencies)
    const precedence = this.topologicalSort(graph.nodes.map(n => n.id), dependencies);

    return {
      base: {
        available: true,
        scenarioCount: scenarios.length,
        groundedCount,
        scenarios,
      },
      execution: {
        dependencies,
        precedence,
      },
      coverage: {
        variants,
        coverageByType,
      },
      impact: {
        affectedModules: [], // populated in a future PR once the graph carries this
      },
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
