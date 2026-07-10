/**
 * Sprint 2D.3 — Execution Graph owns the executable ACTIONS
 *
 * Validates the "graph owns actions" contract end to end:
 *
 *   • KB layer  — `getScenarioActionTemplate` returns the AUTHORED template for
 *     curated scenarios and `null` otherwise (it NEVER invents a sequence).
 *   • Builder   — `materializeActionTemplate` assigns stable ids + array-index
 *     order and copies each target VERBATIM. It does NOT translate canonical
 *     targets into app vocabulary and NEVER reorders/invents steps — the graph
 *     stays application-neutral.
 *   • Script Gen — `emitGraphActionLines` IS the Execution Resolver: it grounds
 *     each canonical target to a locator and EXECUTES the ordered actions
 *     directly (no NL parsing, no regex over prose). When a node carries actions
 *     the legacy `tcStepsToCode` parser is NOT entered; when it does not,
 *     generation falls back to the parser unchanged (100% backward compatible).
 *
 * Actions are STATE-CHANGING verbs ONLY (navigate/fill/click/check/uncheck/
 * select/upload). There is deliberately NO `verify` action — expected outcomes
 * are Assertions, a separate concern landing in Sprint 2D.4.
 *
 * The behaviours the sprint must prove before merge:
 *   (1) actions present  → graph-driven lines emitted & parser not entered
 *   (2) no actions       → legacy parser path unchanged
 *   (3) same graph       → byte-for-byte deterministic output
 *   (4) action order     → preserved exactly (never reordered)
 *   (5) @dataset.username → resolvedDataset value flows into the script
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';
import { materializeActionTemplate } from '../../src/graph/scenario-graph-builder';
import {
  getScenarioActionTemplate,
  getBaselineScenarios,
  type ScenarioActionTemplate,
} from '../../src/engines/qa-knowledge-engine';

// ---------------------------------------------------------------------------
// KB — getScenarioActionTemplate (authored-wins, never invents)
// ---------------------------------------------------------------------------
describe('Sprint 2D.3 — KB.getScenarioActionTemplate', () => {
  const authScenarios = getBaselineScenarios('authentication');
  const byId = (id: string) => authScenarios.find((s) => s.id === id)!;

  it('returns the authored template for a curated scenario', () => {
    const tmpl = getScenarioActionTemplate(byId('auth-pos-valid'));
    expect(tmpl).not.toBeNull();
    // Exact authored sequence: navigate → fill → fill → click. NO `verify` —
    // the authored template ends at the last state-changing action.
    expect(tmpl!.map((a) => a.action)).toEqual([
      'navigate', 'fill', 'fill', 'click',
    ]);
    // Carries CANONICAL targets + symbolic dataset values (resolved downstream).
    expect(tmpl![1]).toMatchObject({ action: 'fill', target: 'username', value: '@dataset.username' });
    expect(tmpl![2]).toMatchObject({ action: 'fill', target: 'password', value: '@dataset.password' });
  });

  it('never emits a `verify` (or any non-state-changing) action', () => {
    const LEGAL = new Set(['navigate', 'fill', 'click', 'check', 'uncheck', 'select', 'upload']);
    for (const s of authScenarios) {
      const tmpl = getScenarioActionTemplate(s);
      if (!tmpl) continue;
      for (const a of tmpl) expect(LEGAL.has(a.action)).toBe(true);
    }
  });

  it('honors a literal (non-dataset) value in an authored template', () => {
    const tmpl = getScenarioActionTemplate(byId('auth-neg-wrong-password'))!;
    const pwd = tmpl.find((a) => a.target === 'password')!;
    expect(pwd.value).toBe('wrong-password'); // literal, not @dataset.*
  });

  it('returns null for an uncurated scenario (never invents a sequence)', () => {
    const uncurated = byId('auth-neg-locked-user'); // authored semantics, NO actionTemplate
    expect(uncurated.actionTemplate).toBeUndefined();
    expect(getScenarioActionTemplate(uncurated)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Builder — materializeActionTemplate (stable id/order, verbatim targets)
// ---------------------------------------------------------------------------
describe('Sprint 2D.3 — builder.materializeActionTemplate', () => {
  const template: ScenarioActionTemplate[] = [
    { action: 'navigate', target: 'login_page' },
    { action: 'fill', target: 'username', value: '@dataset.username' },
    { action: 'fill', target: 'password', value: '@dataset.password' },
    { action: 'click', target: 'login_button' },
  ];

  it('assigns STABLE SEMANTIC ids (<scenarioId>.<action>.<target>) and array-index order', () => {
    const mat = materializeActionTemplate('auth-pos-valid', template);
    // Identity is the step's business meaning, NOT its position — so the id
    // survives insertion/reordering and `afterAction` can point straight at it.
    expect(mat.map((a) => a.id)).toEqual([
      'auth-pos-valid.navigate.login_page',
      'auth-pos-valid.fill.username',
      'auth-pos-valid.fill.password',
      'auth-pos-valid.click.login_button',
    ]);
    expect(mat.map((a) => a.order)).toEqual([0, 1, 2, 3]);
    // Sequence of verbs is preserved 1:1 with the authored template.
    expect(mat.map((a) => a.action)).toEqual(template.map((t) => t.action));
  });

  it('id survives reordering — the same step keeps the same identity', () => {
    const reordered = [template[3], template[0], template[1], template[2]];
    const mat = materializeActionTemplate('auth-pos-valid', reordered);
    // The click keeps `auth-pos-valid.click.login_button` even though it moved to
    // index 0; only `order` reflects the new position. (Position ≠ identity.)
    const click = mat.find((a) => a.action === 'click')!;
    expect(click.id).toBe('auth-pos-valid.click.login_button');
    expect(click.order).toBe(0);
  });

  it('disambiguates duplicate <action>.<target> with a deterministic #n suffix', () => {
    const dup: ScenarioActionTemplate[] = [
      { action: 'fill', target: 'username', value: 'a' },
      { action: 'fill', target: 'username', value: 'b' },
    ];
    const mat = materializeActionTemplate('s', dup);
    expect(mat.map((a) => a.id)).toEqual([
      's.fill.username',
      's.fill.username#2',
    ]);
  });

  it('copies each target VERBATIM — it does NOT translate to app vocabulary', () => {
    const mat = materializeActionTemplate('auth-pos-valid', template);
    // Canonical targets survive untouched: `username` stays `username`,
    // NOT `email_input`; `login_button` stays `login_button`, NOT `submit_cta`.
    expect(mat.map((a) => a.target)).toEqual([
      'login_page', 'username', 'password', 'login_button',
    ]);
  });

  it('preserves value and does not add fields when optional is absent', () => {
    const mat = materializeActionTemplate('auth-pos-valid', template);
    expect(mat[1].value).toBe('@dataset.username');
    expect('optional' in mat[1]).toBe(false);
  });

  it('is a pure function — same input yields identical output', () => {
    const a = materializeActionTemplate('auth-pos-valid', template);
    const b = materializeActionTemplate('auth-pos-valid', template);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// Script Gen — emitGraphActionLines (the Execution Resolver / adapter)
// ---------------------------------------------------------------------------
describe('Sprint 2D.3 — ScriptGen.emitGraphActionLines', () => {
  const engine = new ScriptGenEngine();
  const emit = (actions: any[], ctx: any, resolved: any) =>
    (engine as any).emitGraphActionLines(actions, ctx, resolved) as { lines: string[] };

  // A minimal ctx: `sel` holds pre-grounded locator EXPRESSIONS (as produced by
  // buildGroundedSelectors), `url` is the resolved base URL.
  const baseCtx = () => ({
    url: 'https://app.example.com/login',
    creds: { username: '', password: '' },
    sel: {
      username: `page.getByTestId('username')`,
      password: `page.getByTestId('password')`,
      login: `page.getByTestId('login-button')`,
      error: `page.getByTestId('error')`,
      title: `page.getByTestId('title')`,
    },
    data: undefined,
    crawl: undefined,
    stepTracked: [],
  });

  const validActions = [
    { id: 's:0', order: 0, action: 'navigate', target: 'login_page' },
    { id: 's:1', order: 1, action: 'fill', target: 'username', value: '@dataset.username' },
    { id: 's:2', order: 2, action: 'fill', target: 'password', value: '@dataset.password' },
    { id: 's:3', order: 3, action: 'click', target: 'login_button' },
  ];

  it('(4) executes actions in canonical order, mapping targets to grounded locators', () => {
    const { lines } = emit(validActions, baseCtx(), null);
    const code = lines.join('\n');
    // Ordered, executable statements — one per action.
    expect(code).toContain(`await page.goto('https://app.example.com/login');`);
    expect(code).toContain(`await page.getByTestId('username').fill(`);
    expect(code).toContain(`await page.getByTestId('password').fill(`);
    expect(code).toContain(`await page.getByTestId('login-button').click();`);
    // ORDER is preserved: goto precedes username fill precedes password precedes click.
    const iGoto = code.indexOf('page.goto');
    const iUser = code.indexOf(`getByTestId('username')`);
    const iPwd = code.indexOf(`getByTestId('password')`);
    const iClick = code.indexOf(`getByTestId('login-button').click`);
    expect(iGoto).toBeLessThan(iUser);
    expect(iUser).toBeLessThan(iPwd);
    expect(iPwd).toBeLessThan(iClick);
  });

  it('emits ONLY state-changing statements — never an assertion (no expect/toBeVisible)', () => {
    const { lines } = emit(validActions, baseCtx(), null);
    const code = lines.join('\n');
    expect(code).not.toContain('expect(');
    expect(code).not.toContain('toBeVisible');
  });

  it('(4b) sorts by canonical order even if the array arrives shuffled', () => {
    const shuffled = [validActions[3], validActions[0], validActions[2], validActions[1]];
    const { lines } = emit(shuffled, baseCtx(), null);
    const code = lines.join('\n');
    expect(code.indexOf('page.goto')).toBeLessThan(code.indexOf(`getByTestId('login-button').click`));
  });

  it('(5) resolves @dataset.username/password from resolvedDataset values', () => {
    const { lines } = emit(validActions, baseCtx(), { username: 'graph_user', password: 'graph_pass' });
    const code = lines.join('\n');
    expect(code).toContain(`.fill('graph_user')`);
    expect(code).toContain(`.fill('graph_pass')`);
  });

  it('(5b) binds @dataset.* to the live record when one is present', () => {
    const ctx = { ...baseCtx(), data: { varName: 'user', ref: `getRecord('valid_users')`, hasUsername: true, hasPassword: true } };
    const { lines } = emit(validActions, ctx, null);
    const code = lines.join('\n');
    expect(code).toContain(`.fill(user.username ?? '')`);
    expect(code).toContain(`.fill(user.password ?? '')`);
  });

  it('emits a literal value verbatim (non-dataset)', () => {
    const acts = [
      { id: 's:0', order: 0, action: 'navigate', target: 'login_page' },
      { id: 's:1', order: 1, action: 'fill', target: 'password', value: 'wrong-password' },
    ];
    const { lines } = emit(acts, baseCtx(), null);
    expect(lines.join('\n')).toContain(`.fill('wrong-password')`);
  });

  it('guards an optional action behind a count check', () => {
    const acts = [
      { id: 's:0', order: 0, action: 'click', target: 'login_button', optional: true },
    ];
    const { lines } = emit(acts, baseCtx(), null);
    const code = lines.join('\n');
    expect(code).toContain(`if (await page.getByTestId('login-button').count() > 0) {`);
    expect(code).toContain(`  await page.getByTestId('login-button').click();`);
  });

  it('(3) is deterministic — identical actions + ctx produce identical lines', () => {
    const a = emit(validActions, baseCtx(), { username: 'u', password: 'p' });
    const b = emit(validActions, baseCtx(), { username: 'u', password: 'p' });
    expect(a.lines).toEqual(b.lines);
  });

  it('degrades an unknown target to a stable label locator (no crash)', () => {
    const acts = [{ id: 's:0', order: 0, action: 'check', target: 'terms_checkbox' }];
    const { lines } = emit(acts, baseCtx(), null);
    expect(lines.join('\n')).toContain(`page.getByLabel('terms checkbox')`);
  });
});

// ---------------------------------------------------------------------------
// Integration — through the public generate() entry point.
// Proves (1) the graph-actions path is wired and (2) the legacy fallback is
// preserved when a node carries no actions.
// ---------------------------------------------------------------------------
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

const mkTestCase = (): any => ({
  id: 7003, title: 'Valid credentials login', priority: 'P0', scenarioId: 'login-valid',
  preconditions: 'User is on the login page',
  expected_result: 'User is authenticated and redirected to the products page.',
  steps: [
    'Navigate to https://www.saucedemo.com',
    'Enter a valid username',
    'Enter a valid password',
    'Click the login button',
  ],
});

const positiveSemantics = {
  variableUnderTest: 'none',
  preconditions: 'valid username + valid password',
  variation: 'none',
  expectedBehavior: 'successfully authenticated and redirected',
  requiredDataRole: 'registered_user',
};

const graphActions = [
  { id: 'login-valid:0', order: 0, action: 'navigate', target: 'login_page' },
  { id: 'login-valid:1', order: 1, action: 'fill', target: 'username', value: '@dataset.username' },
  { id: 'login-valid:2', order: 2, action: 'fill', target: 'password', value: '@dataset.password' },
  { id: 'login-valid:3', order: 3, action: 'click', target: 'login_button' },
];

async function generate(withActions: boolean): Promise<string> {
  const engine = new ScriptGenEngine();
  const tc = mkTestCase();
  const node: any = {
    semantics: positiveSemantics,
    execution: { resolvedDataset: { datasetId: 'ds-1', recordId: 'rec-1', reason: 'role-match', values: { username: 'graph_user', password: 'graph_pass' } } },
  };
  if (withActions) node.actions = graphActions;
  const config: any = {
    url: 'https://www.saucedemo.com', cachedCrawlData, testCases: [tc],
    scenarioGraphNodes: new Map<string, any>([['login-valid', node]]),
  };
  const result = await engine.generate(config);
  return result.generatedFiles.map((f: any) => f.content).join('\n\n');
}

describe('Sprint 2D.3 — generate() consumes graph actions', () => {
  it('(1) does NOT enter the legacy step parser when the node carries actions', async () => {
    const engine = new ScriptGenEngine();
    const parserSpy = jest.spyOn(engine as any, 'tcStepsToCode');
    const emitSpy = jest.spyOn(engine as any, 'emitGraphActionLines');
    const tc = mkTestCase();
    const config: any = {
      url: 'https://www.saucedemo.com', cachedCrawlData, testCases: [tc],
      scenarioGraphNodes: new Map<string, any>([['login-valid', {
        semantics: positiveSemantics,
        execution: { resolvedDataset: { datasetId: 'ds-1', recordId: 'rec-1', reason: 'role-match', values: { username: 'graph_user', password: 'graph_pass' } } },
        actions: graphActions,
      }]]),
    };
    await engine.generate(config);
    expect(emitSpy).toHaveBeenCalled();
    expect(parserSpy).not.toHaveBeenCalled();
  });

  it('(1b) emits the graph-resolved credential VALUES via the actions path', async () => {
    const code = await generate(true);
    expect(code).toContain('graph_user');
    expect(code).toContain('graph_pass');
  });

  it('(2) falls back to the legacy parser when the node carries NO actions', async () => {
    const engine = new ScriptGenEngine();
    const parserSpy = jest.spyOn(engine as any, 'tcStepsToCode');
    const emitSpy = jest.spyOn(engine as any, 'emitGraphActionLines');
    const tc = mkTestCase();
    const config: any = {
      url: 'https://www.saucedemo.com', cachedCrawlData, testCases: [tc],
      scenarioGraphNodes: new Map<string, any>([['login-valid', { semantics: positiveSemantics }]]),
    };
    await engine.generate(config);
    expect(parserSpy).toHaveBeenCalled();
    expect(emitSpy).not.toHaveBeenCalled();
  });
});
