/**
 * Unit tests for healing-analytics-service.ts — Priority 1 (Healing Analytics
 * Dashboard).
 *
 * The SQL itself needs a live DB, but the numeric coercion and window logic that
 * decides what the dashboard SHOWS is factored into pure static helpers and is
 * exercised here deterministically:
 *   • buildTimeFilter   — maps a time range to the correct created_at fragment
 *   • num               — robust numeric coercion of string/NULL DB values
 *   • rate              — safe percentage (0–100, one decimal, no divide-by-zero)
 *   • clampDays         — trend window clamped to [1, 365]
 *   • clampLimit        — top-N clamped to [1, 100]
 *
 * Run with: npx tsx tests/unit/healing-analytics-service.test.ts
 */

import { HealingAnalyticsService } from '../../src/services/healing-analytics-service';

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
/*  buildTimeFilter                                                    */
/* ------------------------------------------------------------------ */

function testBuildTimeFilter() {
  console.log('\nbuildTimeFilter:');
  assert(HealingAnalyticsService.buildTimeFilter('today').includes('CURRENT_DATE'), "today → CURRENT_DATE bound");
  assert(HealingAnalyticsService.buildTimeFilter('week').includes("INTERVAL '7 days'"), 'week → 7 day interval');
  assert(HealingAnalyticsService.buildTimeFilter('month').includes("INTERVAL '30 days'"), 'month → 30 day interval');
  assertEqual(HealingAnalyticsService.buildTimeFilter('all'), '', 'all → no time bound');
  assertEqual(HealingAnalyticsService.buildTimeFilter('garbage' as any), '', 'unknown → no time bound (safe default)');
  // Uses the real column name, never the spec's non-existent applied_at.
  assert(HealingAnalyticsService.buildTimeFilter('today').includes('created_at'), 'uses created_at (real column)');
  assert(!HealingAnalyticsService.buildTimeFilter('week').includes('applied_at'), 'never references applied_at');
}

/* ------------------------------------------------------------------ */
/*  num                                                                */
/* ------------------------------------------------------------------ */

function testNum() {
  console.log('\nnum (numeric coercion):');
  assertEqual(HealingAnalyticsService.num(42), 42, 'number passes through');
  assertEqual(HealingAnalyticsService.num('42'), 42, 'numeric string parses');
  assertEqual(HealingAnalyticsService.num('85.5'), 85.5, 'decimal string parses');
  assertEqual(HealingAnalyticsService.num(null), 0, 'null → 0');
  assertEqual(HealingAnalyticsService.num(undefined), 0, 'undefined → 0');
  assertEqual(HealingAnalyticsService.num('not-a-number'), 0, 'garbage → 0');
  assertEqual(HealingAnalyticsService.num(NaN), 0, 'NaN → 0');
}

/* ------------------------------------------------------------------ */
/*  rate                                                               */
/* ------------------------------------------------------------------ */

function testRate() {
  console.log('\nrate (safe percentage):');
  assertEqual(HealingAnalyticsService.rate(50, 100), 50, '50/100 → 50');
  assertEqual(HealingAnalyticsService.rate(1, 3), 33.3, '1/3 → 33.3 (one decimal)');
  assertEqual(HealingAnalyticsService.rate(2, 3), 66.7, '2/3 → 66.7 (rounded)');
  assertEqual(HealingAnalyticsService.rate(0, 0), 0, '0/0 → 0 (no divide-by-zero)');
  assertEqual(HealingAnalyticsService.rate(5, 0), 0, 'n/0 → 0');
  assertEqual(HealingAnalyticsService.rate(7, 7), 100, '7/7 → 100');
}

/* ------------------------------------------------------------------ */
/*  clampDays / clampLimit                                             */
/* ------------------------------------------------------------------ */

function testClamps() {
  console.log('\nclampDays / clampLimit:');
  assertEqual(HealingAnalyticsService.clampDays(30), 30, 'days 30 → 30');
  assertEqual(HealingAnalyticsService.clampDays(0), 1, 'days 0 → 1 (floor)');
  assertEqual(HealingAnalyticsService.clampDays(-5), 1, 'days -5 → 1');
  assertEqual(HealingAnalyticsService.clampDays(1000), 365, 'days 1000 → 365 (cap)');
  assertEqual(HealingAnalyticsService.clampDays(7.9), 7, 'days 7.9 → 7 (floored)');

  assertEqual(HealingAnalyticsService.clampLimit(10), 10, 'limit 10 → 10');
  assertEqual(HealingAnalyticsService.clampLimit(0), 1, 'limit 0 → 1');
  assertEqual(HealingAnalyticsService.clampLimit(500), 100, 'limit 500 → 100 (cap)');
}

/* ------------------------------------------------------------------ */
/*  Run                                                                */
/* ------------------------------------------------------------------ */
testBuildTimeFilter();
testNum();
testRate();
testClamps();

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
