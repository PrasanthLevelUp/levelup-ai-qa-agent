/**
 * QA Artifact Standard — Deterministic Validator.
 * ============================================================================
 *
 * The QA Artifact Standard (docs/QA_ARTIFACT_STANDARD.md) is the CONTRACT for
 * every test case LevelUp emits. This module is that contract expressed as
 * executable CODE — the machine-checkable subset of the 20 principles — so the
 * standard is enforced AFTER generation instead of being re-taught to the model
 * inside every prompt.
 *
 * Why a validator instead of a bigger prompt:
 *   • No drift — the standard changes in ONE place (here + the MD doc), never in
 *     scattered prompt strings that silently fall out of sync.
 *   • No token tax — the 20 principles are not shipped on every request.
 *   • Guaranteed quality — a violation is DETECTED, not hoped-away. The caller
 *     can repair only what failed, then re-validate.
 *
 * Pipeline position:
 *
 *     … Builder → Canonical Validator (structure) → LLM Formatter (wording)
 *       → QA STANDARD VALIDATOR (this) → [repair failed cases] → Output
 *
 * Design discipline (identical to the planner/builder/canonical-validator):
 *   • Pure & synchronous — no I/O, no LLM, no randomness. Deterministic.
 *   • NON-DESTRUCTIVE — it never drops or rewrites a case. It REPORTS violations
 *     (keyed to the principle) so the caller decides whether to repair; coverage
 *     is never touched.
 *   • App-neutral — checks are generic QA rules (wording shape), never tied to
 *     any application's data or pages.
 *
 * Scope: only the principles a machine can check from wording are enforced here
 * (atomic steps, business language, user actions, observable results, title
 * formula, machine-readable verbs, independence). Principles that require domain
 * judgement (e.g. "is the priority risk-appropriate?") are out of scope by
 * design — the validator asserts what is objectively checkable, nothing it would
 * have to guess.
 */

import type { FormatterTestCase } from './scenario-builder';

/* ------------------------------------------------------------------ */
/*  Report types                                                       */
/* ------------------------------------------------------------------ */

export type QaSeverity = 'error' | 'warn';

/** A single principle violation on one field of one case. */
export interface QaViolation {
  scenarioId: string;
  /** The principle number/name from the QA Artifact Standard (e.g. "P2 one-action-per-step"). */
  principle: string;
  /** Which part of the case violated it. */
  field: 'title' | 'steps' | 'expected' | 'preconditions';
  /** 1-based step index when `field === 'steps'`. */
  stepIndex?: number;
  severity: QaSeverity;
  message: string;
}

/**
 * A REUSABLE validation report — deliberately generic so the SAME object is
 * consumed everywhere the QA Standard is enforced: Test-Case Lab today; Script
 * Gen, Healing, Review, Export and the Dashboard next. Callers read the summary
 * (`passed` / `score` / `principlesSatisfied` / `principlesViolated`) for
 * gating and display, and the detail (`violations` / `byId`) for targeted
 * repair. Never throws; pure data.
 */
export interface ValidationReport {
  /** True when NO error-severity violations remain (the gate). */
  passed: boolean;
  /** 0–100 quality score: % of checked items with zero error-severity violations. */
  score: number;
  /** How many items were validated. */
  checked: number;
  /** Total error-severity violations across all items. */
  errors: number;
  /** Total warning-severity violations across all items. */
  warnings: number;
  /** Principle ids satisfied by EVERY checked item (no violation anywhere). */
  principlesSatisfied: string[];
  /** Principle ids violated by at least one item. */
  principlesViolated: string[];
  /** Every individual violation (detail). */
  violations: QaViolation[];
  /** Violations grouped by scenarioId (for targeted repair). */
  byId: Map<string, QaViolation[]>;
  /** scenarioIds that have at least one violation (any severity). */
  failingIds: string[];
}

/**
 * @deprecated Use {@link ValidationReport}. Kept as a type alias for one release
 * so existing imports keep compiling.
 */
export type QaStandardReport = ValidationReport;

/**
 * The full set of principle ids this validator checks. Used to compute
 * `principlesSatisfied` (this set minus whatever was violated). Kept in ONE
 * place so adding a check updates the satisfied/violated accounting for free.
 */
export const CHECKED_PRINCIPLES: readonly string[] = [
  'P2 one-action-per-step',
  'P3 user-actions-only',
  'P4 verification-not-action',
  'P5 business-language',
  'P6 observable-results',
  'P9 machine-readable',
  'P11 title-formula',
  'P16 independence',
];

/* ------------------------------------------------------------------ */
/*  Lexicons — the standard's wording rules, as data                   */
/* ------------------------------------------------------------------ */

/** Allowed leading action verbs (P9 machine-readable). Lowercase. */
const ALLOWED_STEP_VERBS = new Set([
  'open', 'enter', 'click', 'select', 'verify', 'toggle', 'clear',
  'choose', 'upload', 'switch', 'tab', 'hover', 'scroll', 'refresh',
]);

