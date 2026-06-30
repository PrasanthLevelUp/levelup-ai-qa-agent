/**
 * Unit tests for Repo Intelligence — logging & wait convention capture.
 *
 * These are the "attentional" signals we previously MISSED: how a repo reports
 * step progress (test.step / console.log / annotations / logger) and how it
 * synchronizes (web-first assertions / load-state / locator.waitFor /
 * response-wait), plus detection of the waitForTimeout anti-pattern.
 *
 * We exercise the real ASTAnalyzer against a throwaway temp repo so the regexes
 * are validated on realistic source — not just unit-mocked strings.
 *
 * Run with: npx tsx tests/unit/repo-intel-logging-wait.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ASTAnalyzer } from '../../src/context/ast-analyzer';

/* ---- tiny assertion harness (matches the repo's other unit tests) ---- */
let passed = 0;
let failed = 0;
function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

/* ---- fixtures: write a temp repo with known conventions ---- */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-intel-'));
const testsDir = path.join(tmp, 'tests');
fs.mkdirSync(testsDir, { recursive: true });

// File A: enterprise style — test.step blocks + web-first assertions + load-state.
fs.writeFileSync(path.join(testsDir, 'login.spec.ts'), `
import { test, expect } from '@playwright/test';

test('locked user is blocked', async ({ page }) => {
  await test.step('Open Login Page', async () => {
    await page.goto('/');
    await page.waitForLoadState('networkidle');
  });
  await test.step('Verify error', async () => {
    await expect(page.locator('[data-test="error"]')).toBeVisible();
    await expect(page.locator('[data-test="error"]')).toContainText('locked out');
  });
});
`);

// File B: legacy style — console.log breadcrumbs + the waitForTimeout anti-pattern.
fs.writeFileSync(path.join(testsDir, 'legacy.spec.ts'), `
import { test, expect } from '@playwright/test';

test('legacy flow', async ({ page }) => {
  console.log('navigating');
  await page.goto('/');
  await page.waitForTimeout(3000);
  console.log('checking title');
  expect(await page.title()).toBeTruthy();
});
`);

/* ---- run analysis ---- */
console.log('\n=== AST analyzer captures logging + wait patterns ===');
const analyzer = new ASTAnalyzer();
const analyses = analyzer.analyzeRepo(tmp);

const byName = (suffix: string) => analyses.find(a => a.relativePath.endsWith(suffix))!;
const a = byName('login.spec.ts');
const b = byName('legacy.spec.ts');

assert(!!a && !!b, 'both fixture files analysed');

// Logging capture
assert(a.loggingPatterns.includes('test-step'), 'detects test.step() logging in login.spec.ts');
assert(b.loggingPatterns.includes('console-log'), 'detects console.log logging in legacy.spec.ts');
assert(!a.loggingPatterns.includes('console-log'), 'login.spec.ts not falsely tagged console-log');

// Wait capture
assert(a.waitPatterns.includes('web-first-assertions'), 'detects web-first assertions in login.spec.ts');
assert(a.waitPatterns.includes('load-state'), 'detects waitForLoadState in login.spec.ts');
assert(b.waitPatterns.includes('fixed-timeout'), 'detects waitForTimeout anti-pattern in legacy.spec.ts');
assert(!a.waitPatterns.includes('fixed-timeout'), 'login.spec.ts not falsely tagged fixed-timeout');

/* ---- cleanup ---- */
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
