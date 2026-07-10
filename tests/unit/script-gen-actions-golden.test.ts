/**
 * Sprint 2D.3 — GOLDEN end-to-end regression: Scenario → Execution Graph →
 * Script Gen → Playwright spec.
 *
 * This is the long-term guard the review asked for: one full pass through the
 * REAL pipeline, pinned to a committed snapshot. It wires the actual production
 * pieces together with NO hand-authored actions:
 *
 *   KB (`getScenarioActionTemplate`)            — authors the canonical sequence
 *     → Builder (`materializeActionTemplate`)   — assigns id/order, targets VERBATIM
 *       → Graph node.actions                    — canonical, app-neutral
 *         → Script Gen (`generate`)             — Execution Resolver grounds → Playwright
 *
 * Because every stage is deterministic and the generated `.spec.ts` carries no
 * timestamps, the emitted file is byte-stable. Any change to the KB template,
 * the builder, the resolver, or the emitter that alters real output will fail
 * this snapshot — a loud, reviewable diff rather than silent drift.
 *
 * If a diff here is intentional, re-run with `--ci=false -u` and commit the
 * updated snapshot alongside the change (and explain it in the PR).
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';
import {
  getBaselineScenarios,
  getScenarioActionTemplate,
} from '../../src/engines/qa-knowledge-engine';
import { materializeActionTemplate } from '../../src/graph/scenario-graph-builder';

// A tiny, fixed saucedemo login crawl — the same shape the crawler caches.
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

const testCase: any = {
  id: 7003, title: 'Valid credentials login', priority: 'P0', scenarioId: 'login-valid',
  preconditions: 'User is on the login page',
  expected_result: 'User is authenticated and redirected to the products page.',
  steps: [
    'Navigate to https://www.saucedemo.com',
    'Enter a valid username',
    'Enter a valid password',
    'Click the login button',
  ],
};

describe('Sprint 2D.3 — golden: KB → graph → Script Gen → Playwright', () => {
  it('emits the pinned Playwright spec from the real pipeline', async () => {
    // 1. KB authors the canonical action template for the valid-login scenario.
    const scenario = getBaselineScenarios('authentication').find((s) => s.id === 'auth-pos-valid')!;
    const template = getScenarioActionTemplate(scenario);
    expect(template).not.toBeNull();

    // 2. Builder materializes it (id/order; targets copied VERBATIM — canonical).
    const actions = materializeActionTemplate('login-valid', template!);

    // 3. Graph node carries semantics + resolved dataset (2D.2) + actions (2D.3).
    const node: any = {
      semantics: scenario.semantics,
      execution: {
        resolvedDataset: {
          datasetId: 'ds-1', recordId: 'rec-1', reason: 'role-match',
          values: { username: 'standard_user', password: 'secret_sauce' },
        },
      },
      actions,
    };

    // 4. Script Gen consumes the graph and grounds canonical targets → locators.
    const engine = new ScriptGenEngine();
    const result = await engine.generate({
      url: 'https://www.saucedemo.com',
      cachedCrawlData,
      testCases: [testCase],
      scenarioGraphNodes: new Map<string, any>([['login-valid', node]]),
    } as any);

    const spec = result.generatedFiles.map((f: any) => f.content).join('\n\n');

    // The actions came from the graph: exact canonical order, grounded values.
    expect(spec).toContain(`await page.goto('https://www.saucedemo.com/');`);
    expect(spec).toContain(`.fill('standard_user')`);
    expect(spec).toContain(`.fill('secret_sauce')`);

    // The long-term regression pin.
    expect(spec).toMatchSnapshot('login-valid.spec');
  });
});
