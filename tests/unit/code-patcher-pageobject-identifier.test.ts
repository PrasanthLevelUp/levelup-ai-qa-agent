/**
 * Unit tests — CodePatcher identifier-safety (Page Object regression)
 * ===================================================================
 * Regression guard for the production incident where a *bare-word* selector
 * (e.g. failedLocator = "password") was replaced with a naive GLOBAL text
 * replace. In a Page Object the word `password` appears in THREE syntactic
 * positions:
 *
 *   password = this.page.locator('password');   // 1: property NAME (identifier)
 *                              ^^^^^^^^           //    + locator STRING arg
 *   await this.password.fill(pass);              // 2: member ACCESSOR (identifier)
 *
 * The buggy global replace turned ALL of them into the CSS selector, producing:
 *
 *   [data-test="password"] = this.page.locator('[data-test="password"]');
 *   await this.[data-test="password"].fill(pass);
 *
 * — a selector used as a variable name and as a member accessor → invalid TS.
 *
 * These tests prove the patcher now replaces a bare selector ONLY inside the
 * string-literal locator argument, leaving identifiers untouched, and that the
 * defense-in-depth safety net rejects any patch that would still land a
 * selector in identifier position.
 */

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as ts from 'typescript';
import { CodePatcher, type HealingFix } from '../../src/services/code-patcher';

function parseErrorCount(src: string): number {
  const sf = ts.createSourceFile('f.ts', src, ts.ScriptTarget.Latest, true);
  // @ts-expect-error parseDiagnostics is internal but populated by the parser
  return (sf.parseDiagnostics || []).length;
}

function fix(partial: Partial<HealingFix>): HealingFix {
  return {
    testName: 't',
    failedLocator: 'password',
    healedLocator: '[data-test="password"]',
    strategy: 'rule_based',
    confidence: 0.96,
    ...partial,
  } as HealingFix;
}

// A realistic Page Object where the bare word `password` is a property name,
// a locator string argument, AND a member accessor.
const POM = [
  'class LoginPage {',
  "  username = this.page.locator('username');",
  "  password = this.page.locator('password');",
  "  loginBtn = this.page.locator('#login-button');",
  '',
  '  async login(user: string, pass: string) {',
  '    await this.username.fill(user);',
  '    await this.password.fill(pass);',
  '    await this.loginBtn.click();',
  '  }',
  '}',
].join('\n');

describe('CodePatcher identifier-safety — Page Object bare-word heal', () => {
  const patcher = new CodePatcher();

  it('the production bug: bare-word selector heals ONLY the locator string, never the identifier', () => {
    const res = patcher.applyHealingFix(
      POM,
      fix({ failedLocator: 'password', healedLocator: '[data-test="password"]' }),
    );

    expect(res.patched).toBe(true);

    // The locator STRING argument is healed.
    expect(res.patchedCode).toContain(`this.page.locator('[data-test="password"]')`);

    // The property NAME is untouched (still `password = ...`, never `[data-test...] =`).
    expect(res.patchedCode).toMatch(/^\s*password = this\.page\.locator/m);
    expect(res.patchedCode).not.toMatch(/^\s*\[data-test="password"\]\s*=/m);

    // The member ACCESSOR is untouched (`this.password`, never `this.[data-test...]`).
    expect(res.patchedCode).toContain('await this.password.fill(pass);');
    expect(res.patchedCode).not.toContain('this.[data-test');

    // The other unrelated locators are left alone.
    expect(res.patchedCode).toContain(`this.page.locator('username')`);
    expect(res.patchedCode).toContain(`this.page.locator('#login-button')`);

    // Result is valid TypeScript.
    expect(parseErrorCount(res.patchedCode)).toBe(0);
  });

  it('quote-conflict: new selector containing double quotes does not break the wrapping quote', () => {
    // The heal value itself contains " — the wrapper must stay ' so the string
    // literal remains valid: '[data-test="password"]'  (not "[data-test="..."]").
    const res = patcher.applyHealingFix(
      POM,
      fix({ failedLocator: 'password', healedLocator: '[data-test="password"]' }),
    );
    expect(res.patched).toBe(true);
    expect(res.patchedCode).toContain(`'[data-test="password"]'`);
    expect(res.patchedCode).not.toContain(`"[data-test="`);
    expect(parseErrorCount(res.patchedCode)).toBe(0);
  });

  it('a bare-word that is ONLY an identifier (no quoted occurrence) is not force-replaced into invalid code', () => {
    // `loginBtn` appears solely as a property name / accessor, never inside a
    // quoted locator string. A quote-scoped replace finds nothing there, so the
    // Playwright/CSS strategies should not corrupt the identifier either.
    const res = patcher.applyHealingFix(
      POM,
      fix({ failedLocator: 'loginBtn', healedLocator: '[data-test="login-button"]' }),
    );
    // Whatever the outcome, it must never produce invalid TS or a selector in
    // identifier position.
    expect(parseErrorCount(res.patchedCode)).toBe(0);
    expect(res.patchedCode).not.toMatch(/^\s*\[data-test="login-button"\]\s*=/m);
    expect(res.patchedCode).not.toContain('this.[data-test');
  });

  it('still heals correctly when the bare word also appears inside the new selector', () => {
    // new selector contains the old word as a substring — must not recurse or
    // double-replace, and must stay valid.
    const res = patcher.applyHealingFix(
      POM,
      fix({ failedLocator: 'password', healedLocator: '[name="password"]' }),
    );
    expect(res.patched).toBe(true);
    expect(res.patchedCode).toContain(`this.page.locator('[name="password"]')`);
    expect(res.patchedCode).toMatch(/^\s*password = this\.page\.locator/m);
    expect(parseErrorCount(res.patchedCode)).toBe(0);
  });
});
