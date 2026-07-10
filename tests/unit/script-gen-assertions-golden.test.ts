/**
 * Sprint 2D.4 — GOLDEN end-to-end regression: Scenario → Execution Graph →
 * Script Gen → Playwright spec, now with the graph owning ASSERTIONS too.
 *
 * The mirror of the 2D.3 actions golden and the long-term guard the review asked
 * for: one full pass through the REAL pipeline, pinned to a committed snapshot.
 * It wires the actual production pieces together with NO hand-authored actions or
 * assertions:
 *
 *   KB (`getScenarioActionTemplate` + `getScenarioAssertionTemplate`)
 *     → Builder (`materializeActionTemplate` + `materializeAssertionTemplate`)
 *       → Graph node.actions + node.assertions   — canonical, app-neutral
 *         → Script Gen (`generate`)              — Execution Resolver grounds both
 *
 * `auth-neg-wrong-password` is chosen deliberately: its assertion set exercises
 * all three grounding paths in one spec — a canonical target (`login_error`), a
 * `@messages.*` reference (resolved to concrete SauceDemo copy), and a `@page.*`
 * reference (resolved to the login URL). Because every stage is deterministic and
 * the emitted `.spec.ts` carries no timestamps, the file is byte-stable: any
 * change to the KB template, the builder, the resolver, or the renderer that
 * alters real output fails this snapshot — a loud, reviewable diff.
 *
 * If a diff here is intentional, re-run with `--ci=false -u` and commit the
 * updated snapshot alongside the change (and explain it in the PR).
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';
import {
  getBaselineScenarios,
  getScenarioActionTemplate,
  getScenarioAssertionTemplate,
} from '../../src/engines/qa-knowledge-engine';
import {
  materializeActionTemplate,
  materializeAssertionTemplate,
} from '../../src/graph/scenario-graph-builder';

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
  id: 7011, title: 'Invalid password is rejected', priority: 'P0', scenarioId: 'login-wrong-password',
  preconditions: 'User is on the login page',
  expected_result: 'Authentication is rejected with a generic error and the user stays on the login page.',
  steps: [
    'Navigate to https://www.saucedemo.com',
    'Enter a valid username',
    'Enter an incorrect password',
    'Click the login button',
  ],
};

describe('Sprint 2D.4 — golden: KB → graph → Script Gen → Playwright (assertions)', () => {
  it('emits the pinned Playwright spec with graph-owned actions AND assertions', async () => {
    // 1. KB authors BOTH the canonical action + assertion templates.
    const scenario = getBaselineScenarios('authentication').find((s) => s.id === 'auth-neg-wrong-password')!;
    const actionTemplate = getScenarioActionTemplate(scenario);
    const assertionTemplate = getScenarioAssertionTemplate(scenario);
    expect(actionTemplate).not.toBeNull();
    expect(assertionTemplate).not.toBeNull();

    // 2. Builder materializes each (id/order; target/expected copied VERBATIM).
    const actions = materializeActionTemplate('login-wrong-password', actionTemplate!);
    const assertions = materializeAssertionTemplate('login-wrong-password', assertionTemplate!);

    // 3. Graph node: semantics + resolved dataset (2D.2) + actions (2D.3) +
    //    assertions (2D.4) — all canonical, app-neutral.
    const node: any = {
      semantics: scenario.semantics,
      execution: {
        resolvedDataset: {
          datasetId: 'ds-1', recordId: 'rec-1', reason: 'role-match',
          values: { username: 'standard_user', password: 'secret_sauce' },
        },
      },
      actions,
      assertions,
    };

    // 4. Script Gen consumes the graph and grounds canonical targets + symbolic
    //    @page.*/@messages.* references → locators / URLs / copy.
    const engine = new ScriptGenEngine();
    const result = await engine.generate({
      url: 'https://www.saucedemo.com',
      cachedCrawlData,
      testCases: [testCase],
      scenarioGraphNodes: new Map<string, any>([['login-wrong-password', node]]),
    } as any);

    const spec = result.generatedFiles.map((f: any) => f.content).join('\n\n');

    // The assertions came from the graph: the error is checked, the resolved
    // SauceDemo copy is asserted, and the login URL is grounded from @page.login.
    expect(spec).toContain('.toBeVisible();');
    expect(spec).toContain(`.toContainText('Username and password do not match')`);
    expect(spec).toContain(`await expect(page).toHaveURL('https://www.saucedemo.com/')`);

    // The long-term regression pin.
    expect(spec).toMatchSnapshot('login-wrong-password.spec');
  });
});
