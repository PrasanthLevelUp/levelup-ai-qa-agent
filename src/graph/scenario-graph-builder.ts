/**
 * Scenario Graph Builder — parses a requirement into the canonical graph ONCE.
 * ============================================================================
 *
 * This is deliberately a THIN, deterministic composition over the pipeline that
 * already exists — the planner decides WHAT to test, the builder grounds it, the
 * validator proves it. The graph is simply the persistent, reusable crystallised
 * form of that pipeline's output, plus typed edges so it is a real graph.
 *
 * Discipline (identical to planner/builder/validator):
 *   • Pure & synchronous — no I/O, no LLM, no randomness.
 *   • Deterministic — identical inputs ⇒ byte-identical graph (same fingerprint).
 *   • Never invents coverage — nodes come straight from the grounded drafts.
 */

import { planScenarios } from '../engines/scenario-planner';
import {
  buildDraftTestCases,
  buildDeterministicOutput,
  type DraftTestCase,
} from '../engines/scenario-builder';
import { validateCanonicalTestCases } from '../engines/canonical-validator';
import { getScenarioSemantics } from '../engines/qa-knowledge-engine';
import {
  type ScenarioGraph,
  type ScenarioNode,
  type ScenarioEdge,
  type ScenarioPriority,
  type ScenarioSeverity,
  type ScenarioSource,
  type ScenarioSemantics,
  SCENARIO_GRAPH_SCHEMA_VERSION,
  computeFingerprint,
} from './scenario-graph';

/* ------------------------------------------------------------------ */
/*  Loose input shapes (decoupled from the engine types)               */
/* ------------------------------------------------------------------ */

export interface GraphRequirementInput {
  title: string;
  description: string;
  module?: string;
  businessFlow?: string;
  acceptanceCriteria?: string;
  jiraId?: string;
}

export interface BuildScenarioGraphOptions {
  requirementId?: number;
  featureTypeHint?: string;
  /** Fixed timestamp for deterministic tests; defaults to now(). */
  now?: string;
}

/* ------------------------------------------------------------------ */
/*  Edge derivation                                                    */
/* ------------------------------------------------------------------ */

const norm = (s?: string) => (s || '').trim().toLowerCase();

/** Coverage types that represent the "happy path" a variant is derived from. */
const HAPPY_PATH_COVERAGE = new Set(['positive']);

/**
 * Keywords that mean a node PRESUPPOSES a successful primary action (so the
 * happy path must run first). Grounded, conservative — only fires on strong
 * signals, never guesses.
 */
const PRESUPPOSES_SUCCESS = [
  'session', 'timeout', 'remember me', 'remember-me', 'logout', 'log out',
  'after login', 'once logged in', 'authenticated', 'dashboard', 'expire',
];

/**
 * Derive typed edges from the nodes deterministically:
 *   • variant_of      — each non-happy-path node → the happy-path node in the
 *                       SAME risk area (its canonical origin).
 *   • precedes        — the happy-path node → any node that presupposes success.
 *   • shares_selector — any two nodes that reference the same selector.
 */
export function deriveEdges(nodes: ScenarioNode[]): ScenarioEdge[] {
  const edges: ScenarioEdge[] = [];

  // Index the happy-path node per risk area (first one wins — deterministic
  // because node order is deterministic).
  const happyByRisk = new Map<string, ScenarioNode>();
  for (const n of nodes) {
    if (HAPPY_PATH_COVERAGE.has(norm(n.coverageType))) {
      const key = norm(n.riskArea);
      if (!happyByRisk.has(key)) happyByRisk.set(key, n);
    }
  }
  // Fallback single happy path (first positive anywhere) when risk areas differ.
  const anyHappy = nodes.find(n => HAPPY_PATH_COVERAGE.has(norm(n.coverageType)));

  for (const n of nodes) {
    if (HAPPY_PATH_COVERAGE.has(norm(n.coverageType))) continue;
    const origin = happyByRisk.get(norm(n.riskArea)) || anyHappy;
    if (origin && origin.id !== n.id) {
      edges.push({ from: n.id, to: origin.id, type: 'variant_of', reason: `${n.coverageType} variant of the happy path` });
    }
  }

  // precedes: happy path → nodes that presuppose a successful primary action.
  if (anyHappy) {
    for (const n of nodes) {
      if (n.id === anyHappy.id) continue;
      const hay = `${norm(n.title)} ${norm(n.objective)} ${n.steps.map(norm).join(' ')}`;
      if (PRESUPPOSES_SUCCESS.some(k => hay.includes(k))) {
        edges.push({ from: anyHappy.id, to: n.id, type: 'precedes', reason: 'requires a successful primary action first' });
      }
    }
  }

  // shares_selector: undirected-but-recorded-once (i<j) pairs sharing a selector.
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!;
      const b = nodes[j]!;
      const shared = a.selectors.find(s => b.selectors.some(t => norm(t) === norm(s) && norm(s) !== ''));
      if (shared) {
        edges.push({ from: a.id, to: b.id, type: 'shares_selector', reason: shared });
      }
    }
  }

  return edges;
}

/* ------------------------------------------------------------------ */
/*  Builder                                                            */
/* ------------------------------------------------------------------ */

/** Minimal canonical-case shape the assembler reads (matches FormatterTestCase). */
export interface CanonicalCaseLike {
  scenarioId: string;
  title: string;
  objective?: string;
  riskArea: string;
  preconditions: string;
  steps: string[];
  expectedResult: string;
  selectors: string[];
  testData: string;
  priority: string;
  severity: string;
  tags: string[];
  automationReady: boolean;
  automationComplexity: string;
  selectorAvailability: string;
  source: string;
  sourceEvidence: string;
}

