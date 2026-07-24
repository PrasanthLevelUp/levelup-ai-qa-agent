/**
 * CANONICAL ORDERING — SCRIPT GEN PROOF (REQ-005 sort)
 * ===========================================================================
 * Complements canonical-render-proof.ts (which proves the MANUAL renderer).
 * Here we prove the SECOND consumer of the same canonical `ordered` assertion —
 * the Playwright Script Gen engine — emits a REAL ordering check from the SAME
 * semantic fields (collection / direction / orderBy), never a silent drop.
 *
 *   npx ts-node scripts/canonical-ordered-scriptgen-proof.ts
 */
import { planScenarios } from '../src/engines/scenario-planner';
import { buildDraftTestCases, buildDeterministicOutput } from '../src/engines/scenario-builder';
import {
  getScenarioSemantics,
  getScenarioActionTemplate,
  getScenarioAssertionTemplate,
} from '../src/engines/qa-knowledge-engine';
import { assembleScenarioGraph, materializeActionTemplate, materializeAssertionTemplate } from '../src/graph/scenario-graph-builder';
import { ScriptGenEngine } from '../src/script-gen/script-gen-engine';
import type { CoverageType } from '../src/engines/test-coverage-engine';

const REQ: any = {
  id: 'REQ-005',
  title: 'Sort products',
  description:
    'Allow users to sort products by different criteria. On the product list the user can sort by Name (A to Z), Name (Z to A), Price (low to high) and Price (high to low). The selected sort option stays selected and each product\u2019s details are unchanged — only the display sequence changes.',
  module: 'Inventory',
  acceptanceCriteria:
    'Given a product list, when the user selects a sort option, then the list is sorted by that sort option and the selected sort option stays selected.',
};
const KNOWLEDGE: any = {
  applicationProfile: { baseUrl: 'https://www.saucedemo.com/', name: 'SauceDemo', forms: [] },
  testData: [],
};
const FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];

const plan = planScenarios(REQ, FAMILIES, undefined, undefined, false);
const built = buildDraftTestCases(plan as any, KNOWLEDGE, REQ);
const det = buildDeterministicOutput(built.drafts);

const semanticsById = new Map<string, any>((plan as any).scenarios.map((s: any) => [s.id, getScenarioSemantics(s)]));
const actionsById = new Map<string, any>(
  (plan as any).scenarios.flatMap((s: any) => {
    const t = getScenarioActionTemplate(s);
    return t ? [[s.id, materializeActionTemplate(s.id, t)] as const] : [];
  }),
);
const assertionsById = new Map<string, any>(
  (plan as any).scenarios.flatMap((s: any) => {
    const t = getScenarioAssertionTemplate(s);
    return t ? [[s.id, materializeAssertionTemplate(s.id, t)] as const] : [];
  }),
);

const graph = assembleScenarioGraph({
  input: REQ,
  coverageTypes: FAMILIES,
  cases: det.testCases as any,
  meta: built.drafts.map((d: any, i: number) => ({
    coverageType: det.scenarios[i]?.coverageType ?? d.coverageType,
    grounded: d.grounded,
    objective: d.objective,
    semantics: semanticsById.get(d.scenarioId),
    actions: actionsById.get(d.scenarioId),
    assertions: assertionsById.get(d.scenarioId),
  })),
  knowledgeVersion: (plan as any).knowledgeVersion ?? '',
  category: (plan as any).classification?.category ?? 'generic',
  availableDatasets: KNOWLEDGE.testData,
});

const SORT_ID = 'search-pos-sort';
const sortNode = graph.nodes.find((n) => n.id === SORT_ID)!;

// Key the graph nodes by scenarioId exactly as the engine expects.
const scenarioGraphNodes = new Map<string, any>(graph.nodes.map((n) => [n.id, n]));

// One test case for the sort scenario, carrying its scenarioId so the engine
// binds it to the canonical node (and thus to node.actions / node.assertions).
const testCases: any[] = [
  {
    id: 5001,
    title: 'Sort products by Name (A to Z)',
    scenarioId: SORT_ID,
    priority: 'P1',
    preconditions: 'User is on the product list page',
    test_data: '',
    steps: (sortNode.steps ?? []),
    expected_result: sortNode.expectedResult ?? '',
  },
];

const cachedCrawlData: any = {
  url: 'https://www.saucedemo.com/inventory.html', finalUrl: 'https://www.saucedemo.com/inventory.html',
  title: 'Swag Labs', pageType: 'list', pageTypeConfidence: 0.9,
  elements: [], forms: [], navigationLinks: [], buttons: [], inputs: [], headings: [],
  htmlSnapshot: '', totalElements: 0, interactiveElements: 0,
};
const repoProfile: any = {
  framework: 'playwright', language: 'typescript', testPattern: 'spec',
  helperFunctions: [], fixtures: [], sharedConstants: [], dataFiles: [], dependencies: [], pageObjects: [],
};

async function main() {
  const engine = new ScriptGenEngine();
  const result = await engine.generate({
    url: 'https://www.saucedemo.com/inventory.html',
    cachedCrawlData, repoProfile, testCases, scenarioGraphNodes,
  } as any);

  const all = result.generatedFiles.map((f) => f.content).join('\n');

  console.log('\n================ SORT NODE (canonical) ================');
  console.log('id:', SORT_ID, '· authored actions:', sortNode.actions?.length ?? 0, '· assertions:', sortNode.assertions?.length ?? 0);
  const ordered = (sortNode.assertions ?? []).find((a: any) => a.type === 'ordered');
  console.log('ordered assertion semantics:', ordered ? JSON.stringify({ collection: ordered.collection, direction: ordered.direction, orderBy: ordered.orderBy }) : '(none)');

  console.log('\n================ GENERATED PLAYWRIGHT (ordering lines) ================');
  const lines = all.split('\n').filter((l) => /_ordered|localeCompare|allTextContents/.test(l));
  if (lines.length === 0) {
    console.log('  ❌ NO ordering assertion emitted — the `ordered` type was dropped.');
    process.exit(1);
  }
  lines.forEach((l) => console.log('  ' + l.trim()));
  console.log('\n✅ Script Gen emitted a REAL ordering check from the canonical `ordered` semantics.');
}

main().catch((e) => { console.error(e); process.exit(1); });
