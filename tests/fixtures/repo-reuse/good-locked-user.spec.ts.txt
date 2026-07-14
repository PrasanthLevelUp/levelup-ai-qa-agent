import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { getUser } from '../utils/testData';
import { env } from '../utils/env';
import { waits } from '../utils/waits';
import { logger } from '../utils/logger';

/**
 * Verify login attempt with locked user account
 *
 * Test Case ID: 1220
 * Priority: P0
 */

test.describe('Verify login attempt with locked user account', () => {
  test('Verify login attempt with locked user account', async ({ page }) => {
    const user = getUser('locked_user');
    const loginPage = new LoginPage(page);

    logger.info('Navigating to base URL');
    await page.goto(env.baseUrl);
    await waits.forPageLoad(page);

    await loginPage.login(user.username, user.password);

    logger.info('Asserting locked-out error message');
    await expect(page.locator('[data-test="error"]')).toBeVisible();
    await expect(page.locator('[data-test="error"]')).toContainText('locked out');
    logger.info('Test passed: locked user error verified');
  });
});