/** Per-node coverage + grounding, index-aligned with the canonical cases. */
export interface NodeMetaLike {
  coverageType?: string;
  grounded?: boolean;
  objective?: string;
  /**
   * The scenario's application-neutral semantics, resolved from the Knowledge
   * Base (`getScenarioSemantics`) by the caller. Index-aligned with the cases;
   * carried straight onto the node so consumers read one canonical answer.
   */
  semantics?: ScenarioSemantics;
}

export interface AssembleGraphArgs {
  input: GraphRequirementInput;
  coverageTypes: string[];
  cases: CanonicalCaseLike[];
  /** Index-aligned coverage/grounding (from the drafts/scenarios). */
  meta: NodeMetaLike[];
  knowledgeVersion: string;
  category: string;
  requirementId?: number;
  now?: string;
}

/** Turn index-aligned canonical cases + meta into typed scenario nodes. */
function nodesFromCases(cases: CanonicalCaseLike[], meta: NodeMetaLike[]): ScenarioNode[] {
  return cases.map((tc, i) => {
    const m = meta[i] || {};
    return {
      id: tc.scenarioId,
      title: tc.title,
      objective: tc.objective ?? m.objective ?? '',
      ...(m.semantics ? { semantics: m.semantics } : {}),
      coverageType: m.coverageType ?? 'positive',
      priority: tc.priority as ScenarioPriority,
      severity: tc.severity as ScenarioSeverity,
      riskArea: tc.riskArea,
      preconditions: tc.preconditions,
      steps: tc.steps.slice(),
      expectedResult: tc.expectedResult,
      selectors: tc.selectors.slice(),
      testData: tc.testData,
      tags: tc.tags.slice(),
      automationReady: tc.automationReady,
      automationComplexity: tc.automationComplexity as ScenarioNode['automationComplexity'],
      selectorAvailability: tc.selectorAvailability as ScenarioNode['selectorAvailability'],
      source: tc.source as ScenarioSource,
      sourceEvidence: tc.sourceEvidence,
      grounded: m.grounded ?? false,
    };
  });
}

/**
 * Assemble a ScenarioGraph from ALREADY-COMPUTED canonical cases (+ per-node
 * coverage/grounding meta). This is the shared core: the full builder uses it
 * after running the pipeline, and the engine uses it directly with the cases it
 * already validated — so Test Case Lab sources its output FROM the graph without
 * paying to run the pipeline twice.
 */
export function assembleScenarioGraph(args: AssembleGraphArgs): ScenarioGraph {
  const nodes = nodesFromCases(args.cases, args.meta);
  const edges = deriveEdges(nodes);

  const requirementText = [
    args.input.title, args.input.description, args.input.module,
    args.input.businessFlow, args.input.acceptanceCriteria,
  ].filter(Boolean).join('\n');

  const fingerprint = computeFingerprint({
    requirementText,
    coverageTypes: args.coverageTypes,
    knowledgeVersion: args.knowledgeVersion,
    nodeIds: nodes.map(n => n.id),
  });

  return {
    schemaVersion: SCENARIO_GRAPH_SCHEMA_VERSION,
    knowledgeVersion: args.knowledgeVersion,
    category: args.category,
    coverageTypes: [...args.coverageTypes],
    requirement: {
      requirementId: args.requirementId,
      title: args.input.title,
      module: args.input.module,
      jiraId: args.input.jiraId,
    },
    nodes,
    edges,
    fingerprint,
    builtAt: args.now ?? new Date().toISOString(),
  };
}

/**
 * Build the canonical Scenario Graph for a requirement, running the full
 * planner → builder → validator pipeline. Deterministic and fail-open: an
 * empty/unclassifiable requirement yields an empty graph (never throws).
 * Coverage is sourced from the grounded drafts — never invented here.
 */
export function buildScenarioGraph(
  input: GraphRequirementInput,
  coverageTypes: string[],
  knowledge?: any,
  options?: BuildScenarioGraphOptions,
): ScenarioGraph {
  // 1. Plan (WHAT to test) → 2. Build drafts (ground them) →
  // 3. Deterministic output → 4. Validate/repair. Every stage is the SAME code
  // the engine uses, so the graph is exactly what Test Case Lab would produce.
  const plan = planScenarios(input as any, coverageTypes as any, options?.featureTypeHint);
  const { drafts } = buildDraftTestCases(plan, knowledge, input as any);
  const det = buildDeterministicOutput(drafts);
  const { cases } = validateCanonicalTestCases(det.testCases, knowledge);

  // Resolve each planned scenario's canonical semantics ONCE, keyed by its
  // stable scenarioId, so the node carries the same answer the KB authored.
  const semanticsById = new Map<string, ScenarioSemantics>();
  for (const s of plan.scenarios) semanticsById.set(s.id, getScenarioSemantics(s));

  // The arrays are index-aligned (all derived from `drafts` in order):
  // det.scenarios[i] ↔ cases[i] ↔ drafts[i].
  const meta: NodeMetaLike[] = drafts.map((d: DraftTestCase, i) => ({
    coverageType: det.scenarios[i]?.coverageType ?? d.coverageType,
    grounded: d.grounded,
    objective: d.objective,
    semantics: semanticsById.get(d.scenarioId),
  }));

  return assembleScenarioGraph({
    input,
    coverageTypes,
    cases,
    meta,
    knowledgeVersion: plan.knowledgeVersion,
    category: plan.classification.category,
    requirementId: options?.requirementId,
    now: options?.now,
  });
}
