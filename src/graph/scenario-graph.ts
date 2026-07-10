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
// Type-only import: `ResolvedDatasetRecord` is the single source of truth for a
// resolved dataset record (defined in the Dataset Resolver). Importing it as a
// TYPE keeps this pure-data graph model free of any runtime dependency — the
// import is erased at compile time — and dataset-resolver imports nothing, so
// there is no module cycle. We deliberately do NOT redeclare the shape here (as
// we do for `ScenarioSemantics`) because it is an exact, stable contract we want
// to stay identical everywhere it travels.
import type { ResolvedDatasetRecord } from '../engines/dataset-resolver';

/* ------------------------------------------------------------------ */
/*  Node                                                               */
/* ------------------------------------------------------------------ */

export type ScenarioCoverageType = string; // mirrors engine CoverageType (kept loose to avoid a hard dep)
export type ScenarioPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type ScenarioSeverity = 'critical' | 'major' | 'minor' | 'trivial';
export type ScenarioSource = 'requirement' | 'knowledge' | 'test_data' | 'app_profile';

/**
 * The application-neutral SEMANTICS carried on a node — the canonical answer to
 * "what does this scenario fundamentally mean?" so no consumer has to re-infer
 * it from the title. Mirrors `ScenarioSemantics` in the QA knowledge engine; it
 * is redeclared here (rather than imported) to keep this pure-data graph model
 * free of a hard dependency on the engine, exactly as `ScenarioCoverageType` is
 * kept loose.
 *
 * The shape encodes the single-variable principle: valid `preconditions`, the
 * one `variation` applied to them (the `variableUnderTest`), the observable
 * `expectedBehavior`, and the generic `requiredDataRole` (a data ROLE, never a
 * resolved dataset — the Dataset Resolver maps role → dataset downstream).
 */
export interface ScenarioSemantics {
  variableUnderTest: string;
  preconditions: string;
  variation: string;
  expectedBehavior: string;
  /**
   * @deprecated A data ROLE requirement (e.g. "registered_user"), never a resolved
   * dataset. It lives here only until the `resources` section lands, at which point it
   * migrates to `resources.dataRoles` (Graph Schema 2.0). Kept during migration so the
   * move stays additive. See docs/EXECUTION_GRAPH_CONTRACT.md §3.
   */
  requiredDataRole: string;
}

/**
 * A single canonical scenario — the atomic unit of testable intent. This is the
 * shared "truth" every module reads. It carries everything a module could need:
 * the human-readable intent (title/objective), the grounded execution detail
 * (steps/selectors/testData), and the QA metadata (coverage/priority/severity/
 * grounding provenance). Modules take a PROJECTION of this — none of them
 * re-derive it.
 *
 * INVARIANT — every field here must serve at least TWO downstream consumers.
 * The graph is the canonical contract, not a junk drawer: a field used by only
 * one module belongs in that module, not on the shared node. This keeps the
 * graph from slowly accreting single-purpose properties as the platform grows.
 * (`semantics` qualifies: Test Case Lab, Script Gen, Healing and the Dataset
 * Resolver all read it.)
 *
 * CONTRACT — this node's shape is FROZEN. It is organised into seven ownership
 * sections (identity / semantics / resources / execution / actions / assertions
 * / metadata) with strict placement rules. Before adding, moving, or repurposing
 * any field, read docs/EXECUTION_GRAPH_CONTRACT.md and bump
 * SCENARIO_GRAPH_SCHEMA_VERSION. Three-question separation to keep straight:
 * `semantics` = what the scenario MEANS; `resources` = what it NEEDS (immutable
 * requirement, e.g. a data ROLE, browser, locale); `execution` = what THIS run
 * actually USED (the resolved dataset/browser/locale). So `requiredDataRole` is
 * a ROLE requirement (belongs in `semantics` today, `resources.dataRoles` once
 * that section lands); a RESOLVED dataset record belongs in `execution`, never
 * in `semantics` or `resources`. The reserved `resources`, `actions[]` (Sprint
 * 2D.3) and `assertions[]` (Sprint 2D.4) slots are documented there and are
 * added alongside their first consumers.
 */
