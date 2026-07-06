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
 * Discipline:
 *   • Fail-open: errors return `available: false`, never throw.
 *   • Feature-flagged: `SCENARIO_GRAPH_PROVIDER` (default false).
 *   • Weight 0 in grounding initially — advisory context only.
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
   * Empty if no dependencies exist.
   */
  precedence: string[];
}

/* ================================================================== */
/*  Provider Implementation                                            */
/* ================================================================== */

/**
 * Feature flag — default false for backwards compatibility.
 */
function isEnabled(): boolean {
  return process.env.SCENARIO_GRAPH_PROVIDER === 'true';
}

/**
 * ScenarioGraphProvider — gathers canonical scenario intelligence for a
 * requirement and returns it as ScenarioContext.
 */
export class ScenarioGraphProvider implements IntelligenceProvider<ScenarioContext> {
  readonly name = 'scenarioGraph';

  async gather(query: IntelligenceQuery): Promise<IntelligenceResult<ScenarioContext>> {
    const startMs = Date.now();
    const warnings: string[] = [];

    // Guard: feature flag off → return unavailable immediately
    if (!isEnabled()) {
      return {
        available: false,
        context: null,
        metadata: {
          timingMs: 0,
          confidence: 0,
          warnings: ['Feature flag SCENARIO_GRAPH_PROVIDER is off'],
        },
      };
    }

    // Guard: no requirementId → can't build/fetch a graph
    if (!query.requirementId) {
      return {
        available: false,
        context: null,
        metadata: {
          timingMs: Date.now() - startMs,
          confidence: 0,
          warnings: ['No requirementId provided — Scenario Graph unavailable'],
        },
      };
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
        warnings.push('Scenario Graph returned no scenarios for this requirement');
        return {
          available: false,
          context: null,
          metadata: {
            timingMs: Date.now() - startMs,
            confidence: 0,
            warnings,
          },
        };
      }

      logger.info(MOD, `Scenario Graph ${origin}`, {
        requirementId: query.requirementId,
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        fingerprint: graph.fingerprint,
      });

      // Project the internal graph into the public ScenarioContext
      const context = this.projectToContext(graph);

      // Confidence scales with grounded scenario count (grounded = real data)
      const confidence = context.groundedCount > 0
        ? Math.min(100, 60 + context.groundedCount * 5)
        : 0;

      return {
        available: true,
        context,
        metadata: {
          timingMs: Date.now() - startMs,
          confidence,
          version: {
            fingerprint: graph.fingerprint,
            timestamp: graph.builtAt,
          },
          warnings,
        },
      };
    } catch (err: any) {
      logger.warn(MOD, 'Scenario Graph gather failed (fail-open)', { error: err?.message });
      return {
        available: false,
        context: null,
        metadata: {
          timingMs: Date.now() - startMs,
          confidence: 0,
          warnings: [`Scenario Graph provider error: ${err?.message || 'unknown'}`],
        },
      };
    }
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
