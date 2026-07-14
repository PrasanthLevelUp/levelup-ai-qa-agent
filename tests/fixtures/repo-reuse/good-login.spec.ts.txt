import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { InventoryPage } from '../pages/InventoryPage';
import { getUser } from '../utils/testData';
import { env } from '../utils/env';
import { waits } from '../utils/waits';
import { logger } from '../utils/logger';

/**
 * Verify successful login with valid credentials
 *
 * Test Case ID: 1216
 * Priority: P0
 */

test.describe('Verify successful login with valid credentials', () => {
  test('Verify successful login with valid credentials', async ({ page }) => {
    const user = getUser('standard_user');
    const loginPage = new LoginPage(page);
    const inventoryPage = new InventoryPage(page);

    logger.info('Navigating to base URL');
    await page.goto(env.baseUrl);
    await waits.forPageLoad(page);

    await loginPage.login(user.username, user.password);

    logger.info('Asserting redirect to inventory page');
    await expect(page).toHaveURL(/inventory\.html/);
    await expect(page.locator('[data-test="title"]')).toHaveText(/Products/i);
    await inventoryPage.verifyInventoryLoaded();
    logger.info('Test passed: successful login verified');
  });
});