export interface ScenarioNode {
  /** Stable canonical id (the KB scenarioId). Unique within a graph. */
  id: string;
  title: string;
  objective: string;
  /**
   * The application-neutral scenario semantics (variable under test / valid
   * preconditions / single variation / expected behavior / required data role).
   * Optional so older persisted graphs and uncurated scenarios remain valid; the
   * builder always populates it from the Knowledge Base (via
   * `getScenarioSemantics`), so freshly built nodes carry it.
   */
  semantics?: ScenarioSemantics;
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
  /**
   * Per-EXECUTION facts for this node — everything that can change from run to run
   * without changing the scenario's identity. A single scenario (e.g. "Login")
   * may execute against `standard_user`, `problem_user` or `premium_user`, in
   * different environments/browsers/locales; none of that alters what the
   * scenario *is*. Keeping it under `execution` (rather than flattened onto the
   * node) means future consumers — Script Gen, Healing, Replay, Scheduler —
   * extend one clearly-scoped object instead of accreting sibling fields, and it
   * keeps execution data out of the scenario identity / fingerprint.
   *
   * Optional so older persisted graphs and unresolved nodes remain valid.
   */
  execution?: ScenarioExecution;
  /**
   * The canonical, ORDERED executable steps for this scenario — the graph's
   * answer to "what does the browser actually DO?" so Script Gen never has to
   * parse it back out of the natural-language `steps`. Each entry is an
   * application-neutral {@link ScenarioAction}: a verb (`fill`/`click`/…), a
   * semantic `target` (an element identity, NEVER a locator/CSS/page-object),
   * and an optional `value` (a literal or a `@dataset.*` reference resolved from
   * `execution.resolvedDataset`).
   *
   * OWNERSHIP — the Knowledge Base owns the action SEQUENCE (it knows a login is
   * Open → Fill Username → Fill Password → Click). The builder only MATERIALIZES
   * that template into the graph (assigns a stable `id` + `order`); it does NOT
   * translate targets into the application's vocabulary. Neither the KB nor the
   * builder invents actions from the prose steps. When the KB has no authored
   * template for a scenario this stays undefined and Script Gen falls back to its
   * legacy step parser — so the field is purely additive and back-compatible.
   *
   * INVARIANT — targets stay CANONICAL and application-neutral (`username`, not
   * `email_input`). Mapping a canonical target to the app's element and then to a
   * concrete locator is the Execution Resolver's job inside Script Gen, at emit
   * time, from crawl data. Because the graph never encodes app vocabulary or
   * locators, it does NOT need to be rebuilt when the application renames a field
   * or changes its selectors — only the resolver's grounding changes.
   */
  actions?: ScenarioAction[];
  /**
   * The canonical, ORDERED executable ASSERTIONS for this scenario — the graph's
   * answer to "what must be TRUE afterwards?" so Script Gen never has to infer a
   * verification back out of the natural-language `expectedResult`. Each entry is
   * an application-neutral {@link ScenarioAssertion}: a `type` (`url`/`visible`/
   * `text`/…), an optional semantic `target` (an element identity, NEVER a
   * locator/CSS), and an optional `expected` (a literal OR a `@page.*` /
   * `@messages.*` semantic reference the Execution Resolver grounds).
   *
   * OWNERSHIP — mirrors {@link actions} EXACTLY. The Knowledge Base owns the
   * assertion SET (it knows a valid login lands on the inventory page and shows
   * the logout control). The builder only MATERIALIZES the template (assigns a
   * stable `id` + `order`); it does NOT invent assertions and does NOT translate
   * targets/expected into the application's vocabulary. When the KB has no
   * authored template this stays undefined and Script Gen falls back to its
   * legacy assertion inference — so the field is purely additive/back-compatible.
   *
   * INVARIANT — the graph stores PURE BUSINESS MEANING, never Playwright code,
   * locators, or CSS. `{type:'visible', target:'logout_button', expected:true}`,
   * never `expect(page.locator('#logout')).toBeVisible()`. Grounding a canonical
   * target to a locator, and a `@page.*`/`@messages.*` reference to a concrete
   * URL/message, is the Execution Resolver's job inside Script Gen at emit time.
   */
  assertions?: ScenarioAssertion[];
}

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

/**
 * The closed set of executable verbs an action may carry. Application-neutral
 * and framework-neutral — these describe INTENT ("fill this field"), not a
 * Playwright/Selenium call. Script Gen maps each verb to concrete framework
 * code at emit time.
 *
 * DELIBERATELY DOES NOT INCLUDE A `verify`/assert VERB. Actions describe what the
 * browser DOES; asserting what must be TRUE is a separate concern that gets its
 * own typed `assertions[]` section in 2D.4 (emitted as `expect(...)`). Keeping
 * assertions out of the action vocabulary preserves a clean Actions vs Assertions
 * separation — an action list can never smuggle in a coarse, un-typed check.
 */