/** Meta / non-user "verbs" (P3 user-actions-only). These are not tester actions. */
const META_VERBS = ['ensure', 'observe', 'confirm', 'check', 'wait for', 'make sure', 'validate that'];

/** Automation / developer vocabulary (P5 business-language). */
const AUTOMATION_TERMS = [
  'fill ', 'type into', 'trigger', 'press the', 'submit via', 'click element',
  'css', 'xpath', 'selector', 'element id', 'dom ', 'locator', 'assert ',
];

/** Abstract, non-observable expected-result phrases (P6). */
const ABSTRACT_EXPECTED = [
  'login successful', 'successful login', 'logs in successfully',
  'works correctly', 'works as expected', 'behaves correctly', 'behaves as expected',
  'operation completes', 'operation is successful', 'test passes', 'as expected',
  'is successful', 'succeeds', 'works fine', 'no issues', 'functions correctly',
];

/** Cross-test dependency phrasing (P16 independence). */
const DEPENDENCY_PHRASES = [
  /\b(run|execute)\b[^.]{0,30}\b(first|before)\b/i,
  /\bafter (running|executing|completing)\b/i,
  /\bfrom the previous (test|case|step)\b/i,
];

const lc = (s?: string) => (s || '').trim().toLowerCase();

/** The first word of a step (its action verb), lowercased. */
function leadingVerb(step: string): string {
  const m = step.trim().match(/^([a-z]+)/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * Does a step combine more than one action? (P2) Heuristic: it names two or more
 * distinct action verbs joined by "and"/"then"/comma. We only flag when a
 * connective is followed by another recognised action verb, so ordinary prose
 * ("Enter the username and password" DOES flag; "Click the Save and Exit button"
 * — a single control label — does NOT, because "exit" is not an action verb and
 * there is no verb after "and").
 */
function combinesActions(step: string): boolean {
  const s = step.trim();
  // Split on connective words and look for a recognised action verb AFTER one.
  const parts = s.split(/\b(?:and|then)\b|,|;/i);
  if (parts.length < 2) return false;
  let verbClauses = 0;
  for (const part of parts) {
    if (ALLOWED_STEP_VERBS.has(leadingVerb(part))) verbClauses++;
  }
  // Also catch "Enter username and password" — one leading verb, but the
  // connective joins two OBJECTS of an input action → still two data entries.
  if (verbClauses >= 2) return true;
  if (/^enter\b/i.test(s) && /\b(and|,)\b/i.test(s) && /\b(username|password|email|and)\b/i.test(s)) {
    // "Enter username and password" style — two inputs in one step.
    return /\band\b/i.test(s) && /(username|password|email|name|code|number|address)/i.test(s.replace(/^enter\s+/i, ''));
  }
  return false;
}

/** Does a step mix a verification with an action? (P4) */
function mixesVerifyAndAction(step: string): boolean {
  const s = lc(step);
  const hasVerify = /\bverif(y|ies)\b|\bis (displayed|shown|visible|present)\b/.test(s);
  const lead = leadingVerb(step);
  const startsWithAction = ['open', 'enter', 'click', 'select', 'toggle', 'choose', 'upload'].includes(lead);
  return startsWithAction && hasVerify;
}

/* ------------------------------------------------------------------ */
/*  Per-field checks                                                   */
/* ------------------------------------------------------------------ */

function checkTitle(tc: FormatterTestCase, out: QaViolation[]): void {
  const t = tc.title.trim();
  // P11 Title formula: "Verify <behavior> when/with <condition>."
  if (!/^verify\b/i.test(t)) {
    out.push({
      scenarioId: tc.scenarioId, principle: 'P11 title-formula', field: 'title', severity: 'warn',
      message: `Title should follow "Verify <expected behavior> when <condition>." (got: "${t}").`,
    });
  }
}

function checkSteps(tc: FormatterTestCase, out: QaViolation[]): void {
  tc.steps.forEach((step, i) => {
    const idx = i + 1;
    const s = step.trim();
    const low = lc(s);

    // P3 user-actions-only — no meta verbs.
    if (META_VERBS.some(v => low.startsWith(v) || low.includes(` ${v} `))) {
      out.push({ scenarioId: tc.scenarioId, principle: 'P3 user-actions-only', field: 'steps', stepIndex: idx, severity: 'error',
        message: `Step is a meta-action, not a user action: "${s}". Use a concrete action (Click/Enter/Verify).` });
    }

    // P5 business-language — no automation vocabulary.
    if (AUTOMATION_TERMS.some(v => low.includes(v))) {
      out.push({ scenarioId: tc.scenarioId, principle: 'P5 business-language', field: 'steps', stepIndex: idx, severity: 'error',
        message: `Step uses automation vocabulary: "${s}". Use product/business terms.` });
    }

    // P2 one-action-per-step.
    if (combinesActions(s)) {
      out.push({ scenarioId: tc.scenarioId, principle: 'P2 one-action-per-step', field: 'steps', stepIndex: idx, severity: 'error',
        message: `Step combines multiple actions: "${s}". Split into one action per step.` });
    }

    // P4 verification-not-action.
    if (mixesVerifyAndAction(s)) {
      out.push({ scenarioId: tc.scenarioId, principle: 'P4 verification-not-action', field: 'steps', stepIndex: idx, severity: 'error',
        message: `Step mixes an action with a verification: "${s}". Separate them into two steps.` });
    }

    // P9 machine-readable verb — recognised leading verb.
    const verb = leadingVerb(s);
    if (verb && !ALLOWED_STEP_VERBS.has(verb) && !META_VERBS.some(m => low.startsWith(m))) {
      out.push({ scenarioId: tc.scenarioId, principle: 'P9 machine-readable', field: 'steps', stepIndex: idx, severity: 'warn',
        message: `Step starts with a non-standard verb "${verb}": "${s}". Prefer Open/Enter/Click/Select/Verify.` });
    }

    // P16 independence — no cross-test dependency phrasing.
    if (DEPENDENCY_PHRASES.some(re => re.test(s))) {
      out.push({ scenarioId: tc.scenarioId, principle: 'P16 independence', field: 'steps', stepIndex: idx, severity: 'warn',
        message: `Step depends on another test's execution: "${s}". Test cases must be independent.` });
    }
  });
}

function checkExpected(tc: FormatterTestCase, out: QaViolation[]): void {
  const e = tc.expectedResult.trim();
  const low = lc(e);
  // P6 observable-expected — reject abstract-only outcomes.
  // Flag when the WHOLE expected is short AND matches an abstract phrase (i.e.
  // no concrete observable accompanies it).
  const hasAbstract = ABSTRACT_EXPECTED.some(p => low.includes(p));
  const looksConcrete = /(displayed|shown|visible|message|page|redirect|remains|no session|field|header|button|error|url|state|logged)/i.test(e);
  if (hasAbstract && !looksConcrete) {
    out.push({ scenarioId: tc.scenarioId, principle: 'P6 observable-results', field: 'expected', severity: 'error',
      message: `Expected result is abstract: "${e}". State concrete, observable outcomes a tester can see.` });
  }
  if (!e) {
    out.push({ scenarioId: tc.scenarioId, principle: 'P6 observable-results', field: 'expected', severity: 'error',
      message: 'Expected result is empty.' });
  }
}

/* ------------------------------------------------------------------ */
/*  Validator                                                          */
/* ------------------------------------------------------------------ */

/**
 * Validate a batch of canonical/polished test cases against the machine-checkable
 * subset of the QA Artifact Standard. Pure and non-destructive — returns a
 * structured report; the caller decides whether to repair. Never throws.
 */
export function validateQaStandard(cases: FormatterTestCase[]): ValidationReport {
  const violations: QaViolation[] = [];
  for (const tc of cases) {
    checkTitle(tc, violations);
    checkSteps(tc, violations);
    checkExpected(tc, violations);
  }

  const byId = new Map<string, QaViolation[]>();
  for (const v of violations) {
    const list = byId.get(v.scenarioId) ?? [];
    list.push(v);
    byId.set(v.scenarioId, list);
  }

  const errors = violations.filter(v => v.severity === 'error').length;
  const warnings = violations.filter(v => v.severity === 'warn').length;

  // Principles violated (distinct) vs. satisfied (checked-set minus violated).
  const principlesViolated = Array.from(new Set(violations.map(v => v.principle)));
  const principlesSatisfied = CHECKED_PRINCIPLES.filter(p => !principlesViolated.includes(p));

  // Score = % of items with ZERO error-severity violations (warnings don't fail
  // the gate, so they don't reduce the score). Empty input scores a clean 100.
  const errorCaseIds = new Set(violations.filter(v => v.severity === 'error').map(v => v.scenarioId));
  const clean = cases.length - errorCaseIds.size;
  const score = cases.length === 0 ? 100 : Math.round((clean / cases.length) * 100);

  return {
    passed: errors === 0,
    score,
    checked: cases.length,
    errors,
    warnings,
    principlesSatisfied,
    principlesViolated,
    violations,
    byId,
    failingIds: Array.from(byId.keys()),
  };
}

/**
 * Summarise a case's violations as short, model-facing repair instructions.
 * Used by the caller to build a TARGETED repair prompt (only the failed cases,
 * only the specific fixes) — not to re-teach the whole standard.
 */
export function violationsToInstructions(violations: QaViolation[]): string[] {
  return violations.map(v => {
    const where = v.field === 'steps' && v.stepIndex ? `step ${v.stepIndex}` : v.field;
    return `[${where}] ${v.message}`;
  });
}
