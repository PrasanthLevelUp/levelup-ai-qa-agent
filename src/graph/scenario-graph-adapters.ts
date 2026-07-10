/**
 * Scenario Graph Adapters — "reuse everywhere" made concrete.
 * ============================================================================
 *
 * Each consuming module reads the SAME persistent graph, but needs a different
 * projection of it. These pure functions are that projection layer — the single
 * place where the one intelligence source is shaped for each module. No module
 * re-derives scenarios; it asks the graph and adapts.
 *
 *   • Test Case Lab   → deterministic test cases ready for the formatter/export
 *   • Script Gen      → automation specs (ordered by `precedes`, with selectors)
 *   • Healing         → selector → impacted scenarios (what a broken locator hits)
 *   • RTM             → requirement → scenario traceability rows
 *   • Impact Analysis → a changed selector/page → the blast radius of scenarios
 *
 * Pure & deterministic. AI is not involved here — it only polishes wording
 * upstream (Test Case Lab formatter) or fills genuine gaps.
 */

import {
  type ScenarioGraph,
  type ScenarioNode,
  nodesUsingSelector,
  nodesUsingPage,
  outgoingEdges,
} from './scenario-graph';
import {
  type ResolvedDatasetRecord,
  maskResolvedDataset,
} from '../engines/dataset-resolver';

const norm = (s?: string) => (s || '').trim().toLowerCase();

/**
 * Build the human-readable Test Case Lab "Test Data" line that makes Sprint 2C
 * VISIBLE: it surfaces the role, the dataset it resolved to, and the winning
 * record, while keeping the concrete values masked. The node's original
 * `testData` (if any) is preserved on its own line so nothing is lost.
 */
function composeResolvedTestData(node: ScenarioNode): string {
  const r = node.resolvedDataset;
  if (!r) return node.testData;
  const role = node.semantics?.requiredDataRole || 'n/a';
  const fields = Object.keys(r.values);
  // Values stay masked; we only show the field NAMES so the structure is clear.
  const fieldNote = fields.length ? ` · Fields: ${fields.join(', ')} (values masked)` : '';
  const line = `Role: ${role} · Resolved Dataset: ${r.datasetId} · Record: ${r.recordId}${fieldNote}`;
  const base = (node.testData || '').trim();
  return base ? `${base}\n${line}` : line;
}

/* ================================================================== */
/*  1. Test Case Lab                                                   */
/* ================================================================== */

export interface TestCaseLabScenario {
  scenario: string;
  objective: string;
  coverageType: string;
  priority: string;
  riskArea: string;
}

export interface TestCaseLabCase {
  scenarioId: string;
  title: string;
  objective: string;
  preconditions: string;
  steps: string[];
  expectedResult: string;
  testData: string;
  selectors: string[];
  priority: string;
  severity: string;
  tags: string[];
  automationReady: boolean;
  automationComplexity: string;
  selectorAvailability: string;
  source: string;
  sourceEvidence: string;
  scenarioIndex: number;
  /**
   * The dataset record resolved for this case's required data role, with every
   * value MASKED (field names preserved). Present only when the graph node
   * carried a resolved record. This is what makes Sprint 2C visible in the Test
   * Case Lab without leaking credentials; the same info is also folded into the
   * human-readable `testData` line.
   */
  resolvedDataset?: ResolvedDatasetRecord;
}

export interface TestCaseLabProjection {
  scenarios: TestCaseLabScenario[];
  testCases: TestCaseLabCase[];
}

/**
 * Project the graph into the exact deterministic shape Test Case Lab feeds to
 * its formatter. This is the reference consumer: the "deterministic output" the
 * engine currently rebuilds is now simply a view over the stored graph.
 */
