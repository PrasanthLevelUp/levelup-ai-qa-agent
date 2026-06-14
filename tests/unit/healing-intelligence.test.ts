/**
 * Healing Intelligence (Sprint 2) — gating + pure-logic unit tests (flags OFF).
 *
 * Verifies that with ENABLE_HEALING_INTELLIGENCE OFF (the default):
 *   - the feature flag reads false,
 *   - HealingIntelligenceContext.isEnabled() is false,
 *   - load() returns an inert empty context WITHOUT touching the database, and
 *   - the pure helpers (search-term building, evidence derivation, prompt-block
 *     formatting, and the repository-aware confidence boost policy) are correct
 *     in isolation.
 *
 * No database is required. The flag is explicitly deleted at the top so a
 * polluted environment cannot accidentally enable the feature.
 *
 * Run with: npx tsx tests/unit/healing-intelligence.test.ts
 */

delete process.env.ENABLE_HEALING_INTELLIGENCE;

import { FEATURE_FLAGS } from '../../src/config/features';
import {
  HealingIntelligenceContext,
  emptyHealingContext,
  getHealingIntelligenceContext,
  type HealingContextResult,
} from '../../src/services/healing-intelligence-context';
import {
  computeRepositoryConfidenceBoost,
  normalizeSelectorText,
} from '../../src/core/healing-orchestrator';
import type { MethodSearchHit } from '../../src/db/postgres';
import type { RagExample } from '../../src/services/rag-service';
import type { FailureDetails } from '../../src/core/failure-analyzer';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

/* ----------------------------- test fixtures ----------------------------- */

function mkFailure(over: Partial<FailureDetails> = {}): FailureDetails {
  return {
    testName: 'login test',
    failureType: 'locator' as any,
    failedLocator: "page.getByRole('button', { name: 'Submit' })",
    errorMessage: 'locator not found',
    errorPattern: 'TimeoutError',
    filePath: 'tests/login.spec.ts',
    lineNumber: 12,
    failedLineCode: "await page.getByRole('button', { name: 'Submit' }).click();",
    surroundingCode: '',
    screenshotPath: null,
    url: 'https://app.example.com/login',
    timestamp: new Date().toISOString(),
    isTimingIssue: false,
    ...over,
  };
}

function mkMethod(over: Partial<MethodSearchHit> = {}): MethodSearchHit {
  return {
    id: 1,
    methodName: 'clickSubmit',
    filePath: 'pages/LoginPage.ts',
    className: 'LoginPage',
    methodType: 'page_object_method',
    usageCount: 3,
    sourceCode: "async clickSubmit() { await this.page.getByRole('button', { name: 'Submit' }).click(); }",
    similarity: 0.82,
    ...over,
  };
}

function mkRag(over: Partial<RagExample> = {}): RagExample {
  return {
    filePath: 'pages/LoginPage.ts',
    chunkType: 'source',
    chunkName: 'LoginPage',
    content: "getByRole('button', { name: 'Submit' })",
    similarity: 0.7,
    ...over,
  };
}

function ctxWith(over: Partial<HealingContextResult>): HealingContextResult {
  return { ...emptyHealingContext(), ...over };
}

/* -------------------------------- tests ---------------------------------- */

