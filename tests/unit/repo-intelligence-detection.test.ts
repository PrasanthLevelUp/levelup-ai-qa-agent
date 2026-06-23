/**
 * Unit tests for Repository Intelligence detection improvements.
 *
 * Addresses the Repo Intelligence review gaps:
 *   - Fixture detection: fixture *files* (re-export `test` / `base.extend`)
 *     are surfaced even when they declare no fixture functions.
 *   - Business-flow steps: Page-Object-Model method calls and variable-based
 *     navigation (`page.goto(env.baseUrl)`) become readable steps.
 *   - Environment awareness: .env files, dotenv usage, env loader module and
 *     `process.env.X` references are captured.
 *   - Test data discovery: data/*.json files are surfaced with record counts.
 *
 * Run with: npx tsx tests/unit/repo-intelligence-detection.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { RepositoryContextEngine } from '../../src/context/repository-context-engine';

/* ------------------------------------------------------------------ */
/*  Tiny assertion harness                                             */
/* ------------------------------------------------------------------ */
let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

const tmpRoots: string[] = [];
function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-intel-detect-'));
  tmpRoots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf-8');
  }
  return root;
}
function cleanup() {
  for (const r of tmpRoots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/*  Fixture repo mirroring the SauceDemo structure                     */
/* ------------------------------------------------------------------ */
const repo = makeRepo({
  'package.json': JSON.stringify({
    devDependencies: { typescript: '^5', '@playwright/test': '^1' },
    dependencies: { dotenv: '^16' },
  }),
  'tsconfig.json': '{}',
  '.env.example': 'BASE_URL=https://example.com\nSAUCE_PASSWORD=secret',
  'fixtures/baseFixture.ts': [
    `import { test as base } from '@playwright/test';`,
    `export const test = base;`,
    `export { expect } from '@playwright/test';`,
  ].join('\n'),
  'utils/env.ts': [
    `import 'dotenv/config';`,
    `export const env = {`,
    `  baseUrl: process.env.BASE_URL!,`,
    `  password: process.env.SAUCE_PASSWORD!,`,
    `};`,
  ].join('\n'),
  'pages/LoginPage.ts': [
    `export class LoginPage {`,
    `  constructor(private page: any) {}`,
    `  async login(user: string, pass: string) { await this.page.fill('#u', user); }`,
    `}`,
  ].join('\n'),
  'data/valid_users.json': JSON.stringify([
    { key: 'standard_user', value: { username: 'standard_user' } },
    { key: 'a', value: {} }, { key: 'b', value: {} }, { key: 'c', value: {} },
  ]),
  'data/products.json': JSON.stringify([{ id: 1, name: 'Backpack' }]),
  'tests/login.spec.ts': [
    `import { test } from '../fixtures/baseFixture';`,
    `import { LoginPage } from '../pages/LoginPage';`,
    `import { env } from '../utils/env';`,
    `test('standard user can log in', async ({ page }) => {`,
    `  const loginPage = new LoginPage(page);`,
    `  await page.goto(env.baseUrl);`,
    `  await loginPage.login('standard_user', 'secret');`,
    `});`,
  ].join('\n'),
});

const engine = new RepositoryContextEngine();
const { profile } = engine.scan(repo);

/* ── Fixture detection ───────────────────────────────────────────── */
console.log('\n=== Fixture file detection ===');
assert(profile.fixtures.length >= 1, 'fixtures detected (was 0 before fix)');
assert(profile.fixtures.some(f => f.filePath.includes('baseFixture')), 'baseFixture.ts surfaced as a fixture');
assert(profile.hasCustomFixtures === true, 'hasCustomFixtures flips true');

/* ── Business-flow step extraction ───────────────────────────────── */
console.log('\n=== Business-flow steps (POM + variable nav) ===');
assert(profile.businessFlows.length >= 1, 'at least one business flow extracted');
const flow = profile.businessFlows[0];
assert(flow.steps.length >= 1, 'flow has steps (was empty before fix)');
assert(flow.steps.some(s => /LoginPage\.login/.test(s)), 'POM method call surfaced as a step');
assert(flow.steps.some(s => /Navigate to env\.baseUrl/.test(s)), 'variable-based navigation surfaced as a step');

/* ── Environment awareness ───────────────────────────────────────── */
console.log('\n=== Environment awareness ===');
assert(profile.environment.envFiles.includes('.env.example'), '.env.example detected');
assert(profile.environment.usesDotenv === true, 'dotenv usage detected');
assert(profile.environment.configModule === 'utils/env.ts', 'env loader module detected (utils/env.ts)');
assert(profile.environment.envVars.includes('BASE_URL'), 'process.env.BASE_URL captured');
assert(profile.environment.envVars.includes('SAUCE_PASSWORD'), 'process.env.SAUCE_PASSWORD captured');

/* ── Test data discovery ─────────────────────────────────────────── */
console.log('\n=== Test data discovery ===');
assert(profile.dataFiles.length === 2, 'two data files discovered');
const validUsers = profile.dataFiles.find(d => d.name === 'valid_users');
assert(!!validUsers && validUsers.recordCount === 4, 'valid_users record count = 4');

/* ------------------------------------------------------------------ */
cleanup();
console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
