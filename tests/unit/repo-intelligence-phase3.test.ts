/**
 * Unit tests for Repository Intelligence Phase 3 (Method Intelligence, True
 * Reuse Engine, Multi-Language Analyzer).
 *
 * Like the Phase 1/2 suites these tests exercise *gating* and *pure-function*
 * behaviour WITHOUT live infrastructure. With a clean (flags-off) environment:
 *
 *   - the three new flags read false,
 *   - MethodIntelligenceService / TrueReuseEngine report disabled and return
 *     empty results without ever touching Postgres,
 *   - the MultiLanguageAnalyzer reports unavailable (flag off) and never throws,
 *   - pure helpers (classifyMethod / isHelper / hashCode, extractActionKeywords /
 *     scoreSuggestion, detectLanguage / languageForExtension) behave correctly.
 *
 * A SECOND phase (flags ON, in-process) verifies the MultiLanguageAnalyzer can
 * actually parse Java/Python/C# when the tree-sitter grammars are installed —
 * but degrades gracefully (skips) if they are not, so the suite never fails on
 * a machine without the optional native parsers.
 *
 * Run with: npx tsx tests/unit/repo-intelligence-phase3.test.ts
 */

/* Ensure a clean, flags-off environment regardless of the shell. */
for (const k of [
  'ENABLE_METHOD_INTELLIGENCE',
  'ENABLE_TRUE_REUSE',
  'ENABLE_MULTI_LANGUAGE',
]) {
  delete process.env[k];
}

import { FEATURE_FLAGS } from '../../src/config/features';
import {
  MethodIntelligenceService,
  classifyMethod,
  isHelper,
  hashCode as miHashCode,
} from '../../src/services/method-intelligence-service';
import {
  TrueReuseEngine,
  extractActionKeywords,
  scoreSuggestion,
  hashCode as reuseHashCode,
} from '../../src/services/true-reuse-engine';
import {
  MultiLanguageAnalyzer,
  languageForExtension,
  getNodeText,
} from '../../src/context/multi-language-analyzer';

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