async function main() {
  console.log('\n=== Healing Intelligence flag OFF — gating ===');
  assert(FEATURE_FLAGS.REPO_INTELLIGENCE.HEALING_INTELLIGENCE === false, 'HEALING_INTELLIGENCE defaults OFF');
  assert(HealingIntelligenceContext.isEnabled() === false, 'isEnabled() false when flag off');

  // load() must NOT touch the DB when the flag is off (no getPool call) — if it
  // did this would throw because no pool is configured in this test process.
  const svc = getHealingIntelligenceContext();
  const offResult = await svc.load({
    repoId: 'https://github.com/acme/app',
    companyId: 1,
    projectId: 2,
    failure: mkFailure(),
  });
  assert(offResult.contextId === null, 'load() contextId null when flag off');
  assert(offResult.hasEvidence === false, 'load() hasEvidence false when flag off');
  assert(offResult.methodHits.length === 0 && offResult.ragExamples.length === 0, 'load() empty hits when flag off');
  assert(offResult.promptBlock === '', 'load() empty promptBlock when flag off');

  console.log('\n=== emptyHealingContext shape ===');
  const empty = emptyHealingContext();
  assert(empty.contextId === null && empty.hasEvidence === false, 'emptyHealingContext inert');
  assert(empty.evidence.methodIndexHit === false && empty.evidence.pageObjectHit === false, 'empty evidence all false');
  assert(empty.evidence.usedByTestCount === 0 && empty.evidence.ragHit === false, 'empty evidence counts zero');

  console.log('\n=== buildSearchTerm ===');
  const term = HealingIntelligenceContext.buildSearchTerm(mkFailure());
  assert(term.includes('Submit'), 'search term includes locator text');
  assert(term.length <= 400, 'search term capped at 400 chars');
  // When the failed line contains the locator, it should not be duplicated.
  const dupTerm = HealingIntelligenceContext.buildSearchTerm(mkFailure({
    failedLocator: 'getByText("Hi")',
    failedLineCode: 'await page.getByText("Hi").click();',
  }));
  assert(dupTerm === 'await page.getByText("Hi").click();'.slice(0, 400), 'search term de-dupes when locator inside line');
  const emptyTerm = HealingIntelligenceContext.buildSearchTerm(mkFailure({ failedLocator: '', failedLineCode: '' }));
  assert(emptyTerm === '', 'search term empty when no locator/line');

  console.log('\n=== deriveEvidence ===');
  const noEv = HealingIntelligenceContext.deriveEvidence([], []);
  assert(noEv.methodIndexHit === false && noEv.ragHit === false, 'deriveEvidence empty -> no evidence');

  const ev = HealingIntelligenceContext.deriveEvidence(
    [mkMethod({ usageCount: 5, similarity: 0.9 }), mkMethod({ id: 2, methodType: 'test', usageCount: 1 })],
    [mkRag()],
  );
  assert(ev.methodIndexHit === true, 'deriveEvidence methodIndexHit true');
  assert(ev.pageObjectHit === true, 'deriveEvidence pageObjectHit true (page_object_method present)');
  assert(ev.usedByTestCount === 5, 'deriveEvidence usedByTestCount = max usageCount');
  assert(ev.ragHit === true, 'deriveEvidence ragHit true');
  assert(Math.abs(ev.topMethodSimilarity - 0.9) < 1e-9, 'deriveEvidence topMethodSimilarity from first hit');

  // Only a non-page-object method => methodIndexHit but not pageObjectHit.
  const evUtil = HealingIntelligenceContext.deriveEvidence([mkMethod({ methodType: 'utility', usageCount: 0 })], []);
  assert(evUtil.methodIndexHit === true && evUtil.pageObjectHit === false, 'deriveEvidence utility -> not page object');

  console.log('\n=== buildPromptBlock ===');
  assert(HealingIntelligenceContext.buildPromptBlock([], []) === '', 'buildPromptBlock empty -> ""');
  const block = HealingIntelligenceContext.buildPromptBlock([mkMethod()], [mkRag()]);
  assert(block.includes('Repository context'), 'prompt block has header');
  assert(block.includes('LoginPage.clickSubmit'), 'prompt block names class.method');
  assert(block.includes('used by 3 test(s)'), 'prompt block notes usage count');
  assert(block.includes('Related source'), 'prompt block has RAG section');
  // Truncation: a huge source is trimmed.
  const bigBlock = HealingIntelligenceContext.buildPromptBlock(
    [mkMethod({ sourceCode: 'x'.repeat(5000) })], [], { maxCharsPerSnippet: 100 },
  );
  assert(bigBlock.includes('(truncated)'), 'prompt block truncates long source');

  console.log('\n=== normalizeSelectorText ===');
  assert(normalizeSelectorText("getByRole('button')") === normalizeSelectorText('getByRole("button")'),
    'normalize unifies quote styles');
  assert(normalizeSelectorText('  Get By Role ') === 'getbyrole', 'normalize strips whitespace + lowercases');
  assert(normalizeSelectorText('') === '', 'normalize empty -> empty');

  console.log('\n=== computeRepositoryConfidenceBoost ===');
  // No evidence -> zero boost.
  const z = computeRepositoryConfidenceBoost("page.getByRole('button')", emptyHealingContext());
  assert(z.boost === 0 && z.reasons.length === 0, 'no evidence -> zero boost');

  // Locator present in a page-object method, used by tests -> 0.20 + 0.10.
  const poCtx = ctxWith({ hasEvidence: true, methodHits: [mkMethod({ usageCount: 3 })] });
  const po = computeRepositoryConfidenceBoost("page.getByRole('button', { name: 'Submit' })", poCtx);
  assert(Math.abs(po.boost - 0.30) < 1e-9, 'page-object + usage -> +0.30');
  assert(po.reasons.some(r => r.includes('page-object')), 'reason mentions page-object reuse');
  assert(po.reasons.some(r => r.includes('3 existing test')), 'reason mentions usage count');

  // Locator present in a non-page-object indexed method, no usage -> 0.15.
  const idxCtx = ctxWith({ hasEvidence: true, methodHits: [mkMethod({ methodType: 'utility', usageCount: 0 })] });
  const idx = computeRepositoryConfidenceBoost("page.getByRole('button', { name: 'Submit' })", idxCtx);
  assert(Math.abs(idx.boost - 0.15) < 1e-9, 'indexed method (no usage) -> +0.15');

  // Locator only in RAG source -> 0.10.
  const ragCtx = ctxWith({ hasEvidence: true, ragExamples: [mkRag()] });
  const rag = computeRepositoryConfidenceBoost("page.getByRole('button', { name: 'Submit' })", ragCtx);
  assert(Math.abs(rag.boost - 0.10) < 1e-9, 'RAG-only corroboration -> +0.10');

  // Evidence present but locator NOT found verbatim -> small 0.03 boost.
  const weakCtx = ctxWith({ hasEvidence: true, methodHits: [mkMethod({ sourceCode: 'totally unrelated code' })] });
  const weak = computeRepositoryConfidenceBoost("page.getByLabel('Email')", weakCtx);
  assert(Math.abs(weak.boost - 0.03) < 1e-9, 'grounding present but no verbatim match -> +0.03');

  // Empty locator -> zero boost even with evidence.
  const emptyLoc = computeRepositoryConfidenceBoost('', poCtx);
  assert(emptyLoc.boost === 0, 'empty locator -> zero boost');

  // Quote-style differences must still corroborate (normalization works).
  const altQuote = ctxWith({
    hasEvidence: true,
    methodHits: [mkMethod({ sourceCode: 'await this.page.getByRole("button", { name: "Submit" }).click();' })],
  });
  const altQuoteBoost = computeRepositoryConfidenceBoost("page.getByRole('button', { name: 'Submit' })", altQuote);
  assert(altQuoteBoost.boost >= 0.20, 'corroboration robust to quote-style differences');

  console.log(`\n${failed === 0 ? '✅ ALL PASSED' : '❌ FAILURES'} — ${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
