/**
 * Sprint 2D.4 — Execution Graph owns the executable ASSERTIONS
 *
 * The exact mirror of 2D.3, one concern over. Validates the "graph owns
 * assertions" contract end to end:
 *
 *   • KB layer   — `getScenarioAssertionTemplate` returns the AUTHORED template
 *     for a curated scenario and `null` otherwise (it NEVER invents a check).
 *   • Builder    — `materializeAssertionTemplate` assigns stable ids + array-index
 *     order and copies each entry (type/target/expected/optional) VERBATIM. It
 *     does NOT translate canonical targets into app vocabulary and NEVER
 *     reorders/invents checks — the graph stays application-neutral.
 *   • Script Gen — `emitGraphAssertionLines` IS the Execution Resolver: a pure
 *     `switch(type)` renderer that grounds each canonical target to a locator and
 *     resolves `@page.*` / `@messages.*` references to concrete URLs/copy for THIS
 *     app. No NL parsing, no regex over prose, no inference. When a node carries
 *     assertions the legacy `buildTcAssertions` inference is NOT entered; when it
 *     does not, generation falls back to it unchanged (100% backward compatible).
 *
 * The behaviours the sprint must prove before merge:
 *   (1) each frozen AssertionType → the correct Playwright matcher
 *   (2) `@page.*` / `@messages.*` grounded by the resolver, not the graph
 *   (3) canonical `order` honoured even if the array arrives shuffled
 *   (4) `optional` assertions guarded behind a count check
 *   (5) assertions present → graph-driven; absent → legacy inference unchanged
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';
import {
  materializeAssertionTemplate,
  materializeActionTemplate,
} from '../../src/graph/scenario-graph-builder';
import {
  getScenarioAssertionTemplate,
  getScenarioActionTemplate,
  getBaselineScenarios,
  type ScenarioAssertionTemplate,
} from '../../src/engines/qa-knowledge-engine';

// ---------------------------------------------------------------------------
// KB — getScenarioAssertionTemplate (authored-wins, never invents)
// ---------------------------------------------------------------------------
describe('Sprint 2D.4 — KB.getScenarioAssertionTemplate', () => {
  const authScenarios = getBaselineScenarios('authentication');
  const byId = (id: string) => authScenarios.find((s) => s.id === id)!;

  it('returns the authored template for a curated scenario (canonical + symbolic)', () => {
    const tmpl = getScenarioAssertionTemplate(byId('auth-neg-wrong-password'));
    expect(tmpl).not.toBeNull();
    // Exact authored set: error visible → error text → back on login page.
    expect(tmpl!.map((a) => a.type)).toEqual(['visible', 'text', 'url']);
    // Targets stay CANONICAL; the message + page stay SYMBOLIC (resolved later).
    expect(tmpl![0]).toMatchObject({ type: 'visible', target: 'login_error' });
    expect(tmpl![1]).toMatchObject({ type: 'text', target: 'login_error', expected: '@messages.invalid_credentials' });
    expect(tmpl![2]).toMatchObject({ type: 'url', expected: '@page.login' });
  });

  it('carries no locator, no expect(...), no concrete URL (graph is app-neutral)', () => {
    for (const s of authScenarios) {
      for (const a of getScenarioAssertionTemplate(s) ?? []) {
        const raw = String(a.expected ?? '');
        expect(raw).not.toContain('expect(');
        expect(raw).not.toMatch(/^https?:\/\//);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Builder — materializeAssertionTemplate (stable id/order, verbatim entries)
// ---------------------------------------------------------------------------
describe('Sprint 2D.4 — builder.materializeAssertionTemplate', () => {
  const template: ScenarioAssertionTemplate[] = [
    { type: 'visible', target: 'login_error' },
    { type: 'text', target: 'login_error', expected: '@messages.invalid_credentials' },
    { type: 'url', expected: '@page.login' },
  ];

  it('assigns STABLE SEMANTIC ids (from meaning, not position) + array-index order', () => {
    const mat = materializeAssertionTemplate('auth-neg-wrong-password', template);
    // ids encode the business meaning: <scenarioId>.<type>.<subject>. `subject`
    // is the canonical target, or the @page/@messages reference NAME when there
    // is no element target (the url check). NO array index appears in an id.
    expect(mat.map((a) => a.id)).toEqual([
      'auth-neg-wrong-password.visible.login_error',
      'auth-neg-wrong-password.text.login_error',
      'auth-neg-wrong-password.url.login',
    ]);
    expect(mat.map((a) => a.order)).toEqual([0, 1, 2]);
    expect(mat.map((a) => a.type)).toEqual(template.map((t) => t.type));
  });

  it('semantic ids are STABLE under reordering — same check keeps its id', () => {
    const forward = materializeAssertionTemplate('s', template);
    const reversed = materializeAssertionTemplate('s', [...template].reverse());
    const idOf = (arr: any[], type: string, target?: string) =>
      arr.find((a) => a.type === type && a.target === target)!.id;
    // The `visible login_error` check has the SAME id regardless of its position.
    expect(idOf(forward, 'visible', 'login_error')).toBe(idOf(reversed, 'visible', 'login_error'));
    expect(idOf(forward, 'url', undefined)).toBe(idOf(reversed, 'url', undefined));
    // …but `order` still reflects the new position (identity ≠ sequence).
    expect(forward[0].order).toBe(0);
    expect(reversed[0].order).toBe(0);
  });

  it('disambiguates a repeated semantic identity with a deterministic #n suffix', () => {
    const dup: ScenarioAssertionTemplate[] = [
      { type: 'visible', target: 'login_error' },
      { type: 'visible', target: 'login_error' },
    ];
    const mat = materializeAssertionTemplate('s', dup);
    expect(mat.map((a) => a.id)).toEqual([
      's.visible.login_error',
      's.visible.login_error#2',
    ]);
    // Unique + deterministic.
    expect(new Set(mat.map((a) => a.id)).size).toBe(2);
  });

  it('page-level url check with no target derives its subject from the @page reference', () => {
    const mat = materializeAssertionTemplate('auth-pos-valid', [
      { type: 'url', expected: '@page.inventory' },
    ]);
    expect(mat[0].id).toBe('auth-pos-valid.url.inventory');
  });

  it('copies target/expected VERBATIM — no translation to app vocabulary', () => {
    const mat = materializeAssertionTemplate('s', template);
    expect(mat.map((a) => a.target)).toEqual(['login_error', 'login_error', undefined]);
    expect(mat[1].expected).toBe('@messages.invalid_credentials');
    expect(mat[2].expected).toBe('@page.login');
  });

  it('does not add fields when optional is absent', () => {
    const mat = materializeAssertionTemplate('s', template);
    expect('optional' in mat[0]).toBe(false);
  });

  it('is a pure function — same input yields identical output', () => {
    const a = materializeAssertionTemplate('s', template);
    const b = materializeAssertionTemplate('s', template);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('copies afterAction VERBATIM and omits it when the KB does not author one', () => {
    const withRef: ScenarioAssertionTemplate[] = [
      { type: 'visible', target: 'login_error', afterAction: 's.click.login_button' },
      { type: 'url', expected: '@page.login' }, // no afterAction authored
    ];
    const mat = materializeAssertionTemplate('s', withRef);
    // afterAction is an action.id — copied byte-for-byte, never re-derived.
    expect(mat[0].afterAction).toBe('s.click.login_button');
    // Absent stays absent — never invented, never defaulted.
    expect('afterAction' in mat[1]).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// afterAction — the link from an assertion to the action it follows. It IS the
// producing action's `id` (`<scenarioId>.<action>.<target>`), so the join is a
// plain `action.id === afterAction` — one identity, no slug, no computation.
// ---------------------------------------------------------------------------
describe('Sprint 2D.4 review — assertion.afterAction ↔ action.id (direct join)', () => {
  it('action ids are UNIQUE per scenario and include the semantic <scenarioId>.click.login_button', () => {
    for (const id of ['auth-pos-valid', 'auth-neg-wrong-password', 'auth-neg-empty-fields', 'auth-neg-unknown-user']) {
      const scenario = getBaselineScenarios('authentication').find((s) => s.id === id)!;
      const actions = materializeActionTemplate(id, getScenarioActionTemplate(scenario)!);
      const ids = actions.map((a) => a.id);
      expect(ids).toContain(`${id}.click.login_button`);
      expect(new Set(ids).size).toBe(ids.length); // unique within the scenario
    }
  });

  it('every authored afterAction equals EXACTLY ONE action id in the same scenario', () => {
    const scenario = getBaselineScenarios('authentication').find((s) => s.id === 'auth-neg-wrong-password')!;
    const actions = materializeActionTemplate('auth-neg-wrong-password', getScenarioActionTemplate(scenario)!);
    const assertions = materializeAssertionTemplate('auth-neg-wrong-password', getScenarioAssertionTemplate(scenario)!);

    for (const a of assertions) {
      expect(a.afterAction).toBe('auth-neg-wrong-password.click.login_button');
      const matches = actions.filter((act) => act.id === a.afterAction);
      expect(matches).toHaveLength(1); // durable, unambiguous join — by id
      expect(matches[0].action).toBe('click');
      expect(matches[0].target).toBe('login_button');
    }
  });

  it('is IDENTITY not position — the ref survives an action reordering', () => {
    const scenario = getBaselineScenarios('authentication').find((s) => s.id === 'auth-neg-wrong-password')!;
    const actions = materializeActionTemplate('auth-neg-wrong-password', getScenarioActionTemplate(scenario)!);
    const reordered = [...actions].reverse();
    const ref = 'auth-neg-wrong-password.click.login_button';
    // The click moved from last to first, but its id still points to it.
    expect(actions.find((a) => a.id === ref)!.action).toBe('click');
    expect(reordered.find((a) => a.id === ref)!.action).toBe('click');
  });
});

// ---------------------------------------------------------------------------
// Script Gen — emitGraphAssertionLines (the Execution Resolver / renderer)
// ---------------------------------------------------------------------------
describe('Sprint 2D.4 — ScriptGen.emitGraphAssertionLines', () => {
  const engine = new ScriptGenEngine();
  const emit = (assertions: any[], ctx: any, resolved: any = null) =>
    (engine as any).emitGraphAssertionLines(assertions, ctx, resolved) as string[];

  // `sel` holds pre-grounded locator EXPRESSIONS; `url` is the resolved base URL.
  // A saucedemo URL makes the resolver's App Knowledge (messages/routes) active.
  const baseCtx = () => ({
    url: 'https://www.saucedemo.com',
    creds: { username: '', password: '' },
    sel: {
      username: `page.getByTestId('username')`,
      password: `page.getByTestId('password')`,
      login: `page.getByTestId('login-button')`,
      error: `page.getByTestId('error')`,
      title: `page.getByTestId('title')`,
      logout: `page.getByTestId('logout')`,
    },
    data: undefined,
    crawl: undefined,
    stepTracked: [],
  });

  const A = (type: string, extra: any = {}, order = 0) => ({ id: `s:a:${order}`, order, type, ...extra });

  it('(1) renders each frozen AssertionType to the correct Playwright matcher', () => {
    const cases: Array<[any, string]> = [
      [A('visible', { target: 'login_error' }), `await expect(page.getByTestId('error')).toBeVisible();`],
      [A('hidden', { target: 'login_error' }), `await expect(page.getByTestId('error')).toBeHidden();`],
      [A('enabled', { target: 'login_button' }), `await expect(page.getByTestId('login-button')).toBeEnabled();`],
      [A('disabled', { target: 'login_button' }), `await expect(page.getByTestId('login-button')).toBeDisabled();`],
      [A('checked', { target: 'login_button' }), `await expect(page.getByTestId('login-button')).toBeChecked();`],
      [A('unchecked', { target: 'login_button' }), `await expect(page.getByTestId('login-button')).not.toBeChecked();`],
      [A('value', { target: 'username', expected: 'standard_user' }), `await expect(page.getByTestId('username')).toHaveValue('standard_user');`],
      [A('count', { target: 'login_error', expected: 1 }), `await expect(page.getByTestId('error')).toHaveCount(1);`],
      [A('attribute', { target: 'password', expected: 'type=password' }), `await expect(page.getByTestId('password')).toHaveAttribute('type', 'password');`],
    ];
    for (const [assertion, expected] of cases) {
      expect(emit([assertion], baseCtx()).join('\n')).toContain(expected);
    }
  });

  it('(2a) grounds `url @page.login` to the app base URL (exact string)', () => {
    const code = emit([A('url', { expected: '@page.login' })], baseCtx()).join('\n');
    expect(code).toContain(`await expect(page).toHaveURL('https://www.saucedemo.com');`);
  });

  it('(2b) grounds `url @page.inventory` to the canonical /inventory\\.html/ regex on saucedemo', () => {
    const code = emit([A('url', { expected: '@page.inventory' })], baseCtx()).join('\n');
    expect(code).toContain(`await expect(page).toHaveURL(/inventory\\.html/);`);
  });

  it('(2c) grounds `text @messages.*` to the concrete app copy via toContainText', () => {
    const code = emit([A('text', { target: 'login_error', expected: '@messages.invalid_credentials' })], baseCtx()).join('\n');
    expect(code).toContain(`await expect(page.getByTestId('error')).toContainText('Username and password do not match');`);
  });

  it('(2d) degrades an UNRESOLVED message to a visibility check (never invents copy)', () => {
    // A non-sauce app has no message map → the reference cannot resolve.
    const ctx = { ...baseCtx(), url: 'https://unknown.example.com/login' };
    const code = emit([A('text', { target: 'login_error', expected: '@messages.invalid_credentials' })], ctx).join('\n');
    expect(code).toContain('.toBeVisible();');
    expect(code).not.toContain('toContainText');
  });

  it('(2e) the graph passes NO selectors/URLs — grounding is entirely the resolver\'s', () => {
    // The renderer receives only canonical targets + symbolic refs; the concrete
    // locator text comes from ctx.sel, never from the assertion objects.
    const assertions = [A('visible', { target: 'login_error' }), A('url', { expected: '@page.login' }, 1)];
    for (const a of assertions) {
      expect(JSON.stringify(a)).not.toContain('getByTestId');
      expect(JSON.stringify(a)).not.toContain('saucedemo.com');
    }
  });

  it('(3) honours canonical order even if the array arrives shuffled', () => {
    const shuffled = [
      A('url', { expected: '@page.login' }, 2),
      A('visible', { target: 'login_error' }, 0),
      A('text', { target: 'login_error', expected: '@messages.invalid_credentials' }, 1),
    ];
    const code = emit(shuffled, baseCtx()).join('\n');
    expect(code.indexOf('toBeVisible')).toBeLessThan(code.indexOf('toContainText'));
    expect(code.indexOf('toContainText')).toBeLessThan(code.indexOf('toHaveURL'));
  });

  it('(4) guards an optional assertion behind a count check', () => {
    const code = emit([A('visible', { target: 'login_error', optional: true })], baseCtx()).join('\n');
    expect(code).toContain(`if (await page.getByTestId('error').count() > 0) {`);
    expect(code).toContain(`  await expect(page.getByTestId('error')).toBeVisible();`);
    expect(code).toContain('}');
  });

  it('(4b) never guards a page-level url check (no target to count)', () => {
    const code = emit([A('url', { expected: '@page.login', optional: true })], baseCtx()).join('\n');
    expect(code).not.toContain('.count() > 0');
  });

  it('is deterministic — identical assertions + ctx produce identical lines', () => {
    const set = [A('visible', { target: 'login_error' }), A('url', { expected: '@page.login' }, 1)];
    expect(emit(set, baseCtx())).toEqual(emit(set, baseCtx()));
  });

  it('degrades an unknown target to a stable label locator (no crash)', () => {
    const code = emit([A('visible', { target: 'promo_banner' })], baseCtx()).join('\n');
    expect(code).toContain(`page.getByLabel('promo banner')`);
  });
});
