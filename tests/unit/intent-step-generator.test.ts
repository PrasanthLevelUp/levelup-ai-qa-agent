/**
 * Unit tests for the Intent-aware Step Generator (Sprint 2).
 *
 * The defect this sprint fixed: the four NON-FORM intents (authorization,
 * authentication, session, direct-URL) fell to a single skeleton placeholder
 * ("Exercise the <title> scenario against the application") because they do not
 * fill the feature form. Sprint 1 correctly refused to fabricate form-fill steps
 * for them; Sprint 2 replaces the placeholder with the REAL deterministic step
 * flow each intent requires — WITHOUT inventing business facts (no "Login as HR
 * Admin") and WITHOUT fabricating form selectors, so they stay Needs Review.
 *
 * Scope note (evidence-driven): Gate 0 showed search / cancel / file-upload were
 * ALREADY correct after Sprint 1, so this sprint does not touch them — the
 * feature-grounding-engine suite guards those. This suite covers only the four
 * intents that reproduced as placeholders.
 *
 * Run with: npx jest tests/unit/intent-step-generator.test.ts
 */

import { planScenarios } from '../../src/engines/scenario-planner';
import {
  buildDraftTestCases,
  classifyHeldIntent,
} from '../../src/engines/scenario-builder';
import { getScenarioStepFlow } from '../../src/engines/qa-knowledge-engine';
import type { CoverageType } from '../../src/engines/test-coverage-engine';

/* ------------------------------------------------------------------ */
/*  classifyHeldIntent — sub-classify a held scenario by STABLE signal */
/* ------------------------------------------------------------------ */
describe('classifyHeldIntent — picks the right non-form flow from stable signals', () => {
  it('classifies direct-URL / direct-endpoint scenarios as direct_url (even though the id also carries "authz")', () => {
    expect(classifyHeldIntent({ id: 'crud-neg-direct-endpoint-authz', riskArea: 'Authorization' })).toBe('direct_url');
  });
  it('classifies session / timeout / expiry scenarios as session', () => {
    expect(classifyHeldIntent({ id: 'checkout-edge-session-timeout', riskArea: 'Flow resilience' })).toBe('session');
    expect(classifyHeldIntent({ id: 'login-session-expiry', riskArea: 'Authorization' })).toBe('session');
  });
  it('classifies unauthenticated / redirect-to-login scenarios as authentication', () => {
    expect(classifyHeldIntent({ id: 'crud-neg-unauthenticated-redirect', riskArea: 'Authorization' })).toBe('authentication');
  });
  it('defaults the broad "unauthorized" concern to authorization', () => {
    expect(classifyHeldIntent({ id: 'crud-neg-unauthorized', riskArea: 'Authorization' })).toBe('authorization');
    expect(classifyHeldIntent({ id: 'admin-sec-unauthorized', riskArea: 'Privilege escalation' })).toBe('authorization');
  });
  it('uses the title only as a LAST fallback (structured signals win)', () => {
    // riskArea/id are silent → falls back to title.
    expect(classifyHeldIntent({ id: 'x', title: 'Unauthenticated user is redirected to login' })).toBe('authentication');
    expect(classifyHeldIntent({ id: 'x', title: 'Session times out mid-flow' })).toBe('session');
  });
});

/* ------------------------------------------------------------------ */
/*  End-to-end through the builder                                     */
/* ------------------------------------------------------------------ */
const ADD_FORM = {
  page: 'https://demo.orangehrmlive.com/web/index.php/pim/addEmployee',
  submitLabel: 'Save', submitSelector: 'button[type=submit]',
  fields: [
    { label: 'First Name', name: 'firstName', type: 'text', required: true, selector: 'input[name=firstName]' },
    { label: 'Last Name', name: 'lastName', type: 'text', required: true, selector: 'input[name=lastName]' },
    { label: 'Profile Photo', name: 'photo', type: 'file', selector: 'input[type=file]' },
  ],
};
const KNOWLEDGE: any = {
  applicationProfile: { baseUrl: 'https://demo.orangehrmlive.com/', name: 'OrangeHRM', forms: [ADD_FORM] },
  testData: [{ name: 'new_employee', sampleKeys: ['employeeId', 'firstName', 'lastName'] }],
};
const EMPLOYEE_REQ = {
  title: 'Create Employee',
  description:
    'Admin can add a new employee by entering first name and last name. Only authorized admins may access the ' +
    'add form; unauthenticated users are redirected to login; direct URL access is authorization-checked.',
  module: 'HR',
  acceptanceCriteria:
    'Given an authorized admin, when a valid employee is submitted, then the record is created and a success ' +
    'notification is shown.',
};
const FAMILIES: CoverageType[] = ['positive', 'negative', 'edge_cases'];

