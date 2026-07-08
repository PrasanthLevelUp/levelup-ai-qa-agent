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
 *   1. Business Outcome  — did the user's goal actually succeed?      ⭐⭐⭐⭐⭐
 *   2. Application State — is the system now in the expected state?   ⭐⭐⭐⭐
 *   3. Critical UI       — are the essential controls present/usable? ⭐⭐⭐
 *   4. Negative State    — are failures correctly absent (or present  ⭐⭐
 *                          for a negative test)?
 *   5. Technical State   — is navigation / session / persistence ok?  ⭐
 *
 * This replaces the weak default that generators fall into:
 *
 *                          URL  →  text  →  done
 *
 * `planVerifications(step, context?)` turns a single step into an ORDERED
 * verification plan (strongest evidence first) of STRUCTURED intents — NOT
 * Playwright code. A framework adapter (the Script Composer) renders the intents
 * into `expect()` calls, so the same plan could target Playwright, Cypress, or
 * Selenium. This is the one decision point for verification, exactly as
 * `evaluateCandidate()` is the one decision point for implementation.
 *
 * Maintainability: step intent is classified into a small, fixed set of
 * verification CATEGORIES (authentication, shopping, navigation, crud, search,
 * forms) — NOT an ever-growing pile of per-feature regexes. Add a category or a
 * signal here; never a new module.
 *
 * Hard rules (identical to EngineeringStandards — these are the only two
 * deterministic rule libraries the project will ever have):
 *   • NO AI, NO LLM, NO prompts, NO embeddings, NO fuzzy/semantic matching.
 *     Classification is signal-based (explicit regexes), never inferred.
 *   • Pure & deterministic — same input → same plan, forever.
 *   • Fail-open — always returns at least one verification; never throws.
 *   • This is the ONE place verification behaviour evolves.
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

/**
 * Optional context that lets the plan make STRONGER decisions without changing
 * the architecture. Everything is optional — a plan is always valid without it.
 * Populated by the composer from upstream stages (App Profile, Candidate
 * Resolution, page objects). Signal-based use only — never inspected by an LLM.
 */
export interface VerificationContext {
  /** Page-object method/property names available for this screen (from repo intel). */
  pageObjectMembers?: string[];
  /** Known control names on the page (e.g. from the App Profile crawl). */
  knownControls?: string[];
  /** The winning Candidate Resolution type for this step, if any. */
  candidateType?: string;
  /** Assertions already present on the step — used to avoid redundant intents. */
  existingAssertions?: string[];
}

// ───────────────────────────────────────────────────────────────────────────
// The verification hierarchy — tiers + strength (priority order)
// ───────────────────────────────────────────────────────────────────────────

/** The five verification tiers, strongest evidence first. */
export type VerificationTier =
  | 'business-outcome'
  | 'application-state'
  | 'critical-ui'
  | 'negative-state'
  | 'technical-state';

/** Evidence strength, 1 (weakest) … 5 (strongest). The Composer prefers high. */
export type VerificationStrength = 1 | 2 | 3 | 4 | 5;

export interface VerificationTierSpec {
  tier: VerificationTier;
  /** Higher = verified first. This is what orders a plan. */
  priority: number;
  /** Evidence strength (⭐). Business outcome is the strongest proof a feature works. */
  strength: VerificationStrength;
  /** The senior-engineer question this tier answers. */
  question: string;
}

/**
 * The frozen hierarchy. The ORDER encodes how a senior engineer proves a feature
 * works — business outcome first, technical plumbing last. Strength lets the
 * Composer prefer strong evidence over a pile of weak URL/text checks. Tuning
 * verification = editing this table or the category/signals below.
 */
export const VERIFICATION_TIERS: Readonly<Record<VerificationTier, VerificationTierSpec>> = Object.freeze({
  'business-outcome':  { tier: 'business-outcome',  priority: 100, strength: 5, question: "Did the user's goal actually succeed?" },
  'application-state': { tier: 'application-state', priority: 80,  strength: 4, question: 'Is the system now in the expected state?' },
  'critical-ui':       { tier: 'critical-ui',       priority: 60,  strength: 3, question: 'Are the essential controls present and usable?' },
  'negative-state':    { tier: 'negative-state',    priority: 40,  strength: 2, question: 'Are failure conditions correctly absent (or present, for a negative test)?' },
  'technical-state':   { tier: 'technical-state',   priority: 20,  strength: 1, question: 'Is navigation / session / persistence correct?' },
});

// ───────────────────────────────────────────────────────────────────────────
// Verification categories — the maintainable alternative to regex explosion.
// One signal per category (not per feature). Each category contributes the
// domain-aware intents a senior engineer would check for that kind of flow.
// ───────────────────────────────────────────────────────────────────────────

export type VerificationCategory =
  | 'authentication'
  | 'shopping'
  | 'navigation'
  | 'crud'
  | 'search'
  | 'forms'
  | 'generic';

