/**
 * SCENARIO INTEGRITY VALIDATOR — deterministic checks
 * ====================================================
 * Eight pure functions, each answering one narrow "is this internally
 * consistent?" question via keyword/lexicon/structure analysis. No LLM, no
 * network, no mutation. Each returns an `IntegrityCheckResult`.
 *
 * A check that cannot find enough signal to judge returns `passed: true` with
 * a full score — the validator is permissive by design (never blocks, never
 * invents problems). It only warns when it finds a CLEAR inconsistency.
 */
import type {
  IntegrityCheckResult,
  ScenarioForIntegrity,
} from './types';
import { validateExpectedResult } from '../expected-result-validator';

// ---------------------------------------------------------------------------
// Lexicons (deterministic keyword sets)
// ---------------------------------------------------------------------------

/** Tokens that signal a NEGATIVE / failure-path intent. */
const NEGATIVE_TOKENS = [
  'invalid',
  'incorrect',
  'wrong',
  'locked',
  'denied',
  'unauthorized',
  'unauthorised',
  'expired',
  'blocked',
  'failed',
  'failure',
  'reject',
  'rejected',
  'error',
  'disabled',
  'forbidden',
  'malformed',
  'empty',
  'missing',
  'unavailable',
  'timeout',
  'timed out',
];

/** Tokens that signal a POSITIVE / happy-path intent. */
const POSITIVE_TOKENS = [
  'success',
  'successful',
  'successfully',
  'valid',
  'correct',
  'granted',
  'allowed',
  'accepted',
  'confirmed',
  'complete',
  'completed',
  'redirected to dashboard',
  'welcome',
];

/** Actions that only make sense for an authenticated user. */
const AUTH_REQUIRING_TOKENS = [
  'checkout',
  'cart',
  'account',
  'profile',
  'dashboard',
  'order',
  'payment',
  'my orders',
  'wishlist',
  'saved address',
  'log out',
  'logout',
  'sign out',
];

/** Tokens that indicate the preconditions already establish a session. */
const AUTH_ESTABLISHED_TOKENS = [
  'logged in',
  'logged-in',
  'log in',
  'signed in',
  'signed-in',
  'authenticated',
  'valid session',
  'active session',
  'existing session',
  'user session',
  'account exists',
  'registered user',
];

/** Actionable step verbs — steps that a script would drive. */
const ACTIONABLE_STEP_TOKENS = [
  'enter',
  'type',
  'input',
  'fill',
  'click',
  'tap',
  'press',
  'select',
  'choose',
  'submit',
  'upload',
  'check',
  'toggle',
  'search',
];

/** Steps that provide input (needed before a submit is meaningful). */
const INPUT_STEP_TOKENS = ['enter', 'type', 'input', 'fill', 'select', 'choose', 'upload'];

