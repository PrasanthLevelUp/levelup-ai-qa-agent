/**
 * Sprint RCI-1 — Repository Test Inventory extraction.
 *
 * These tests exercise the FULL path the way production does: build a small
 * on-disk repo, run RepositoryContextEngine.scan(), and assert on
 * profile.testInventory. This proves the per-test facts captured by the AST
 * analyzer are correctly classified into the deterministic inventory — with
 * NO LLM, NO embeddings, NO generation.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryContextEngine } from '../../src/context/repository-context-engine';
import type { TestInventoryEntry, CoverageSummaryEntry } from '../../src/context/types';

const tmpRoots: string[] = [];

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rci1-inv-'));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  return root;
}

function scan(files: Record<string, string>): TestInventoryEntry[] {
  const root = makeRepo(files);
  return new RepositoryContextEngine().scan(root).profile.testInventory;
}

function scanCoverage(files: Record<string, string>): CoverageSummaryEntry[] {
  const root = makeRepo(files);
  return new RepositoryContextEngine().scan(root).profile.coverageSummary;
}

afterAll(() => {
  for (const r of tmpRoots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const PKG = JSON.stringify({ devDependencies: { '@playwright/test': '^1' } });

describe('Repository Test Inventory (RCI-1)', () => {
  it('extracts one entry per test with instantiated POM methods + assertions', () => {
    const inv = scan({
      'package.json': PKG,
      'tsconfig.json': '{}',
      'pages/LoginPage.ts': `
        import { Page } from '@playwright/test';
        export class LoginPage {
          constructor(private page: Page) {}
          async login(u: string, p: string) { await this.page.goto('/login'); }
        }`,
      'tests/login.spec.ts': `
        import { test, expect } from '@playwright/test';
        import { LoginPage } from '../pages/LoginPage';
        test.describe('Login', () => {
          test('valid user can sign in @tc:TC1001', async ({ page }) => {
            const loginPage = new LoginPage(page);
            await loginPage.login('standard', 'secret');
            await expect(page).toHaveURL(/inventory/);
            await expect(page.locator('.title')).toHaveText('Products');
          });
          test('locked out user sees error', async ({ page }) => {
            const loginPage = new LoginPage(page);
            await loginPage.login('locked', 'secret');
            await expect(page.locator('[data-test="error"]')).toBeVisible();
          });
        });`,
    });

    expect(inv).toHaveLength(2);
    const valid = inv.find(e => e.testName.startsWith('valid user'))!;
    expect(valid).toBeDefined();
    expect(valid.feature).toBe('Login');            // clean describe label
    expect(valid.metadata.featureSource).toBe('describe');
    expect(valid.flow).toBe('login');
    expect(valid.suite).toBe('Login');
    expect(valid.pomMethods).toContain('LoginPage.login');
    expect(valid.assertions).toEqual(expect.arrayContaining(['toHaveURL', 'toHaveText']));
    expect(valid.tags).toContain('@tc:TC1001');
    expect(valid.page).toBe('Login');               // from POM class
    expect(valid.framework).toBe('playwright');
    // base 40 + assertions 20 + describe 15 + tags 10 + pom 10 + framework 5 = 100
    expect(valid.confidence).toBe(100);
  });

  it('captures fixture-injected POM methods (loginPage.method form)', () => {
    const inv = scan({
      'package.json': PKG,
      'tests/checkout.spec.ts': `
        import { test, expect } from '../fixtures/baseFixture';
        test('complete purchase end to end', async ({ loginPage, cartPage }) => {
          await loginPage.login('standard', 'secret');
          await cartPage.addItem('backpack');
          await cartPage.checkout();
          await expect(cartPage.confirmation).toBeVisible();
        });`,
      'fixtures/baseFixture.ts': `
        import { test as base } from '@playwright/test';
        export const test = base.extend({});`,
    });

    const entry = inv.find(e => e.testName.startsWith('complete purchase'))!;
    expect(entry).toBeDefined();
    expect(entry.pomMethods).toEqual(
      expect.arrayContaining(['loginPage.login', 'cartPage.addItem', 'cartPage.checkout']),
    );
    expect(entry.feature).toBe('Checkout');   // keyword bucket (no clean describe)
    expect(entry.metadata.featureSource).toBe('keyword');
    expect(entry.flow).toBe('checkout');
  });

  it('recognises Cypress should() assertions', () => {
    const inv = scan({
      'package.json': JSON.stringify({ devDependencies: { cypress: '^13' } }),
      'cypress/e2e/search.cy.ts': `
        describe('Search', () => {
          it('filters products by term', () => {
            cy.visit('/');
            cy.get('[data-test=search]').type('shirt');
            cy.get('.result').should('have.length', 3);
            cy.get('.result').first().should('be.visible');
          });
        });`,
    });

    const entry = inv.find(e => e.testName.startsWith('filters products'))!;
    expect(entry).toBeDefined();
    expect(entry.framework).toBe('cypress');
    expect(entry.assertions).toEqual(
      expect.arrayContaining(['should:have.length', 'should:be.visible']),
    );
    expect(entry.feature).toBe('Search');
  });

  it('is deterministic — same repo yields identical inventory', () => {
    const files = {
      'package.json': PKG,
      'tests/a.spec.ts': `
        import { test, expect } from '@playwright/test';
        test('does a thing', async ({ page }) => {
          await page.goto('/');
          await expect(page).toHaveTitle('Home');
        });`,
    };
    const first = JSON.stringify(scan(files));
    const second = JSON.stringify(scan(files));
    expect(first).toBe(second);
  });

  it('confidence stays within 0-100 and a bare test scores the base', () => {
    const inv = scan({
      'package.json': PKG,
      'tests/bare.spec.ts': `
        import { test } from '@playwright/test';
        test('placeholder with no assertions', async ({ page }) => {
          await page.goto('/');
        });`,
    });
    const entry = inv[0];
    expect(entry.confidence).toBeGreaterThanOrEqual(0);
    expect(entry.confidence).toBeLessThanOrEqual(100);
    // base 40 + framework 5 (playwright), no assertions/describe/tags/pom.
    expect(entry.confidence).toBe(45);
    expect(entry.assertions).toHaveLength(0);
  });

  it('emits no inventory for a repo with no tests', () => {
    const inv = scan({
      'package.json': PKG,
      'src/util.ts': `export function add(a: number, b: number) { return a + b; }`,
    });
    expect(inv).toHaveLength(0);
  });
});

describe('Coverage Summary (per-feature rollup)', () => {
  it('rolls tests up by feature with counts, percentage and avg confidence', () => {
    const cov = scanCoverage({
      'package.json': PKG,
      'tests/login.spec.ts': `
        import { test, expect } from '@playwright/test';
        test.describe('Authentication', () => {
          test('valid login', async ({ page }) => { await expect(page).toHaveURL('/home'); });
          test('invalid login', async ({ page }) => { await expect(page).toHaveText('error'); });
          test('locked user', async ({ page }) => { await expect(page).toBeVisible(); });
        });`,
      'tests/checkout.spec.ts': `
        import { test, expect } from '@playwright/test';
        test.describe('Checkout', () => {
          test('checkout with card', async ({ page }) => { await expect(page).toHaveURL('/done'); });
        });`,
    });

    // Sorted by testCount desc → Authentication (3) before Checkout (1).
    expect(cov.map((c) => c.feature)).toEqual(['Authentication', 'Checkout']);
    expect(cov[0].testCount).toBe(3);
    expect(cov[1].testCount).toBe(1);

    // Percentages are of the 4-test total and sum back to 100.
    expect(cov[0].percentage).toBe(75);
    expect(cov[1].percentage).toBe(25);
    expect(cov.reduce((s, c) => s + c.percentage, 0)).toBe(100);

    // avgConfidence is a bounded mean.
    for (const c of cov) {
      expect(c.avgConfidence).toBeGreaterThanOrEqual(0);
      expect(c.avgConfidence).toBeLessThanOrEqual(100);
    }
  });

  it('is deterministic and total test counts match the inventory length', () => {
    const files = {
      'package.json': PKG,
      'tests/a.spec.ts': `
        import { test, expect } from '@playwright/test';
        test.describe('Cart', () => {
          test('add item', async ({ page }) => { await expect(page).toBeVisible(); });
          test('remove item', async ({ page }) => { await expect(page).toBeVisible(); });
        });`,
    };
    const first = scanCoverage(files);
    const second = scanCoverage(files);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    const invCount = scan(files).length;
    expect(first.reduce((s, c) => s + c.testCount, 0)).toBe(invCount);
  });

  it('is empty for a repo with no tests', () => {
    const cov = scanCoverage({
      'package.json': PKG,
      'src/util.ts': `export function add(a: number, b: number) { return a + b; }`,
    });
    expect(cov).toHaveLength(0);
  });
});
