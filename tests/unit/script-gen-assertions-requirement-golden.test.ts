/**
 * Sprint 2D.4 — REQUIREMENT-LEVEL golden: Requirement → Scenario Graph →
 * Assertions → Script Gen → Playwright spec, pinned to a committed snapshot.
 *
 * This is the addition the review asked for. The existing assertions golden
 * (`script-gen-assertions-golden.test.ts`) starts from a hand-materialized node
 * (it calls `materializeActionTemplate` / `materializeAssertionTemplate`
 * directly). That proves the KB → builder → renderer contract, but it skips the
 * planner and the real graph assembly.
 *
 * THIS golden starts one stage earlier — from a raw requirement — and drives the
 * ACTUAL production builder end-to-end:
 *
 *   Requirement (prose)
 *     → buildScenarioGraph (planner → builder → validator)     — the real graph
 *       → node.actions + node.assertions (semantic ids, app-neutral)
 *         → project nodes exactly like api/routes/script-gen.ts
 *           → Script Gen (`generate`)                          — resolver grounds
 *             → Playwright .spec.ts                            — pinned snapshot
 *
 * Nothing here is hand-authored: the scenarios, their actions, and their
 * assertions are all decided by the planner + KB + builder. If a change anywhere
 * in that chain alters real output, this snapshot fails with a loud, reviewable
 * diff. `auth-neg-wrong-password` is chosen for the same reason as the sibling
 * golden: it exercises all three grounding paths (canonical target, `@messages.*`
 * copy, `@page.*` URL) in a single spec.
 *
 * If a diff here is intentional, re-run with `--ci=false -u` and commit the
 * updated snapshot alongside the change (and explain it in the PR).
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';
import { buildScenarioGraph } from '../../src/graph/scenario-graph-builder';
import type { Dataset } from '../../src/engines/dataset-resolver';

const FIXED_NOW = '2026-01-01T00:00:00.000Z';

/* ------------------------------------------------------------------ */
/*  Fixtures — a raw login requirement + grounded SauceDemo profile.   */
/*  Deliberately prose-only: the planner decides which scenarios exist.*/
/* ------------------------------------------------------------------ */

const LOGIN_REQ = {
  title: 'User Login',
  description:
    'A registered user logs in with their username and password to access the inventory.',
  acceptanceCriteria:
    'Valid credentials authenticate; invalid credentials are rejected with an error.',
  businessFlow: 'Open login page → enter username + password → submit → land on inventory.',
  module: 'Authentication',
};

const LOGIN_PROFILE = {
  baseUrl: 'https://www.saucedemo.com',
  name: 'Swag Labs',
  loginUrl: 'https://www.saucedemo.com',
  username: 'standard_user',
  pages: [{ url: 'https://www.saucedemo.com', title: 'Login', pageType: 'auth' }],
  forms: [
    {
      page: 'https://www.saucedemo.com',
      action: '/',
      method: 'POST',
      submitSelector: '#login-button',
      fields: [
        { name: 'user-name', type: 'text', required: true, selector: '#user-name', label: 'Username' },
        { name: 'password', type: 'password', required: true, selector: '#password', label: 'Password' },
      ],
    },
  ],
  keyElements: [{ label: 'Login', tag: 'button', selector: '#login-button', role: 'button' }],
};

const LOGIN_KNOWLEDGE: any = {
  applicationProfile: LOGIN_PROFILE,
  testData: [
    { name: 'standard_user', environment: 'staging', recordCount: 1, sampleKeys: ['username', 'password'] },
  ],
};

// A dataset advertising the `registered_user` role so the resolver can attach a
// concrete record to the node under `execution.resolvedDataset` (Sprint 2C/2D.2).
const DATASETS: readonly Dataset[] = [
  {
    datasetId: 'valid_users',
    name: 'valid_users',
    roles: ['registered_user'],
    records: [
      {
        recordId: 'standard_user',
        values: { username: 'standard_user', password: 'secret_sauce' },
        tags: ['registered_user'],
      },
    ],
  },
];

