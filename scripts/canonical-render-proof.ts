/**
 * CANONICAL RENDERING PROOF — Sort Products (REQ-005)
 * ===========================================================================
 * Runs the REAL pipeline exactly as test-coverage-engine does:
 *   planScenarios → buildDraftTestCases → buildDeterministicOutput
 *   → materialize KB action/assertion templates → assembleScenarioGraph
 *   → toTestCaseLab (the MANUAL renderer)
 *
 * Then prints, for the sort scenario:
 *   • BEFORE — the legacy prose the manual builder produced (node.steps),
 *              i.e. the form-pick + CRUD-template output (the 2/10 artifact).
 *   • AFTER  — the canonical-rendered manual columns from toTestCaseLab.
 *
 * The App Profile deliberately carries ONLY a checkout form so the legacy path
 * reproduces the original bug (checkout steps on a sort scenario). Run:
 *   npx ts-node scripts/canonical-render-proof.ts
 */
import { planScenarios } from '../src/engines/scenario-planner';
import { buildDraftTestCases, buildDeterministicOutput } from '../src/engines/scenario-builder';
import {
  getScenarioSemantics,
  getScenarioActionTemplate,
  getScenarioAssertionTemplate,
} from '../src/engines/qa-knowledge-engine';
import { assembleScenarioGraph, materializeActionTemplate, materializeAssertionTemplate } from '../src/graph/scenario-graph-builder';
import { toTestCaseLab } from '../src/graph/scenario-graph-adapters';
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

// ONLY a checkout form — this is what made the legacy builder emit checkout steps.
const CHECKOUT_FORM = {
  page: 'https://www.saucedemo.com/checkout-step-one.html',
  submitLabel: 'Continue',
  submitSelector: '[data-test="continue"]',
  fields: [
    { label: 'First Name', name: 'firstName', type: 'text', required: true, selector: '[data-test="firstName"]' },
    { label: 'Last Name', name: 'lastName', type: 'text', required: true, selector: '[data-test="lastName"]' },
    { label: 'Zip/Postal Code', name: 'postalCode', type: 'text', required: true, selector: '[data-test="postalCode"]' },
  ],
};
const KNOWLEDGE: any = {
  applicationProfile: { baseUrl: 'https://www.saucedemo.com/', name: 'SauceDemo', forms: [CHECKOUT_FORM] },
  testData: [],
};
const FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];

const plan = planScenarios(REQ, FAMILIES, undefined, undefined, false);
const built = buildDraftTestCases(plan as any, KNOWLEDGE, REQ);
const det = buildDeterministicOutput(built.drafts);

// Materialize the KB templates exactly as the engine does.
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

const projection = toTestCaseLab(graph);

console.log('\n================ CLASSIFICATION ================');
console.log('category:', (plan as any).classification?.category, '· scenarios:', (plan as any).scenarios.length);

const SORT_ID = 'search-pos-sort';
const node = graph.nodes.find((n) => n.id === SORT_ID);
const projected = projection.testCases.find((t) => t.scenarioId === SORT_ID);

console.log('\n================ SORT SCENARIO ================');
console.log('id:', SORT_ID, '· authored actions:', node?.actions?.length ?? 0, '· assertions:', node?.assertions?.length ?? 0);

console.log('\n---------------- BEFORE (legacy manual prose — node.steps) ----------------');
(node?.steps ?? []).forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
console.log('  Expected:', (node?.expectedResult ?? '').split('\n').join(' | '));

console.log('\n---------------- AFTER (canonical-rendered — toTestCaseLab) ----------------');
(projected?.steps ?? []).forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
console.log('  Expected Result:');
(projected?.expectedResult ?? '').split('\n').forEach((l) => console.log(`     ${l}`));
console.log('  Test Data:', projected?.testData);

// Zero-regression spot check: a scenario WITHOUT authored actions must be identical.
const plain = graph.nodes.find((n) => !n.actions || n.actions.length === 0);
if (plain) {
  const plainProj = projection.testCases.find((t) => t.scenarioId === plain.id)!;
  const stepsSame = JSON.stringify(plain.steps) === JSON.stringify(plainProj.steps);
  const expSame = plain.expectedResult === plainProj.expectedResult;
  console.log('\n================ ZERO-REGRESSION CHECK ================');
  console.log(`non-authored scenario "${plain.id}": steps unchanged=${stepsSame}, expected unchanged=${expSame}`);
}
