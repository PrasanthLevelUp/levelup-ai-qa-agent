/**
 * No silent generic fallback for test-case / requirement intent — Unit Tests
 * =========================================================================
 * Regression guard for the ROOT of the "requirement-based generation emits 4
 * unrelated smoke/search/navigation/form specs, 0% grounded, 100% score" bug.
 *
 * Even after the route-level guard (which returns 422 when a requirement
 * resolves 0 test cases BEFORE generation), a second, deeper leak remained:
 * when real cases WERE supplied but the deterministic engine produced nothing
 * (e.g. no automatable/parseable steps) it SILENTLY dropped through to the
 * generic LLM "workflow generator" (path 2) and dressed the ungrounded output
 * up as a success. That silent fallback is now removed — the engine raises
 * `DeterministicGenerationEmptyError` instead, so the API can fail honestly.
 *
 * This test drives the real `ScriptGenEngine.generate()` with cached crawl data
 * (no network) and test cases whose steps do not parse, and asserts the engine
 * THROWS rather than emitting generic specs.
 *
 * Run with:  npx tsx tests/unit/no-generic-fallback.test.ts
 */

import {
  ScriptGenEngine,
  DeterministicGenerationEmptyError,
  type GenerationConfig,
} from '../../src/script-gen/script-gen-engine';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

// Minimal cached crawl (fast path → no network, no DB).
const cachedCrawlData: any = {
  url: 'https://example.test/',
  finalUrl: 'https://example.test/',
  title: 'Example',
  pageType: 'unknown',
  elements: [],
  forms: [],
  buttons: [],
  inputs: [],
  headings: [],
  navigationLinks: [],
  totalElements: 0,
  interactiveElements: 0,
};