export function toTestCaseLab(graph: ScenarioGraph): TestCaseLabProjection {
  const scenarios: TestCaseLabScenario[] = graph.nodes.map(n => ({
    scenario: n.title,
    objective: n.objective,
    coverageType: n.coverageType,
    priority: n.priority,
    riskArea: n.riskArea,
  }));
  const testCases: TestCaseLabCase[] = graph.nodes.map((n, i) => ({
    scenarioId: n.id,
    title: n.title,
    objective: n.objective,
    preconditions: n.preconditions,
    steps: n.steps.slice(),
    expectedResult: n.expectedResult,
    // Enrich the visible Test Data line with the resolved role/dataset/record
    // (values masked). Falls back to the node's raw testData when unresolved.
    testData: composeResolvedTestData(n),
    selectors: n.selectors.slice(),
    priority: n.priority,
    severity: n.severity,
    tags: n.tags.slice(),
    automationReady: n.automationReady,
    automationComplexity: n.automationComplexity,
    selectorAvailability: n.selectorAvailability,
    source: n.source,
    sourceEvidence: n.sourceEvidence,
    scenarioIndex: i,
    // Mask at the projection boundary — the node keeps the real values.
    ...(n.resolvedDataset ? { resolvedDataset: maskResolvedDataset(n.resolvedDataset) } : {}),
  }));
  return { scenarios, testCases };
}

/* ================================================================== */
/*  2. Script Generation                                               */
/* ================================================================== */

export interface ScriptGenSpec {
  scenarioId: string;
  name: string;
  /** Ordered automation steps (grounded, with selectors in-line). */
  steps: string[];
  selectors: string[];
  expectedResult: string;
  testData: string;
  automationReady: boolean;
  automationComplexity: string;
  /** scenarioIds that must run before this one (from `precedes` edges). */
  dependsOn: string[];
}

/**
 * Project the graph into automation specs. Nodes that presuppose a successful
 * primary action carry their prerequisite scenarioIds (from `precedes` edges),
 * so Script Gen can sequence flows instead of re-inferring order.
 */
export function toScriptGenSpecs(graph: ScenarioGraph): ScriptGenSpec[] {
  return graph.nodes.map(n => {
    // A node depends on X when there is an edge X --precedes--> n.
    const dependsOn = graph.edges
      .filter(e => e.type === 'precedes' && e.to === n.id)
      .map(e => e.from);
    return {
      scenarioId: n.id,
      name: n.title,
      steps: n.steps.slice(),
      selectors: n.selectors.slice(),
      expectedResult: n.expectedResult,
      testData: n.testData,
      automationReady: n.automationReady,
      automationComplexity: n.automationComplexity,
      dependsOn,
    };
  });
}

/* ================================================================== */
/*  3. Healing                                                         */
/* ================================================================== */

export interface HealingSelectorContext {
  selector: string;
  /** Scenarios that use this selector — the tests a broken locator affects. */
  impactedScenarioIds: string[];
  impactedTitles: string[];
  /** Highest priority among impacted scenarios (drives heal urgency). */
  topPriority: string;
}

/**
 * Given a selector that broke at runtime, tell Healing which scenarios it
 * belongs to (and how urgent) — instead of Healing guessing from the script
 * alone. Reuse of the graph gives healing the requirement-level context.
 */
export function toHealingContext(graph: ScenarioGraph, brokenSelector: string): HealingSelectorContext {
  const hits = nodesUsingSelector(graph, brokenSelector);
  const priorities = hits.map(h => h.priority).sort(); // P0 < P1 < P2 < P3 lexically
  return {
    selector: brokenSelector,
    impactedScenarioIds: hits.map(h => h.id),
    impactedTitles: hits.map(h => h.title),
    topPriority: priorities[0] ?? 'P3',
  };
}

/* ================================================================== */
/*  4. RTM (Requirements Traceability Matrix)                          */
/* ================================================================== */

export interface RTMRow {
  requirementTitle: string;
  requirementModule?: string;
  jiraId?: string;
  scenarioId: string;
  scenario: string;
  coverageType: string;
  priority: string;
  riskArea: string;
  grounded: boolean;
  /** The happy-path scenario this row varies, if any (from `variant_of`). */
  variantOf?: string;
}

