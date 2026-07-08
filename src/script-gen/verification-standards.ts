/**
 * Verification Standards — the deterministic rules for PROVING behaviour works
 * ============================================================================
 * The second (and final) deterministic rule library. Its sibling,
 * EngineeringStandards, answers "how should automation be WRITTEN?". This one
 * answers the other half of a senior automation engineer's job:
 *
 *                  "What proves this business behaviour works?"
 *
 * A senior engineer does not think "how many assertions can I add?". They think
 * "how do I PROVE the feature works?" — and they verify strongest signal first,
 * in a fixed hierarchy:
 *
 *   1. Business Outcome  — did the user's goal actually succeed?
 *   2. Application State — is the system now in the expected state?
 *   3. Critical UI       — are the essential controls present & usable?
 *   4. Negative State    — are failures correctly absent (or present, for a
 *                          negative test)?
 *   5. Technical State   — is navigation / session / persistence correct?
 *
 * This replaces the weak default that generators fall into:
 *
 *                          URL  →  text  →  done
 *
 * `planVerifications(step)` turns a single step into an ORDERED verification
 * plan (strongest signal first). It is the one decision point for verification,
 * exactly as `evaluateCandidate()` is the one decision point for implementation.
 *
 * Hard rules (identical to EngineeringStandards — these are the only two
 * deterministic rule libraries the project will ever have):
 *   • NO AI, NO LLM, NO prompts, NO embeddings, NO fuzzy/semantic matching.
 *     Classification is signal-based (explicit regexes), never inferred.
 *   • Pure & deterministic — same step → same plan, forever.
 *   • Fail-open — always returns at least one verification; never throws.
 *   • This is the ONE place verification behaviour evolves. New rules are added
 *     HERE (+1 signal, adjust a tier) — never in a new module.
 */

// ───────────────────────────────────────────────────────────────────────────
// The step we verify. Kept minimal & structural so this library stays
// decoupled from the composer — the engine's TestPlanStep is assignable to it.
// ───────────────────────────────────────────────────────────────────────────

export interface VerifiableStep {
  /** navigate | fill | click | select | hover | press | assert | wait | screenshot. */
  action: string;
  /** Human description of the step's intent — the primary classification input. */
  description: string;
  /** Optional target/element description. */
  target?: string;
  /** Optional value (for fill/select). */
  value?: string;
}

// ───────────────────────────────────────────────────────────────────────────
// The verification hierarchy — the tier table (priority order)
// ───────────────────────────────────────────────────────────────────────────

/** The five verification tiers, strongest signal first. */
export type VerificationTier =
  | 'business-outcome'
  | 'application-state'
  | 'critical-ui'
  | 'negative-state'
  | 'technical-state';

export interface VerificationTierSpec {
  tier: VerificationTier;
  /** Higher = verified first. This is what orders a plan. */
  priority: number;
  /** The senior-engineer question this tier answers. */
  question: string;
}

/**
 * The frozen hierarchy. This is the heart of the library: the ORDER encodes how
 * a senior engineer proves a feature works — business outcome first, technical
 * plumbing last. Tuning verification = editing this table or the signals below.
 */
export const VERIFICATION_TIERS: Readonly<Record<VerificationTier, VerificationTierSpec>> = Object.freeze({
  'business-outcome':  { tier: 'business-outcome',  priority: 100, question: "Did the user's goal actually succeed?" },
  'application-state': { tier: 'application-state', priority: 80,  question: 'Is the system now in the expected state?' },
  'critical-ui':       { tier: 'critical-ui',       priority: 60,  question: 'Are the essential controls present and usable?' },
  'negative-state':    { tier: 'negative-state',    priority: 40,  question: 'Are failure conditions correctly absent (or present, for a negative test)?' },
  'technical-state':   { tier: 'technical-state',   priority: 20,  question: 'Is navigation / session / persistence correct?' },
});

// ───────────────────────────────────────────────────────────────────────────
// Signals — the deterministic classifiers (the "ESLint rules" of verification)
// Each tier fires when its signal matches the step. Add/adjust rules HERE.
// ───────────────────────────────────────────────────────────────────────────

/** Business outcome achieved — a user goal completed. */
const OUTCOME_SIGNAL =
  /\b(complete[ds]?|success(ful|fully)?|confirm(ed|ation)?|placed|submit(ted)?|logged\s?in|log\s?in|sign\s?in|signed\s?in|register(ed)?|purchas(e|ed)|checkout|checked\s?out|added?\s?to\s?(the\s)?cart|book(ed|ing)?|paid|payment|order)\b/i;

/** Application/data state — counts, totals, contents the action should change. */
const STATE_SIGNAL =
  /\b(cart|badge|count|total|subtotal|price|quantity|qty|inventory|stock|balance|list(ed)?|items?|number\s?of|amount|summary|updated|reflect(ed|s)?)\b/i;

/** Critical UI — essential controls that must be present & usable. */
const UI_SIGNAL =
  /\b(button|link|icon|menu|nav(igation)?|header|footer|field|input|dropdown|tab|logout|log\s?out|visible|displayed|shown|enabled|present|appears?)\b/i;

