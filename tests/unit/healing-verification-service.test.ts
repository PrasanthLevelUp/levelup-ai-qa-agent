/**
 * Unit tests for healing-verification-service.ts — Sprint B Phase 1 (Runner
 * Integration).
 *
 * The pure helpers that decide WHAT outcome gets recorded are exercised here
 * directly and deterministically (no DB, no network):
 *   • mapExitCodeToResult — 0 → 'pass', anything else (incl. signals) → 'fail'
 *   • normalizeConfidence — engine 0–1 scale → learning-loop 0–100 scale,
 *     pass-through for already-0–100 values, clamping and null handling
 *   • genJobId — unique, 'hv_'-prefixed identifiers
 *   • resolveResult — explicit result wins; else exit code; else 'error'
 *
 * Run with: npx tsx tests/unit/healing-verification-service.test.ts
 */

import { HealingVerificationService } from '../../src/services/healing-verification-service';

/* ------------------------------------------------------------------ */
/*  Tiny assert harness (mirrors healing-outcome-service.test.ts)      */
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

/* ------------------------------------------------------------------ */
/*  mapExitCodeToResult                                                */
/* ------------------------------------------------------------------ */

function testMapExitCode() {
  console.log('\nmapExitCodeToResult:');
  assertEqual(HealingVerificationService.mapExitCodeToResult(0), 'pass', 'exit 0 → pass');
  assertEqual(HealingVerificationService.mapExitCodeToResult(1), 'fail', 'exit 1 → fail');
  assertEqual(HealingVerificationService.mapExitCodeToResult(2), 'fail', 'exit 2 → fail');
  assertEqual(HealingVerificationService.mapExitCodeToResult(137), 'fail', 'exit 137 (SIGKILL) → fail');
  assertEqual(HealingVerificationService.mapExitCodeToResult(-1), 'fail', 'negative exit → fail');
}

/* ------------------------------------------------------------------ */
/*  normalizeConfidence                                                */
/* ------------------------------------------------------------------ */

function testNormalizeConfidence() {
  console.log('\nnormalizeConfidence:');
  assertEqual(HealingVerificationService.normalizeConfidence(0.85), 85, '0.85 (0–1 scale) → 85');
  assertEqual(HealingVerificationService.normalizeConfidence(1), 100, '1.0 → 100');
  assertEqual(HealingVerificationService.normalizeConfidence(0), 0, '0 → 0');
  assertEqual(HealingVerificationService.normalizeConfidence(85), 85, '85 (already 0–100) → 85');
  assertEqual(HealingVerificationService.normalizeConfidence(100), 100, '100 → 100');
  assertEqual(HealingVerificationService.normalizeConfidence(150), 100, '150 clamps → 100');
  assertEqual(HealingVerificationService.normalizeConfidence(-0.5), 0, 'negative clamps → 0');
  assertEqual(HealingVerificationService.normalizeConfidence(null), null, 'null → null');
  assertEqual(HealingVerificationService.normalizeConfidence(undefined), null, 'undefined → null');
  assertEqual(HealingVerificationService.normalizeConfidence(NaN), null, 'NaN → null');
  // A small fractional value scales proportionally.
  assertEqual(HealingVerificationService.normalizeConfidence(0.5), 50, '0.5 → 50');
}

/* ------------------------------------------------------------------ */
/*  genJobId                                                           */
/* ------------------------------------------------------------------ */

function testGenJobId() {
  console.log('\ngenJobId:');
  const a = HealingVerificationService.genJobId();
  const b = HealingVerificationService.genJobId();
  assert(a.startsWith('hv_'), `job id is prefixed: ${a}`);
  assert(a !== b, 'two ids are unique');
  // Generate a batch and confirm no collisions.
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i++) ids.add(HealingVerificationService.genJobId());
  assertEqual(ids.size, 1000, '1000 generated ids are all unique');
}

/* ------------------------------------------------------------------ */
/*  resolveResult (private — exercised via a thin subclass)            */
/* ------------------------------------------------------------------ */

class TestableService extends HealingVerificationService {
  public resolve(result?: string, exitCode?: number) {
    return (this as any).resolveResult(result, exitCode);
  }
}

function testResolveResult() {
  console.log('\nresolveResult precedence:');
  const svc = new TestableService();
  assertEqual(svc.resolve('pass', 1), 'pass', 'explicit result wins over exit code');
  assertEqual(svc.resolve(undefined, 0), 'pass', 'exit 0 → pass when no explicit result');
  assertEqual(svc.resolve(undefined, 1), 'fail', 'exit 1 → fail when no explicit result');
  assertEqual(svc.resolve(undefined, undefined), 'error', 'no result + no exit code → error (pulls confidence down)');
  assertEqual(svc.resolve('timeout', undefined), 'timeout', 'explicit timeout preserved');
}

/* ------------------------------------------------------------------ */
/*  Run                                                                */
/* ------------------------------------------------------------------ */
testMapExitCode();
testNormalizeConfidence();
testGenJobId();
testResolveResult();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
