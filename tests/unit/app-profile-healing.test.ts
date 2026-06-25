/**
 * Unit tests — Application-Profile Healing Bridge
 * ===============================================
 * Proves the gap both audits flagged is closed: the crawled Application Profile
 * now feeds the healer, and the SauceDemo login failure heals deterministically
 * from the crawl ([data-test="login-button"]) with ZERO AI tokens.
 *
 * Run: npx tsx tests/unit/app-profile-healing.test.ts
 */

import assert from 'node:assert';
import {
  deriveElementDescription,
  collectElements,
  bestElementMatch,
  buildGroundedCandidates,
} from '../../src/services/app-profile-healing';
import { HealingOrchestrator } from '../../src/core/healing-orchestrator';
import type { FailureDetails } from '../../src/core/failure-analyzer';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: any) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}`, extra ?? ''); }
}

/* ---- 1. deriveElementDescription ---- */
console.log('deriveElementDescription:');
check('getByRole button name → "log in button"',
  deriveElementDescription({ failedLocator: "page.getByRole('button', { name: 'Log in' })" }) === 'log in button');
check('getByTestId humanised',
  deriveElementDescription({ failedLocator: "page.getByTestId('login-button')" }) === 'login button');
check('getByLabel → "username"',
  deriveElementDescription({ failedLocator: "page.getByLabel('Username')" }) === 'username');
check('getByPlaceholder → "password"',
  deriveElementDescription({ failedLocator: "page.getByPlaceholder('Password')" }) === 'password');
check('data-test attr humanised',
  deriveElementDescription({ failedLocator: `page.locator('[data-test="login-button"]')` }) === 'login button');
check('css id humanised',
  deriveElementDescription({ failedLocator: "page.locator('#user-name')" }) === 'user name');
check('falls back to failedLineCode when locator empty',
  deriveElementDescription({ failedLocator: '', failedLineCode: "await page.getByRole('button', { name: 'Login' }).click();" }) === 'login button');

/* ---- 2. collectElements + matching (SauceDemo-style crawl) ---- */
console.log('crawl matching:');
const crawl = {
  elements: [
    { tag: 'input', type: 'text', id: 'user-name', name: 'user-name', placeholder: 'Username', attributes: { 'data-test': 'username' } },
    { tag: 'input', type: 'password', id: 'password', name: 'password', placeholder: 'Password', attributes: { 'data-test': 'password' } },
    { tag: 'input', type: 'submit', id: 'login-button', name: 'login-button', textContent: 'Login', attributes: { 'data-test': 'login-button', value: 'Login' } },
    { tag: 'a', textContent: 'About', href: '/about', attributes: {} },
  ],
};
const els = collectElements(crawl);
check('collectElements flattens crawl', els.length === 4, els.length);

const match = bestElementMatch(els, 'log in button');
check('matches the login submit element', !!match && match.el.attributes['data-test'] === 'login-button', match?.el);

const usernameMatch = bestElementMatch(els, 'username');
check('matches the username field', !!usernameMatch && usernameMatch.el.attributes['data-test'] === 'username', usernameMatch?.el);

/* ---- 3. grounded candidate construction (correct data-test semantics) ---- */
console.log('grounded candidates:');
const cands = buildGroundedCandidates(match!.el, 'log in button');
check('top candidate is the exact data-test attribute selector',
  cands[0].locator === `page.locator('[data-test="login-button"]')`, cands[0]);
check('top candidate confidence high', cands[0].confidence >= 0.9, cands[0]?.confidence);
check('does NOT emit a default-mismatched getByTestId for data-test',
  !cands.some((c) => c.locator.includes('getByTestId')), cands.map((c) => c.locator));
check('offers a role-based alternative for resilience',
  cands.some((c) => c.locator.includes('getByRole')), cands.map((c) => c.locator));
check('every candidate is grounded (validated=true, source app_profile)',
  cands.every((c) => c.validated && c.source === 'app_profile'));

/* ---- 4. orchestrator: heals from App Profile BEFORE any AI ---- */
console.log('orchestrator early-return (App Profile before AI):');
// Engines are never reached on the App-Profile path, so nulls are safe and
// guarantee the test fails loudly if the early return ever regresses.
const orchestrator = new HealingOrchestrator(null as any, null as any, null as any);

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

(async () => {
  const appProfileInput = {
    candidates: buildGroundedCandidates(match!.el, 'log in button'),
    profileFound: true,
    elementsScanned: els.length,
    description: 'log in button',
  };

  const outcome = await orchestrator.heal(
    failure, undefined, undefined, undefined, undefined, undefined, appProfileInput,
  );

  check('selectedEngine is app_profile', outcome.selectedEngine === 'app_profile', outcome.selectedEngine);
  check('healed with the grounded data-test locator',
    outcome.suggestion?.newLocator === `page.locator('[data-test="login-button"]')`, outcome.suggestion?.newLocator);
  check('zero AI tokens used', outcome.suggestion?.tokensUsed === 0, outcome.suggestion?.tokensUsed);
  check('reasoning attributes the source to App Profile',
    !!outcome.suggestion?.reasoning?.includes('[App Profile]'), outcome.suggestion?.reasoning);
  check('strategy surfaced as rule_based (deterministic, non-AI)',
    outcome.suggestion?.strategy === 'rule_based', outcome.suggestion?.strategy);

  // Empty App Profile must NOT short-circuit the pipeline.
  const emptyOutcome = await orchestrator.heal(
    failure, undefined, undefined, undefined, undefined, undefined,
    { candidates: [], profileFound: false, elementsScanned: 0, description: '' },
  ).catch(() => ({ selectedEngine: 'threw-as-expected-without-engines' } as any));
  check('no App-Profile candidates → does not return app_profile',
    emptyOutcome.selectedEngine !== 'app_profile', emptyOutcome.selectedEngine);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