/** Negative expectation — this step is about a failure / error / absence. */
const NEGATIVE_SIGNAL =
  /\b(error|invalid|fail(s|ed|ure)?|denied|reject(ed|s)?|forbidden|unauthori[sz]ed|should\s?not|cannot|can't|without|missing|empty|blank|blocked|warning|not\s+(allowed|permitted|visible|shown|present|able))\b/i;

/** Technical state — navigation, session, persistence, transport. */
const TECHNICAL_SIGNAL =
  /\b(url|page|navigat(e|ed|ion)|redirect(ed)?|route[ds]?|session|cookie|token|localstorage|storage|persist(ed|s|ence)?|api|endpoint|status\s?code|network|request|response)\b/i;

/** Actions that actually change something — worth an "no error appeared" check. */
const MUTATING_ACTIONS = new Set(['fill', 'click', 'select', 'press', 'navigate']);

// ───────────────────────────────────────────────────────────────────────────
// The plan
// ───────────────────────────────────────────────────────────────────────────

/** One thing to verify, with the tier and the rule that produced it. */
export interface VerificationIntent {
  tier: VerificationTier;
  /** Inherited from the tier — used to order the plan. */
  priority: number;
  /** What to verify, in plain engineering language. */
  intent: string;
  /** Why this fired — the deterministic rule/signal, for transparency & tests. */
  reason: string;
}

/** The ordered verification plan for a single step. */
export interface VerificationPlan {
  /** Strongest signal first: business-outcome → … → technical-state. */
  intents: VerificationIntent[];
  /** True when the step asserts a failure/error is the expected result. */
  negativeTest: boolean;
}

/** Build one intent from its tier spec. */
function intentFor(tier: VerificationTier, intent: string, reason: string): VerificationIntent {
  return { tier, priority: VERIFICATION_TIERS[tier].priority, intent, reason };
}

/** First matching token of a regex (for a readable `reason`), or ''. */
function firstMatch(re: RegExp, text: string): string {
  const m = re.exec(text);
  return m ? m[0].toLowerCase() : '';
}

/**
 * Plan the verifications for a single step. Returns an ORDERED plan (strongest
 * signal first) built purely from deterministic signals in the step's action +
 * description. Never throws; always returns at least one verification.
 *
 * This is verification's single decision point — downstream assertion
 * generation just renders this plan into Playwright `expect()` calls.
 */
export function planVerifications(step: VerifiableStep): VerificationPlan {
  try {
    const text = `${step.description ?? ''} ${step.target ?? ''}`.trim();
    const action = (step.action ?? '').toLowerCase();
    const negativeTest = NEGATIVE_SIGNAL.test(text);

    const intents: VerificationIntent[] = [];

    // 1. Business outcome — the user's goal. Inverted for a negative test.
    const outcomeHit = firstMatch(OUTCOME_SIGNAL, text);
    if (negativeTest) {
      intents.push(intentFor(
        'business-outcome',
        'Assert the action did NOT succeed — the user goal must be blocked, not completed.',
        `negative signal '${firstMatch(NEGATIVE_SIGNAL, text)}'`,
      ));
    } else if (outcomeHit) {
      intents.push(intentFor(
        'business-outcome',
        'Assert the primary business outcome is achieved (success confirmation / expected result).',
        `outcome signal '${outcomeHit}'`,
      ));
    }

    // 2. Application state — counts / totals / contents changed by the action.
    const stateHit = firstMatch(STATE_SIGNAL, text);
    if (stateHit) {
      intents.push(intentFor(
        'application-state',
        'Assert the resulting application state (counts, totals, list contents) matches expectation.',
        `state signal '${stateHit}'`,
      ));
    }

    // 3. Critical UI — essential controls present & usable.
    const uiHit = firstMatch(UI_SIGNAL, text);
    if (uiHit) {
      intents.push(intentFor(
        'critical-ui',
        'Assert the essential control(s) for this screen are visible and enabled.',
        `ui signal '${uiHit}'`,
      ));
    }

    // 4. Negative state — expected error present, or unexpected error absent.
    if (negativeTest) {
      intents.push(intentFor(
        'negative-state',
        'Assert the expected error / validation message IS shown.',
        `negative signal '${firstMatch(NEGATIVE_SIGNAL, text)}'`,
      ));
    } else if (MUTATING_ACTIONS.has(action)) {
      intents.push(intentFor(
        'negative-state',
        'Assert no unexpected error / validation message appeared after the action.',
        `mutating action '${action}'`,
      ));
    }

    // 5. Technical state — navigation / session / persistence.
    const techHit = firstMatch(TECHNICAL_SIGNAL, text);
    if (techHit || action === 'navigate') {
      intents.push(intentFor(
        'technical-state',
        'Assert navigation / session / persistence is correct (URL, cookie, stored data).',
        techHit ? `technical signal '${techHit}'` : "navigate action",
      ));
    }

    // Fail-open baseline: every step implies an intended result. If no signal
    // fired, verify the step's stated result at the outcome level rather than
    // returning nothing (never regress to "URL → text → done").
    if (intents.length === 0) {
      intents.push(intentFor(
        'business-outcome',
        `Assert the step's stated result: "${(step.description ?? '').trim() || 'expected behaviour'}".`,
        'baseline — no specific signal matched',
      ));
    }

    // Order strongest signal first; stable on equal priority (declaration order).
    intents.sort((a, b) => b.priority - a.priority);

    return { intents, negativeTest };
  } catch {
    // Fail open — verification is additive, never a gate.
    return {
      intents: [intentFor('business-outcome', 'Assert the step produced its expected result.', 'fail-open fallback')],
      negativeTest: false,
    };
  }
}

/** The tiers as an array, strongest first — for callers that iterate the hierarchy. */
export function verificationTiersInOrder(): VerificationTierSpec[] {
  return Object.values(VERIFICATION_TIERS).sort((a, b) => b.priority - a.priority);
}