async function main() {
  const engine = new ScriptGenEngine();

  /* ── Error contract ────────────────────────────────────────────────────── */
  {
    const e = new DeterministicGenerationEmptyError(3, ['case A: no steps'], 'boom');
    assert(e instanceof Error, 'error: is an Error subclass');
    assert(e.code === 'DETERMINISTIC_GENERATION_EMPTY', 'error: carries stable code');
    assert(e.name === 'DeterministicGenerationEmptyError', 'error: has a distinct name');
    assert(e.intendedCaseCount === 3, 'error: preserves intended case count');
    assert(Array.isArray(e.caseErrors) && e.caseErrors.length === 1, 'error: preserves per-case reasons');
  }

  /* ── testCases batch with no parseable steps → THROWS, no generic specs ─── */
  {
    const config: GenerationConfig = {
      url: 'https://example.test/',
      cachedCrawlData,
      // Requirement-style batch. Empty steps ⇒ deterministic path yields null
      // for every case ⇒ engine must refuse the generic fallback.
      testCases: [
        { id: 1, title: 'Case one', steps: '' as any },
        { id: 2, title: 'Case two', steps: '' as any },
      ] as any,
    };
    let threw: any = null;
    let result: any = null;
    try { result = await engine.generate(config); }
    catch (err) { threw = err; }
    assert(threw instanceof DeterministicGenerationEmptyError, 'batch: throws DeterministicGenerationEmptyError (no generic fallback)');
    assert(result === null, 'batch: never returns a generic GenerationResult');
    if (threw instanceof DeterministicGenerationEmptyError) {
      assert(threw.intendedCaseCount === 2, 'batch: reports the 2 intended cases');
      // Observability (Bug #2): caseErrors must NO LONGER be empty — it must
      // name the failing Stage-1 reason per case (was `caseErrors: []`).
      assert(threw.caseErrors.length === 2, 'batch: caseErrors carries a reason per case (not [])');
      assert(threw.caseErrors.every(e => /STAGE 1/.test(e)), 'batch: each reason names the failing stage');
      // Pipeline observability — the funnel must show the count dropping to 0 at
      // canonicalization (11→0 pattern) so the failing stage is obvious.
      const p = threw.pipeline;
      assert(!!p, 'batch: pipeline summary present on the error');
      if (p) {
        assert(p.inputTestCases === 2, 'batch/pipeline: inputTestCases = 2');
        assert(p.canonicalized === 0, 'batch/pipeline: canonicalized = 0 (drop point)');
        assert(p.parsed === 0 && p.grounded === 0 && p.generatedScripts === 0, 'batch/pipeline: all downstream stages = 0');
        assert(p.cases.length === 2, 'batch/pipeline: one trace per case');
        assert(p.cases.every(c => c.reachedStage === 'Canonicalization' && c.status === 'FAILED'), 'batch/pipeline: each case stalls at Canonicalization/FAILED');
        assert(p.cases.every(c => typeof c.reason === 'string' && c.reason.length > 0), 'batch/pipeline: each case carries a reason');
      }
    }
  }

  /* ── unparseable object-shape steps → THROWS with shape+keys diagnostics ── */
  {
    const config: GenerationConfig = {
      url: 'https://example.test/',
      cachedCrawlData,
      testCases: [
        { id: 201, title: 'Foreign schema', steps: [{ foo: 1, bar: true }] as any },
      ] as any,
    };
    let threw: any = null;
    try { await engine.generate(config); }
    catch (err) { threw = err; }
    assert(threw instanceof DeterministicGenerationEmptyError, 'foreign-shape: throws (no generic fallback)');
    if (threw instanceof DeterministicGenerationEmptyError) {
      assert(threw.caseErrors.length === 1, 'foreign-shape: caseErrors populated');
      assert(/shape=object-array/.test(threw.caseErrors[0]!), 'foreign-shape: reason names detected shape');
      assert(/keys=\[foo, bar\]/.test(threw.caseErrors[0]!), 'foreign-shape: reason names observed keys');
    }
  }

  /* ── canonical model absorbs the {instruction,expectedResult} root cause ── */
  {
    // The EXACT shape that produced `DeterministicGenerationEmptyError(11, [])`
    // for requirement c45af114. It must now GENERATE grounded scripts instead
    // of throwing — proving the canonical normalizer closed the root cause.
    const groundedCrawl: any = {
      url: 'https://automationexercise.com/login', finalUrl: 'https://automationexercise.com/login',
      title: 'Login', pageType: 'login',
      elements: [
        { tag: 'input', attributes: { 'data-qa': 'login-email', name: 'email', type: 'email' }, text: '' },
        { tag: 'input', attributes: { 'data-qa': 'login-password', name: 'password', type: 'password' }, text: '' },
        { tag: 'button', attributes: { 'data-qa': 'login-button' }, text: 'Login' },
      ],
      forms: [], buttons: [], inputs: [], headings: [], navigationLinks: [], totalElements: 3, interactiveElements: 3,
    };
    const config: GenerationConfig = {
      url: 'https://automationexercise.com/login',
      cachedCrawlData: groundedCrawl,
      testCases: [{
        id: 102, title: 'Login with valid credentials', requirement_id: 'c45af114',
        steps: [
          { instruction: 'Navigate to https://automationexercise.com/login', expectedResult: 'page loads' },
          { instruction: 'Enter email into login-email', expectedResult: 'ok' },
          { instruction: 'Enter password into login-password', expectedResult: 'ok' },
          { instruction: 'Click login-button', expectedResult: 'logged in' },
        ] as any,
      }] as any,
    };
    let threw: any = null;
    let result: any = null;
    try { result = await engine.generate(config); }
    catch (err) { threw = err; }
    assert(threw === null, 'instruction-shape: no longer throws (root cause fixed)');
    assert(result && result.generatedFiles.length > 0, 'instruction-shape: emits grounded spec file(s)');
    // Pipeline observability on the SUCCESS path — the funnel should show a
    // full traversal (1→1→1→1→1), proving the case reached "Generated".
    if (result) {
      const p = result.pipeline;
      assert(!!p, 'instruction-shape/pipeline: summary present on success result');
      if (p) {
        assert(p.inputTestCases === 1, 'instruction-shape/pipeline: inputTestCases = 1');
        assert(p.canonicalized === 1 && p.parsed === 1, 'instruction-shape/pipeline: canonicalized & parsed = 1');
        assert(p.generatedScripts === 1, 'instruction-shape/pipeline: generatedScripts = 1');
        assert(p.cases.length === 1 && p.cases[0]!.status === 'OK' && p.cases[0]!.reachedStage === 'Generated', 'instruction-shape/pipeline: case traced OK → Generated');
      }
    }
  }

  /* ── single testCase with no parseable steps → THROWS ──────────────────── */
  {
    const config: GenerationConfig = {
      url: 'https://example.test/',
      cachedCrawlData,
      testCase: { id: 9, title: 'Lonely case', steps: '' as any } as any,
    };
    let threw: any = null;
    try { await engine.generate(config); }
    catch (err) { threw = err; }
    assert(threw instanceof DeterministicGenerationEmptyError, 'single: throws DeterministicGenerationEmptyError (no LLM fallback)');
    if (threw instanceof DeterministicGenerationEmptyError) {
      assert(threw.intendedCaseCount === 1, 'single: reports 1 intended case');
    }
  }

  /* ── URL-only generation (no cases) still allowed to reach path 2 ──────── */
  {
    // A pure URL run carries NO test-case intent, so it must NOT throw the
    // deterministic-empty error — it is the one legitimate use of the generic
    // generator. We only assert it does not raise our typed guard (it may still
    // fail for lack of an API key / empty crawl — that's a different concern).
    const config: GenerationConfig = {
      url: 'https://example.test/',
      cachedCrawlData,
    };
    let typedGuard = false;
    try { await engine.generate(config); }
    catch (err) { if (err instanceof DeterministicGenerationEmptyError) typedGuard = true; }
    assert(!typedGuard, 'url-only: does NOT raise the deterministic-empty guard (path 2 stays valid here)');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => { console.error(err); process.exit(1); });
