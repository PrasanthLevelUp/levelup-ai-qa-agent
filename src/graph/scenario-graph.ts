/**
 * Persistent Scenario Graph — the ONE intelligence source.
 * ============================================================================
 *
 * The long-term architecture: a requirement is parsed into a canonical graph of
 * scenarios ONCE, stored, and then REUSED by every module instead of each module
 * re-deriving the same knowledge:
 *
 *        Requirement
 *             │
 *             ▼
 *        Scenario Graph  ── Login Success / Invalid Password / Invalid Email /
 *             │            Empty Fields / Password Masking / SQL Injection /
 *             │            Session Timeout / Remember Me …
 *             ▼
 *        Store once
 *             │
 *             ▼
 *        Reuse everywhere
 *          ├── Test Case Lab        (formats the nodes into test cases)
 *          ├── Script Generation    (turns nodes into automation specs)
 *          ├── Healing              (maps a broken selector back to its nodes)
 *          ├── RTM                  (requirement → scenario traceability rows)
 *          └── Impact Analysis      (a changed selector/page → impacted nodes)
 *
 *      AI only POLISHES wording or FILLS gaps — it is never the source of truth.
 *
 * This module defines the canonical, serialisable domain model. It is pure data
 * + tiny pure helpers: no I/O, no LLM, no framework types. The builder
 * (scenario-graph-builder.ts) produces it deterministically from the existing
 * planner → builder → validator pipeline; the service (scenario-graph-service.ts)
 * persists and reuses it; the adapters (scenario-graph-adapters.ts) project it
 * into the exact shape each consuming module needs.
 */

import { createHash } from 'crypto';

/* ------------------------------------------------------------------ */
/*  Node                                                               */
/* ------------------------------------------------------------------ */

export type ScenarioCoverageType = string; // mirrors engine CoverageType (kept loose to avoid a hard dep)
export type ScenarioPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type ScenarioSeverity = 'critical' | 'major' | 'minor' | 'trivial';
export type ScenarioSource = 'requirement' | 'knowledge' | 'test_data' | 'app_profile';

/**
 * A single canonical scenario — the atomic unit of testable intent. This is the
 * shared "truth" every module reads. It carries everything a module could need:
 * the human-readable intent (title/objective), the grounded execution detail
 * (steps/selectors/testData), and the QA metadata (coverage/priority/severity/
 * grounding provenance). Modules take a PROJECTION of this — none of them
 * re-derive it.
 */
export interface ScenarioNode {
  /** Stable canonical id (the KB scenarioId). Unique within a graph. */
  id: string;
  title: string;
  objective: string;
  coverageType: ScenarioCoverageType;
  priority: ScenarioPriority;
  severity: ScenarioSeverity;
  riskArea: string;
  preconditions: string;
  steps: string[];
  expectedResult: string;
  /** Selectors referenced by the steps (typed, deterministic). */
  selectors: string[];
  testData: string;
  tags: string[];
  automationReady: boolean;
  automationComplexity: 'low' | 'medium' | 'high';
  selectorAvailability: 'high' | 'medium' | 'low' | 'unknown';
  source: ScenarioSource;
  sourceEvidence: string;
  /** True when the scenario is grounded in the requirement/app profile/test data. */
  grounded: boolean;
}

/* ------------------------------------------------------------------ */
/*  Edge                                                               */
/* ------------------------------------------------------------------ */

/**
 * Typed relationships between nodes. Edges are what make this a GRAPH rather
 * than a list — and they are exactly what powers cross-module reuse:
 *   • variant_of      — a negative/edge/security node varies the happy path it
 *                       is derived from (same risk area). Lets RTM group and
 *                       Test Case Lab order coherently.
 *   • precedes        — this node must run before the target (e.g. a successful
 *                       login precedes "session timeout" / "remember me").
 *                       Script Gen uses this to sequence flows.
 *   • shares_selector — two nodes touch the same selector. This is the backbone
 *                       of Impact Analysis + Healing: a changed/broken selector
 *                       fans out to every node that shares it.
 */
export type ScenarioEdgeType = 'variant_of' | 'precedes' | 'shares_selector';

export interface ScenarioEdge {
  from: string; // node id
  to: string;   // node id
  type: ScenarioEdgeType;
  /** Optional human-readable reason (e.g. the shared selector). */
  reason?: string;
}

/* ------------------------------------------------------------------ */
/*  Graph                                                              */
/* ------------------------------------------------------------------ */

export interface ScenarioGraphRequirementRef {
  /** DB requirement id when persisted; undefined for an in-memory build. */
  requirementId?: number;
  title: string;
  module?: string;
  jiraId?: string;
}

export interface ScenarioGraph {
  /** Schema version of the graph model itself. */
  schemaVersion: string;
  /** QA knowledge-base version the nodes were planned from (telemetry). */
  knowledgeVersion: string;
  /** The QA category the requirement classified as (auth, crud, …). */
  category: string;
  /** Coverage types the graph was built for (the user's selection). */
  coverageTypes: ScenarioCoverageType[];
  requirement: ScenarioGraphRequirementRef;
  nodes: ScenarioNode[];
  edges: ScenarioEdge[];
  /**
   * Content fingerprint — a stable hash over the inputs that determine the
   * graph (requirement text + coverage selection + KB version + node ids).
   * The service rebuilds ONLY when this changes, which is what "parse once,
   * reuse everywhere" means in practice.
   */
  fingerprint: string;
  builtAt: string; // ISO timestamp
}

export const SCENARIO_GRAPH_SCHEMA_VERSION = '1.0.0';

/* ------------------------------------------------------------------ */
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

/** Stable SHA-1 of the semantic inputs — deterministic across processes. */
export function computeFingerprint(parts: {
  requirementText: string;
  coverageTypes: string[];
  knowledgeVersion: string;
  nodeIds: string[];
}): string {
  const canonical = JSON.stringify({
    r: parts.requirementText.trim().replace(/\s+/g, ' '),
    c: [...parts.coverageTypes].sort(),
    k: parts.knowledgeVersion,
    n: [...parts.nodeIds].sort(),
  });
  return createHash('sha1').update(canonical).digest('hex');
}

/** Look a node up by its canonical id. */
export function getNode(graph: ScenarioGraph, id: string): ScenarioNode | undefined {
  return graph.nodes.find(n => n.id === id);
}

/** Every node that references a given selector (Impact Analysis / Healing). */
export function nodesUsingSelector(graph: ScenarioGraph, selector: string): ScenarioNode[] {
  const key = (selector || '').trim().toLowerCase();
  if (!key) return [];
  return graph.nodes.filter(n => n.selectors.some(s => s.trim().toLowerCase() === key));
}

/** Every node whose steps navigate to / reference a given page or URL fragment. */
export function nodesUsingPage(graph: ScenarioGraph, page: string): ScenarioNode[] {
  const key = (page || '').trim().toLowerCase();
  if (!key) return [];
  return graph.nodes.filter(n => n.steps.some(s => s.toLowerCase().includes(key)));
}

/** Outgoing edges of a given type from a node. */
export function outgoingEdges(graph: ScenarioGraph, id: string, type?: ScenarioEdgeType): ScenarioEdge[] {
  return graph.edges.filter(e => e.from === id && (!type || e.type === type));
}
