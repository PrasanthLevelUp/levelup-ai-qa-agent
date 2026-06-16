/**
 * Unit tests for healing-outcome-service.ts — Sprint B (Healing Outcomes
 * Learning Loop).
 *
 * The learning maths is intentionally a PURE function with no DB dependency, so
 * the heart of the loop is exercised here directly and deterministically:
 *   • calculateConfidenceUpdate — exponential smoothing (α = 0.1), pass vs fail
 *   • clamping to [0, 100] and rounding to 1 decimal (DECIMAL(5,2))
 *   • monotonic convergence: repeated passes → 100, repeated fails → 0
 *   • a single fail can't erase a long success history (and vice-versa)
 *   • isSuccess — only 'pass' counts; timeout/error/fail all pull down
 *   • resolveElementId — canonicalises selectors to a stable bucket key
 *   • aggregate success-rate maths (mirrors getHealingLearningStats)
 *
 * Run with: npx tsx tests/unit/healing-outcome-service.test.ts
 */

import {
  HealingOutcomeService,
  LEARNING_RATE,
  DEFAULT_CONFIDENCE,
} from '../../src/services/healing-outcome-service';

/* ------------------------------------------------------------------ */
/*  Tiny assert harness (mirrors profile-diff-engine.test.ts)          */
/* ------------------------------------------------------------------ */

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function assertEqual(actual: any, expected: any, msg: string) {
  const ok = actual === expected;
  if (!ok) console.error(`     actual=${JSON.stringify(actual)}, expected=${JSON.stringify(expected)}`);
  assert(ok, msg);
}

function assertClose(actual: number, expected: number, msg: string, eps = 1e-9) {
  const ok = Math.abs(actual - expected) <= eps;
  if (!ok) console.error(`     actual=${actual}, expected≈${expected}`);
  assert(ok, msg);
}

const calc = HealingOutcomeService.calculateConfidenceUpdate;

/* ------------------------------------------------------------------ */
/*  1. Single-step pass / fail maths                                   */
/* ------------------------------------------------------------------ */
function testSingleStep() {
  console.log('\n▶ calculateConfidenceUpdate — single step');

  // pass: c + α(100 − c). From 50, α=0.1 → 50 + 0.1*50 = 55.
  assertClose(calc(50, true), 55, 'pass from 50 → 55');
  // fail: c − α·c. From 50 → 50 − 0.1*50 = 45.
  assertClose(calc(50, false), 45, 'fail from 50 → 45');

  // From 0: a pass moves up, a fail stays at 0 (floor).
  assertClose(calc(0, true), 10, 'pass from 0 → 10');
  assertClose(calc(0, false), 0, 'fail from 0 → 0 (clamped floor)');

  // From 100: a fail moves down, a pass stays at 100 (ceiling).
  assertClose(calc(100, false), 90, 'fail from 100 → 90');
  assertClose(calc(100, true), 100, 'pass from 100 → 100 (clamped ceiling)');

  // Learning rate is the exported constant.
  assertEqual(LEARNING_RATE, 0.1, 'LEARNING_RATE is 0.1');
  assertEqual(DEFAULT_CONFIDENCE, 50, 'DEFAULT_CONFIDENCE is 50');
}

/* ------------------------------------------------------------------ */
/*  2. Clamping, rounding & invalid inputs                             */
/* ------------------------------------------------------------------ */
function testClampAndRound() {
  console.log('\n▶ clamping, rounding & invalid inputs');

  // Out-of-range current values are clamped before the update.
  assertClose(calc(150, false), 90, 'current > 100 clamped to 100 first');
  assertClose(calc(-20, true), 10, 'current < 0 clamped to 0 first');

  // Non-finite current → treated as the neutral default (50).
  assertClose(calc(NaN, true), 55, 'NaN current → default 50 then pass → 55');
  assertClose(calc(undefined as any, false), 45, 'undefined current → default 50 then fail → 45');

  // Result is rounded to 1 decimal place.
  const v = calc(33, true); // 33 + 0.1*67 = 39.7
  assertClose(v, 39.7, '33 pass → 39.7 (1 dp)');
  assertEqual(Math.round(v * 10) === v * 10, true, 'result has at most 1 decimal place');

  // A custom (valid) rate is honoured; invalid rates fall back to default.
  assertClose(calc(50, true, 0.5), 75, 'custom rate 0.5: pass from 50 → 75');
  assertClose(calc(50, true, 0), 55, 'rate 0 (invalid) → falls back to 0.1');
  assertClose(calc(50, true, 2), 55, 'rate > 1 (invalid) → falls back to 0.1');
}

