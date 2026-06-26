/**
 * Global Playwright auto-fixture that captures page.url() at test failure.
 *
 * This fixture is injected at runtime (via a generated playwright.config override)
 * so we get the REAL browser URL without regex-guessing from error text.
 *
 * Writes to: <repoPath>/test-results-page-urls.json
 */

const fs = require('fs');
const path = require('path');
const { test: base } = require('@playwright/test');

const urlsFile = path.join(process.cwd(), 'test-results-page-urls.json');

// Auto-fixture that runs for every test, captures page.url() on failure.
const test = base.extend({
  pageUrlCapture: [async ({ page }, use, testInfo) => {
    await use();
    // After test completes: if failed, capture page.url() from the live browser.
    if (testInfo.status === 'failed' || testInfo.status === 'timedOut') {
      try {
        const currentUrl = await page.url();
        const entry = {
          testName: testInfo.title,
          file: testInfo.file,
          url: currentUrl,
          status: testInfo.status,
        };
        // Append to a JSON array file (robust merge in artifact collector).
        let urls = [];
        if (fs.existsSync(urlsFile)) {
          const raw = fs.readFileSync(urlsFile, 'utf-8');
          try { urls = JSON.parse(raw); } catch { urls = []; }
        }
        urls.push(entry);
        fs.writeFileSync(urlsFile, JSON.stringify(urls, null, 2));
      } catch (err) {
        // Defensive: if page is already closed or page.url() fails, skip silently.
        // Healing will fall back to the next URL signal (execution base URL / latest profile).
      }
    }
  }, { auto: true }],
});

module.exports = { test };
