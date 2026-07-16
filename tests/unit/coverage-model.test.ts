/**
 * Sprint RCI-2 — Coverage Model construction.
 *
 * Exercises the FULL production path: build a small on-disk repo, run
 * RepositoryContextEngine.scan(), and assert on profile.coverageModel. The
 * Coverage Model is the deterministic, per-feature description of WHAT THE REPO
 * COVERS (flows, assertions, helpers, page objects) — derived purely from the
 * Test Inventory. NO requirements, NO reuse, NO generation, NO LLM.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryContextEngine } from '../../src/context/repository-context-engine';
import type { CoverageModel } from '../../src/context/types';

const tmpRoots: string[] = [];

function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rci2-cov-'));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  return root;
}

function scanModel(files: Record<string, string>): CoverageModel[] {
  const root = makeRepo(files);
  return new RepositoryContextEngine().scan(root).profile.coverageModel;
}

afterAll(() => {
  for (const r of tmpRoots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const PKG = JSON.stringify({ devDependencies: { '@playwright/test': '^1' } });

describe('Coverage Model (RCI-2)', () => {
  it('builds a per-feature model with flows, assertions, helpers and files', () => {
    const models = scanModel({
      'package.json': PKG,
      'pages/LoginPage.ts': `
        import { Page } from '@playwright/test';
        export class LoginPage {
          constructor(private page: Page) {}
          async login(u: string, p: string) { await this.page.goto('/login'); }
        }`,
      'tests/auth.spec.ts': `
        import { test, expect } from '@playwright/test';
        import { LoginPage } from '../pages/LoginPage';
        test.describe('Authentication', () => {
          test('valid user can sign in @tc:TC1001', async ({ page }) => {
            const loginPage = new LoginPage(page);
            await loginPage.login('standard', 'secret');
            await expect(page).toHaveURL(/inventory/);
          });
          test('locked out user sees error', async ({ page }) => {
            const loginPage = new LoginPage(page);
            await loginPage.login('locked', 'secret');
            await expect(page.locator('[data-test=error]')).toBeVisible();
          });
        });`,
      'tests/checkout.spec.ts': `
        import { test, expect } from '@playwright/test';
        test.describe('Checkout', () => {
          test('complete purchase', async ({ page }) => {
            await expect(page).toHaveURL('/done');
          });
        });`,
    });

    // Sorted by testCount desc → Authentication (2) before Checkout (1).
    expect(models.map(m => m.feature)).toEqual(['Authentication', 'Checkout']);

    const auth = models.find(m => m.feature === 'Authentication')!;
    expect(auth.testCount).toBe(2);
    expect(auth.testFiles).toEqual(['tests/auth.spec.ts']);
    // helpers = POM methods the tests call
    expect(auth.helpers).toContain('LoginPage.login');
    // assertions unioned across the feature
    expect(auth.assertions).toEqual(expect.arrayContaining(['toHaveURL', 'toBeVisible']));
    // page objects exercised
    expect(auth.pageObjects.length).toBeGreaterThan(0);
    // one flow per distinct behavior; tag token stripped from the label
    expect(auth.flows.length).toBe(2);
    const signIn = auth.flows.find(f => /sign in/i.test(f.name))!;
    expect(signIn).toBeDefined();
    expect(signIn.name).not.toContain('@tc');
    expect(signIn.testFiles).toEqual(['tests/auth.spec.ts']);

    // Reserved fields kept empty, not faked.
    expect(auth.browsers).toEqual([]);
    expect(auth.apiCalls).toEqual([]);
  });

  it('merges identically-titled tests across files into one flow', () => {
    const models = scanModel({
      'package.json': PKG,
      'tests/a.spec.ts': `
        import { test, expect } from '@playwright/test';
        test.describe('Cart', () => {
          test('add item to cart', async ({ page }) => { await expect(page).toBeVisible(); });
        });`,
      'tests/b.spec.ts': `
        import { test, expect } from '@playwright/test';
        test.describe('Cart', () => {
          test('add item to cart', async ({ page }) => { await expect(page).toHaveText('1'); });
        });`,
    });

    const cart = models.find(m => m.feature === 'Cart')!;
    expect(cart.testCount).toBe(2);
    const flow = cart.flows.find(f => /add item to cart/i.test(f.name))!;
    expect(flow).toBeDefined();
    expect(flow.testCount).toBe(2);
    // both files accumulated onto the single merged flow
    expect(flow.testFiles).toEqual(['tests/a.spec.ts', 'tests/b.spec.ts']);
    // assertions unioned from both files
    expect(flow.assertions).toEqual(expect.arrayContaining(['toBeVisible', 'toHaveText']));
  });

  it('is deterministic — same repo yields identical model', () => {
    const files = {
      'package.json': PKG,
      'tests/a.spec.ts': `
        import { test, expect } from '@playwright/test';
        test.describe('Search', () => {
          test('filter by term', async ({ page }) => { await expect(page).toBeVisible(); });
          test('sort results', async ({ page }) => { await expect(page).toHaveText('x'); });
        });`,
    };
    expect(JSON.stringify(scanModel(files))).toBe(JSON.stringify(scanModel(files)));
  });

  it('total flow/test counts reconcile with the feature test count', () => {
    const models = scanModel({
      'package.json': PKG,
      'tests/auth.spec.ts': `
        import { test, expect } from '@playwright/test';
        test.describe('Authentication', () => {
          test('valid login', async ({ page }) => { await expect(page).toHaveURL('/home'); });
          test('invalid login', async ({ page }) => { await expect(page).toHaveText('err'); });
        });`,
    });
    const auth = models.find(m => m.feature === 'Authentication')!;
    const flowTestSum = auth.flows.reduce((s, f) => s + f.testCount, 0);
    expect(flowTestSum).toBe(auth.testCount);
  });

  it('is empty for a repo with no tests', () => {
    const models = scanModel({
      'package.json': PKG,
      'src/util.ts': `export function add(a: number, b: number) { return a + b; }`,
    });
    expect(models).toEqual([]);
  });
});
