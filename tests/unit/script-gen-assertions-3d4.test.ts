/**
 * Sprint 3.4 — Assertion Quality: business assertions first, URL/title last.
 *
 * This is an EMITTER-QUALITY change, not an intelligence change. The Execution
 * Graph still owns WHAT to assert (Sprint 2D.4); Script Gen still only TRANSLATES
 * canonical assertions into Playwright via the pure `switch(type)` renderer. The
 * one thing 3.4 adds is PRESENTATION ORDER at emit time:
 *
 *   • A Senior SDET proves BUSINESS success by checking a real element / message
 *     / state is present, and treats the page URL as corroboration — not proof.
 *   • Some KB positive scenarios author the `url` check FIRST (e.g. auth-pos-valid
 *     lists url → visible). Rendering that verbatim makes the generated spec lead
 *     with `expect(page).toHaveURL(...)`, which reads like a navigation test, not
 *     a login test.
 *   • So at EMIT time only, Script Gen presents business assertions first and
 *     demotes page-level `url` checks to the end.
 *
 * The invariants this suite locks in:
 *   (1) positive login renders the business `visible` BEFORE the `url` fallback
 *   (2) it is a STABLE PARTITION — business meaning is never reordered against
 *       itself, and no assertion is added, dropped, or invented (count is stable)
 *   (3) every non-url (business) type outranks `url`
 *   (4) multiple url checks keep their relative order, all after the business set
 *   (5) already-business-first scenarios (negative flows) are untouched
 *   (6) deterministic
 */

import { ScriptGenEngine } from '../../src/script-gen/script-gen-engine';
import { materializeAssertionTemplate } from '../../src/graph/scenario-graph-builder';
import {
  getScenarioAssertionTemplate,
  getBaselineScenarios,
} from '../../src/engines/qa-knowledge-engine';

describe('Sprint 3.4 — ScriptGen assertion ordering (business-first, URL last)', () => {
  const engine = new ScriptGenEngine();
  const emit = (assertions: any[], ctx: any, resolved: any = null) =>
    (engine as any).emitGraphAssertionLines(assertions, ctx, resolved) as string[];

  // Pre-grounded locator expressions; a saucedemo URL activates the resolver's
  // App Knowledge (routes/messages) so `@page.*` / `@messages.*` resolve.
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

  it('(1) POSITIVE login: the KB authors url→visible, but the spec leads with the business check', () => {
    // Feed the EXACT authored order for the happy path (url first, per the KB).
    const authored = [
      A('url', { expected: '@page.inventory' }, 0),
      A('visible', { target: 'authenticated_landing' }, 1),
    ];
    const code = emit(authored, baseCtx()).join('\n');
    // Business success (a visible element) is asserted BEFORE the URL fallback.
    expect(code.indexOf('toBeVisible')).toBeLessThan(code.indexOf('toHaveURL'));
  });

  it('(1b) end-to-end from the REAL KB template for auth-pos-valid', () => {
    const scenario = getBaselineScenarios('authentication').find((s) => s.id === 'auth-pos-valid')!;
    const assertions = materializeAssertionTemplate('auth-pos-valid', getScenarioAssertionTemplate(scenario)!);
    // Sanity: the KB really does author url BEFORE visible (this is the defect).
    expect(assertions.map((a) => a.type)).toEqual(['url', 'visible']);
    const code = emit(assertions, baseCtx()).join('\n');
    // …yet the emitted spec leads with the business assertion.
    expect(code.indexOf('toBeVisible')).toBeLessThan(code.indexOf('toHaveURL'));
  });

  it('(2) STABLE PARTITION — no assertion is added, dropped, or invented', () => {
    const authored = [
      A('url', { expected: '@page.inventory' }, 0),
      A('visible', { target: 'authenticated_landing' }, 1),
    ];
    const lines = emit(authored, baseCtx());
    const expects = lines.filter((l) => /\bexpect\s*\(/.test(l));
    // Exactly the two authored checks — one visible, one url. Nothing invented.
    expect(expects).toHaveLength(2);
    expect(lines.join('\n')).toContain('toBeVisible');
    expect(lines.join('\n')).toContain('toHaveURL');
  });

  it('(3) every business AssertionType outranks a url check', () => {
    const businessTypes: Array<[string, any]> = [
      ['visible', { target: 'login_error' }],
      ['hidden', { target: 'login_error' }],
      ['enabled', { target: 'login_button' }],
      ['disabled', { target: 'login_button' }],
      ['checked', { target: 'login_button' }],
      ['unchecked', { target: 'login_button' }],
      ['text', { target: 'login_error', expected: '@messages.invalid_credentials' }],
      ['value', { target: 'username', expected: 'standard_user' }],
      ['count', { target: 'login_error', expected: 1 }],
      ['attribute', { target: 'password', expected: 'type=password' }],
    ];
    for (const [type, extra] of businessTypes) {
      // url authored FIRST (order 0), business SECOND (order 1) — the worst case.
      const code = emit([
        A('url', { expected: '@page.login' }, 0),
        A(type, extra, 1),
      ], baseCtx()).join('\n');
      expect(code.indexOf('toHaveURL')).toBeGreaterThan(0);
      // The business matcher line appears before the url line.
      const urlIdx = code.indexOf('toHaveURL');
      const businessIdx = code.search(/toBe|toContainText|toHaveValue|toHaveCount|toHaveAttribute/);
      expect(businessIdx).toBeLessThan(urlIdx);
    }
  });

  it('(4) multiple url checks keep their relative order and all follow the business set', () => {
    const assertions = [
      A('url', { expected: '@page.login' }, 0),      // authored first…
      A('visible', { target: 'login_error' }, 1),    // business
      A('url', { expected: '@page.inventory' }, 2),  // second url
    ];
    const code = emit(assertions, baseCtx()).join('\n');
    const visIdx = code.indexOf('toBeVisible');
    const firstUrl = code.indexOf(`toHaveURL('https://www.saucedemo.com')`);
    const secondUrl = code.indexOf('toHaveURL(/inventory');
    // Business first…
    expect(visIdx).toBeLessThan(firstUrl);
    expect(visIdx).toBeLessThan(secondUrl);
    // …and the two url checks retain their canonical relative order.
    expect(firstUrl).toBeLessThan(secondUrl);
  });

  it('(5) already business-first scenarios are untouched (negative wrong-password)', () => {
    const scenario = getBaselineScenarios('authentication').find((s) => s.id === 'auth-neg-wrong-password')!;
    const assertions = materializeAssertionTemplate('auth-neg-wrong-password', getScenarioAssertionTemplate(scenario)!);
    // KB order is already visible → text → url (business-first).
    expect(assertions.map((a) => a.type)).toEqual(['visible', 'text', 'url']);
    const code = emit(assertions, baseCtx()).join('\n');
    expect(code.indexOf('toBeVisible')).toBeLessThan(code.indexOf('toContainText'));
    expect(code.indexOf('toContainText')).toBeLessThan(code.indexOf('toHaveURL'));
  });

  it('(6) deterministic — identical input yields identical ordered output', () => {
    const set = [
      A('url', { expected: '@page.inventory' }, 0),
      A('visible', { target: 'authenticated_landing' }, 1),
    ];
    expect(emit(set, baseCtx())).toEqual(emit(set, baseCtx()));
  });
});
