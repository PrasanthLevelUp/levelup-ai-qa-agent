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
