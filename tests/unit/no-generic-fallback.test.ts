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