export type ScenarioActionKind =
  | 'navigate'
  | 'fill'
  | 'click'
  | 'check'
  | 'uncheck'
  | 'select'
  | 'upload';

/**
 * A single canonical executable step. This is the exact, minimal contract the
 * graph exposes to Script Gen — nothing more. It is deliberately tiny: an
 * ordered verb + semantic target + optional value.
 *
 *   • `id`       — STABLE SEMANTIC identity, derived from the step's business
 *                  meaning (`<scenarioId>.<action>.<target>`, e.g.
 *                  `auth-pos-valid.click.login_button`), NOT its array position.
 *                  It survives insertions/reordering so diffs, healing, impact
 *                  analysis, replay and analytics can reference a specific step by
 *                  a durable name — and an assertion's `afterAction` points at
 *                  exactly this value. The builder assigns it (see
 *                  `materializeActionTemplate`); collisions within a node get a
 *                  deterministic `#2`/`#3` suffix. This is the action's ONE and
 *                  ONLY identity — there is no separate slug/derived key.
 *   • `order`    — 0-based execution order. The array is authoritative, but the
 *                  explicit ordinal makes the contract self-describing and lets
 *                  consumers sort defensively without relying on array order.
 *                  (Identity lives in `id`, sequence in `order` — decoupled.)
 *   • `action`   — the verb (see {@link ScenarioActionKind}).
 *   • `target`   — a SEMANTIC element identity (e.g. `username`, `login_button`,
 *                  `error_message`). NEVER a CSS selector, XPath, page-object
 *                  path, or raw locator — grounding to a locator is Script Gen's
 *                  job. `navigate` uses the page/route identity as its target.
 *   • `value`    — optional. A literal (e.g. a URL, a dropdown option) OR a
 *                  `@dataset.*` reference (e.g. `@dataset.username`) that Script
 *                  Gen resolves from `execution.resolvedDataset`. Absent for
 *                  valueless verbs (`click`, `check`, `uncheck`, …).
 *   • `optional` — when true the step may be skipped if its target is absent
 *                  (e.g. a "Remember me" checkbox that some apps omit). Defaults
 *                  to false / required.
 */
export interface ScenarioAction {
  id: string;
  order: number;
  action: ScenarioActionKind;
  target: string;
  value?: string;
  optional?: boolean;
}

/* ------------------------------------------------------------------ */
/*  Assertions                                                         */
/* ------------------------------------------------------------------ */

/**
 * The FROZEN, closed set of assertion types the graph may carry. Chosen to
 * cover "almost everything" without ever growing into scenario vocabulary:
 * these describe a CHECKABLE PROPERTY of the page/element, framework-neutral.
 * Script Gen maps each to a concrete `expect(...)` at emit time.
 *
 * DELIBERATELY DOES NOT INCLUDE scenario-shaped values like `success`,
 * `failure`, `login`, `logout`. Those are SCENARIOS, not assertions — encoding
 * them here would drag business meaning back into the check vocabulary and
 * re-open the "Script Gen guesses what success looks like" hole 2D.4 closes.
 *
 *   • `url`        — the page URL matches `expected` (a path/fragment/@page.*).
 *   • `visible`    — the target element is visible.
 *   • `hidden`     — the target element is present but hidden.
 *   • `enabled`    — the target element is enabled.
 *   • `disabled`   — the target element is disabled.
 *   • `checked`    — the target checkbox/radio is checked.
 *   • `unchecked`  — the target checkbox/radio is NOT checked.
 *   • `text`       — the target contains `expected` text (a literal/@messages.*).
 *   • `value`      — the target input has form value `expected`.
 *   • `count`      — the target matches `expected` (a number) of elements.
 *   • `attribute`  — the target has attribute `expected`, encoded `name=value`.
 */
export type AssertionType =
  | 'url'
  | 'visible'
  | 'hidden'
  | 'enabled'
  | 'disabled'
  | 'checked'
  | 'unchecked'
  | 'text'
  | 'value'
  | 'count'
  | 'attribute';

