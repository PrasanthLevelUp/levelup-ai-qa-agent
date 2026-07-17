/**
 * EXPECTED RESULT VALIDATOR
 * =========================
 * Sprint: "Expected Result Excellence" (Part 2 — the provability gate).
 *
 * The previous sprint made Expected Results RICH (business-observable assertion
 * lists instead of one generic sentence). That surfaced a NEW, equally dangerous
 * failure mode the founder named exactly:
 *
 *     "Rich, but not provable."
 *
 * An assertion like "The block is enforced server-side" or "No data corruption"
 * or "The record is durably saved" reads well but a black-box QA engineer CANNOT
 * observe it. It is a statement about internals, not a check they can execute.
 *
 * This module is a DETERMINISTIC gate — no LLM, no network, no tokens — that
 * scores every single assertion against the three conditions the founder set:
 *
 *   1. OBSERVABLE   — a tester can actually SEE the outcome in the running app
 *                     (a message, a list row, a field value, a redirect). It is
 *                     NOT a claim about an invisible internal effect.
 *   2. GROUNDED     — the assertion is derivable from the Requirement, the
 *                     Planner scenario, or the Application Profile ONLY. It does
 *                     not invent side-effects (emails, audit trails, search
 *                     re-indexing, notifications) the inputs never mention.
 *   3. BLACK-BOX    — a QA engineer could verify it WITHOUT reading code: no
 *                     server-side/database/transaction/CSRF/cache internals.
 *
 * Determinism: pure lexicon + word-boundary matching. Same input → same verdict.
 * It NEVER throws and NEVER mutates its input, mirroring the Scenario Integrity
 * Validator's contract. It is the "definition of done" for an Expected Result:
 * every assertion the Builder emits must pass all three conditions.
 */

// ---------------------------------------------------------------------------
// Lexicons — the deterministic rules. Kept small, explicit and heavily
// commented so a reviewer can audit exactly WHY an assertion is rejected.
// ---------------------------------------------------------------------------

/**
 * CODE-LEVEL / INFRASTRUCTURE terms. Their presence means the assertion is
 * talking about an implementation internal a black-box tester cannot verify
 * without reading code or inspecting the backend. Fails BLACK-BOX (and, by
 * extension, OBSERVABLE — you cannot see any of these from the UI).
 */
const CODE_LEVEL_TERMS = [
  'server-side',
  'server side',
  'serverside',
  'backend',
  'back-end',
  'back end',
  'database',
  'db table',
  'sql',
  'csrf',
  'xsrf',
  'transaction',
  'committed',
  'rollback',
  'roll back',
  'cache',
  'cached',
  'invalidated',
  'hashed',
  'encrypted',
  'sanitized',
  'sanitised',
  'status code',
  'http status',
];

/**
 * INTERNAL-STATE terms. The outcome may be real, but it describes an effect
 * that is NOT directly observable from the UI ("durably saved", "no data
 * corruption", "search index refreshed", "escaped/neutralised", "executed/
 * interpreted"). The Builder must instead assert the OBSERVABLE PROXY (the row
 * shows the literal text; no pop-up appears; the record is still listed after a
 * refresh). Fails OBSERVABLE.
 */
const INTERNAL_STATE_TERMS = [
  'durably',
  'durable',
  'escaped',
  'escaping',
  'neutralised',
  'neutralized',
  'executed',
  'interpreted',
  'corruption',
  'corrupted',
  'reindex',
  're-index',
  're-indexed',
  'reindexed',
  'index refreshed',
  'search index',
  'indexing',
  'written to disk',
  'at rest',
  'in the database',
];

/**
 * SIDE-EFFECT concepts that must be GROUNDED. If an assertion mentions one of
 * these but NONE of the inputs (requirement / planner scenario / app profile)
 * mention it, the assertion is inventing a side-effect the feature never
 * promised. Fails GROUNDED. (If the requirement DOES mention e.g. an email,
 * the concept is grounded and allowed.)
 */