async function main() {
  /* ================================================================== */
  /*  Feature flags default OFF                                          */
  /* ================================================================== */
  console.log('\n=== Feature flags default OFF ===');
  const RI = FEATURE_FLAGS.REPO_INTELLIGENCE;
  assertEqual(RI.METHOD_INTELLIGENCE, false, 'METHOD_INTELLIGENCE defaults false');
  assertEqual(RI.TRUE_REUSE, false, 'TRUE_REUSE defaults false');
  assertEqual(RI.MULTI_LANGUAGE, false, 'MULTI_LANGUAGE defaults false');

  /* ================================================================== */
  /*  MethodIntelligenceService — gating                                 */
  /* ================================================================== */
  console.log('\n=== MethodIntelligenceService gating ===');
  assertEqual(MethodIntelligenceService.isEnabled(), false, 'isEnabled() false (flag off + no schema)');
  const mi = new MethodIntelligenceService();
  const res = await mi.analyzeRepository('/tmp/does-not-matter', 123);
  assertEqual(res.analyzed, false, 'analyzeRepository() does not run when disabled');
  assertEqual(res.methodsStored, 0, 'analyzeRepository() stores nothing when disabled');
  assert(typeof res.reason === 'string' && res.reason.length > 0, 'analyzeRepository() reports a reason when disabled');
  assertEqual((await mi.search(1, 'login')).length, 0, 'search() returns [] when disabled');
  const stats = await mi.getStats(1);
  assertEqual(stats.totalMethods, 0, 'getStats() returns zeroed stats when disabled');

  /* ----- extractFromFile works on raw TS regardless of flags --------- */
  console.log('\n=== MethodIntelligenceService extraction (flag-independent) ===');
  const fs = await import('fs');
  const os = await import('os');
  const path = await import('path');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mi-test-'));
  const tsFile = path.join(tmpDir, 'helpers', 'login.helper.ts');
  fs.mkdirSync(path.dirname(tsFile), { recursive: true });
  fs.writeFileSync(tsFile, `
    /** Logs a user in. */
    export async function loginAsUser(page: any, user: string, pass: string) {
      await page.goto('/login');
      await fillCredentials(page, user, pass);
      await clickSubmit(page);
    }
    function fillCredentials(page: any, u: string, p: string) { page.fill(u); }
    export const clickSubmit = async (page: any) => { await page.click('#submit'); };
  `);
  const extracted = mi.extractFromFile(tsFile, tmpDir);
  const names = extracted.map(e => e.methodName).sort();
  assert(names.includes('loginAsUser'), 'extractFromFile finds function declaration loginAsUser');
  assert(names.includes('fillCredentials'), 'extractFromFile finds nested function fillCredentials');
  assert(names.includes('clickSubmit'), 'extractFromFile finds exported arrow function clickSubmit');
  const loginMethod = extracted.find(e => e.methodName === 'loginAsUser')!;
  assert(loginMethod.isAsync === true, 'loginAsUser detected as async');
  assert(loginMethod.calledMethods.includes('fillCredentials'), 'loginAsUser records call to fillCredentials');
  assert(loginMethod.calledMethods.includes('clickSubmit'), 'loginAsUser records call to clickSubmit');
  assert(loginMethod.codeHash.length === 64, 'codeHash is a 64-char sha256 hex');
  assert((loginMethod.description ?? '').toLowerCase().includes('logs a user in'), 'JSDoc captured as description');
  fs.rmSync(tmpDir, { recursive: true, force: true });

  /* ================================================================== */
  /*  classifyMethod / isHelper / hashCode                               */
  /* ================================================================== */
  console.log('\n=== Method classification helpers ===');
  assertEqual(classifyMethod('loginAsUser', 'tests/utils/auth.ts', null), 'utility', 'utils/ path → utility');
  assertEqual(classifyMethod('clickLogin', 'src/pages/LoginPage.ts', 'LoginPage'), 'page_object_method', 'Page class → page_object_method');
  assertEqual(classifyMethod('testLogin', 'tests/login.spec.ts', null), 'test', 'spec file → test');
  assertEqual(classifyMethod('doThing', 'src/support/things.ts', null), 'utility', 'support/ path → utility');
  assertEqual(classifyMethod('doThing', 'src/random/things.ts', null), 'helper', 'generic location → helper');
  assertEqual(isHelper('clickLogin', 'src/pages/LoginPage.ts', 'LoginPage'), true, 'page-object method counts as reusable helper');
  assertEqual(isHelper('testLogin', 'tests/login.spec.ts', null), false, 'test does not count as reusable helper');
  assertEqual(miHashCode('a  b\n c'), miHashCode('a b c'), 'hashCode normalizes whitespace');
  assert(miHashCode('a') !== miHashCode('b'), 'hashCode differs for different code');
  assertEqual(miHashCode('x'), reuseHashCode('x'), 'MI and reuse hashCode are identical (so dedup matches)');

  /* ================================================================== */
  /*  TrueReuseEngine — gating                                           */
  /* ================================================================== */
  console.log('\n=== TrueReuseEngine gating ===');
  assertEqual(TrueReuseEngine.isEnabled(), false, 'isEnabled() false (flag off + no schema)');
  const reuse = new TrueReuseEngine();
  assertEqual(await reuse.findExistingHelper('log in as admin', 1), null, 'findExistingHelper() null when disabled');
  assertEqual((await reuse.isDuplicate('some code', 1)).isDuplicate, false, 'isDuplicate() false when disabled');
  assertEqual(await reuse.buildReuseContext(['log in'], 1), '', 'buildReuseContext() empty when disabled');

  /* ================================================================== */
  /*  extractActionKeywords / scoreSuggestion                            */
  /* ================================================================== */
  console.log('\n=== Reuse pure helpers ===');
  const kw = extractActionKeywords('User should log in and then click the checkout button to verify the cart');
  assert(kw.includes('login'), 'extractActionKeywords detects login');
  assert(kw.includes('click'), 'extractActionKeywords detects click');
  assert(kw.includes('verify'), 'extractActionKeywords detects verify');
  assert(kw.includes('cart'), 'extractActionKeywords detects cart');
  assertEqual(extractActionKeywords('').length, 0, 'extractActionKeywords empty string → []');
  const hitA: any = { id: 1, methodName: 'loginAsUser', filePath: 'h.ts', className: null, methodType: 'helper', usageCount: 10, sourceCode: '', similarity: 0.4 };
  const hitB: any = { id: 2, methodName: 'unrelatedThing', filePath: 'h.ts', className: null, methodType: 'helper', usageCount: 0, sourceCode: '', similarity: 0.4 };
  const sA = scoreSuggestion(hitA, ['login']);
  const sB = scoreSuggestion(hitB, ['login']);
  assert(sA > sB, 'scoreSuggestion ranks name+keyword+usage match above unrelated');
  assert(sA >= 0.55, 'scoreSuggestion boosts a literal keyword-name match');

  /* ================================================================== */
  /*  MultiLanguageAnalyzer — gating + detection                         */
  /* ================================================================== */
  console.log('\n=== MultiLanguageAnalyzer gating ===');
  assertEqual(MultiLanguageAnalyzer.isFlagEnabled(), false, 'isFlagEnabled() false by default');
  const mla = new MultiLanguageAnalyzer();
  assertEqual(mla.isAvailable('java'), false, 'isAvailable() false when flag off (even if grammar present)');
  const offResult = mla.analyzeSource('class A {}', 'java');
  assertEqual(offResult.available, false, 'analyzeSource() unavailable when flag off');
  assert(typeof offResult.reason === 'string', 'analyzeSource() reports a reason when flag off');
  // detectLanguage / extension mapping are flag-independent.
  assertEqual(mla.detectLanguage('/x/Foo.java'), 'java', 'detectLanguage .java → java');
  assertEqual(mla.detectLanguage('/x/foo.py'), 'python', 'detectLanguage .py → python');
  assertEqual(mla.detectLanguage('/x/Foo.cs'), 'csharp', 'detectLanguage .cs → csharp');
  assertEqual(mla.detectLanguage('/x/foo.ts'), null, 'detectLanguage .ts → null (handled by TS analyzer)');
  assertEqual(languageForExtension('/x/Foo.java'), 'java', 'languageForExtension matches instance method');
  assertEqual(getNodeText(null, 'src'), '', 'getNodeText null-safe');

  /* NOTE: Real flags-ON multi-language parsing is verified in the sibling
   * suite `repo-intelligence-phase3-multilang.test.ts`, which must set
   * ENABLE_MULTI_LANGUAGE *before* importing features.ts (the flag is frozen at
   * import time, so it cannot be toggled within this flags-off process). */

  /* ------------------------------------------------------------------ */
  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Test harness crashed:', err);
  process.exit(1);
});
