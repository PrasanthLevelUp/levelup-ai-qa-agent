/**
 * Repository Test Inventory Scanner — Sprint RCI-1
 * ================================================
 * Proves the DETERMINISTIC scanner on realistic Playwright/Cypress fixtures
 * written to a temp dir. No LLM, no network — same input ⇒ same output.
 *
 * The fixtures mirror the two real SauceDemo shapes we validated against:
 *   1. POM instantiated in-test:      const loginPage = new LoginPage(page)
 *   2. POM injected via fixture:      test('...', async ({ loginPage }) => ...)
 * plus @tc: tags, describe suites, and Playwright web-first assertions.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RepositoryInventoryScanner,
  scanRepositoryInventory,
} from '../../src/coverage-intelligence/repository-inventory-scanner';

const LOGIN_SPEC = `
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { InventoryPage } from '../pages/InventoryPage';

test.describe('Login — 16 scenarios', () => {
  test('Verify that the user can log in when valid credentials are provided.', async ({ page }) => {
    // @tc:TC1969
    const loginPage = new LoginPage(page);
    const inventoryPage = new InventoryPage(page);
    await page.goto('https://www.saucedemo.com/');
    await loginPage.login('standard_user', 'secret');
    await expect(page).toHaveURL(/inventory\\.html/);
    await expect(page.locator('[data-test="title"]')).toHaveText(/Products/i);
    await inventoryPage.verifyInventoryLoaded();
  });

  test('Verify that login is rejected when invalid credentials are provided.', async ({ page }) => {
    // @tc:TC1978
    const loginPage = new LoginPage(page);
    await page.goto('https://www.saucedemo.com/');
    await loginPage.login('invalid_user', 'nope');
    await expect(page.locator('[data-test="error"]')).toBeVisible();
    await expect(page.locator('[data-test="error"]')).toContainText('do not match');
  });
});
`;

const CHECKOUT_SPEC = `
import { test, expect } from '../fixtures/baseFixture';

test('standard user can complete checkout', async ({ page, loginPage, inventoryPage, cartPage, checkoutPage }) => {
  await page.goto('https://www.saucedemo.com/');
  await loginPage.login('standard_user', 'secret');
  await inventoryPage.addProductToCart();
  await inventoryPage.openCart();
  await cartPage.checkout();
  await checkoutPage.completeOrder();
  await checkoutPage.verifyOrderSuccess();
  await expect(page.locator('[data-test="complete-header"]')).toBeVisible();
});
`;

const CYPRESS_SPEC = `
describe('Cart', () => {
  it('adds an item to the cart', () => {
    cy.visit('/');
    cy.get('[data-test="add-to-cart"]').click();
    cy.get('[data-test="cart-badge"]').should('have.text', '1');
    cy.get('[data-test="cart-badge"]').should('be.visible');
  });
});
`;

describe('RepositoryInventoryScanner (RCI-1, deterministic)', () => {
  let repoDir: string;

  beforeAll(() => {
    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rci1-'));
    fs.mkdirSync(path.join(repoDir, 'tests'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'node_modules', 'junk'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'tests', 'login.spec.ts'), LOGIN_SPEC);
    fs.writeFileSync(path.join(repoDir, 'tests', 'checkout.spec.ts'), CHECKOUT_SPEC);
    fs.writeFileSync(path.join(repoDir, 'tests', 'cart.cy.ts'), CYPRESS_SPEC);
    // A file that must be IGNORED (inside node_modules).
    fs.writeFileSync(path.join(repoDir, 'node_modules', 'junk', 'ignored.spec.ts'), LOGIN_SPEC);
  });

  afterAll(() => {
    fs.rmSync(repoDir, { recursive: true, force: true });
  });

  it('finds every test across files and skips node_modules', () => {
    const r = scanRepositoryInventory(repoDir);
    // 2 (login) + 1 (checkout) + 1 (cypress) = 4 — node_modules copy excluded.
    expect(r.testsFound).toBe(4);
    expect(r.testFilesScanned).toBe(3);
  });

  it('extracts test name, tags, assertions and POM methods (instantiated form)', () => {
    const r = scanRepositoryInventory(repoDir);
    const login = r.records.find(t => t.testName.startsWith('Verify that the user can log in'));
    expect(login).toBeDefined();
    expect(login!.framework).toBe('playwright');
    expect(login!.tags).toContain('@tc:TC1969');
    expect(login!.assertions).toEqual(expect.arrayContaining(['toHaveURL', 'toHaveText']));
    expect(login!.pomMethods).toEqual(
      expect.arrayContaining(['LoginPage.login', 'InventoryPage.verifyInventoryLoaded']),
    );
    expect(login!.feature).toBe('Login');
    expect(login!.confidence).toBeGreaterThanOrEqual(80);
  });

  it('extracts POM methods from fixture-injected page objects', () => {
    const r = scanRepositoryInventory(repoDir);
    const checkout = r.records.find(t => t.testName === 'standard user can complete checkout');
    expect(checkout).toBeDefined();
    expect(checkout!.pomMethods).toEqual(
      expect.arrayContaining(['loginPage.login', 'cartPage.checkout', 'checkoutPage.completeOrder']),
    );
    expect(checkout!.feature).toBe('Checkout');
  });

  it('recognises Cypress framework and should-assertions', () => {
    const r = scanRepositoryInventory(repoDir);
    const cart = r.records.find(t => t.testName === 'adds an item to the cart');
    expect(cart).toBeDefined();
    expect(cart!.framework).toBe('cypress');
    expect(cart!.assertions.some(a => a.startsWith('should'))).toBe(true);
    expect(cart!.feature).toBe('Cart');
  });

  it('is deterministic — identical results across repeated scans', () => {
    const a = scanRepositoryInventory(repoDir);
    const b = new RepositoryInventoryScanner().scan(repoDir);
    const norm = (res: any) =>
      JSON.stringify(
        res.records
          .map((x: any) => ({ ...x, metadata: undefined }))
          .sort((x: any, y: any) => (x.filePath + x.testName).localeCompare(y.filePath + y.testName)),
      );
    expect(norm(a)).toBe(norm(b));
  });

  it('assigns a confidence score in [0,100] to every record', () => {
    const r = scanRepositoryInventory(repoDir);
    for (const rec of r.records) {
      expect(rec.confidence).toBeGreaterThanOrEqual(0);
      expect(rec.confidence).toBeLessThanOrEqual(100);
      expect(rec.filePath).toBeTruthy();
    }
  });
});
