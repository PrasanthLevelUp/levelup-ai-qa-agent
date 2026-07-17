/**
 * Generate a comprehensive CSV demonstrating all Sprint 3 data intents in one
 * requirement: Positive, Boundary, Duplicate, SQL, XSS, Whitespace, Unicode.
 *
 * Run: npx ts-node scripts/comprehensive-csv-demo.ts > comprehensive-output.csv
 */
import { planScenarios } from '../src/engines/scenario-planner';
import { buildDraftTestCases } from '../src/engines/scenario-builder';
import type { CoverageType } from '../src/engines/test-coverage-engine';

const FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];

// A constraint-bearing registration form that will justify boundary scenarios.
const KNOWLEDGE: any = {
  applicationProfile: {
    baseUrl: 'https://demo.example.com/', name: 'AcmeApp',
    forms: [{
      page: 'https://demo.example.com/register',
      submitLabel: 'Register', submitSelector: 'button[type=submit]',
      fields: [
        { label: 'Username', name: 'username', type: 'text', required: true, selector: 'input[name=username]' },
        { label: 'Email', name: 'email', type: 'email', required: true, selector: 'input[name=email]' },
        { label: 'Phone', name: 'phone', type: 'tel', selector: 'input[name=phone]' },
        { label: 'Age', name: 'age', type: 'number', selector: 'input[name=age]' },
        { label: 'Notes', name: 'notes', type: 'text', selector: 'textarea[name=notes]' },
      ],
    }],
  },
  testData: [{ name: 'new_user', sampleKeys: ['username', 'email'] }],
};

// Requirement that justifies positive, boundary (username max 20), duplicate,
// SQL, XSS, whitespace, unicode, and invalid-format negatives.
const REQUIREMENT: any = {
  title: 'User Registration',
  description: 'A visitor registers by entering username (max 20 characters), email, phone, age, and optional notes. The system validates format, checks for duplicate usernames and emails, prevents SQL injection and XSS, and rejects whitespace-only or non-ASCII usernames.',
  module: 'Accounts',
  acceptanceCriteria: `
Given valid details, when the visitor submits the form, then the account is created.
The username must not exceed 20 characters.
Duplicate usernames and emails are rejected.
SQL injection and XSS payloads in any field are rejected.
Whitespace-only usernames are rejected.
Non-ASCII or special characters in the username are rejected.
`,
};

const plan = planScenarios(REQUIREMENT, FAMILIES, undefined, undefined, false);
const { drafts } = buildDraftTestCases(plan as any, KNOWLEDGE, REQUIREMENT);

// CSV header
console.log('ID,Title,Coverage,Steps,Expected');

for (const d of drafts) {
  const id = d.id || 'N/A';
  const title = (d.title || '').replace(/"/g, '""');
  const cov = d.coverageType || '';
  const steps = (d.steps || []).join(' | ').replace(/"/g, '""');
  const expected = (d.expectedResult || '').replace(/"/g, '""');
  console.log(`"${id}","${title}","${cov}","${steps}","${expected}"`);
}
