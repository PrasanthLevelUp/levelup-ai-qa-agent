/**
 * Unit tests — CodePatcher kind-safety
 * ====================================
 * Regression guard for the production `spec_load_error` incident.
 *
 * The rule engine produced a heal where:
 *   failedLocator = "#username"                         (a BARE selector)
 *   healedLocator = page.locator('[data-test="username"]')  (a FULL expression)
 *
 * The old Strategy-1 direct replace substituted the full expression into the
 * existing `this.page.locator('#username')` STRING slot, yielding:
 *   this.page.locator('page.locator('[data-test="username"]')')
 * — nested calls + unbalanced quotes → invalid TS → every spec failed to load
 * (Tests=0, exit=1, spec_load_error).
 *
 * These tests prove the patcher now:
 *   • normalises kinds so a bare slot gets a bare selector (valid TS), and
 *   • rejects any patch that would embed a locator EXPRESSION inside a selector
 *     STRING (defense-in-depth), instead of committing invalid code.
 */

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import * as ts from 'typescript';
import { CodePatcher, type HealingFix } from '../../src/services/code-patcher';

const POM = `  username = this.page.locator('#username');`;

function parseErrorCount(src: string): number {
  const sf = ts.createSourceFile('f.ts', src, ts.ScriptTarget.Latest, true);
  // @ts-expect-error parseDiagnostics is internal but populated by the parser
  return (sf.parseDiagnostics || []).length;
}

function fix(partial: Partial<HealingFix>): HealingFix {
  return {
    testName: 't',
    failedLocator: '#username',
    healedLocator: '[data-test="username"]',
    strategy: 'rule_based',
    confidence: 0.96,
    ...partial,
  } as HealingFix;
}

describe('CodePatcher kind-safety', () => {
  const patcher = new CodePatcher();

  it('the production bug: bare failed + full-expression heal → valid bare selector', () => {
    const res = patcher.applyHealingFix(
      POM,
      fix({ failedLocator: '#username', healedLocator: `page.locator('[data-test="username"]')` }),
    );
    expect(res.patched).toBe(true);
    expect(res.patchedCode).toContain(`this.page.locator('[data-test="username"]')`);
    // No nested page.locator('...page.locator(...
    expect(res.patchedCode).not.toContain(`locator('page.locator(`);
    expect(parseErrorCount(res.patchedCode)).toBe(0);
  });

  it('bare failed + bare heal still works and stays valid', () => {
    const res = patcher.applyHealingFix(
      POM,
      fix({ failedLocator: '#username', healedLocator: '[data-test="username"]' }),
    );
    expect(res.patched).toBe(true);
    expect(res.patchedCode).toContain(`this.page.locator('[data-test="username"]')`);
    expect(parseErrorCount(res.patchedCode)).toBe(0);
  });

  it('expression failed + expression heal performs a clean direct swap', () => {
    const res = patcher.applyHealingFix(
      POM,
      fix({
        failedLocator: `this.page.locator('#username')`,
        healedLocator: `this.page.locator('[data-test="username"]')`,
      }),
    );
    expect(res.patched).toBe(true);
    expect(res.patchedCode).toContain(`this.page.locator('[data-test="username"]')`);
    expect(parseErrorCount(res.patchedCode)).toBe(0);
  });

  it('rejects a heal that cannot be reduced to a bare selector (getByRole) rather than corrupting the file', () => {
    const res = patcher.applyHealingFix(
      POM,
      fix({ failedLocator: '#username', healedLocator: `page.getByRole('textbox', { name: 'Username' })`, strategy: 'ai', confidence: 0.8 }),
    );
    // Safety net: original returned untouched, marked not patched.
    expect(res.patched).toBe(false);
    expect(res.patchedCode).toBe(POM);
    expect(parseErrorCount(res.patchedCode)).toBe(0);
    expect(res.description).toMatch(/invalid code|manual review/i);
  });
});

/* -------------------------------------------------------------------------- */
/*  Inline (raw Playwright) regressions                                       */
/*  The fix must be correct not only for Page Objects (this.page.locator(...))*/
/*  but ALSO for inline test code: await page.locator('#x').fill(...) and     */
/*  await page.getByRole(...) chains.                                          */
/* -------------------------------------------------------------------------- */

describe('CodePatcher kind-safety — inline Playwright code', () => {
  const patcher = new CodePatcher();

  const INLINE_LOCATOR = `  await page.locator('#username').fill('standard_user');`;
  const INLINE_GETBYROLE_TARGET = `  await page.locator('#username').fill('standard_user');`;

  it('inline bare-selector heal: page.locator(\'#username\').fill() → [data-test] selector, stays valid', () => {
    const res = patcher.applyHealingFix(
      INLINE_LOCATOR,
      fix({ failedLocator: '#username', healedLocator: '[data-test="username"]' }),
    );
    expect(res.patched).toBe(true);
    expect(res.patchedCode).toContain(`await page.locator('[data-test="username"]').fill('standard_user');`);
    expect(res.patchedCode).not.toContain('#username');
    expect(parseErrorCount(res.patchedCode)).toBe(0);
  });

  it('inline production-shape heal: bare failed + FULL expression heal must NOT double-wrap', () => {
    // Mirrors the prod incident but for inline code:
    //   failed = "#username"  (bare, lives in the locator('...') string slot)
    //   heal   = page.locator('[data-test="username"]')  (full expression)
    // Naive raw replace → page.locator('page.locator('[data-test="username"]')')
    const res = patcher.applyHealingFix(
      INLINE_LOCATOR,
      fix({ failedLocator: '#username', healedLocator: `page.locator('[data-test="username"]')` }),
    );
    expect(res.patched).toBe(true);
    expect(res.patchedCode).toContain(`await page.locator('[data-test="username"]').fill('standard_user');`);
    expect(res.patchedCode).not.toContain(`locator('page.locator(`);
    expect(parseErrorCount(res.patchedCode)).toBe(0);
  });

  it('inline expression→expression getByRole heal: whole locator call is swapped cleanly', () => {
    // failed is supplied as a full expression, heal is a getByRole expression →
    // a clean expression-for-expression swap is valid and expected.
    const res = patcher.applyHealingFix(
      INLINE_GETBYROLE_TARGET,
      fix({
        failedLocator: `page.locator('#username')`,
        healedLocator: `page.getByRole('textbox', { name: 'Username' })`,
        strategy: 'ai',
        confidence: 0.82,
      }),
    );
    expect(res.patched).toBe(true);
    expect(res.patchedCode).toContain(`await page.getByRole('textbox', { name: 'Username' }).fill('standard_user');`);
    expect(res.patchedCode).not.toContain(`page.locator('#username')`);
    // No expression embedded inside a string slot.
    expect(res.patchedCode).not.toContain(`locator('page.`);
    expect(res.patchedCode).not.toContain(`locator('getByRole`);
    expect(parseErrorCount(res.patchedCode)).toBe(0);
  });

  it('inline bare failed + getByRole heal is safely rejected (cannot be a bare selector) — never corrupts', () => {
    const res = patcher.applyHealingFix(
      INLINE_LOCATOR,
      fix({ failedLocator: '#username', healedLocator: `page.getByRole('textbox', { name: 'Username' })`, strategy: 'ai', confidence: 0.8 }),
    );
    expect(res.patched).toBe(false);
    expect(res.patchedCode).toBe(INLINE_LOCATOR);
    expect(parseErrorCount(res.patchedCode)).toBe(0);
  });
});