/** One classifier per category. Order matters: most specific first. */
const CATEGORY_SIGNALS: ReadonlyArray<{ category: VerificationCategory; re: RegExp }> = [
  { category: 'authentication', re: /\b(log\s?in|login|log\s?out|logout|sign\s?in|sign\s?out|signin|signout|sign\s?up|register|authenticat|credential|password|session)\b/i },
  { category: 'shopping',       re: /\b(cart|checkout|order|purchase|buy|payment|pay|price|total|subtotal|inventory|product|add\s?to\s?cart|basket|shipping)\b/i },
  { category: 'crud',           re: /\b(create|add|new|edit|update|modify|delete|remove|save|record|entry|employee|profile|account)\b/i },
  { category: 'search',         re: /\b(search|filter|sort|query|results?|find|lookup)\b/i },
  { category: 'forms',          re: /\b(form|field|submit|input|validation|required|dropdown|checkbox|radio|upload|attach)\b/i },
  { category: 'navigation',     re: /\b(navigate|go\s?to|open|visit|page|redirect|route|link|menu|tab|breadcrumb)\b/i },
];

/** Classify a step's intent into ONE verification category (or 'generic'). */
export function classifyCategory(text: string): VerificationCategory {
  for (const { category, re } of CATEGORY_SIGNALS) {
    if (re.test(text)) return category;
  }
  return 'generic';
}

// ───────────────────────────────────────────────────────────────────────────
// Fine-grained tier signals (used to add tiers a category alone wouldn't imply)
// ───────────────────────────────────────────────────────────────────────────

const OUTCOME_SIGNAL =
  /\b(complete[ds]?|success(ful|fully)?|confirm(ed|ation)?|placed|submit(ted)?|logged\s?in|log\s?in|sign\s?in|signed\s?in|register(ed)?|purchas(e|ed)|checkout|checked\s?out|added?\s?to\s?(the\s)?cart|book(ed|ing)?|paid|payment|order)\b/i;
const STATE_SIGNAL =
  /\b(cart|badge|count|total|subtotal|price|quantity|qty|inventory|stock|balance|list(ed)?|items?|number\s?of|amount|summary|updated|reflect(ed|s)?)\b/i;
const UI_SIGNAL =
  /\b(button|link|icon|menu|nav(igation)?|header|footer|field|input|dropdown|tab|logout|log\s?out|visible|displayed|shown|enabled|present|appears?)\b/i;
