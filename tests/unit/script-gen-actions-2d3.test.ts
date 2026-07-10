/**
 * Sprint 2D.3 — Execution Graph owns the executable ACTIONS
 *
 * Validates the "graph owns actions" contract end to end:
 *
 *   • KB layer  — `getScenarioActionTemplate` returns the AUTHORED template for
 *     curated scenarios and `null` otherwise (it NEVER invents a sequence).
 *   • Builder   — `bindActionTemplate` binds abstract targets to the App Profile,
 *     assigns stable ids + array-index order, and NEVER reorders/invents steps.
 *   • Script Gen — `emitGraphActionLines` EXECUTES the ordered actions directly
 *     (no NL parsing, no regex over prose). When a node carries actions the
 *     legacy `tcStepsToCode` parser is NOT entered; when it does not, generation
 *     falls back to the parser unchanged (100% backward compatible).
 *
 * The five behaviours the sprint must prove before merge:
 *   (1) actions present  → graph-driven lines emitted & parser not entered
 *   (2) no actions       → legacy parser path unchanged
 *   (3) same graph       → byte-for-byte deterministic output
 *   (4) action order     → preserved exactly (never reordered)
 *   (5) @dataset.username → resolvedDataset value flows into the script
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';
import {
  bindActionTemplate,
  type TargetBindings,
} from '../../src/graph/scenario-graph-builder';
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
    // Exact authored sequence: navigate → fill → fill → click → verify.
    expect(tmpl!.map((a) => a.action)).toEqual([
      'navigate', 'fill', 'fill', 'click', 'verify',
    ]);
    // Carries ABSTRACT targets + symbolic dataset values (bound downstream).
    expect(tmpl![1]).toMatchObject({ action: 'fill', target: 'username', value: '@dataset.username' });
    expect(tmpl![2]).toMatchObject({ action: 'fill', target: 'password', value: '@dataset.password' });
  });

  it('honors a literal (non-dataset) value in an authored template', () => {
    const tmpl = getScenarioActionTemplate(byId('auth-neg-wrong-password'))!;
    const pwd = tmpl.find((a) => a.target === 'password')!;
    expect(pwd.value).toBe('wrong-password'); // literal, not @dataset.*
  });

  it('returns null for an uncurated scenario (never invents a sequence)', () => {
    const uncurated = byId('auth-neg-unknown-user'); // authored semantics, NO actionTemplate
    expect(uncurated.actionTemplate).toBeUndefined();
    expect(getScenarioActionTemplate(uncurated)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Builder — bindActionTemplate (binds targets, stable id/order, no reorder)
// ---------------------------------------------------------------------------
describe('Sprint 2D.3 — builder.bindActionTemplate', () => {
  const template: ScenarioActionTemplate[] = [
    { action: 'navigate', target: 'login_page' },
    { action: 'fill', target: 'username', value: '@dataset.username' },
    { action: 'fill', target: 'password', value: '@dataset.password' },
    { action: 'click', target: 'login_button' },
    { action: 'verify', target: 'authenticated_landing' },
  ];

  it('assigns stable ids and array-index order without reordering', () => {
    const bound = bindActionTemplate('auth-pos-valid', template);
    expect(bound.map((a) => a.id)).toEqual([
      'auth-pos-valid:0', 'auth-pos-valid:1', 'auth-pos-valid:2',
      'auth-pos-valid:3', 'auth-pos-valid:4',
    ]);
    expect(bound.map((a) => a.order)).toEqual([0, 1, 2, 3, 4]);
    // Sequence of verbs is preserved 1:1 with the authored template.
    expect(bound.map((a) => a.action)).toEqual(template.map((t) => t.action));
  });

  it('binds targets from the App Profile bindings, passing through the rest', () => {
    const bindings: TargetBindings = {
      login_page: '/login',
      login_button: 'submit_cta',
    };
    const bound = bindActionTemplate('auth-pos-valid', template, bindings);
    expect(bound[0].target).toBe('/login');       // bound
    expect(bound[3].target).toBe('submit_cta');   // bound
    expect(bound[1].target).toBe('username');     // passthrough (no binding)
  });

  it('preserves value and does not add fields when optional is absent', () => {
    const bound = bindActionTemplate('auth-pos-valid', template);
    expect(bound[1].value).toBe('@dataset.username');
    expect('optional' in bound[1]).toBe(false);
  });

  it('is a pure function — same input yields identical output', () => {
    const a = bindActionTemplate('auth-pos-valid', template);
    const b = bindActionTemplate('auth-pos-valid', template);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

// ---------------------------------------------------------------------------
// Script Gen — emitGraphActionLines (the deterministic adapter)
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
    { id: 's:4', order: 4, action: 'verify', target: 'authenticated_landing' },
  ];

  it('(4) executes actions in canonical order, mapping targets to grounded locators', () => {
    const { lines } = emit(validActions, baseCtx(), null);
    const code = lines.join('\n');
    // Ordered, executable statements — one per action.
    expect(code).toContain(`await page.goto('https://app.example.com/login');`);
    expect(code).toContain(`await page.getByTestId('username').fill(`);
    expect(code).toContain(`await page.getByTestId('password').fill(`);
    expect(code).toContain(`await page.getByTestId('login-button').click();`);
    expect(code).toContain(`await expect(page.getByTestId('title')).toBeVisible();`);
    // ORDER is preserved: goto precedes username fill precedes click precedes verify.
    const iGoto = code.indexOf('page.goto');
    const iUser = code.indexOf(`getByTestId('username')`);
    const iClick = code.indexOf(`getByTestId('login-button').click`);
    const iVerify = code.indexOf('toBeVisible');
    expect(iGoto).toBeLessThan(iUser);
    expect(iUser).toBeLessThan(iClick);
    expect(iClick).toBeLessThan(iVerify);
  });

  it('(4b) sorts by canonical order even if the array arrives shuffled', () => {
    const shuffled = [validActions[3], validActions[0], validActions[4], validActions[1], validActions[2]];
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
    const acts = [{ id: 's:0', order: 0, action: 'verify', target: 'terms_checkbox' }];
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
  { id: 'login-valid:4', order: 4, action: 'verify', target: 'authenticated_landing' },
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
