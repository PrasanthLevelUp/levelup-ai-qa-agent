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
import {
  getScenarioSemantics,
  getScenarioActionTemplate,
  type ScenarioActionTemplate,
} from '../engines/qa-knowledge-engine';
import { datasetResolver, type Dataset } from '../engines/dataset-resolver';
import {
  type ScenarioGraph,
  type ScenarioNode,
  type ScenarioEdge,
  type ScenarioPriority,
  type ScenarioSeverity,
  type ScenarioSource,
  type ScenarioSemantics,
  type ScenarioAction,
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
  /**
   * Datasets available for role resolution (see `AssembleGraphArgs`). Passed
   * straight through to `assembleScenarioGraph`. Omitted means no resolution.
   */
  availableDatasets?: readonly Dataset[];
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
/*  Action materialization (KB template → canonical node actions)      */
/* ------------------------------------------------------------------ */

/**
 * MATERIALIZE a KB-authored action TEMPLATE into the graph's canonical
 * `ScenarioAction[]`.
 *
 * This is the ONLY thing the builder does with actions, and it is deliberately
 * minimal — it adds STRUCTURE (identity + order), nothing else:
 *   • assigns a STABLE SEMANTIC `id` (`<scenarioId>.<action>.<target>`, e.g.
 *     `auth-pos-valid.click.login_button`) derived from the step's business
 *     meaning, NOT its array position — so the id survives insertions/reordering
 *     and an assertion's `afterAction` can reference the step by a durable name.
 *     Duplicate meanings within one scenario get a deterministic `#n` suffix
 *     (encounter order), exactly like {@link materializeAssertionTemplate}. The
 *     `<action>.<target>` shape is INLINED, never a separate exported helper —
 *     an action has exactly ONE identity (`id`), never a second derived key;
 *   • sets `order` to the array index (a faithful copy of the KB order, never a
 *     re-sort — identity lives in `id`, sequence in `order`);
 *   • copies `target`, `value` and `optional` VERBATIM.
 *
 * It does NOT invent, add, drop, or reorder steps (the sequence is the KB's —
 * "the builder may materialize actions, but it must never invent them"), and it
 * does NOT translate targets into the application's vocabulary. Targets stay
 * CANONICAL (`username`, not `email_input`): the builder has no business knowing
 * app vocabulary, and keeping it out means the graph never has to be rebuilt when
 * the app renames a field or changes selectors. Mapping a canonical target to the
 * app's element and then to a locator is the Execution Resolver's job inside
 * Script Gen, at emit time — exactly as it already grounds the human steps.
 *
 * Pure and deterministic: identical inputs ⇒ identical output.
 */
export function materializeActionTemplate(
  scenarioId: string,
  template: readonly ScenarioActionTemplate[],
): ScenarioAction[] {
  // Count semantic-identity occurrences so a repeated `<action>.<target>` gets a
  // stable `#n` suffix instead of silently colliding — the SAME disambiguation
  // rule assertions use. Login flows never collide (navigate.login_page /
  // fill.username / fill.password / click.login_button are all distinct), but the
  // rule keeps every id UNIQUE and DETERMINISTIC for any input.
  const seen = new Map<string, number>();
  return template.map((step, i) => {
    const slug = `${step.action}.${step.target}`;
    const n = (seen.get(slug) ?? 0) + 1;
    seen.set(slug, n);
    const id = n === 1 ? `${scenarioId}.${slug}` : `${scenarioId}.${slug}#${n}`;
    const action: ScenarioAction = {
      id,
      order: i,
      action: step.action,
      target: step.target,
    };
    if (step.value !== undefined) action.value = step.value;
    if (step.optional !== undefined) action.optional = step.optional;
    return action;
  });
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
  /**
   * The scenario's canonical executable actions, materialized from the KB
   * action template (`getScenarioActionTemplate` → `materializeActionTemplate`)
   * by the caller. Targets stay CANONICAL (app-neutral); the Execution Resolver
   * in Script Gen grounds them to locators. Absent when the KB has no authored
   * template — the node then carries no `actions` and Script Gen falls back to
   * its legacy step parser.
   */
  actions?: ScenarioAction[];
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
  /**
   * Datasets available to resolve each node's `semantics.requiredDataRole`
   * against. When provided, resolution runs ONCE here at graph-build time and
   * the winning record is carried on the node under `execution.resolvedDataset`.
   * Omitted (or empty) means no resolution — nodes simply carry no `execution`,
   * which is the pre-Sprint-2C behaviour, so this is fully backwards compatible.
   */
  availableDatasets?: readonly Dataset[];
}

/** Turn index-aligned canonical cases + meta into typed scenario nodes. */
function nodesFromCases(
  cases: CanonicalCaseLike[],
  meta: NodeMetaLike[],
  availableDatasets?: readonly Dataset[],
): ScenarioNode[] {
  return cases.map((tc, i) => {
    const m = meta[i] || {};
    // Resolve the required data role EXACTLY ONCE, here, deterministically. The
    // resolver is pure and returns `null` when the role is empty or no available
    // dataset declares it — in which case the node simply carries no resolved
    // record. We never fall back, guess, or pick datasets[0].
    const role = m.semantics?.requiredDataRole;
    const resolved =
      role && availableDatasets?.length
        ? datasetResolver.resolve(role, availableDatasets)
        : null;
    return {
      id: tc.scenarioId,
      title: tc.title,
      objective: tc.objective ?? m.objective ?? '',
      ...(m.semantics ? { semantics: m.semantics } : {}),
      ...(m.actions && m.actions.length ? { actions: m.actions } : {}),
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
      // Carry the REAL (unmasked) resolved record under `execution` — the node is
      // the internal source of truth. `execution` groups all per-run facts
      // (dataset today; environment/browser/locale later) apart from scenario
      // identity. Masking is applied only at projection boundaries.
      ...(resolved ? { execution: { resolvedDataset: resolved } } : {}),
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
  const nodes = nodesFromCases(args.cases, args.meta, args.availableDatasets);
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
  // Materialize each planned scenario's KB action TEMPLATE ONCE, same keying.
  // The KB owns the sequence (`getScenarioActionTemplate`, authored-or-null —
  // never invented); the builder only materializes structure (`id`/`order`) via
  // `materializeActionTemplate` and copies targets VERBATIM (canonical). It does
  // NOT translate targets into app vocabulary — that grounding is the Execution
  // Resolver's job in Script Gen. Scenarios with no authored template get no
  // entry, so their nodes carry no `actions`.
  const actionsById = new Map<string, ScenarioAction[]>();
  for (const s of plan.scenarios) {
    semanticsById.set(s.id, getScenarioSemantics(s));
    const template = getScenarioActionTemplate(s);
    if (template) actionsById.set(s.id, materializeActionTemplate(s.id, template));
  }

  // The arrays are index-aligned (all derived from `drafts` in order):
  // det.scenarios[i] ↔ cases[i] ↔ drafts[i].
  const meta: NodeMetaLike[] = drafts.map((d: DraftTestCase, i) => ({
    coverageType: det.scenarios[i]?.coverageType ?? d.coverageType,
    grounded: d.grounded,
    objective: d.objective,
    semantics: semanticsById.get(d.scenarioId),
    actions: actionsById.get(d.scenarioId),
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
    availableDatasets: options?.availableDatasets,
  });
}
