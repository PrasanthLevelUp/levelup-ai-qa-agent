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
 * The unit of value is a VERIFICATION OBJECTIVE, not an assertion. A senior
 * engineer proves a *business objective* ("user authenticated", "cart
 * updated", "order placed") and backs it with one or more pieces of EVIDENCE:
 *
 *        Verification Objective  →  Evidence[]  →  (framework) assertions
 *
 * e.g. objective "user authenticated" is proven by evidence
 * {success-indicator, landmark-control, error-absent}. That is still ONE
 * objective — success is measured in objectives proven, never in assertion
 * count. `planVerifications(step, context?)` turns a step into the objectives
 * it should prove, each carrying framework-agnostic evidence — NOT Playwright.
 * A framework adapter (the Script Composer) renders evidence into `expect()`
 * calls, so the same plan could target Playwright, Cypress, or Selenium. This
 * is the one decision point for verification, exactly as `evaluateCandidate()`
 * is the one decision point for implementation.
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
// Evidence — the framework-agnostic proof a business objective actually holds.
// A single objective is backed by one or MORE pieces of evidence. The Composer
// renders each kind into an `expect()` call; the kinds themselves know nothing
// about Playwright.
// ───────────────────────────────────────────────────────────────────────────

export type EvidenceKind =
  | 'success-indicator' // the success / confirmation UI for the goal is shown
  | 'state-change'      // the resulting state (badge, count, total, list) is present
  | 'landmark-control'  // the landmark control that proves we arrived (menu, cart, target)
  | 'error-absent'      // no unexpected error / validation message appeared
  | 'error-present'     // the EXPECTED error is shown (negative test)
  | 'navigation';       // URL / session / persistence is correct (weakest)

/** Strength + priority each evidence kind inherits from its verification tier. */
const EVIDENCE_META: Readonly<Record<EvidenceKind, { strength: VerificationStrength; priority: number }>> = Object.freeze({
  'success-indicator': { strength: 5, priority: 100 },
  'error-present':     { strength: 5, priority: 100 }, // proving a blocked goal IS a business outcome
  'state-change':      { strength: 4, priority: 80 },
  'landmark-control':  { strength: 3, priority: 60 },
  'error-absent':      { strength: 2, priority: 40 },
  'navigation':        { strength: 1, priority: 20 },
});

/** Which evidence kind a tier contributes (positive flows). */
const EVIDENCE_FROM_TIER: Readonly<Record<VerificationTier, EvidenceKind>> = Object.freeze({
  'business-outcome':  'success-indicator',
  'application-state': 'state-change',
  'critical-ui':       'landmark-control',
  'negative-state':    'error-absent',
  'technical-state':   'navigation',
});

/** Signals that a step is the COMPLETION of a flow (final confirmation), for naming. */
const COMPLETION_SIGNAL =
  /\b(finish|complete[ds]?|confirm(ed|ation)?|thank\s?you|place[ds]?\s?(the\s)?order|success(ful|fully)?|submit(ted)?|purchas(e|ed)|paid|receipt)\b/i;

// ───────────────────────────────────────────────────────────────────────────
// The plan — verification OBJECTIVES (not assertions, not framework code)
// ───────────────────────────────────────────────────────────────────────────

/**
 * One business objective to prove, with the evidence that proves it. This is
 * the unit of value: success is measured in objectives proven, and each
 * objective may need several pieces of evidence (still ONE objective). The
 * Composer turns `evidence` into framework assertions.
 */
export interface VerificationObjective {
  /** Plain-language business objective, e.g. "user authenticated", "cart updated". */
  objective: string;
  /** The verification category this step was classified into. */
  category: VerificationCategory;
  /** Priority of the strongest evidence — orders objectives across a plan. */
  priority: number;
  /** Strength (⭐ 1–5) of the strongest evidence backing this objective. */
  strength: VerificationStrength;
  /** The evidence that proves the objective, strongest first (framework-agnostic). */
  evidence: EvidenceKind[];
  /** True when the objective is a blocked/failed outcome (negative test). */
  negative: boolean;
  /** Why this objective/evidence set fired — the deterministic rules, for tests. */
  reason: string;
}

/** The verification plan for a single step. */
export interface VerificationPlan {
  /** Business objectives to prove, strongest first. Usually one per checkpoint. */
  objectives: VerificationObjective[];
  /** The category the step was classified into. */
  category: VerificationCategory;
  /** True when the step asserts a failure/error is the expected result. */
  negativeTest: boolean;
}

/** First matching token of a regex (for a readable `reason`), or ''. */
function firstMatch(re: RegExp, text: string): string {
  const m = re.exec(text);
  return m ? m[0].toLowerCase() : '';
}

/** The business objective a step proves, in senior-engineer language. */
function objectiveName(category: VerificationCategory, completion: boolean, negative: boolean): string {
  if (negative) return 'action correctly blocked';
  switch (category) {
    case 'authentication': return 'user authenticated';
    case 'shopping':       return completion ? 'order placed' : 'cart updated';
    case 'crud':           return completion ? 'record saved' : 'record updated';
    case 'search':         return 'search results returned';
    case 'forms':          return completion ? 'form submitted' : 'form input accepted';
    case 'navigation':     return 'destination reached';
    case 'generic':        return 'expected result produced';
  }
}

/**
 * Plan the verifications for a single step. Returns the business OBJECTIVES the
 * step should prove — each carrying framework-agnostic EVIDENCE ordered
 * strongest-first — built purely from deterministic signals + optional context.
 * Never throws; never empty. This is the single decision point for verification.
 */
export function planVerifications(step: VerifiableStep, context?: VerificationContext): VerificationPlan {
  try {
    const text = `${step.description ?? ''} ${step.target ?? ''}`.trim();
    const action = (step.action ?? '').toLowerCase();
    const negativeTest = NEGATIVE_SIGNAL.test(text);
    const category = classifyCategory(text);
    const completion = COMPLETION_SIGNAL.test(text);

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

    // Negative handling: a normal mutating step verifies error ABSENCE.
    if (!negativeTest && MUTATING_ACTIONS.has(action)) {
      add('negative-state', `mutating action '${action}'`);
    }

    // Context strengthening (optional, signal-based): if the page is known to
    // expose a landmark control, ensure a critical-UI check is present.
    const controls = [...(context?.knownControls ?? []), ...(context?.pageObjectMembers ?? [])];
    if (controls.some((c) => /logout|sign\s?out|avatar|account|dashboard/i.test(c))) {
      add('critical-ui', 'context — landmark control available');
    }

    // ── Collapse the fired tiers into the ONE business objective this step
    //    proves, backed by evidence (strongest first). This is the shift from
    //    "count assertions" to "prove objectives": many pieces of evidence,
    //    one objective. ────────────────────────────────────────────────────
    let evidence: EvidenceKind[];
    const reasons = [...fired.values()];

    if (negativeTest) {
      // A negative test proves exactly one thing: the goal was blocked and the
      // expected error is shown. One strong objective, one strong evidence.
      evidence = ['error-present'];
    } else if (completion) {
      // At a flow's COMPLETION (order placed, form submitted), the final
      // confirmation is the proof. Intermediate state (cart badge, running
      // totals) is STALE by now — asserting it would be a false failure, so we
      // drop it. Authentication & forms still keep the focused "no validation
      // error slipped through" guard on the happy path.
      evidence = ['success-indicator'];
      if (category === 'authentication' || category === 'forms') evidence.push('error-absent');
    } else {
      // Map tiers → evidence, dedup, order by strength.
      const kinds = new Set<EvidenceKind>();
      for (const t of fired.keys()) kinds.add(EVIDENCE_FROM_TIER[t]);

      // Strength preference: drop the weakest 'navigation' evidence whenever a
      // stronger proof is available (a senior engineer doesn't lean on a URL
      // check when a real outcome is observable).
      if (kinds.size > 1) kinds.delete('navigation');

      // Focused negative guard: only authentication & forms warrant an explicit
      // "no error slipped through" check — elsewhere it is noise.
      if (category !== 'authentication' && category !== 'forms') kinds.delete('error-absent');

      evidence = [...kinds].sort((a, b) => EVIDENCE_META[b].priority - EVIDENCE_META[a].priority);
    }

    // Fail-open baseline: never regress to "URL → text → done".
    if (evidence.length === 0) {
      evidence = ['success-indicator'];
      reasons.push('baseline — no specific signal matched');
    }

    const strength = evidence.reduce<VerificationStrength>(
      (m, e) => (EVIDENCE_META[e].strength > m ? EVIDENCE_META[e].strength : m), 1);
    const priority = evidence.reduce((m, e) => Math.max(m, EVIDENCE_META[e].priority), 0);

    const objective: VerificationObjective = {
      objective: objectiveName(category, completion, negativeTest),
      category,
      priority,
      strength,
      evidence,
      negative: negativeTest,
      reason: reasons.join('; ') || 'baseline',
    };

    return { objectives: [objective], category, negativeTest };
  } catch {
    return {
      objectives: [{
        objective: 'expected result produced',
        category: 'generic',
        priority: EVIDENCE_META['success-indicator'].priority,
        strength: EVIDENCE_META['success-indicator'].strength,
        evidence: ['success-indicator'],
        negative: false,
        reason: 'fail-open fallback',
      }],
      category: 'generic',
      negativeTest: false,
    };
  }
}

/** The tiers as an array, strongest first — for callers that iterate the hierarchy. */
export function verificationTiersInOrder(): VerificationTierSpec[] {
  return Object.values(VERIFICATION_TIERS).sort((a, b) => b.priority - a.priority);
}
