/**
 * Honest reliability breakdown — Unit Tests
 * =========================================
 * Regression guard for the "script reports 100% reliable while 0/14 locators are
 * grounded and the files don't match the requirement" dishonesty.
 *
 * `computeReliabilityBreakdown` must decompose reliability into code quality,
 * grounding quality and business coverage, and combine them WEAKEST-LINK so a
 * single zeroed dimension collapses the headline execution-readiness score.
 *
 * Run with:  npx tsx tests/unit/reliability-breakdown.test.ts
 */

import { computeReliabilityBreakdown, toPublicReliability } from '../../src/script-gen/validation-runner';

let passed = 0;
let failed = 0;
function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function main() {
  /* ── The exact production bug: perfect code, zero grounding ─────────────── */
  {
    const b = computeReliabilityBreakdown({
      codeQuality: 100,
      grounding: { grounded: 0, total: 14 },
      intendedTestCaseCount: 0,   // generic fallback — no intended cases resolved
      usedRealTestCases: false,
    });
    assert(b.codeQuality === 100, 'bug: code quality is still reported as 100');
    assert(b.groundingQuality === 0, 'bug: grounding quality is honestly 0 (0/14)');
    assert(b.businessCoverage === null, 'bug: business coverage is n/a (no intended cases)');
    assert(b.executionReadiness === 0, 'bug: execution readiness collapses to 0 (weakest link)');
    assert(/grounding 0%/.test(b.headline), 'bug: headline surfaces the 0% grounding');
  }

  /* ── Fully grounded, real cases → high readiness ───────────────────────── */
  {
    const b = computeReliabilityBreakdown({
      codeQuality: 100,
      grounding: { grounded: 20, total: 20 },
      intendedTestCaseCount: 11,
      usedRealTestCases: true,
    });
    assert(b.groundingQuality === 100, 'good: grounding 20/20 = 100%');
    assert(b.businessCoverage === 100, 'good: real cases drove generation → 100%');
    assert(b.executionReadiness === 100, 'good: all dimensions high → readiness 100');
  }

  /* ── Requirement intent but fallback ran → business coverage 0 ─────────── */
  {
    const b = computeReliabilityBreakdown({
      codeQuality: 100,
      grounding: { grounded: 10, total: 10 },
      intendedTestCaseCount: 11,   // user intended 11 cases...
      usedRealTestCases: false,    // ...but the generic fallback ran
    });
    assert(b.businessCoverage === 0, 'fallback: intended cases not used → business coverage 0');
    assert(b.executionReadiness === 0, 'fallback: readiness collapses despite 100% code & grounding');
  }

  /* ── Partial grounding multiplies through ──────────────────────────────── */
  {
    const b = computeReliabilityBreakdown({
      codeQuality: 100,
      grounding: { grounded: 5, total: 10 }, // 50%
      intendedTestCaseCount: 4,
      usedRealTestCases: true,               // 100%
    });
    assert(b.groundingQuality === 50, 'partial: grounding 5/10 = 50%');
    // 1.0 * 0.5 * 1.0 = 0.5 → 50
    assert(b.executionReadiness === 50, 'partial: readiness = product of dimensions (50%)');
  }

  /* ── Pure URL / plain-English generation: no cases, no locators expected ── */
  {
    const b = computeReliabilityBreakdown({
      codeQuality: 90,
      grounding: null,             // nothing to ground
      intendedTestCaseCount: 0,    // no predefined cases
      usedRealTestCases: false,
    });
    assert(b.groundingQuality === null, 'url: grounding n/a when no locators resolved');
    assert(b.businessCoverage === null, 'url: business coverage n/a when no intended cases');
    assert(b.executionReadiness === 90, 'url: readiness = code quality when only that applies');
  }

  /* ── Scores are clamped to 0..100 and rounded ──────────────────────────── */
  {
    const b = computeReliabilityBreakdown({
      codeQuality: 137,                       // out of range
      grounding: { grounded: 1, total: 3 },   // 33.33% → 33
      intendedTestCaseCount: 2,
      usedRealTestCases: true,
    });
    assert(b.codeQuality === 100, 'clamp: code quality clamped to 100');
    assert(b.groundingQuality === 33, 'round: 1/3 grounding rounds to 33%');
  }

  /* ── Public API projection: only 4 headline fields, no internals ───────── */
  {
    const full = computeReliabilityBreakdown({
      codeQuality: 100,
      grounding: { grounded: 0, total: 14 },
      intendedTestCaseCount: 5,
      usedRealTestCases: false,
    });
    const pub = toPublicReliability(full);
    const keys = Object.keys(pub).sort();
    assert(
      JSON.stringify(keys) === JSON.stringify(['codeQuality', 'coverage', 'executionReadiness', 'grounding']),
      'public: exposes exactly {executionReadiness, grounding, coverage, codeQuality}',
    );
    assert(!('headline' in (pub as any)), 'public: internal headline is NOT exposed');
    assert(!('dimensions' in (pub as any)), 'public: internal dimensions[] is NOT exposed');
    assert(!('groundingQuality' in (pub as any)), 'public: verbose groundingQuality key is renamed to grounding');
    assert(!('businessCoverage' in (pub as any)), 'public: verbose businessCoverage key is renamed to coverage');
    assert(pub.executionReadiness === 0, 'public: execution readiness collapses to 0 (0% grounding)');
    assert(pub.codeQuality === 100, 'public: code quality preserved');
    assert(pub.grounding === 0, 'public: grounding = 0 (0/14)');
    assert(pub.coverage === 0, 'public: coverage = 0 (fallback ran on intended cases)');
  }

  /* ── Public API: null dimensions survive the projection ────────────────── */
  {
    const full = computeReliabilityBreakdown({
      codeQuality: 90,
      grounding: null,
      intendedTestCaseCount: 0,
      usedRealTestCases: false,
    });
    const pub = toPublicReliability(full);
    assert(pub.grounding === null, 'public: grounding stays null when nothing to ground');
    assert(pub.coverage === null, 'public: coverage stays null when no intended cases');
    assert(pub.executionReadiness === 90, 'public: readiness = code quality when only that applies');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