const SIDE_EFFECT_CONCEPTS = [
  'email',
  'e-mail',
  'notification',
  'notified',
  'sms',
  'webhook',
  'audit',
  'audit trail',
  'audit log',
  'slack',
  'telegram',
  'push notification',
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary-aware presence test. Multi-word phrases are matched as phrases;
 * hyphenated terms are matched loosely (hyphen OR space). Prevents false
 * positives from substrings (e.g. "validated" must not trip "valid").
 */
function present(haystack: string, needle: string): boolean {
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  // Allow "server-side" to match "server side" and vice-versa.
  const flexible = escapeRe(n).replace(/\\-|\\ /g, '[\\s-]');
  return new RegExp(`(^|[^a-z0-9])${flexible}([^a-z0-9]|$)`).test(h);
}

function matched(haystack: string, needles: string[]): string[] {
  return needles.filter((n) => present(haystack, n));
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Grounding sources: requirement, planner scenario, application profile. */
export interface ProvabilityContext {
  /** Requirement title + description + acceptance criteria + business flow. */
  requirementText?: string;
  /** The planner scenario's own title + objective + risk area. */
  scenarioText?: string;
  /** Profile-derived text: page titles/types, field labels, entity, list name. */
  profileText?: string;
}

/** Verdict for a SINGLE assertion against the three conditions. */
export interface AssertionVerdict {
  assertion: string;
  observable: boolean;
  grounded: boolean;
  blackBox: boolean;
  /** True only when all three conditions hold. */
  passed: boolean;
  /** Human-readable reasons for each failed condition (empty when passed). */
  violations: string[];
}

/** Aggregate verdict for a whole Expected Result (a list of assertions). */
export interface ExpectedResultVerdict {
  passed: boolean;
  /** 0..1 — fraction of assertions that passed all three conditions. */
  score: number;
  assertions: AssertionVerdict[];
  /** Flattened "[assertion] reason" strings for every violation. */
  violations: string[];
}

// ---------------------------------------------------------------------------
// Core validation
// ---------------------------------------------------------------------------

/**
 * Score ONE assertion. Pure & deterministic.
 */
export function validateAssertion(
  assertion: string,
  ctx: ProvabilityContext = {},
): AssertionVerdict {
  const violations: string[] = [];
  const text = (assertion || '').trim();

  // BLACK-BOX — no code-level / infrastructure internals.
  const codeHits = matched(text, CODE_LEVEL_TERMS);
  const blackBox = codeHits.length === 0;
  if (!blackBox) {
    violations.push(
      `not black-box verifiable — refers to implementation internals (${codeHits.join(', ')}); assert the visible outcome instead.`,
    );
  }

  // OBSERVABLE — no invisible internal-state claims.
  const stateHits = matched(text, INTERNAL_STATE_TERMS);
  const observable = stateHits.length === 0;
  if (!observable) {
    violations.push(
      `not observable — describes an internal effect (${stateHits.join(', ')}); assert what the tester can SEE (a message, a list row, a field value).`,
    );
  }

  // GROUNDED — any side-effect concept must appear in the inputs.
  const corpus = `${ctx.requirementText || ''} ${ctx.scenarioText || ''} ${ctx.profileText || ''}`;
  const ungrounded = SIDE_EFFECT_CONCEPTS.filter(
    (c) => present(text, c) && !present(corpus, c),
  );
  const grounded = ungrounded.length === 0;
  if (!grounded) {
    violations.push(
      `not grounded — invents a side-effect (${ungrounded.join(', ')}) that the requirement, planner and app profile never mention.`,
    );
  }

  return {
    assertion: text,
    observable,
    grounded,
    blackBox,
    passed: observable && grounded && blackBox,
    violations,
  };
}

/**
 * Score a whole Expected Result (its assertion list). Pure & deterministic,
 * never throws.
 */
export function validateExpectedResult(
  assertions: string[] | null | undefined,
  ctx: ProvabilityContext = {},
): ExpectedResultVerdict {
  try {
    const list = (assertions || []).filter((a) => typeof a === 'string' && a.trim().length > 0);
    if (list.length === 0) {
      return { passed: true, score: 1, assertions: [], violations: [] };
    }
    const verdicts = list.map((a) => validateAssertion(a, ctx));
    const passedCount = verdicts.filter((v) => v.passed).length;
    const violations = verdicts
      .filter((v) => !v.passed)
      .flatMap((v) => v.violations.map((r) => `[${v.assertion}] ${r}`));
    return {
      passed: violations.length === 0,
      score: verdicts.length ? passedCount / verdicts.length : 1,
      assertions: verdicts,
      violations,
    };
  } catch {
    // A validator bug must never break generation — fail open, permissively.
    return { passed: true, score: 1, assertions: [], violations: [] };
  }
}