/* ------------------------------------------------------------------ */
/*  3. Convergence & monotonicity over sequences                       */
/* ------------------------------------------------------------------ */
function testConvergence() {
  console.log('\n▶ convergence & monotonicity');

  // Repeated passes converge monotonically toward 100 without exceeding it.
  let c = DEFAULT_CONFIDENCE;
  let prev = c;
  let monotonicUp = true;
  for (let i = 0; i < 100; i++) {
    c = calc(c, true);
    if (c < prev) monotonicUp = false;
    prev = c;
  }
  assert(monotonicUp, '100 consecutive passes are monotonically non-decreasing');
  // With 1-dp rounding the score plateaus at 99.9 (99.9 + 0.1·0.1 rounds back
  // to 99.9), so "converged to ~100" means it reached the 99.9 ceiling.
  assert(c >= 99.5 && c <= 100, '100 consecutive passes converge to ~100 (≥99.5 plateau)');

  // Repeated fails converge monotonically toward 0 without going below it.
  c = DEFAULT_CONFIDENCE;
  prev = c;
  let monotonicDown = true;
  for (let i = 0; i < 100; i++) {
    c = calc(c, false);
    if (c > prev) monotonicDown = false;
    prev = c;
  }
  assert(monotonicDown, '100 consecutive fails are monotonically non-increasing');
  // Symmetric plateau at 0.1 (0.1 − 0.1·0.1 rounds back to 0.1).
  assert(c >= 0 && c <= 0.6, '100 consecutive fails converge to ~0 (≤0.6 plateau)');

  // Every intermediate value always stays within [0, 100].
  c = DEFAULT_CONFIDENCE;
  let inRange = true;
  const pattern = [true, false, true, true, false, false, true, false];
  for (let i = 0; i < 200; i++) {
    c = calc(c, pattern[i % pattern.length]);
    if (c < 0 || c > 100) inRange = false;
  }
  assert(inRange, 'mixed pass/fail sequence stays within [0, 100]');
}

/* ------------------------------------------------------------------ */
/*  4. Stability — one outcome can't whipsaw an established score      */
/* ------------------------------------------------------------------ */
function testStability() {
  console.log('\n▶ stability of an established score');

  // Build a strong history of passes, then a single fail.
  let c = DEFAULT_CONFIDENCE;
  for (let i = 0; i < 30; i++) c = calc(c, true);
  const high = c;
  const afterOneFail = calc(high, false);
  assert(afterOneFail > 80, 'a single fail after 30 passes stays high (>80)');
  assert(high - afterOneFail < high * 0.11, 'one fail removes at most ~10% of the score');

  // Build a strong history of fails, then a single pass.
  c = DEFAULT_CONFIDENCE;
  for (let i = 0; i < 30; i++) c = calc(c, false);
  const low = c;
  const afterOnePass = calc(low, true);
  assert(afterOnePass < 20, 'a single pass after 30 fails stays low (<20)');
}

/* ------------------------------------------------------------------ */
/*  5. isSuccess — only 'pass' is a success                            */
/* ------------------------------------------------------------------ */
function testIsSuccess() {
  console.log('\n▶ isSuccess result normalisation');
  assertEqual(HealingOutcomeService.isSuccess('pass'), true, "'pass' → success");
  assertEqual(HealingOutcomeService.isSuccess('PASS'), true, "'PASS' (case-insensitive) → success");
  assertEqual(HealingOutcomeService.isSuccess('fail'), false, "'fail' → failure");
  assertEqual(HealingOutcomeService.isSuccess('timeout'), false, "'timeout' → failure");
  assertEqual(HealingOutcomeService.isSuccess('error'), false, "'error' → failure");
  assertEqual(HealingOutcomeService.isSuccess(''), false, "'' → failure");
}

/* ------------------------------------------------------------------ */
/*  6. resolveElementId — stable bucket key                            */
/* ------------------------------------------------------------------ */
function testResolveElementId() {
  console.log('\n▶ resolveElementId canonicalisation');

  // Explicit elementId always wins.
  assertEqual(
    HealingOutcomeService.resolveElementId({ elementId: 'login-btn', result: 'pass' }),
    'login-btn',
    'explicit elementId is used verbatim',
  );

  // Different phrasings of the same id collapse to one canonical key.
  const a = HealingOutcomeService.resolveElementId({ originalSelector: '#email', result: 'pass' });
  const b = HealingOutcomeService.resolveElementId({ originalSelector: 'getById("email")', result: 'pass' });
  assertEqual(a, '#email', '#email canonicalises to #email');
  assertEqual(a, b, '#email and getById("email") map to the same bucket');

  // data-testid phrasings collapse together too.
  const t1 = HealingOutcomeService.resolveElementId({ originalSelector: '[data-testid="submit"]', result: 'pass' });
  const t2 = HealingOutcomeService.resolveElementId({ originalSelector: 'getByTestId("submit")', result: 'pass' });
  assertEqual(t1, t2, 'data-testid attribute and getByTestId map to the same bucket');

  // Falls back to the healed selector, then to 'unknown'.
  assertEqual(
    HealingOutcomeService.resolveElementId({ healedSelector: '#new', result: 'pass' }),
    '#new',
    'falls back to healed selector when original is absent',
  );
  assertEqual(
    HealingOutcomeService.resolveElementId({ result: 'pass' }),
    'unknown',
    'no selectors at all → "unknown"',
  );
}

/* ------------------------------------------------------------------ */
/*  7. Aggregate success-rate maths (mirrors getHealingLearningStats)  */
/* ------------------------------------------------------------------ */
function testAggregateRates() {
  console.log('\n▶ aggregate success-rate maths');

  const successRate = (succ: number, total: number) =>
    total > 0 ? Math.round((succ / total) * 1000) / 10 : 0;

  assertEqual(successRate(0, 0), 0, 'no outcomes → 0% (no divide-by-zero)');
  assertEqual(successRate(1, 2), 50, '1/2 → 50.0%');
  assertEqual(successRate(2, 3), 66.7, '2/3 → 66.7% (1 dp)');
  assertEqual(successRate(7, 7), 100, '7/7 → 100%');
  assertEqual(successRate(0, 5), 0, '0/5 → 0%');
}

/* ------------------------------------------------------------------ */
/*  Run                                                                */
/* ------------------------------------------------------------------ */
testSingleStep();
testClampAndRound();
testConvergence();
testStability();
testIsSuccess();
testResolveElementId();
testAggregateRates();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
