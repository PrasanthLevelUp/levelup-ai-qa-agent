/**
 * Scenario Graph Service — the single "get the intelligence" entry point.
 * ============================================================================
 *
 * This is what every module calls. It implements "parse once, reuse everywhere":
 *
 *   1. Build the canonical graph deterministically for the requirement.
 *   2. Compute its fingerprint (requirement text + coverage + KB version).
 *   3. If a stored graph with that fingerprint exists → REUSE it (no rebuild).
 *   4. Otherwise → persist the freshly-built graph (store once) and return it.
 *
 * FAIL-OPEN: persistence is best-effort. With no DATABASE_URL, or on any DB
 * error, the service still returns a correct freshly-built graph — the pipeline
 * never depends on the store being reachable. The store is an optimisation and a
 * cross-module contract, never a hard dependency.
 *
 * The build itself is the existing planner → builder → validator pipeline, so
 * the graph is identical to what Test Case Lab would compute inline — it is just
 * computed ONCE and shared.
 */

import { logger } from '../utils/logger';
import {
  buildScenarioGraph,
  type GraphRequirementInput,
} from './scenario-graph-builder';
import type { ScenarioGraph } from './scenario-graph';

const MOD = 'scenario-graph-service';

/** True when the persistent Scenario Graph store is enabled (default true). */
export function scenarioGraphEnabled(): boolean {
  return (process.env['GEN_SCENARIO_GRAPH'] ?? 'true').toLowerCase() !== 'false';
}

export interface GetOrBuildOptions {
  requirementId?: number;
  companyId?: number;
  projectId?: number;
  featureTypeHint?: string;
  /** Force a rebuild + re-store even if a matching fingerprint exists. */
  forceRebuild?: boolean;
}

export interface GetOrBuildResult {
  graph: ScenarioGraph;
  /** 'reused' — loaded from the store; 'built' — freshly built (+persisted if possible). */
  origin: 'reused' | 'built';
  /** True when the returned graph was successfully persisted this call. */
  persisted: boolean;
}

/**
 * Lazily require the DB repository so this module has NO hard dependency on the
 * database layer (keeps the graph engine unit-testable without pg, and lets the
 * service fail open when there is no DATABASE_URL).
 */
function repo(): {
  saveScenarioGraph: (g: any, scope?: any) => Promise<any>;
  getScenarioGraph: (reqId: number, fp: string) => Promise<any>;
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const db = require('../db/postgres');
    if (db && typeof db.saveScenarioGraph === 'function') return db;
    return null;
  } catch {
    return null;
  }
}

/**
 * The one call the whole platform uses to obtain a requirement's scenario graph.
 * Deterministic + fail-open. Builds, then reuses-or-stores.
 */
export async function getOrBuildScenarioGraph(
  input: GraphRequirementInput,
  coverageTypes: string[],
  knowledge?: unknown,
  options?: GetOrBuildOptions,
): Promise<GetOrBuildResult> {
  // Always build deterministically first — this is cheap (zero LLM) and gives us
  // the fingerprint we key reuse on. Build is the source of truth; the store is
  // just a cache/contract for other modules.
  const built = buildScenarioGraph(input, coverageTypes, knowledge, {
    requirementId: options?.requirementId,
    featureTypeHint: options?.featureTypeHint,
  });

  const canPersist = scenarioGraphEnabled() && !!options?.requirementId && !!process.env['DATABASE_URL'];
  if (!canPersist) {
    return { graph: built, origin: 'built', persisted: false };
  }

  const db = repo();
  if (!db) return { graph: built, origin: 'built', persisted: false };

  // Reuse path: identical fingerprint already stored ⇒ return it untouched.
  if (!options?.forceRebuild) {
    try {
      const existing = await db.getScenarioGraph(options!.requirementId!, built.fingerprint);
      if (existing?.graph) {
        logger.info(MOD, 'Scenario graph reused', {
          requirementId: options!.requirementId, fingerprint: built.fingerprint,
          nodes: built.nodes.length, edges: built.edges.length,
        });
        return { graph: existing.graph as ScenarioGraph, origin: 'reused', persisted: true };
      }
    } catch (err) {
      logger.warn(MOD, 'Scenario graph read failed — falling back to fresh build', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Store-once path: persist the freshly-built graph (best-effort).
  try {
    await db.saveScenarioGraph(built, {
      requirementId: options!.requirementId,
      companyId: options?.companyId,
      projectId: options?.projectId,
    });
    logger.info(MOD, 'Scenario graph built + stored', {
      requirementId: options!.requirementId, fingerprint: built.fingerprint,
      category: built.category, nodes: built.nodes.length, edges: built.edges.length,
    });
    return { graph: built, origin: 'built', persisted: true };
  } catch (err) {
    logger.warn(MOD, 'Scenario graph persist failed — returning in-memory graph', {
      error: err instanceof Error ? err.message : String(err),
    });
    return { graph: built, origin: 'built', persisted: false };
  }
}

// Re-export the pure builder + adapters so consumers import from one module.
export { buildScenarioGraph } from './scenario-graph-builder';
export * from './scenario-graph-adapters';
export type { ScenarioGraph, ScenarioNode, ScenarioEdge } from './scenario-graph';