const NEGATIVE_SIGNAL =
  /\b(error|invalid|fail(s|ed|ure)?|denied|reject(ed|s)?|forbidden|unauthori[sz]ed|should\s?not|cannot|can't|without|missing|empty|blank|blocked|warning|not\s+(allowed|permitted|visible|shown|present|able))\b/i;
const TECHNICAL_SIGNAL =
  /\b(url|page|navigat(e|ed|ion)|redirect(ed)?|route[ds]?|session|cookie|token|localstorage|storage|persist(ed|s|ence)?|api|endpoint|status\s?code|network|request|response)\b/i;

/** Actions that actually change something — worth a "no error appeared" check. */
const MUTATING_ACTIONS = new Set(['fill', 'click', 'select', 'press', 'navigate']);

/**
 * Category → the tiers that category should always try to verify. This is a
 * DATA table, not code branches — adding a category means adding a row, never a
 * new `if`. Tiers still only appear when meaningful for the step.
 */
const CATEGORY_TIERS: Readonly<Record<VerificationCategory, VerificationTier[]>> = Object.freeze({
  authentication: ['business-outcome', 'critical-ui', 'negative-state', 'technical-state'],
  shopping:       ['business-outcome', 'application-state', 'critical-ui', 'negative-state'],
  crud:           ['business-outcome', 'application-state', 'negative-state'],
  search:         ['business-outcome', 'application-state'],
  forms:          ['business-outcome', 'negative-state', 'critical-ui'],
  navigation:     ['critical-ui', 'technical-state'],
  // 'generic' carries no domain knowledge — rely on fine-grained signals, and
  // fall back to the baseline outcome intent if none fire.
  generic:        [],
});

// ───────────────────────────────────────────────────────────────────────────
// The plan (structured intent — NOT framework code)
// ───────────────────────────────────────────────────────────────────────────

/** One thing to verify, with tier, strength, and the rule that produced it. */
export interface VerificationIntent {
  tier: VerificationTier;
  /** Inherited from the tier — used to order the plan. */
  priority: number;
  /** Evidence strength (⭐ 1–5) — lets the Composer prefer strong proof. */
  strength: VerificationStrength;
  /** The verification category this step was classified into. */
  category: VerificationCategory;
  /** What to verify, in plain, framework-agnostic engineering language. */
  intent: string;
  /** Why this fired — the deterministic rule/signal, for transparency & tests. */
  reason: string;
}

/** The ordered verification plan for a single step. */
export interface VerificationPlan {
  /** Strongest evidence first: business-outcome → … → technical-state. */
  intents: VerificationIntent[];
  /** The category the step was classified into. */
  category: VerificationCategory;
  /** True when the step asserts a failure/error is the expected result. */
  negativeTest: boolean;
}

function intentFor(
  tier: VerificationTier,
  category: VerificationCategory,
  intent: string,
  reason: string,
): VerificationIntent {
  const spec = VERIFICATION_TIERS[tier];
  return { tier, priority: spec.priority, strength: spec.strength, category, intent, reason };
}

/** First matching token of a regex (for a readable `reason`), or ''. */
function firstMatch(re: RegExp, text: string): string {
  const m = re.exec(text);
  return m ? m[0].toLowerCase() : '';
}

/** Human phrasing for each tier's default intent, per category. */
function intentText(tier: VerificationTier, category: VerificationCategory, negativeTest: boolean): string {
  switch (tier) {
    case 'business-outcome':
      return negativeTest
        ? 'Assert the action did NOT succeed — the user goal must be blocked, not completed.'
        : 'Assert the primary business outcome is achieved (success confirmation / expected result).';
    case 'application-state':
      return 'Assert the resulting application state (counts, totals, list contents) matches expectation.';
    case 'critical-ui':
      return category === 'authentication'
        ? 'Assert the post-auth landmark control (e.g. logout / user menu) is visible.'
        : 'Assert the essential control(s) for this screen are visible and enabled.';
    case 'negative-state':
      return negativeTest
        ? 'Assert the expected error / validation message IS shown.'
        : 'Assert no unexpected error / validation message appeared after the action.';
    case 'technical-state':
      return 'Assert navigation / session / persistence is correct (URL, cookie, stored data).';
  }
}

/**
 * Plan the verifications for a single step. Returns an ORDERED plan (strongest
 * evidence first) of structured intents, built purely from deterministic
 * signals in the step + optional context. Never throws; never empty.
 */
export function planVerifications(step: VerifiableStep, context?: VerificationContext): VerificationPlan {
  try {
    const text = `${step.description ?? ''} ${step.target ?? ''}`.trim();
    const action = (step.action ?? '').toLowerCase();
    const negativeTest = NEGATIVE_SIGNAL.test(text);
    const category = classifyCategory(text);

    // A tier fires if (a) its category expects it, or (b) a fine-grained signal
    // matches. Collected into a set so nothing is duplicated.
    const fired = new Map<VerificationTier, string>();
    const add = (t: VerificationTier, reason: string) => { if (!fired.has(t)) fired.set(t, reason); };

    // (a) category-driven tiers
    for (const t of CATEGORY_TIERS[category]) add(t, `category '${category}'`);

    // (b) signal-driven tiers (make plans stronger for cross-cutting steps)
    const outcomeHit = firstMatch(OUTCOME_SIGNAL, text);
    if (outcomeHit) add('business-outcome', `outcome signal '${outcomeHit}'`);
    const stateHit = firstMatch(STATE_SIGNAL, text);
    if (stateHit) add('application-state', `state signal '${stateHit}'`);
    const uiHit = firstMatch(UI_SIGNAL, text);
    if (uiHit) add('critical-ui', `ui signal '${uiHit}'`);
    const techHit = firstMatch(TECHNICAL_SIGNAL, text);
    if (techHit || action === 'navigate') add('technical-state', techHit ? `technical signal '${techHit}'` : 'navigate action');

    // Negative handling: a negative test always verifies both the blocked
    // outcome and the visible error; a normal mutating step verifies error
    // ABSENCE.
    if (negativeTest) {
      add('business-outcome', `negative signal '${firstMatch(NEGATIVE_SIGNAL, text)}'`);
      add('negative-state', `negative signal '${firstMatch(NEGATIVE_SIGNAL, text)}'`);
    } else if (MUTATING_ACTIONS.has(action)) {
      add('negative-state', `mutating action '${action}'`);
    }

    // Context strengthening (optional, signal-based): if the page is known to
    // expose a landmark control, ensure a critical-UI check is present.
    const controls = [...(context?.knownControls ?? []), ...(context?.pageObjectMembers ?? [])];
    if (controls.some((c) => /logout|sign\s?out|avatar|account|dashboard/i.test(c))) {
      add('critical-ui', 'context — landmark control available');
    }

    let intents = [...fired.entries()].map(([tier, reason]) =>
      intentFor(tier, category, intentText(tier, category, negativeTest), reason),
    );

    // Fail-open baseline: never regress to "URL → text → done".
    if (intents.length === 0) {
      intents = [intentFor(
        'business-outcome',
        category,
        `Assert the step's stated result: "${(step.description ?? '').trim() || 'expected behaviour'}".`,
        'baseline — no specific signal matched',
      )];
    }

    // Order strongest evidence first; stable on equal priority.
    intents.sort((a, b) => b.priority - a.priority);

    return { intents, category, negativeTest };
  } catch {
    return {
      intents: [intentFor('business-outcome', 'generic', 'Assert the step produced its expected result.', 'fail-open fallback')],
      category: 'generic',
      negativeTest: false,
    };
  }
}

/** The tiers as an array, strongest first — for callers that iterate the hierarchy. */
export function verificationTiersInOrder(): VerificationTierSpec[] {
  return Object.values(VERIFICATION_TIERS).sort((a, b) => b.priority - a.priority);
}
