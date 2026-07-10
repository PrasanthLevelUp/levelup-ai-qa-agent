import { auditScriptQuality, type QualityRuleId } from '../../src/script-gen/script-quality-guard';

/**
 * Sprint 3 — Script Quality Guard rule tests. Each rule is proven to FIRE on a
 * known-bad snippet and to STAY SILENT on the clean equivalent, so the guard is
 * trustworthy as both the measurement baseline and the eventual PR 3.9 gate.
 */

const rules = (src: string): QualityRuleId[] =>
  auditScriptQuality(src).violations.map((v) => v.rule);

describe('script quality guard — each rule fires on bad code', () => {
  test('no-wait-for-timeout', () => {
    expect(rules(`test('t', async ({ page }) => { await page.waitForTimeout(1000); });`))
      .toContain('no-wait-for-timeout');
  });

  test('no-networkidle', () => {
    expect(rules(`test('t', async ({ page }) => { await page.waitForLoadState('networkidle'); });`))
      .toContain('no-networkidle');
  });

  test('no-manual-text-content', () => {
    expect(rules(`test('t', async ({ page }) => { const x = await page.locator('h1').textContent(); expect(x).toBe('a'); });`))
      .toContain('no-manual-text-content');
  });

  test('no-todo-marker (TODO and Unsupported step)', () => {
    expect(rules(`test('t', async ({ page }) => { await page.click('x'); /* TODO fix */ });`))
      .toContain('no-todo-marker');
    // comments are stripped, so use a string marker the emitter might emit
    expect(rules(`test('t', async ({ page }) => { throw new Error('Unsupported step'); });`))
      .toContain('no-todo-marker');
  });

  test('no-weak-assertion', () => {
    expect(rules(`test('t', async ({ page }) => { expect(page.locator('x')).toBeTruthy(); });`))
      .toContain('no-weak-assertion');
  });

  test('no-weak-locator (xpath + nth-child)', () => {
    expect(rules(`test('t', async ({ page }) => { await page.locator('//div[1]').click(); });`))
      .toContain('no-weak-locator');
    expect(rules(`test('t', async ({ page }) => { await page.locator('ul li:nth-child(2)').click(); });`))
      .toContain('no-weak-locator');
  });

  test('no-unused-variable (scoped to test block)', () => {
    expect(rules(`test('t', async ({ page }) => { const unused = 5; await page.click('x'); });`))
      .toContain('no-unused-variable');
  });

  test('no-duplicate-variable (same test block)', () => {
    expect(rules(`test('t', async ({ page }) => { const u = 1; const u = 2; expect(u).toBe(2); });`))
      .toContain('no-duplicate-variable');
  });

  test('no-dead-import', () => {
    expect(rules(`import { test, expect, chromium } from '@playwright/test';\ntest('t', async ({ page }) => { await page.click('x'); expect(1).toBe(1); });`))
      .toContain('no-dead-import');
  });
});

describe('script quality guard — clean code passes', () => {
  const clean = `import { test, expect } from '@playwright/test';

test.describe('Valid credentials login', () => {
  test('Valid credentials login', async ({ page }) => {
    await page.goto('https://www.saucedemo.com/');
    await page.waitForLoadState('domcontentloaded');

    await page.locator('[data-test="username"]').fill('standard_user');
    await page.locator('[data-test="password"]').fill('secret_sauce');
    await page.locator('[data-test="login-button"]').click();

    await expect(page).toHaveURL(/inventory\\.html/);
    await expect(page.locator('[data-test="title"]')).toHaveText(/Products/i);
  });
});
`;

  test('the pinned golden spec is clean (zero violations)', () => {
    const report = auditScriptQuality(clean);
    expect(report.violations).toEqual([]);
    expect(report.clean).toBe(true);
  });

  test('name reused across DIFFERENT tests is NOT a duplicate', () => {
    const src = `test('a', async ({ page }) => { const u = 1; expect(u).toBe(1); });
test('b', async ({ page }) => { const u = 2; expect(u).toBe(2); });`;
    expect(rules(src)).not.toContain('no-duplicate-variable');
    expect(rules(src)).not.toContain('no-unused-variable');
  });
});
