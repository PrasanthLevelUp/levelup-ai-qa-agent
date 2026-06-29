/**
 * Regression test: semantic dedup must be SCENARIO-AWARE.
 *
 * Bug: dedup removed near-duplicate cases globally, with no awareness of which
 * scenario each case belonged to. When two scenarios each had a single,
 * near-identical case (e.g. "login with leading whitespace" vs "…trailing
 * whitespace"), dedup deleted one — orphaning its scenario ("No test cases
 * linked") and making the total case count drop BELOW the scenario count.
 *
 * Fix: never remove the last surviving case of a scenario. True within-scenario
 * duplicates are still removed.
 *
 * No network: openai.embeddings.create is stubbed with controlled vectors.
 *
 * Run with: npx tsx tests/unit/dedup-scenario-aware.test.ts
 */

process.env.OPENAI_API_KEY = 'test-key-for-unit-tests';

import { TestCoverageEngine, type TestCase } from '../../src/engines/test-coverage-engine';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function tc(title: string, scenarioIndex: number, priority = 'P1'): TestCase {
  return {
    title,
    preconditions: '',
    steps: ['step'],
    expectedResult: `expected for ${title}`,
    testData: '',
    priority,
    severity: 'major',
    tags: [],
    automationReady: true,
    automationComplexity: 'medium',
    selectorAvailability: 'unknown',
    scenarioIndex,
  } as any;
}

(async () => {
  console.log('\nScenario-aware semantic dedup');

  const engine = new TestCoverageEngine();

  // Four cases:
  //   A (scenario 0) and B (scenario 1) are IDENTICAL embeddings but each is the
  //     only case of its scenario → BOTH must survive (protected).
  //   C and D (both scenario 2) are IDENTICAL embeddings → one is a true
  //     within-scenario duplicate and should be removed (scenario 2 keeps one).
  const cases = [
    tc('Locked login with leading whitespace', 0),
    tc('Locked login with trailing whitespace', 1),
    tc('Rapid login attempt', 2),
    tc('Rapid login attempt (dup)', 2),
  ];

  // Controlled vectors, returned in input order:
  //   index 0,1 → [1,0,0]  (A == B)
  //   index 2,3 → [0,1,0]  (C == D)
  const vectorByText: Record<string, number[]> = {};
  cases.forEach((c, i) => {
    const sig = `${c.title}. ${c.expectedResult}`.trim().slice(0, 500);
    vectorByText[sig] = i < 2 ? [1, 0, 0] : [0, 1, 0];
  });

  (engine as any).openai = {
    embeddings: {
      create: async ({ input }: { input: string[] }) => ({
        data: input.map((t: string) => ({ embedding: vectorByText[t] || [0, 0, 1] })),
      }),
    },
  };

  const { kept, removed } = await engine.deduplicateTestCases(cases, 0.9);

  const keptScenarios = new Set(kept.map(k => (k as any).scenarioIndex));

  check('removes exactly one (the true within-scenario duplicate)', removed === 1, `removed=${removed}`);
  check('kept count is 3', kept.length === 3, `kept=${kept.length}`);
  check('scenario 0 still has a case (not orphaned)', keptScenarios.has(0));
  check('scenario 1 still has a case (not orphaned)', keptScenarios.has(1));
  check('scenario 2 still has a case', keptScenarios.has(2));
  check('every scenario retains >= 1 case (no orphans)', keptScenarios.size === 3, `scenarios kept=${keptScenarios.size}`);
  check('total cases (3) >= scenario count (3)', kept.length >= keptScenarios.size);

  console.log('\n' + '='.repeat(60));
  console.log(`\nResults: ${passed}/${passed + failed} checks passed`);
  if (failed > 0) { console.log(`\n❌ ${failed} check(s) failed\n`); process.exit(1); }
  console.log('\n✅ All checks passed!\n'); process.exit(0);
})().catch(err => { console.error('Test runner error:', err); process.exit(1); });