// A tiny, fixed SauceDemo login crawl — the same shape the crawler caches.
const cachedCrawlData: any = {
  url: 'https://www.saucedemo.com', finalUrl: 'https://www.saucedemo.com',
  title: 'Swag Labs', pageType: 'login', pageTypeConfidence: 0.9,
  elements: [
    { tag: 'input', id: 'user-name', name: 'user-name', type: 'text', attributes: { 'data-test': 'username' } },
    { tag: 'input', id: 'password', name: 'password', type: 'password', attributes: { 'data-test': 'password' } },
    { tag: 'input', id: 'login-button', type: 'submit', attributes: { 'data-test': 'login-button' } },
  ],
  forms: [], navigationLinks: [], buttons: [], inputs: [], headings: [],
  htmlSnapshot: '', totalElements: 3, interactiveElements: 3,
};

// A test case whose scenarioId matches the graph node id — this is the join key
// Script Gen uses to pull the graph's actions + assertions for the case.
const testCase: any = {
  id: 7042, title: 'Invalid password is rejected', priority: 'P0',
  scenarioId: 'auth-neg-wrong-password',
  preconditions: 'User is on the login page',
  expected_result:
    'Authentication is rejected with a generic error and the user stays on the login page.',
  steps: [
    'Navigate to https://www.saucedemo.com',
    'Enter a valid username',
    'Enter an incorrect password',
    'Click the login button',
  ],
};

describe('Sprint 2D.4 — golden: Requirement → graph → Script Gen → Playwright (assertions)', () => {
  it('builds the real graph from a requirement and emits the pinned spec', async () => {
    // 1. Build the REAL graph from raw requirement prose. The planner decides
    //    the scenarios; the builder materializes their actions + assertions with
    //    stable semantic ids; the resolver attaches the winning dataset record.
    const graph = buildScenarioGraph(LOGIN_REQ, ['positive', 'negative'], LOGIN_KNOWLEDGE, {
      now: FIXED_NOW,
      requirementId: 42,
      availableDatasets: DATASETS,
    });

    // The negative wrong-password scenario must exist and carry graph-owned,
    // semantically-identified assertions (not array-position ids).
    const node: any = graph.nodes.find((n: any) => n.id === 'auth-neg-wrong-password');
    expect(node).toBeDefined();
    expect(node.assertions.map((a: any) => a.id)).toEqual([
      'auth-neg-wrong-password.visible.login_error',
      'auth-neg-wrong-password.text.login_error',
      'auth-neg-wrong-password.url.login',
    ]);

    // Every assertion is linked to the step that produced it (2D.4 review),
    // and the link resolves — by action.id (identity, NOT array position) — to the
    // real click action in the same node. afterAction IS that action's id, so the
    // join is a plain `act.id === a.afterAction`, no slug/derivation. This is what
    // powers "after clicking Login, expected …" in Replay / Healing / the timeline.
    for (const a of node.assertions) {
      expect(a.afterAction).toBe('auth-neg-wrong-password.click.login_button');
      const producer = node.actions.find((act: any) => act.id === a.afterAction);
      expect(producer).toBeDefined();
      expect(producer.action).toBe('click');
      expect(producer.target).toBe('login_button');
    }

    // 2. Project nodes EXACTLY as api/routes/script-gen.ts does: keyed by node.id
    //    with only {semantics, execution, actions, assertions}.
    const scenarioGraphNodes = new Map<string, any>(
      graph.nodes.map((n: any) => [
        n.id,
        {
          ...(n.semantics ? { semantics: n.semantics } : {}),
          ...(n.execution ? { execution: n.execution } : {}),
          ...(n.actions ? { actions: n.actions } : {}),
          ...(n.assertions ? { assertions: n.assertions } : {}),
        },
      ]),
    );

    // 3. Script Gen consumes the projected graph and grounds canonical targets +
    //    symbolic @page.*/@messages.* references → locators / URLs / copy.
    const engine = new ScriptGenEngine();
    const result = await engine.generate({
      url: 'https://www.saucedemo.com',
      cachedCrawlData,
      testCases: [testCase],
      scenarioGraphNodes,
    } as any);

    const spec = result.generatedFiles.map((f: any) => f.content).join('\n\n');

    // The assertions came from the graph, resolved to concrete SauceDemo output.
    expect(spec).toContain('.toBeVisible();');
    expect(spec).toContain(`.toContainText('Username and password do not match')`);
    expect(spec).toContain(`await expect(page).toHaveURL('https://www.saucedemo.com/')`);

    // The long-term regression pin.
    expect(spec).toMatchSnapshot('requirement-auth-neg-wrong-password.spec');
  });
});