/**
 * A single canonical executable assertion — the exact, minimal, FROZEN contract
 * the graph exposes to Script Gen. Mirrors {@link ScenarioAction}: an ordered,
 * typed check over a semantic target, nothing more.
 *
 *   • `id`       — STABLE SEMANTIC identity, derived from the check's business
 *                  meaning (`<scenarioId>.<type>.<subject>`, e.g.
 *                  `auth-neg-password.text.login_error`), NOT its array position.
 *                  It survives insertions/reordering so diffs, healing, impact
 *                  analysis, replay and analytics can reference a specific check
 *                  by a durable name. The builder assigns it (see
 *                  `materializeAssertionTemplate`); it is never position-based.
 *   • `order`    — 0-based EXECUTION order. The array is authoritative; the
 *                  ordinal makes the contract self-describing and lets consumers
 *                  sort defensively. (Identity lives in `id`, sequence in `order` —
 *                  the two are deliberately decoupled.)
 *   • `type`     — the checkable property (see {@link AssertionType}).
 *   • `target`   — optional SEMANTIC element identity (e.g. `logout_button`,
 *                  `login_error`). Absent for page-level checks (`url`). NEVER a
 *                  CSS selector, XPath, page-object path, or raw locator —
 *                  grounding to a locator is the Execution Resolver's job.
 *   • `expected` — optional. A literal (`'/inventory'`, `true`, `6`) OR a
 *                  semantic reference the Execution Resolver grounds:
 *                    · `@page.<name>`     → a concrete URL/route from App Knowledge
 *                    · `@messages.<name>` → a concrete UI message from App Knowledge
 *                  For `type:'attribute'`, `expected` is `'<name>=<value>'`.
 *                  Structural types (`visible`/`hidden`/`enabled`/`disabled`/
 *                  `checked`/`unchecked`) need no `expected` — the type carries it.
 *   • `optional` — when true the check is skipped if its target is absent (e.g.
 *                  a control some apps omit). Defaults to false / required.
 *   • `afterAction` — optional reference to the action this check is evaluated
 *                  *after* — the producing step's EXACT {@link ScenarioAction} `id`
 *                  (`<scenarioId>.<action>.<target>`, e.g.
 *                  `auth-pos-valid.click.login_button`). It answers "which step
 *                  produced this outcome?", so Replay, Healing, the execution
 *                  timeline, and root-cause explanations can say "after clicking
 *                  Login, expected the inventory page" instead of a bare "assertion
 *                  failed". Because it IS the action's id, a consumer resolves it
 *                  with a plain `node.actions.find(a => a.id === assertion.afterAction)`
 *                  — no helper, no slug, no computation: one identity everywhere.
 *                  Identity, not position — it survives action reordering exactly
 *                  as `id` does. Absent when the check is not tied to a specific
 *                  step (e.g. a scenario with no materialized actions).
 */
export interface ScenarioAssertion {
  id: string;
  order: number;
  type: AssertionType;
  target?: string;
  expected?: string | number | boolean;
  optional?: boolean;
  afterAction?: string;
}

/**
 * Execution-scoped facts attached to a {@link ScenarioNode}. Distinct from
 * `semantics` (what the scenario means) — this is *how a particular run is
 * parameterised*. Today it carries the resolved dataset record; environment,
 * browser and locale are the natural next members (added by future sprints).
 */
export interface ScenarioExecution {
  /**
   * The concrete dataset record resolved for this node's `semantics.requiredDataRole`,
   * or absent when the role is empty or no available dataset declares it. Resolved
   * EXACTLY ONCE, deterministically, at graph-build time (see scenario-graph-builder),
   * then carried here so every downstream consumer (Test Case Lab, Script Gen, the
   * LLM formatter) reuses the same record instead of re-resolving. The node holds the
   * REAL (unmasked) values — it is the internal source of truth; masking happens only
   * at the projection boundaries (adapters / prompt) via `maskResolvedDataset`.
   */
  resolvedDataset?: ResolvedDatasetRecord;
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

// 1.1.0 — Sprint 2D.3 populated the reserved `actions[]` section for the first
//         time (MINOR bump per the contract's versioning rule).
// 1.2.0 — Sprint 2D.4 populated the reserved `assertions[]` section for the
//         first time (MINOR bump — a new section slot populated for the first
//         time is backward-compatible/additive).
// 1.2.1 — Sprint 2D.4 review: added the optional `assertions[].afterAction`
//         semantic action reference. PATCH (not MINOR) per the contract's own
//         versioning rule: an ADDITIVE OPTIONAL FIELD within an already-populated
//         section is backward-compatible — a reader that omits it is unaffected.
export const SCENARIO_GRAPH_SCHEMA_VERSION = '1.2.1';

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
