/**
 * PX-1A PROOF — Data structure (keys) beats the label (name)
 *
 * Verifies the user's requirement: Dataset KEYS → Dataset NAME → Requirement context.
 */
import { planScenarios } from '../src/engines/scenario-planner';
import { buildDraftTestCases } from '../src/engines/scenario-builder';
import type { CoverageType } from '../src/engines/test-coverage-engine';

const REQUIREMENT = {
  title: 'Add New Employee',
  description: 'HR admin can create a new employee record',
  module: 'HR',
  acceptanceCriteria: 'Given valid employee data, the record is created and searchable.',
};

const FORM = {
  page: 'https://demo.orangehrmlive.com/web/index.php/pim/addEmployee',
  submitLabel: 'Save',
  submitSelector: 'button[type=submit]',
  fields: [
    { label: 'First Name', name: 'firstName', type: 'text', required: true },
    { label: 'Last Name', name: 'lastName', type: 'text', required: true },
  ],
};

function run(label: string, testData: any[], expectPositive: string | null) {
  const knowledge = {
    applicationProfile: { baseUrl: 'https://x/', name: 'OrangeHRM', forms: [FORM] },
    testData,
  };
  const families: CoverageType[] = ['positive', 'negative', 'edge_cases'];
  const plan = planScenarios(REQUIREMENT, families, undefined, undefined, false);
  const { drafts } = buildDraftTestCases(plan as any, knowledge, REQUIREMENT);
  const pos = drafts.find(d => d.coverageType === 'positive' && /create.*valid/i.test(d.title));
  const got = /Dataset: (\w+)/.exec(pos?.testData || '')?.[1] ?? '(inline)';
  const ok = expectPositive === null ? got === '(inline)' : got === expectPositive;
  console.log(`${ok ? '✅' : '❌'} ${label}`);
  console.log(`     positive create → ${pos?.testData}`);
  console.log(`     expected: ${expectPositive ?? '(inline)'}, got: ${got}\n`);
  return ok;
}

console.log('\n=== PX-1A PROOF — keys beat name; requirement is only a tie-breaker ===\n');
let allOk = true;

// 1. KEYS beat NAME: generic-named dataset whose KEYS fit the form wins over a
//    well-named dataset whose keys are irrelevant (createdAt/updatedAt).
allOk = run(
  'Generic name + fitting keys beats employee-name + irrelevant keys',
  [
    { name: 'Employee_Master', sampleKeys: ['id', 'createdAt', 'updatedAt'] },
    { name: 'Regression_Set',  sampleKeys: ['employeeId', 'firstName', 'lastName', 'department'] },
  ],
  'Regression_Set',
) && allOk;

// 2. Meaningless names + fitting keys: still matches on keys (structure over label).
allOk = run(
  'Meaningless name but fitting keys still matches (keys are the signal)',
  [
    { name: 'Dataset_A', sampleKeys: ['firstName', 'lastName'] },
  ],
  'Dataset_A',
) && allOk;

// 3. Meaningless names AND unfitting keys → inline (no random guess).
allOk = run(
  'Meaningless name + unrelated keys → inline (no greedy fallback)',
  [
    { name: 'Regression_Set_01', sampleKeys: ['orderId', 'sku', 'price'] },
    { name: 'Dataset_A',         sampleKeys: ['col1', 'col2'] },
  ],
  null,
) && allOk;

// 4. Requirement context is ONLY a tie-breaker between structurally-equal datasets.
allOk = run(
  'Requirement context breaks a tie (both fit keys) → prefers the employee one',
  [
    { name: 'person_records', sampleKeys: ['firstName', 'lastName'] },
    { name: 'employee_data',  sampleKeys: ['firstName', 'lastName'] },
  ],
  'employee_data',
) && allOk;

console.log('═══════════════════════════════════════════════════════════');
console.log(allOk ? 'ALL PROOFS PASSED ✅' : 'SOME PROOFS FAILED ❌');
console.log('═══════════════════════════════════════════════════════════\n');
process.exit(allOk ? 0 : 1);
