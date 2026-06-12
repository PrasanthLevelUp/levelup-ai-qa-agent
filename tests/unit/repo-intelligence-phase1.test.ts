/**
 * Unit tests for Repository Intelligence Phase 1 fixes.
 *
 * Covers:
 *   - FIX 2: pre-scan language guard (detectRepoLanguage + UnsupportedLanguageError)
 *   - FIX 3: code_chunks storage gated off by default (feature flag)
 *   - FIX 4: multi-file majority-vote coding-style detection
 *
 * Run with: npx tsx tests/unit/repo-intelligence-phase1.test.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  RepositoryContextEngine,
  detectRepoLanguage,
  UnsupportedLanguageError,
  SUPPORTED_LANGUAGES,
} from '../../src/context/repository-context-engine';

/* ------------------------------------------------------------------ */
/*  Tiny assertion harness (matches sibling tsx tests)                 */
/* ------------------------------------------------------------------ */
let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}
function assertEqual(actual: any, expected: any, msg: string) {
  assert(actual === expected, `${msg} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

/* ------------------------------------------------------------------ */
/*  Temp-repo helpers                                                  */
/* ------------------------------------------------------------------ */
const tmpRoots: string[] = [];
function makeRepo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-intel-test-'));
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

/* ================================================================== */
/*  FIX 2 — Language detection                                         */
/* ================================================================== */
console.log('\n=== FIX 2: detectRepoLanguage ===');

assertEqual(
  detectRepoLanguage(makeRepo({ 'tsconfig.json': '{}', 'package.json': '{}' })),
  'typescript', 'tsconfig.json → typescript');

assertEqual(
  detectRepoLanguage(makeRepo({ 'package.json': JSON.stringify({ devDependencies: { typescript: '^5' } }) })),
  'typescript', 'package.json with typescript dep → typescript');

assertEqual(
  detectRepoLanguage(makeRepo({ 'package.json': JSON.stringify({ dependencies: { express: '^4' } }) })),
  'javascript', 'package.json without ts dep → javascript');

assertEqual(
  detectRepoLanguage(makeRepo({ 'requirements.txt': 'pytest\n', 'tests/test_x.py': 'def test_x():\n    assert True\n' })),
  'python', 'requirements.txt → python');

assertEqual(
  detectRepoLanguage(makeRepo({ 'pom.xml': '<project/>', 'Main.java': 'class Main {}' })),
  'java', 'pom.xml → java');

assertEqual(
  detectRepoLanguage(makeRepo({ 'App.csproj': '<Project/>', 'Program.cs': 'class P {}' })),
  'csharp', '*.csproj → csharp');

assertEqual(
  detectRepoLanguage(makeRepo({ 'src/foo.py': 'x = 1\n', 'src/bar.py': 'y = 2\n' })),
  'python', 'extension fallback → python (no marker files)');

assertEqual(
  detectRepoLanguage(makeRepo({ 'README.md': '# hi' })),
  'unknown', 'no source/markers → unknown');

/* ================================================================== */
/*  FIX 2 — scan() guard throws on unsupported languages               */
/* ================================================================== */
console.log('\n=== FIX 2: scan() language guard ===');

const engine = new RepositoryContextEngine();

const pyRepo = makeRepo({ 'requirements.txt': 'pytest\n', 'tests/test_login.py': 'def test_login():\n    assert 1 == 1\n' });
let threw = false;
try { engine.scan(pyRepo); }
catch (e) {
  threw = e instanceof UnsupportedLanguageError;
  if (e instanceof UnsupportedLanguageError) {
    assertEqual(e.detectedLanguage, 'python', 'error carries detectedLanguage=python');
    assert(e.message.includes('not currently supported'), 'error message is actionable');
  }
}
assert(threw, 'scan() throws UnsupportedLanguageError for a Python repo');

assert(SUPPORTED_LANGUAGES.includes('typescript') && SUPPORTED_LANGUAGES.includes('javascript'),
  'SUPPORTED_LANGUAGES = [typescript, javascript]');

/* ================================================================== */
/*  FIX 3 + FIX 4 — TS repo scans, no chunks by default, voted style   */
/* ================================================================== */
console.log('\n=== FIX 3 + FIX 4: TS repo scan ===');

// Build a small TS Playwright-style repo: 2-space indent, single quotes, semicolons.
const tsFile = (n: number) => [
  `import { test, expect } from '@playwright/test';`,
  ``,
  `test('case ${n} should work', async ({ page }) => {`,
  `  await page.goto('https://example.com');`,
  `  await expect(page.getByTestId('btn')).toBeVisible();`,
  `});`,
  ``,
].join('\n');

const repoFiles: Record<string, string> = {
  'package.json': JSON.stringify({ devDependencies: { typescript: '^5', '@playwright/test': '^1' } }),
  'tsconfig.json': '{}',
};
for (let i = 1; i <= 6; i++) repoFiles[`tests/case${i}.spec.ts`] = tsFile(i);
const tsRepo = makeRepo(repoFiles);

const { profile, chunks } = engine.scan(tsRepo);

assert(profile.language === 'typescript', 'TS repo → profile.language=typescript');
// FIX 3: chunks gated off by default (ENABLE_CODE_CHUNKS not set).
assertEqual(chunks.length, 0, 'FIX 3: code chunks not extracted when flag disabled (default)');
// FIX 4: style detection reflects the sampled files.
assertEqual(profile.codingStyle.quoteStyle, 'single', 'FIX 4: quoteStyle voted single');
assertEqual(profile.codingStyle.semicolons, true, 'FIX 4: semicolons voted true');
assertEqual(profile.codingStyle.indentStyle, 'spaces-2', 'FIX 4: indentStyle voted spaces-2');

/* ------------------------------------------------------------------ */
cleanup();
console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