function drafts() {
  const plan = planScenarios(EMPLOYEE_REQ as any, FAMILIES, undefined, undefined, false);
  return buildDraftTestCases(plan as any, KNOWLEDGE as any, EMPLOYEE_REQ as any).drafts;
}

const isPlaceholder = (d: any) => (d.steps as string[]).some((s) => /Exercise the ".*" scenario/.test(s));
const find = (id: string) => drafts().find((d: any) => d.scenarioId === id) as any;
const NO_FORM_FILL = (text: string) => {
  expect(text).not.toContain('First Name');
  expect(text).not.toContain('Last Name');
  expect(text).not.toContain('Profile Photo');
  expect(text).not.toMatch(/Enter .* in the .* field/);
};

describe('Intent-aware Step Generator — deterministic non-form flows', () => {
  it('AUTHORIZATION scenario gets a real access-control flow, no placeholder, no form-fill', () => {
    const d = find('crud-neg-unauthorized');
    expect(d).toBeDefined();
    expect(isPlaceholder(d)).toBe(false);
    const text = (d.steps as string[]).join(' ');
    expect(text).toMatch(/required permission/i);
    expect(text).toMatch(/access is denied/i);
    NO_FORM_FILL(text);
    // Never claims a specific role the requirement did not state.
    expect(text).not.toMatch(/HR Admin|as an admin user/i);
    expect(d.needsReview).toBe(true);
    expect(d.automationReady).toBe(false);
  });

  it('AUTHENTICATION scenario gets a redirect-to-login flow, no placeholder', () => {
    const d = find('crud-neg-unauthenticated-redirect');
    expect(d).toBeDefined();
    expect(isPlaceholder(d)).toBe(false);
    const text = (d.steps as string[]).join(' ');
    expect(text).toMatch(/not authenticated|no active session/i);
    expect(text).toMatch(/redirected to the login/i);
    NO_FORM_FILL(text);
    expect(d.automationReady).toBe(false);
  });

  it('DIRECT-URL scenario gets a direct-request / server-side check flow, no placeholder', () => {
    const d = find('crud-neg-direct-endpoint-authz');
    expect(d).toBeDefined();
    expect(isPlaceholder(d)).toBe(false);
    const text = (d.steps as string[]).join(' ');
    expect(text).toMatch(/URL directly|bypassing/i);
    expect(text).toMatch(/server-side authorization check/i);
    NO_FORM_FILL(text);
    expect(d.automationReady).toBe(false);
  });

  it('steps read in the product vocabulary (entity + feature label), not "the record"', () => {
    const d = find('crud-neg-unauthorized');
    const text = (d.steps as string[]).join(' ');
    expect(text).toContain('Create Employee');
    expect(text).toContain('Employee');
  });
});

/* ------------------------------------------------------------------ */
/*  SESSION — reproduced via a checkout requirement                    */
/* ------------------------------------------------------------------ */
describe('Intent-aware Step Generator — session flow (checkout requirement)', () => {
  const CO_KNOW: any = {
    applicationProfile: {
      baseUrl: 'https://shop.example.com/', name: 'Shop',
      forms: [{ page: 'https://shop.example.com/checkout', submitLabel: 'Place Order', submitSelector: 'button#place', fields: [{ label: 'Card Number', name: 'card', type: 'text', selector: '#card' }] }],
    },
    testData: [],
  };
  const CO_REQ: any = {
    title: 'Checkout',
    description: 'User completes checkout by entering card number then places the order. Session may expire during checkout.',
    module: 'Commerce',
    acceptanceCriteria: 'Given a cart, when the user checks out with valid payment, then an order is placed. Session timeout / expire during checkout must be handled.',
  };
  function coDrafts() {
    const plan = planScenarios(CO_REQ, FAMILIES, undefined, undefined, false);
    return { plan, drafts: buildDraftTestCases(plan as any, CO_KNOW, CO_REQ).drafts };
  }

  it('SESSION-timeout scenario gets a login → expire → resubmit flow, no placeholder', () => {
    const { plan, drafts } = coDrafts();
    const idx = plan.scenarios.findIndex((s: any) => /session/i.test(s.id));
    expect(idx).toBeGreaterThanOrEqual(0);
    const d: any = drafts[idx];
    // Confirm the KB did not assign it a form stepFlow (it is a held intent).
    expect(getScenarioStepFlow(plan.scenarios[idx] as any)).toBeNull();
    expect(isPlaceholder(d)).toBe(false);
    const text = (d.steps as string[]).join(' ');
    expect(text).toMatch(/session to expire|invalidate the session/i);
    expect(text).toMatch(/re-authenticate|no partial/i);
    expect(d.needsReview).toBe(true);
    expect(d.automationReady).toBe(false);
  });
});
