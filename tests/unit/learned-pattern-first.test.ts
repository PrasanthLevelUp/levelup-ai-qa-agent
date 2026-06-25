/**
 * Learning-first healing — verifies the Learning Engine (Step 0) outranks every
 * other layer.
 *
 * Roadmap adjustment: "if you've already healed the same issue once, nothing is
 * more reliable than your own successful history. Learning should always
 * outrank AI." This test pins that ordering:
 *   1. A learned pattern short-circuits BEFORE App Profile (and before AI).
 *   2. No learned pattern → the pipeline falls through to App Profile.
 *   3. A learned-pattern lookup that throws is non-critical (never blocks).
 *
 * Run: npx tsx tests/unit/learned-pattern-first.test.ts
 */
import { HealingOrchestrator } from '../../src/core/healing-orchestrator';
import type { FailureDetails } from '../../src/core/failure-analyzer';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} — got: ${JSON.stringify(got)}`);
  }
}

const failure: FailureDetails = {
  testName: 'login test',
  failureType: 'locator',
  failedLocator: "page.getByRole('button', { name: 'Log in' })",
  errorMessage: 'locator resolved to 0 elements',
  errorPattern: 'strict mode violation',
  filePath: '/tmp/login.spec.ts',
  lineNumber: 12,
  failedLineCode: "await page.getByRole('button', { name: 'Log in' }).click();",
  surroundingCode: '',
  screenshotPath: null,
  url: 'https://www.saucedemo.com/',
  timestamp: new Date().toISOString(),
  isTimingIssue: false,
};

// A grounded App Profile candidate that WOULD heal — used to prove the learned
// pattern wins even when App Profile also has an answer.
const appProfileInput = {
  candidates: [
    {
      locator: `page.locator('[data-test="login-button"]')`,
      confidence: 0.96,
      source: 'app_profile' as const,
      reasoning: 'data-test hook from crawl',
      validated: true,
    },
  ],
  profileFound: true,
  elementsScanned: 5,
  description: 'log in button',
};

// Stub PatternEngine: returns a learned pattern on demand.
function makePatternEngine(behaviour: 'hit' | 'miss' | 'throw') {
  return {
    async findMatch() {
      if (behaviour === 'throw') throw new Error('db down');
      if (behaviour === 'miss') return null;
      return {
        newLocator: `page.getByRole('button', { name: 'Login' })`,
        confidence: 0.92,
        reasoning: 'Matched historical fix (usage_count=7)',
        usageCount: 7,
      };
    },
  } as any;
}

(async () => {
  console.log('Learning-first healing:');

  // 1. Learned pattern present → it wins over App Profile.
  const hitOrch = new HealingOrchestrator(null as any, makePatternEngine('hit'), null as any);
  const hit = await hitOrch.heal(
    failure, undefined, undefined, undefined, undefined, undefined, appProfileInput,
  );
  check('learned pattern wins → selectedEngine is learned_pattern',
    hit.selectedEngine === 'learned_pattern', hit.selectedEngine);
  check('reuses the historical locator (not the App Profile one)',
    hit.suggestion?.newLocator === `page.getByRole('button', { name: 'Login' })`,
    hit.suggestion?.newLocator);
  check('zero AI tokens used', hit.suggestion?.tokensUsed === 0, hit.suggestion?.tokensUsed);
  check('reasoning attributes the source to Learned Pattern',
    !!hit.suggestion?.reasoning?.includes('[Learned Pattern]'), hit.suggestion?.reasoning);
  check('strategy is database_pattern',
    hit.suggestion?.strategy === 'database_pattern', hit.suggestion?.strategy);

  // 2. No learned pattern → falls through to App Profile.
  const missOrch = new HealingOrchestrator(null as any, makePatternEngine('miss'), null as any);
  const miss = await missOrch.heal(
    failure, undefined, undefined, undefined, undefined, undefined, appProfileInput,
  );
  check('no learned pattern → falls through to App Profile',
    miss.selectedEngine === 'app_profile', miss.selectedEngine);

  // 3. Lookup throws → non-critical, still falls through to App Profile.
  const throwOrch = new HealingOrchestrator(null as any, makePatternEngine('throw'), null as any);
  const threw = await throwOrch.heal(
    failure, undefined, undefined, undefined, undefined, undefined, appProfileInput,
  );
  check('learned-pattern error is non-critical → App Profile still heals',
    threw.selectedEngine === 'app_profile', threw.selectedEngine);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