/**
 * Project the graph into RTM rows — one per scenario, each tracing back to the
 * requirement, with its coverage type and its relationship to the happy path.
 */
export function toRTMRows(graph: ScenarioGraph): RTMRow[] {
  return graph.nodes.map(n => {
    const variant = outgoingEdges(graph, n.id, 'variant_of')[0];
    return {
      requirementTitle: graph.requirement.title,
      requirementModule: graph.requirement.module,
      jiraId: graph.requirement.jiraId,
      scenarioId: n.id,
      scenario: n.title,
      coverageType: n.coverageType,
      priority: n.priority,
      riskArea: n.riskArea,
      grounded: n.grounded,
      variantOf: variant?.to,
    };
  });
}

/** Coverage summary for RTM dashboards — counts per coverage type, grounded %. */
export function toRTMCoverageSummary(graph: ScenarioGraph): {
  total: number;
  grounded: number;
  byCoverageType: Record<string, number>;
} {
  const byCoverageType: Record<string, number> = {};
  let grounded = 0;
  for (const n of graph.nodes) {
    byCoverageType[n.coverageType] = (byCoverageType[n.coverageType] || 0) + 1;
    if (n.grounded) grounded++;
  }
  return { total: graph.nodes.length, grounded, byCoverageType };
}

/* ================================================================== */
/*  5. Impact Analysis                                                 */
/* ================================================================== */

export interface ImpactAnalysisResult {
  /** What changed (selectors and/or pages). */
  changedSelectors: string[];
  changedPages: string[];
  /** Directly impacted scenarios (touch a changed selector/page). */
  directScenarioIds: string[];
  /**
   * Transitively impacted scenarios — direct hits plus anything linked to them
   * via `variant_of` / `shares_selector` (the blast radius).
   */
  transitiveScenarioIds: string[];
  directTitles: string[];
}

/**
 * Given a set of changed selectors and/or pages (e.g. from a crawl diff), report
 * the blast radius over the graph: which scenarios must be re-checked. This is
 * exactly the reuse Impact Analysis needs — it reads the graph rather than
 * re-parsing scripts.
 */
export function toImpactAnalysis(
  graph: ScenarioGraph,
  changed: { selectors?: string[]; pages?: string[] },
): ImpactAnalysisResult {
  const changedSelectors = (changed.selectors || []).filter(Boolean);
  const changedPages = (changed.pages || []).filter(Boolean);

  const direct = new Set<string>();
  for (const sel of changedSelectors) for (const n of nodesUsingSelector(graph, sel)) direct.add(n.id);
  for (const pg of changedPages) for (const n of nodesUsingPage(graph, pg)) direct.add(n.id);

  // Transitive: pull in nodes connected to any direct hit via variant_of /
  // shares_selector edges (one hop — enough to catch siblings of a broken flow).
  const transitive = new Set<string>(direct);
  for (const e of graph.edges) {
    if (e.type === 'precedes') continue;
    if (direct.has(e.from)) transitive.add(e.to);
    if (direct.has(e.to)) transitive.add(e.from);
  }

  const titleOf = (id: string) => graph.nodes.find(n => n.id === id)?.title || id;
  return {
    changedSelectors,
    changedPages,
    directScenarioIds: [...direct],
    transitiveScenarioIds: [...transitive],
    directTitles: [...direct].map(titleOf),
  };
}

/* ------------------------------------------------------------------ */
/*  Convenience                                                        */
/* ------------------------------------------------------------------ */

/** True when a node is the happy-path origin of at least one variant. */
export function isHappyPath(graph: ScenarioGraph, node: ScenarioNode): boolean {
  return graph.edges.some(e => e.type === 'variant_of' && e.to === node.id)
    || norm(node.coverageType) === 'positive';
}