/** Steps that finalize/submit a form. */
const SUBMIT_STEP_TOKENS = ['submit', 'save', 'continue', 'place order', 'pay', 'sign in', 'log in', 'register', 'create account'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lc(s: string | undefined | null): string {
  return (s ?? '').toLowerCase();
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Word-boundary token match. Prevents false positives from substrings — e.g.
 * "valid" must NOT match inside "invalid". Multi-word tokens (e.g. "timed out")
 * are matched as phrases with boundaries on each end.
 */
function tokenPresent(haystack: string, needle: string): boolean {
  return new RegExp(`\\b${escapeRe(needle)}\\b`).test(haystack);
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => tokenPresent(haystack, n));
}

function matchedTokens(haystack: string, needles: string[]): string[] {
  return needles.filter((n) => tokenPresent(haystack, n));
}

/** Coverage types whose INTENT is a negative / failure path. */
function isNegativeCoverage(coverageType: string): boolean {
  const c = lc(coverageType);
  return (
    c.includes('negative') ||
    c.includes('security') ||
    c.includes('boundary') ||
    c.includes('edge')
  );
}

/** Coverage types whose INTENT is a positive / happy path. */
function isPositiveCoverage(coverageType: string): boolean {
  const c = lc(coverageType);
  return c === 'positive' || c.includes('happy') || c.includes('smoke');
}

function result(
  partial: Omit<IntegrityCheckResult, 'passed'> & { passed?: boolean }
): IntegrityCheckResult {
  return {
    passed: partial.messages.length === 0,
    ...partial,
  } as IntegrityCheckResult;
}

// ---------------------------------------------------------------------------
// 1. Persona consistency
//    Does the title's intent (positive/negative) agree with the test data and
//    the expected result? e.g. "Successful login" but testData = "invalid
//    password" and expected = "error shown" is an internal contradiction.
// ---------------------------------------------------------------------------

export function checkPersonaConsistency(s: ScenarioForIntegrity): IntegrityCheckResult {
  const label = 'Persona consistency';
  const weight = 5;
  const titleText = `${lc(s.title)} ${lc(s.objective)}`;
  const dataText = `${lc(s.testData)}`;
  const expectedText = `${lc(s.expected?.observable)} ${lc(s.expectedResult)}`;

  const titleNeg = containsAny(titleText, NEGATIVE_TOKENS);
  const titlePos = containsAny(titleText, POSITIVE_TOKENS);

  const messages: string[] = [];

  // Only judge when the title has a CLEAR polarity.
  if (titlePos && !titleNeg) {
    if (containsAny(dataText, NEGATIVE_TOKENS)) {
      messages.push(
        `Title/objective reads as a positive (happy-path) scenario but test data looks negative ("${matchedTokens(dataText, NEGATIVE_TOKENS).join('", "')}").`
      );
    }
    if (containsAny(expectedText, NEGATIVE_TOKENS) && !containsAny(expectedText, POSITIVE_TOKENS)) {
      messages.push(
        `Title/objective reads as positive but the expected result describes a failure ("${matchedTokens(expectedText, NEGATIVE_TOKENS).join('", "')}").`
      );
    }
  } else if (titleNeg && !titlePos) {
    if (containsAny(expectedText, POSITIVE_TOKENS) && !containsAny(expectedText, NEGATIVE_TOKENS)) {
      messages.push(
        `Title/objective reads as a negative (failure-path) scenario but the expected result describes success ("${matchedTokens(expectedText, POSITIVE_TOKENS).join('", "')}").`
      );
    }
  }

  return result({ id: 'persona_consistency', label, weight, score: messages.length ? 0 : 1, messages });
}

// ---------------------------------------------------------------------------
// 2. Coverage polarity
//    Does the expected result's polarity match the coverage type's intent?
//    e.g. coverageType "negative" but expected observable describes success.
// ---------------------------------------------------------------------------

export function checkCoveragePolarity(s: ScenarioForIntegrity): IntegrityCheckResult {
  const label = 'Coverage polarity';
  const weight = 4;
  const coverage = lc(s.coverageType);
  const expectedText = `${lc(s.expected?.observable)} ${lc(s.expectedResult)}`;
  const messages: string[] = [];

  if (!coverage || !expectedText.trim()) {
    return result({ id: 'coverage_polarity', label, weight, score: 1, messages });
  }

  const expNeg = containsAny(expectedText, NEGATIVE_TOKENS);
  const expPos = containsAny(expectedText, POSITIVE_TOKENS);

  if (isNegativeCoverage(coverage) && expPos && !expNeg) {
    messages.push(
      `Coverage type "${s.coverageType}" implies a failure path, but the expected result describes success.`
    );
  } else if (isPositiveCoverage(coverage) && expNeg && !expPos) {
    messages.push(
      `Coverage type "${s.coverageType}" implies a happy path, but the expected result describes a failure.`
    );
  }

  return result({ id: 'coverage_polarity', label, weight, score: messages.length ? 0 : 1, messages });
}

// ---------------------------------------------------------------------------
// 3. Test data suitability
//    Does the test data's polarity fit the coverage type? A positive coverage
//    with negative-looking test data (or vice versa) is suspicious.
// ---------------------------------------------------------------------------

export function checkTestDataSuitability(s: ScenarioForIntegrity): IntegrityCheckResult {
  const label = 'Test data suitability';
  const weight = 3;
  const coverage = lc(s.coverageType);
  const dataText = lc(s.testData);
  const messages: string[] = [];

  if (!coverage || !dataText.trim()) {
    return result({ id: 'test_data_suitability', label, weight, score: 1, messages });
  }

  const dataNeg = containsAny(dataText, NEGATIVE_TOKENS);
  const dataPos = containsAny(dataText, POSITIVE_TOKENS);

  if (isPositiveCoverage(coverage) && dataNeg && !dataPos) {
    messages.push(
      `Positive coverage but test data looks negative ("${matchedTokens(dataText, NEGATIVE_TOKENS).join('", "')}") — confirm this is intended.`
    );
  } else if (isNegativeCoverage(coverage) && dataPos && !dataNeg) {
    messages.push(
      `Failure-path coverage but test data looks like clean/valid input — a negative case usually needs invalid or boundary data.`
    );
  }

  return result({ id: 'test_data_suitability', label, weight, score: messages.length ? 0 : 1, messages });
}

// ---------------------------------------------------------------------------
// 4. Expected result consistency
//    Is there an expected result at all, and does the observable projection
//    agree with the objective's polarity? (Complements persona/coverage with a
//    presence check.)
// ---------------------------------------------------------------------------

export function checkExpectedResultConsistency(s: ScenarioForIntegrity): IntegrityCheckResult {
  const label = 'Expected result consistency';
  const weight = 4;
  const observable = lc(s.expected?.observable) || lc(s.expectedResult);
  const messages: string[] = [];

  if (!observable.trim()) {
    messages.push('No observable expected result is defined — a reviewer cannot tell what proves the scenario.');
    return result({ id: 'expected_result_consistency', label, weight, score: 0, messages });
  }

  const objective = lc(s.objective);
  if (objective.trim()) {
    const objNeg = containsAny(objective, NEGATIVE_TOKENS);
    const objPos = containsAny(objective, POSITIVE_TOKENS);
    const obsNeg = containsAny(observable, NEGATIVE_TOKENS);
    const obsPos = containsAny(observable, POSITIVE_TOKENS);
    if (objPos && !objNeg && obsNeg && !obsPos) {
      messages.push('Objective is positive but the observable expected result describes a failure.');
    } else if (objNeg && !objPos && obsPos && !obsNeg) {
      messages.push('Objective is negative but the observable expected result describes success.');
    }
  }

  return result({ id: 'expected_result_consistency', label, weight, score: messages.length ? 0.5 : 1, messages });
}

// ---------------------------------------------------------------------------
// 5. Step completeness
//    Are the steps non-empty, and if the flow submits/finalizes, is there an
//    input step before it? A "click Submit" with no preceding input is
//    structurally incomplete for a form flow.
// ---------------------------------------------------------------------------

export function checkStepCompleteness(s: ScenarioForIntegrity): IntegrityCheckResult {
  const label = 'Step completeness';
  const weight = 4;
  const steps = (s.steps ?? []).map(lc).filter((x) => x.trim());
  const messages: string[] = [];

  if (steps.length === 0) {
    messages.push('Scenario has no steps.');
    return result({ id: 'step_completeness', label, weight, score: 0, messages });
  }

  const submitIdx = steps.findIndex((st) => containsAny(st, SUBMIT_STEP_TOKENS));
  if (submitIdx >= 0) {
    const hasInputBefore = steps
      .slice(0, submitIdx)
      .some((st) => containsAny(st, INPUT_STEP_TOKENS));
    // Only warn for form-like submits (sign in / register / place order etc.)
    const submitStep = steps[submitIdx];
    const formLike = containsAny(submitStep, ['sign in', 'log in', 'register', 'create account', 'place order', 'submit', 'save']);
    if (formLike && !hasInputBefore) {
      messages.push(
        'A submit/finalize step appears without any preceding input step — a form flow usually needs data entered first.'
      );
    }
  }

  return result({ id: 'step_completeness', label, weight, score: messages.length ? 0.5 : 1, messages });
}

// ---------------------------------------------------------------------------
// 6. Preconditions
//    If the steps perform an auth-requiring action (checkout, view account…)
//    do the preconditions establish a session? Missing setup is a common,
//    silent flakiness source.
// ---------------------------------------------------------------------------

export function checkPreconditions(s: ScenarioForIntegrity): IntegrityCheckResult {
  const label = 'Preconditions';
  const weight = 3;
  const steps = (s.steps ?? []).map(lc);
  const stepsText = steps.join(' ');
  const pre = lc(s.preconditions);
  const messages: string[] = [];

  const needsAuth = containsAny(stepsText, AUTH_REQUIRING_TOKENS);
  // If the flow itself logs in, the session is established within the steps.
  const logsInWithinSteps = containsAny(stepsText, ['log in', 'sign in', 'login', 'authenticate']);
  const authEstablished = containsAny(pre, AUTH_ESTABLISHED_TOKENS) || logsInWithinSteps;

  if (needsAuth && !authEstablished) {
    messages.push(
      `Steps require an authenticated user (${matchedTokens(stepsText, AUTH_REQUIRING_TOKENS).join(', ')}) but preconditions do not establish a logged-in session.`
    );
  }

  return result({ id: 'preconditions', label, weight, score: messages.length ? 0.5 : 1, messages });
}

// ---------------------------------------------------------------------------
// 7. Business flow consistency  ⭐⭐⭐⭐⭐
//    Deterministic state-progression check. Maps steps to stage ranks and flags
//    ONLY clearly-impossible orderings. Intentionally conservative — it never
//    guesses; it only fires on physically impossible sequences.
// ---------------------------------------------------------------------------

/** Ordered stage lexicon. Rank encodes natural e-commerce/session progression. */
const STAGE_PATTERNS: Array<{ rank: number; name: string; tokens: string[] }> = [
  { rank: 0, name: 'open/landing', tokens: ['open the', 'navigate to', 'go to home', 'landing page', 'open app', 'launch'] },
  { rank: 1, name: 'login', tokens: ['log in', 'sign in', 'login', 'authenticate'] },
  { rank: 2, name: 'browse', tokens: ['browse', 'search for', 'view product', 'open product', 'product page', 'catalog', 'category'] },
  { rank: 3, name: 'add-to-cart', tokens: ['add to cart', 'add to basket', 'add item'] },
  { rank: 4, name: 'cart', tokens: ['view cart', 'open cart', 'go to cart', 'basket'] },
  { rank: 5, name: 'checkout', tokens: ['checkout', 'check out', 'proceed to pay', 'shipping details', 'billing details'] },
  { rank: 6, name: 'payment', tokens: ['payment', 'enter card', 'pay now', 'place order', 'complete purchase'] },
  { rank: 7, name: 'confirmation', tokens: ['confirmation', 'order confirmed', 'order placed', 'thank you page', 'receipt'] },
  { rank: 8, name: 'logout', tokens: ['log out', 'logout', 'sign out'] },
];

interface StageHit {
  index: number;
  rank: number;
  name: string;
}

export function checkBusinessFlow(s: ScenarioForIntegrity): IntegrityCheckResult {
  const label = 'Business flow consistency';
  const weight = 5;
  const steps = (s.steps ?? []).map(lc);
  const messages: string[] = [];

  if (steps.length < 2) {
    return result({ id: 'business_flow', label, weight, score: 1, messages });
  }

  const hits: StageHit[] = [];
  steps.forEach((st, index) => {
    for (const stage of STAGE_PATTERNS) {
      if (containsAny(st, stage.tokens)) {
        hits.push({ index, rank: stage.rank, name: stage.name });
        break; // first (lowest-rank) matching stage wins per step
      }
    }
  });

  const has = (rank: number) => hits.some((h) => h.rank === rank);
  const firstIndexOf = (rank: number) => {
    const h = hits.find((x) => x.rank === rank);
    return h ? h.index : -1;
  };

  // Rule A: logout followed by an in-session activity (browse..confirmation).
  const logout = hits.find((h) => h.rank === 8);
  if (logout) {
    const afterLogout = hits.find((h) => h.index > logout.index && h.rank >= 2 && h.rank <= 7);
    if (afterLogout) {
      messages.push(
        `Impossible flow: "${afterLogout.name}" happens after logout (a logged-out user cannot ${afterLogout.name}).`
      );
    }
  }

  // Rule B: checkout or payment present with no prior add-to-cart.
  const addIdx = firstIndexOf(3);
  const checkoutIdx = firstIndexOf(5);
  const paymentIdx = firstIndexOf(6);
  if ((checkoutIdx >= 0 || paymentIdx >= 0) && addIdx === -1) {
    messages.push(
      'Impossible flow: checkout/payment occurs but nothing was ever added to the cart.'
    );
  } else if (addIdx >= 0) {
    if (checkoutIdx >= 0 && checkoutIdx < addIdx) {
      messages.push('Impossible flow: checkout happens before any item is added to the cart.');
    }
    if (paymentIdx >= 0 && paymentIdx < addIdx) {
      messages.push('Impossible flow: payment happens before any item is added to the cart.');
    }
  }

  // Rule C: payment before checkout.
  if (checkoutIdx >= 0 && paymentIdx >= 0 && paymentIdx < checkoutIdx) {
    messages.push('Impossible flow: payment occurs before checkout.');
  }

  // Rule D: confirmation/payment followed by a fresh login (order then log in).
  const confirmIdx = firstIndexOf(7);
  const loginIdx = firstIndexOf(1);
  if (loginIdx >= 0) {
    if (confirmIdx >= 0 && loginIdx > confirmIdx) {
      messages.push('Impossible flow: a login step appears after the order was already confirmed.');
    } else if (paymentIdx >= 0 && loginIdx > paymentIdx && !has(8)) {
      messages.push('Impossible flow: a login step appears after payment was completed.');
    }
  }

  return result({ id: 'business_flow', label, weight, score: messages.length ? 0 : 1, messages });
}

// ---------------------------------------------------------------------------
// 8. Grounding completeness (LOW weight — score penalty, not a hard warn)
//    What fraction of actionable steps carry a selector-bearing grounding entry?
//    Low grounding lowers the readiness score but is NEVER a block (many valid
//    scenarios are drafted before selectors are resolved).
// ---------------------------------------------------------------------------

export function checkGroundingCompleteness(s: ScenarioForIntegrity): IntegrityCheckResult {
  const label = 'Grounding completeness';
  const weight = 2;
  const steps = s.steps ?? [];
  const grounding = s.grounding ?? [];
  const messages: string[] = [];

  const actionableIdx: number[] = [];
  steps.forEach((st, i) => {
    if (containsAny(lc(st), ACTIONABLE_STEP_TOKENS)) actionableIdx.push(i + 1); // 1-based
  });

  if (actionableIdx.length === 0) {
    return result({ id: 'grounding_completeness', label, weight, score: 1, messages });
  }

  const groundedSteps = new Set(
    grounding.filter((g) => g && g.selector && g.selector.trim()).map((g) => g.stepIndex)
  );
  const covered = actionableIdx.filter((idx) => groundedSteps.has(idx)).length;
  const fraction = covered / actionableIdx.length;

  // Informational message only when grounding is notably incomplete.
  if (fraction < 0.5) {
    messages.push(
      `Only ${covered}/${actionableIdx.length} actionable steps have a resolved selector — the Script Composer may need to discover locators for the rest.`
    );
  }

  // Score reflects coverage fraction (never zero-blocks; low weight).
  return {
    id: 'grounding_completeness',
    label,
    weight,
    score: fraction,
    passed: fraction >= 0.5,
    messages,
  };
}

// ---------------------------------------------------------------------------
// 9. Field validity (Scenario ↔ Fields — the deterministic Step Validator)
//    Every field a step references must EXIST for this feature. When the
//    caller supplies the feature's real field set (`applicationFields`), any
//    step that enters data into a field NOT in that set is a hallucinated
//    field — e.g. "Enter … in the Username field" on an Add Employee feature
//    whose only fields are First Name / Last Name / Employee ID. This is the
//    check that catches login-form leakage and, more generally, any field an
//    LLM invented that does not belong to the feature under test.
//
//    Deterministic and fail-open: with no field set to compare against (an
//    ungrounded skeleton, or an older case), there is nothing to judge → pass.
// ---------------------------------------------------------------------------

// Field references are emitted by the builder as "… in the <Label> field". The
// capture EXCLUDES parentheses so a data phrase that itself contains "in the …"
// inside a parenthetical (e.g. "(a duplicate of a record already in the system)")
// cannot be mis-read as a field name — the regex then correctly locks onto the
// real trailing "in the <Label> field". Labels are short field names, never
// prose, so excluding "()" costs us nothing and removes a whole class of
// false positives.
const FIELD_REF_RE = /\bin the ([^()]+?) field\b/gi;

/** Normalise a field label for comparison (lowercase, collapse whitespace). */
function normField(s: string): string {
  return lc(s).replace(/\s+/g, ' ').trim();
}

export function checkFieldValidity(s: ScenarioForIntegrity): IntegrityCheckResult {
  const label = 'Field validity';
  const weight = 5; // High weight: a wrong field is a correctness (trust) defect.
  const messages: string[] = [];

  const known = (s.applicationFields ?? []).map(normField).filter(Boolean);
  const steps = s.steps ?? [];

  // Nothing to compare against ⇒ cannot judge ⇒ pass (never a false alarm).
  if (known.length === 0 || steps.length === 0) {
    return result({ id: 'field_validity', label, weight, score: 1, messages });
  }

  const knownSet = new Set(known);
  const foreign = new Set<string>();
  for (const step of steps) {
    let m: RegExpExecArray | null;
    FIELD_REF_RE.lastIndex = 0;
    while ((m = FIELD_REF_RE.exec(step)) !== null) {
      const ref = normField(m[1]);
      // Ignore the generic fallback label the builder emits when a field has no
      // name/label — it is not a claim about a specific real field.
      if (!ref || ref === 'field') continue;
      if (!knownSet.has(ref)) foreign.add(m[1].trim());
    }
  }

  if (foreign.size > 0) {
    messages.push(
      `Steps reference field(s) that do NOT exist for this feature: "${Array.from(foreign).join('", "')}". ` +
        `The feature's real fields are: ${known.join(', ')}. This case must be regenerated or marked Needs Review — it is not automation-ready.`,
    );
  }

  return result({ id: 'field_validity', label, weight, score: foreign.size > 0 ? 0 : 1, messages });
}

// ---------------------------------------------------------------------------
// 10. Expected-result provability
//     Sprint "Expected Result Excellence" (Part 2). Every assertion in the
//     Expected Result must be PROVABLE by a black-box QA engineer: Observable
//     (a tester can SEE it), Grounded (derivable from requirement/planner/
//     profile — no invented side-effects), and Black-box verifiable (no server-
//     side/database/transaction internals). This catches the "rich, but not
//     provable" defect deterministically. Delegates to the Expected Result
//     Validator; the grounding corpus here is the scenario view we have (title,
//     objective, real field labels).
// ---------------------------------------------------------------------------
export function checkExpectedResultProvable(s: ScenarioForIntegrity): IntegrityCheckResult {
  const label = 'Expected result provable';
  const weight = 4; // A non-provable expected result cannot be executed as-is.
  const messages: string[] = [];

  const assertions = s.expected?.assertions ?? [];
  // No assertion list to judge (e.g. a hand-built or legacy expected) ⇒ cannot
  // judge ⇒ pass. The check only fires on the structured assertion list.
  if (assertions.length === 0) {
    return result({ id: 'expected_result_provable', label, weight, score: 1, messages });
  }

  const scenarioText = `${s.title ?? ''} ${s.objective ?? ''}`;
  const profileText = (s.applicationFields ?? []).join(' ');
  const verdict = validateExpectedResult(assertions, { scenarioText, profileText });

  if (!verdict.passed) {
    for (const v of verdict.violations) messages.push(v);
  }

  return result({
    id: 'expected_result_provable',
    label,
    weight,
    score: verdict.passed ? 1 : 0,
    messages,
  });
}

/** All checks, in report order. */
export const ALL_CHECKS = [
  checkPersonaConsistency,
  checkCoveragePolarity,
  checkTestDataSuitability,
  checkExpectedResultConsistency,
  checkStepCompleteness,
  checkPreconditions,
  checkBusinessFlow,
  checkGroundingCompleteness,
  checkFieldValidity,
  checkExpectedResultProvable,
];
