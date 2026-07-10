/**
 * QA Knowledge Engine — deterministic, LLM-free QA intelligence.
 * ============================================================================
 *
 * The competitive moat of LevelUp AI is QA-FIRST, AI-ASSISTED generation:
 * deterministic QA intelligence decides *what* should be tested, and the LLM is
 * used only to *express and enrich* those scenarios against the concrete
 * requirement + grounding context.
 *
 * This module encodes the "what". For well-understood feature categories
 * (authentication, CRUD, search, checkout, payment, …) a senior QA engineer
 * already knows ~70-80% of the scenarios that must exist BEFORE reading a single
 * line of the requirement. We capture that institutional knowledge here as a
 * static, versioned knowledge base — zero tokens, fully deterministic, unit
 * testable.
 *
 * Two responsibilities:
 *   1. classifyQACategory() — map a requirement to a QA category using cheap,
 *      observable keyword signals (never an LLM call).
 *   2. QA_KNOWLEDGE_BASE      — the baseline scenario obligations per category,
 *      each tagged with the coverage type it belongs to so the Scenario Planner
 *      can filter to the user's selected coverage types.
 *
 * IMPORTANT design rules:
 *   • These are CANDIDATE obligations, not mandates. The planner passes them to
 *     the LLM as a plan to EXPAND — the LLM still drops any scenario the concrete
 *     requirement/context does not support (grounding is never overridden).
 *   • Coverage types used here MUST be valid `CoverageType` ids so the planner
 *     can filter against the user's selection (Priority 1 — respect selection).
 *   • Extending the KB (new category or new scenario) requires no code changes
 *     elsewhere — the planner reads it generically.
 */

import type { CoverageType, RequirementInput } from './test-coverage-engine';

/** Knowledge-base version — bump when the baseline scenarios change materially
 *  so generation telemetry can be correlated to KB revisions. */
export const QA_KNOWLEDGE_VERSION = '1.1.0';

/**
 * Feature categories a senior QA engineer recognises on sight. `generic` is the
 * safe fallback when no category matches confidently — the planner then emits no
 * baseline plan and the LLM works purely from the requirement (legacy behaviour).
 */
export type QACategory =
  | 'authentication'
  | 'crud'
  | 'search'
  | 'checkout'
  | 'payment'
  | 'admin'
  | 'workflow'
  | 'reporting'
  | 'import'
  | 'export'
  | 'generic';

/**
 * The STRENGTH of an obligation, independent of when it triggers:
 *   • 'required' — the category is incomplete without this scenario.
 *   • 'optional' — a valuable scenario, but not a completeness requirement.
 * (Level does not yet gate emission — it is carried in the contract for future
 * prioritisation / coverage-gap reporting. `condition` is what decides emission.)
 */
export type ObligationLevel = 'required' | 'optional';

/**
 * WHEN an obligation applies:
 *   • 'always'   — whenever the feature is of this category; grounded in the
 *                  Requirement that established the category (no keyword needed).
 *   • 'evidence' — only when explicit evidence (Acceptance Criteria / Requirement /
 *                  App Knowledge / Test Data) recognises it via the scenario's
 *                  `conditionalOnKeywords`; otherwise the scenario is NOT planned.
 */
export type ObligationCondition = 'always' | 'evidence';

/**
 * How a baseline scenario earns its place — KNOWLEDGE, not policy. Keeping
 * `level` (required/optional) and `condition` (always/evidence) as orthogonal
 * data lets the Knowledge Base describe every obligation shape without the code
 * ever growing new tiers.
 */
export interface ScenarioObligation {
  level: ObligationLevel;
  condition: ObligationCondition;
}

/**
 * The SEMANTICS of a scenario — the application-NEUTRAL answer to "what does
 * this scenario fundamentally mean?" that today is left implicit in the
 * title/objective and has to be re-inferred (differently, sometimes wrongly) by
 * every downstream consumer (Test Case Lab, Script Generation, Healing, Dataset
 * Resolver, Coverage-gap).
 *
 * This is KNOWLEDGE, not execution. It is authored ONCE in the Knowledge Base,
 * next to the scenario definition it describes, and is deliberately expressed in
 * GENERIC QA CONCEPTS — roles and shapes, never application specifics. Nothing
 * here belongs to SauceDemo, Salesforce, or SAP; "a wrong password is rejected"
 * varies the password from a registered-user baseline in EVERY application.
 *
 * What is NOT here (by design):
 *   • No concrete dataset — `requiredDataRole` names a ROLE ('registered_user'),
 *     never a file/table ('valid_users.csv'). The Dataset Resolver maps role →
 *     dataset later, so planning is never coupled to data storage.
 *   • No application policy — app-specific escalations (lock-after-N, OTP,
 *     captcha) are DIFFERENT scenarios with their own obligation/evidence, not a
 *     `variation` of wrong-password. This keeps the semantics universal.
 *
 * The shape encodes the SINGLE-VARIABLE PRINCIPLE a senior QA engineer applies
 * to negative/edge design: a scenario starts from valid `preconditions` and
 * changes EXACTLY ONE thing (`variation`) — the `variableUnderTest`. Everything
 * else stays valid. That is what makes a negative test diagnostic ("wrong
 * password only" vs. "wrong password AND unknown user") instead of ambiguous.
 */
export interface ScenarioSemantics {
  /**
   * The single input/condition this scenario varies from a valid baseline.
   * `'none'` for a pure positive/observation scenario that changes nothing.
   */
  variableUnderTest: string;
  /** The valid starting state every input/condition is set to. */
  preconditions: string;
  /**
   * The single change applied to the preconditions (the one variable under
   * test). `'none'` when nothing is varied (positive / pure-observation).
   */
  variation: string;
  /** The observable pass/fail behavior a tester can assert against. */
  expectedBehavior: string;
  /**
   * The generic data ROLE this scenario needs (e.g. 'registered_user',
   * 'unregistered_user', 'locked_account') — NEVER a concrete dataset. The
   * Dataset Resolver maps the role to actual rows (valid_users.csv / users.xlsx
   * / an API fixture) later, so the KB and Planner stay decoupled from storage.
   */
  requiredDataRole: string;
}

/**
 * The closed set of executable verbs a KB action template step may carry.
 * Application- and framework-neutral (intent, not a Playwright/Selenium call).
 * Redeclared here — identical to the graph's `ScenarioActionKind` — to keep the
 * Knowledge Base decoupled from the graph module, exactly as `ScenarioSemantics`
 * is redeclared rather than imported.
 */
export type ScenarioActionKind =
  | 'navigate'
  | 'fill'
  | 'click'
  | 'check'
  | 'uncheck'
  | 'select'
  | 'upload';

/**
 * One authored step of a scenario's canonical action SEQUENCE. This is the KB's
 * expression of "what does the browser do, in order?" — it owns the sequence and
 * the abstract semantic targets; it does NOT own layout (id/order) or grounding.
 *
 * The builder turns each template step into a graph `ScenarioAction` by assigning
 * a deterministic `id`/`order` from the array position — never reordering, never
 * translating the target into the app's vocabulary. Targets stay CANONICAL; the
 * Execution Resolver in Script Gen maps them to the app's element and locator at
 * emit time. Deliberately carries NO id/order (structural, assigned by the
 * builder) and NO locator/selector (grounding is the resolver's job).
 */
export interface ScenarioActionTemplate {
  /** The verb (see {@link ScenarioActionKind}). */
  action: ScenarioActionKind;
  /**
   * Abstract SEMANTIC target — an element/page identity (e.g. `login_page`,
   * `username`, `password`, `login_button`, `error_message`). NEVER a locator.
   */
  target: string;
  /**
   * Optional literal (e.g. a dropdown option) or a `@dataset.*` reference (e.g.
   * `@dataset.username`) resolved downstream from `execution.resolvedDataset`.
   */
  value?: string;
  /** When true the step may be skipped if its target is absent in the app. */
  optional?: boolean;
}

/**
 * The FROZEN, closed set of assertion types a KB assertion template entry may
 * carry. Redeclared here — identical to the graph's `AssertionType` — to keep
 * the Knowledge Base decoupled from the graph module, exactly as
 * `ScenarioActionKind` is redeclared rather than imported. These describe a
 * checkable PROPERTY of the page/element (never a Playwright call); Script Gen
 * maps each to a concrete `expect(...)` at emit time. Deliberately excludes
 * scenario-shaped values (`success`/`failure`/`login`/`logout`) — those are
 * SCENARIOS, not assertions.
 */
export type AssertionType =
  | 'url'
  | 'visible'
  | 'hidden'
  | 'enabled'
  | 'disabled'
  | 'checked'
  | 'unchecked'
  | 'text'
  | 'value'
  | 'count'
  | 'attribute';

/**
 * One authored entry of a scenario's canonical VERIFICATION set — the KB's
 * expression of "what must be TRUE after the actions run?". The Knowledge Base
 * owns this because it — not a natural-language `expectedResult` parser — is the
 * authority on what a valid login, a rejected login, or a logout PROVES.
 *
 * The builder turns each template entry into a graph `ScenarioAssertion` by
 * assigning a deterministic `id`/`order` from the array position — never
 * reordering, never translating the target/expected into the app's vocabulary.
 * Targets stay CANONICAL (`login_error`, `logout_button`) and `@page.*` /
 * `@messages.*` references stay symbolic; the Execution Resolver in Script Gen
 * grounds them to a concrete locator/URL/message at emit time. Deliberately
 * carries NO id/order (structural, assigned by the builder) and NO locator/CSS.
 */
export interface ScenarioAssertionTemplate {
  /** The checkable property (see {@link AssertionType}). */
  type: AssertionType;
  /**
   * Abstract SEMANTIC target — an element identity (e.g. `login_error`,
   * `logout_button`, `authenticated_landing`, `password`). Absent for page-level
   * checks (`url`). NEVER a locator or CSS selector.
   */
  target?: string;
  /**
   * Optional literal (`true`, `6`, `type=password`) OR a semantic reference the
   * Execution Resolver grounds: `@page.<name>` → a concrete URL/route, or
   * `@messages.<name>` → a concrete UI message. Structural types
   * (`visible`/`hidden`/…) need no `expected`.
   */
  expected?: string | number | boolean;
  /** When true the check is skipped if its target is absent in the app. */
  optional?: boolean;
  /**
   * Optional reference to the action this check runs *after* — the EXACT
   * `ScenarioAction.id` of a step in THIS scenario's `actionTemplate`
   * (`<scenarioId>.<action>.<target>`, e.g. `auth-pos-valid.click.login_button`).
   * The KB — the authority on the sequence — declares it; the builder copies it
   * VERBATIM onto the graph `ScenarioAssertion.afterAction`. It is identity, not
   * position: it is the step's ONE canonical id, never an array index and never a
   * separate slug — so a consumer resolves it with a plain
   * `node.actions.find(a => a.id === afterAction)`, no computation. Author it only
   * when the scenario HAS an `actionTemplate` to reference; omit it otherwise. The
   * qa-knowledge assertions invariant test rejects any afterAction that does not
   * match a real action id in the same scenario (no dangling references).
   */
  afterAction?: string;
}

/**
 * A single baseline scenario the category implies. This is the deterministic
 * "obligation" — the LLM later expands it into concrete, grounded test cases.
 */
export interface PlannedScenario {
  /** Stable id, unique within a category — used for telemetry + dedup. */
  id: string;
  /** Human-readable scenario title (what situation is under test). */
  title: string;
  /** What running this scenario PROVES (senior-QA objective). */
  objective: string;
  /** The coverage type this scenario belongs to — MUST be a valid CoverageType. */
  coverageType: CoverageType;
  /** Suggested priority; the LLM/user may override. */
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  /** The product risk this scenario guards against. */
  riskArea: string;
  /**
   * The category's PRIMARY happy-path. A core scenario is the direct expression
   * of the requirement itself (e.g. "valid login" for a login requirement), so
   * the Scenario Planner always derives it from the Requirement — it needs no
   * keyword evidence. Exactly one scenario per category should be `core`.
   */
  core?: boolean;
  /**
   * How this scenario earns its place, expressed as KNOWLEDGE (data), not policy.
   * The Knowledge Base describes the obligation; the Planner reads it and applies
   * one fixed, generic rule (see `getScenarioObligation`). Splitting the strength
   * (`level`) from the trigger (`condition`) lets the KB express new obligations —
   * "Password Expiry: required, on evidence", "OTP: optional, on evidence" —
   * WITHOUT inventing new tiers in code.
   *
   * When omitted, a sensible default is derived from the scenario's shape: a
   * `core` happy-path is {required, always}; anything else is {optional, evidence}
   * (planned only when its `conditionalOnKeywords` are recognised). Set this
   * explicitly for a category-universal obligation a senior QA engineer writes for
   * ANY feature of the category before reading the spec — e.g. "invalid credentials
   * rejected" and "required fields validated" for a credential login — by marking
   * it `{ level: 'required', condition: 'always' }`. Reserve `condition: 'always'`
   * for obligations that are genuinely category-universal and technology-independent;
   * anything depending on a specific mechanism, threshold or option stays `evidence`.
   */
  obligation?: ScenarioObligation;
  /**
   * The application-neutral scenario semantics (variable under test / valid
   * preconditions / single variation / expected behavior / required data role).
   * Authored here, next to the scenario definition, so every downstream consumer
   * reads ONE canonical answer instead of re-inferring it. When omitted,
   * `getScenarioSemantics` derives a safe default from the scenario's shape (see
   * that function) so uncurated categories keep working unchanged.
   */
  semantics?: ScenarioSemantics;
  /**
   * The canonical, ORDERED action sequence for this scenario (Open → Fill →
   * Click → Verify …). Authored here because the Knowledge Base — not a step
   * parser — is the authority on what a login/checkout/search fundamentally
   * DOES. When present the builder binds each abstract `target` to the app and
   * attaches the result to the node's `actions[]`, and Script Gen executes it
   * directly (no prose parsing). When omitted, `getScenarioActionTemplate`
   * returns `null` and Script Gen falls back to its legacy step parser — so this
   * is purely additive. The KB NEVER derives a sequence it was not authored with:
   * a guessed action sequence is worse than none.
   */
  actionTemplate?: ScenarioActionTemplate[];
  /**
   * The canonical VERIFICATION set for this scenario — what must be TRUE after
   * the actions run. Authored here because the Knowledge Base — not a prose
   * `expectedResult` parser — is the authority on what a valid login, a rejected
   * login, or a logout PROVES. When present the builder materializes each entry
   * onto the node's `assertions[]` and Script Gen renders them directly (no
   * inference). When omitted, `getScenarioAssertionTemplate` returns `null` and
   * Script Gen falls back to its legacy assertion inference — so this is purely
   * additive. Entries carry CANONICAL targets (`login_error`, `logout_button`)
   * and symbolic `@page.*` / `@messages.*` references; grounding them to concrete
   * locators/URLs/messages happens downstream (Execution Resolver), never here.
   */
  assertionTemplate?: ScenarioAssertionTemplate[];
  /**
   * Recognition vocabulary: lowercase terms that let this Knowledge layer
   * RECOGNISE the scenario in the explicit evidence (Acceptance Criteria,
   * Requirement description, App Knowledge, Test Data). A NON-core scenario is
   * derived ONLY when one of these terms appears in that evidence; if none do,
   * the scenario is NOT planned (the Planner never invents from coverage type
   * alone). The matching itself is performed by `recognizeScenarioEvidence` in
   * THIS module — the vocabulary and the matching are co-located here so the
   * Planner never has to know testing heuristics.
   */
  conditionalOnKeywords?: string[];
}

export interface QACategoryClassification {
  category: QACategory;
  /** 0-1 confidence from keyword-signal strength. */
  confidence: number;
  /** The concrete signals (matched keywords) that drove the classification. */
  matchedSignals: string[];
}

/* ---------------------------------------------------------------------------
 * Category detection — deterministic keyword signals.
 * Ordered by specificity: payment/checkout/auth are checked before the generic
 * CRUD/workflow buckets so a "checkout payment" requirement is not mis-bucketed
 * as CRUD just because it also "creates" an order.
 * ------------------------------------------------------------------------- */
interface CategorySignal {
  category: QACategory;
  /** Regexes over the lowercased requirement haystack; each match adds weight. */
  patterns: RegExp[];
  /** Base weight when at least one pattern matches (specificity prior). */
  weight: number;
}

const CATEGORY_SIGNALS: CategorySignal[] = [
  {
    category: 'payment',
    weight: 1.0,
    patterns: [/\bpayment\b/, /\bpay\b/, /\bcard\b/, /\bbilling\b/, /\binvoice\b/, /\btransaction\b/, /\brefund\b/, /\bstripe\b/, /\bwallet\b/, /\bcharge\b/],
  },
  {
    category: 'checkout',
    weight: 0.95,
    patterns: [/\bcheckout\b/, /\bcart\b/, /\border\b/, /\bshipping\b/, /\bplace order\b/, /\bpurchase\b/, /\bpromo\b/, /\bcoupon\b/, /\btax\b/],
  },
  {
    category: 'authentication',
    weight: 0.95,
    patterns: [/\blogin\b/, /\blog[\s-]?in\b/, /\bsign[\s-]?in\b/, /\bsign[\s-]?up\b/, /\bauth\b/, /\bauthenticat/, /\bpassword\b/, /\bcredential/, /\block(ed|out)?\b/, /\bsession\b/, /\b2fa\b/, /\botp\b/, /\bmfa\b/, /\blogout\b/, /\bregister\b/],
  },
  {
    category: 'search',
    weight: 0.9,
    patterns: [/\bsearch\b/, /\bfilter\b/, /\bquery\b/, /\bsort\b/, /\bautocomplete\b/, /\bsuggest/, /\bfacet\b/, /\bresults?\b/],
  },
  {
    category: 'reporting',
    weight: 0.85,
    patterns: [/\breport\b/, /\bdashboard\b/, /\banalytic/, /\bchart\b/, /\bmetric\b/, /\bkpi\b/, /\bsummary\b/, /\bstatistics?\b/],
  },
  {
    category: 'import',
    weight: 0.85,
    patterns: [/\bimport\b/, /\bupload\b/, /\bbulk (add|create|insert)\b/, /\bcsv upload\b/, /\bfile upload\b/, /\bingest/],
  },
  {
    category: 'export',
    weight: 0.85,
    patterns: [/\bexport\b/, /\bdownload\b/, /\bgenerate (csv|pdf|excel|xlsx|report file)\b/, /\bto csv\b/, /\bto pdf\b/],
  },
  {
    category: 'admin',
    weight: 0.8,
    patterns: [/\badmin\b/, /\brole\b/, /\bpermission/, /\baccess control\b/, /\brbac\b/, /\bmanage users?\b/, /\bprivilege/, /\bgrant\b/, /\brevoke\b/],
  },
  {
    category: 'workflow',
    weight: 0.75,
    patterns: [/\bworkflow\b/, /\bapproval\b/, /\bapprove\b/, /\breject\b/, /\bmulti[\s-]?step\b/, /\bwizard\b/, /\bstate machine\b/, /\bstatus transition\b/, /\bstage\b/],
  },
  {
    category: 'crud',
    weight: 0.7,
    patterns: [/\bcreate\b/, /\badd\b/, /\bedit\b/, /\bupdate\b/, /\bdelete\b/, /\bremove\b/, /\bform\b/, /\bsubmit\b/, /\bsave\b/, /\brecord\b/, /\bentry\b/, /\bregistration form\b/],
  },
];

/**
 * Classify a requirement into a QA category using cheap keyword signals. Pure,
 * synchronous, ZERO LLM tokens. Falls back to `generic` (confidence 0) when no
 * category matches — the planner then emits no baseline plan.
 *
 * @param input          The requirement.
 * @param featureTypeHint Optional hint from an upstream analysis (e.g.
 *                        RequirementAnalysis.featureType) — nudges the score.
 */
export function classifyQACategory(
  input: Pick<RequirementInput, 'title' | 'description' | 'module' | 'businessFlow' | 'acceptanceCriteria'>,
  featureTypeHint?: string,
): QACategoryClassification {
  const hay = [
    input.title,
    input.description,
    input.module,
    input.businessFlow,
    input.acceptanceCriteria,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  // Score every category; keep the strongest.
  let best: QACategoryClassification = { category: 'generic', confidence: 0, matchedSignals: [] };
  let bestRaw = 0;

  for (const sig of CATEGORY_SIGNALS) {
    const matched: string[] = [];
    for (const p of sig.patterns) {
      const m = hay.match(p);
      if (m) matched.push(m[0].trim());
    }
    if (matched.length === 0) continue;

    // Raw score: base weight + diminishing bonus per extra distinct signal.
    const distinct = Array.from(new Set(matched));
    let raw = sig.weight + Math.min(0.3, (distinct.length - 1) * 0.1);

    // Feature-type hint alignment nudges the matching category up.
    if (featureTypeHint) {
      const hint = featureTypeHint.toLowerCase();
      const aligns =
        (sig.category === 'authentication' && /auth/.test(hint)) ||
        (sig.category === 'payment' && /pay|billing/.test(hint)) ||
        (sig.category === 'search' && /search/.test(hint)) ||
        (sig.category === 'reporting' && /report|dashboard|analytic/.test(hint)) ||
        (sig.category === 'crud' && /data_entry|form|crud/.test(hint));
      if (aligns) raw += 0.15;
    }

    if (raw > bestRaw) {
      bestRaw = raw;
      best = {
        category: sig.category,
        // Squash raw score into a 0-1 confidence (cap at 1).
        confidence: Math.min(1, Math.round(raw * 100) / 100),
        matchedSignals: distinct,
      };
    }
  }

  return best;
}

/* ---------------------------------------------------------------------------
 * The knowledge base — baseline scenario obligations per category.
 * Each scenario is tagged with the coverage type it belongs to; the Scenario
 * Planner filters these against the user's SELECTED coverage types.
 * ------------------------------------------------------------------------- */
export const QA_KNOWLEDGE_BASE: Record<Exclude<QACategory, 'generic'>, PlannedScenario[]> = {
  authentication: [
    { id: 'auth-pos-valid', title: 'Valid credentials log in successfully', objective: 'A registered user with correct credentials is authenticated and lands in the authenticated area.', coverageType: 'positive', priority: 'P0', riskArea: 'Authentication / access', core: true,
      semantics: { variableUnderTest: 'none', preconditions: 'a registered user with the correct username and correct password', variation: 'none — all credentials are valid', expectedBehavior: 'authentication succeeds and the user reaches the authenticated landing page', requiredDataRole: 'registered_user' },
      actionTemplate: [
        { action: 'navigate', target: 'login_page' },
        { action: 'fill', target: 'username', value: '@dataset.username' },
        { action: 'fill', target: 'password', value: '@dataset.password' },
        { action: 'click', target: 'login_button' },
      ],
      assertionTemplate: [
        { type: 'url', expected: '@page.inventory', afterAction: 'auth-pos-valid.click.login_button' },
        { type: 'visible', target: 'authenticated_landing', afterAction: 'auth-pos-valid.click.login_button' },
      ] },
    { id: 'auth-neg-wrong-password', title: 'Invalid password is rejected', objective: 'A wrong password does not authenticate and a clear, non-leaking error is shown.', coverageType: 'negative', priority: 'P0', riskArea: 'Unauthorized access', obligation: { level: 'required', condition: 'always' },
      semantics: { variableUnderTest: 'password', preconditions: 'a registered user with the correct username and correct password', variation: 'the password is replaced with an incorrect value (the username stays valid)', expectedBehavior: 'authentication is rejected with a generic error and the user stays on the login page', requiredDataRole: 'registered_user' },
      actionTemplate: [
        { action: 'navigate', target: 'login_page' },
        { action: 'fill', target: 'username', value: '@dataset.username' },
        { action: 'fill', target: 'password', value: 'wrong-password' },
        { action: 'click', target: 'login_button' },
      ],
      assertionTemplate: [
        { type: 'visible', target: 'login_error', afterAction: 'auth-neg-wrong-password.click.login_button' },
        { type: 'text', target: 'login_error', expected: '@messages.invalid_credentials', afterAction: 'auth-neg-wrong-password.click.login_button' },
        { type: 'url', expected: '@page.login', afterAction: 'auth-neg-wrong-password.click.login_button' },
      ] },
    { id: 'auth-neg-empty-fields', title: 'Empty required fields are rejected', objective: 'Submitting with blank username and/or password is blocked with field-level validation.', coverageType: 'negative', priority: 'P1', riskArea: 'Input validation', obligation: { level: 'required', condition: 'always' },
      semantics: { variableUnderTest: 'a required field', preconditions: 'a registered user with the correct username and correct password', variation: 'exactly ONE required field is left blank while the other stays valid', expectedBehavior: 'field-level validation blocks submission before authentication is attempted', requiredDataRole: 'registered_user' },
      actionTemplate: [
        { action: 'navigate', target: 'login_page' },
        { action: 'fill', target: 'username', value: '@dataset.username' },
        { action: 'click', target: 'login_button' },
      ],
      assertionTemplate: [
        { type: 'visible', target: 'login_error', afterAction: 'auth-neg-empty-fields.click.login_button' },
        { type: 'text', target: 'login_error', expected: '@messages.password_required', afterAction: 'auth-neg-empty-fields.click.login_button' },
        { type: 'url', expected: '@page.login', afterAction: 'auth-neg-empty-fields.click.login_button' },
      ] },
    { id: 'auth-neg-unknown-user', title: 'Unknown / non-existent user is rejected', objective: 'An unregistered identifier cannot authenticate and the error does not reveal whether the account exists.', coverageType: 'negative', priority: 'P1', riskArea: 'Account enumeration', conditionalOnKeywords: ['unknown', 'non-existent', 'nonexistent', 'not registered', 'unregistered', 'enumerat', 'no account', 'does not exist'],
      semantics: { variableUnderTest: 'username', preconditions: 'a valid password paired with a registered username', variation: 'the username is replaced with an unregistered identifier (the password stays valid)', expectedBehavior: 'authentication is rejected with a non-enumerating error that does not reveal whether the account exists', requiredDataRole: 'unregistered_user' },
      // The username is an unregistered SENTINEL the KB owns (never a real record),
      // so the graph — not Script Gen's step inference — decides what "unknown
      // user" means. The password stays valid (@dataset) so ONLY the identifier
      // is the variable under test.
      actionTemplate: [
        { action: 'navigate', target: 'login_page' },
        { action: 'fill', target: 'username', value: 'unregistered_user' },
        { action: 'fill', target: 'password', value: '@dataset.password' },
        { action: 'click', target: 'login_button' },
      ],
      assertionTemplate: [
        { type: 'visible', target: 'login_error', afterAction: 'auth-neg-unknown-user.click.login_button' },
        { type: 'text', target: 'login_error', expected: '@messages.invalid_credentials', afterAction: 'auth-neg-unknown-user.click.login_button' },
        { type: 'url', expected: '@page.login', afterAction: 'auth-neg-unknown-user.click.login_button' },
      ] },
    { id: 'auth-neg-locked-user', title: 'Locked / disabled account cannot log in', objective: 'A locked or disabled account is refused even with correct credentials.', coverageType: 'negative', priority: 'P1', riskArea: 'Account state enforcement', conditionalOnKeywords: ['lock', 'disable', 'suspend', 'attempt'],
      semantics: { variableUnderTest: 'account state', preconditions: 'a registered user with the correct username and correct password', variation: 'the account is in a locked / disabled state while the credentials remain correct', expectedBehavior: 'authentication is refused with a locked/disabled-account message despite correct credentials', requiredDataRole: 'locked_account' },
      assertionTemplate: [
        { type: 'visible', target: 'login_error' },
        { type: 'text', target: 'login_error', expected: '@messages.locked_out' },
        { type: 'url', expected: '@page.login' },
      ] },
    { id: 'auth-edge-whitespace-case', title: 'Whitespace / case handling on identifier', objective: 'Leading/trailing whitespace is trimmed and identifier case is handled per the rule (case-insensitive email, etc.).', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Input normalization', conditionalOnKeywords: ['whitespace', 'trim', 'case-insensitive', 'case sensitive', 'case-sensitive', 'lowercase', 'uppercase', 'normali'],
      semantics: { variableUnderTest: 'identifier formatting', preconditions: 'a registered user with the correct username and correct password', variation: 'only the identifier formatting is altered (surrounding whitespace or letter case) while the underlying value stays correct', expectedBehavior: 'the identifier is normalized per the rule and authentication succeeds as if entered cleanly', requiredDataRole: 'registered_user' },
      assertionTemplate: [
        { type: 'url', expected: '@page.inventory' },
        { type: 'visible', target: 'authenticated_landing' },
      ] },
    { id: 'auth-neg-invalid-identifier-format', title: 'Malformed identifier format is rejected', objective: 'A malformed identifier (missing @, spaces, or invalid characters in an email login) is rejected with field-level validation before authentication is attempted.', coverageType: 'negative', priority: 'P2', riskArea: 'Input validation', conditionalOnKeywords: ['email', 'format', 'malformed', 'valid email', 'invalid email', 'identifier'],
      semantics: { variableUnderTest: 'identifier format', preconditions: 'a valid password paired with a well-formed registered identifier', variation: 'the identifier is replaced with a malformed value (e.g. missing @ / invalid characters) while the password stays valid', expectedBehavior: 'field-level format validation rejects it before authentication is attempted', requiredDataRole: 'registered_user' },
      assertionTemplate: [
        { type: 'visible', target: 'login_error' },
        { type: 'url', expected: '@page.login' },
      ] },
    { id: 'auth-sec-injection', title: 'Injection-style credentials are handled safely', objective: 'SQL/script injection strings in the username or password neither authenticate nor error out — they are treated as ordinary invalid input.', coverageType: 'security', priority: 'P1', riskArea: 'Injection safety', conditionalOnKeywords: ['injection', 'sql', 'script', 'xss', 'saniti', 'malicious', 'special character'],
      semantics: { variableUnderTest: 'input payload', preconditions: 'a valid credential pair entered into the login form', variation: 'one credential field carries an SQL/script injection payload instead of an ordinary value', expectedBehavior: 'the payload neither authenticates nor triggers an error/crash — it is treated as ordinary invalid input', requiredDataRole: 'registered_user' },
      assertionTemplate: [
        { type: 'visible', target: 'login_error' },
        { type: 'url', expected: '@page.login' },
      ] },
    { id: 'auth-edge-password-masking', title: 'Password input is masked and not exposed', objective: 'The password field masks entry and the value is not exposed in the DOM, page source, autocomplete, or logs.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Credential exposure', conditionalOnKeywords: ['mask', 'masked', 'hidden', 'plain text', 'plaintext', 'visible', 'obscure', 'autocomplete'],
      semantics: { variableUnderTest: 'none (UI/security property observation)', preconditions: 'a user typing a correct password into the login form', variation: 'none — the entered value is observed, not changed', expectedBehavior: 'the password is masked on screen and never exposed in the DOM, page source, autocomplete, or logs', requiredDataRole: 'registered_user' },
      assertionTemplate: [
        { type: 'attribute', target: 'password', expected: 'type=password' },
      ] },
    { id: 'auth-sec-lockout-threshold', title: 'Account lockout after repeated failures', objective: 'After the configured number of failed attempts the account is locked / throttled.', coverageType: 'security', priority: 'P1', riskArea: 'Brute-force resistance', conditionalOnKeywords: ['lock', 'attempt', 'brute', 'throttle', 'rate'],
      semantics: { variableUnderTest: 'number of consecutive failed attempts', preconditions: 'a registered account with correct credentials available', variation: 'authentication is attempted with a wrong password repeatedly up to and past the configured threshold', expectedBehavior: 'after the threshold the account is locked / throttled and further attempts are refused', requiredDataRole: 'registered_user' },
      assertionTemplate: [
        { type: 'visible', target: 'login_error' },
        { type: 'text', target: 'login_error', expected: '@messages.locked_out' },
        { type: 'url', expected: '@page.login' },
      ] },
    { id: 'auth-sec-session', title: 'Session established and protected', objective: 'A session/token is issued on login and protected resources reject requests without it.', coverageType: 'security', priority: 'P1', riskArea: 'Session management', conditionalOnKeywords: ['session', 'token', 'timeout', 'expire'],
      semantics: { variableUnderTest: 'presence of a valid session', preconditions: 'a user who has logged in successfully and holds a valid session/token', variation: 'a protected resource is requested WITHOUT the valid session/token', expectedBehavior: 'the request without a session is rejected while the authenticated session can reach the resource', requiredDataRole: 'registered_user' },
      assertionTemplate: [
        { type: 'url', expected: '@page.login' },
      ] },
    { id: 'auth-pos-remember-me', title: 'Remember-me persists the session', objective: 'When remember-me is selected the session persists across browser restarts per policy.', coverageType: 'positive', priority: 'P2', riskArea: 'Session persistence', conditionalOnKeywords: ['remember'],
      semantics: { variableUnderTest: 'remember-me option', preconditions: 'a valid login with the remember-me option left unselected', variation: 'the remember-me option is selected at login (credentials stay valid)', expectedBehavior: 'the session persists across a browser restart per the remember-me policy', requiredDataRole: 'registered_user' },
      assertionTemplate: [
        { type: 'url', expected: '@page.inventory' },
        { type: 'visible', target: 'authenticated_landing' },
      ] },
    { id: 'auth-pos-logout', title: 'Logout ends the session', objective: 'Logging out invalidates the session and protected pages are no longer reachable.', coverageType: 'positive', priority: 'P1', riskArea: 'Session termination', conditionalOnKeywords: ['logout', 'log out', 'sign out', 'session'],
      semantics: { variableUnderTest: 'session validity after logout', preconditions: 'a user logged in with a valid, active session', variation: 'the user logs out, then a protected page is requested with the now-ended session', expectedBehavior: 'the session is invalidated and protected pages are no longer reachable', requiredDataRole: 'registered_user' },
      assertionTemplate: [
        { type: 'url', expected: '@page.login' },
        { type: 'visible', target: 'login_button' },
      ] },
  ],
  crud: [
    { id: 'crud-pos-create', title: 'Create a record with valid data', objective: 'A record is created and persisted with valid input and confirmation is shown.', coverageType: 'positive', priority: 'P0', riskArea: 'Data creation', core: true },
    { id: 'crud-pos-read', title: 'Read / view an existing record', objective: 'A created record is retrievable and displays the persisted values.', coverageType: 'positive', priority: 'P1', riskArea: 'Data retrieval' },
    { id: 'crud-pos-update', title: 'Update an existing record', objective: 'Editing a record persists the change and reflects it on next read.', coverageType: 'positive', priority: 'P0', riskArea: 'Data mutation' },
    { id: 'crud-pos-delete', title: 'Delete a record', objective: 'Deleting a record removes it and it is no longer retrievable.', coverageType: 'positive', priority: 'P1', riskArea: 'Data deletion' },
    { id: 'crud-neg-required-fields', title: 'Missing required fields are rejected', objective: 'Create/update with blank required fields is blocked with validation messaging.', coverageType: 'negative', priority: 'P0', riskArea: 'Input validation' },
    { id: 'crud-neg-invalid-format', title: 'Invalid field formats are rejected', objective: 'Wrong types/formats (email, number, date) are rejected with field-level errors.', coverageType: 'negative', priority: 'P1', riskArea: 'Data integrity' },
    { id: 'crud-neg-duplicate', title: 'Duplicate / unique-constraint violation is handled', objective: 'Creating a record that violates a uniqueness rule is rejected clearly.', coverageType: 'negative', priority: 'P2', riskArea: 'Data integrity', conditionalOnKeywords: ['unique', 'duplicate', 'exists', 'already'] },
    { id: 'crud-edge-boundary-lengths', title: 'Field length / value boundaries', objective: 'Min/max lengths and numeric limits behave correctly at, below and above the boundary.', coverageType: 'boundary', priority: 'P2', riskArea: 'Boundary handling' },
    { id: 'crud-neg-delete-nonexistent', title: 'Operate on a non-existent / already-deleted record', objective: 'Update/delete of a missing record fails gracefully (404/appropriate message).', coverageType: 'negative', priority: 'P2', riskArea: 'State handling' },
  ],
  search: [
    { id: 'search-pos-match', title: 'Search returns matching results', objective: 'A query with known matches returns the expected results.', coverageType: 'positive', priority: 'P0', riskArea: 'Search correctness', core: true },
    { id: 'search-pos-no-results', title: 'No-results state for non-matching query', objective: 'A query with no matches shows a clear empty state, not an error.', coverageType: 'positive', priority: 'P1', riskArea: 'Empty-state handling' },
    { id: 'search-edge-empty-query', title: 'Empty / whitespace-only query', objective: 'An empty or whitespace query is handled per spec (all results, prompt, or blocked).', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Input handling' },
    { id: 'search-edge-special-chars', title: 'Special characters / injection-like input', objective: 'Special characters and injection-like strings are handled safely and do not break search.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Robustness' },
    { id: 'search-pos-filters', title: 'Filters / facets narrow results', objective: 'Applying and combining filters narrows results correctly and clearing restores them.', coverageType: 'positive', priority: 'P1', riskArea: 'Filtering correctness', conditionalOnKeywords: ['filter', 'facet', 'refine'] },
    { id: 'search-pos-sort', title: 'Sorting orders results correctly', objective: 'Each sort option orders the results as specified and is stable.', coverageType: 'positive', priority: 'P2', riskArea: 'Sort correctness', conditionalOnKeywords: ['sort', 'order by', 'ascending', 'descending'] },
    { id: 'search-pos-pagination', title: 'Pagination navigates result pages', objective: 'Page navigation shows the correct slice with no duplicates or gaps.', coverageType: 'positive', priority: 'P2', riskArea: 'Pagination', conditionalOnKeywords: ['page', 'pagination', 'load more', 'infinite'] },
    { id: 'search-perf-large', title: 'Search performance on large datasets', objective: 'Query returns within the acceptable time on a realistically large dataset.', coverageType: 'performance', priority: 'P2', riskArea: 'Performance at scale' },
  ],
  checkout: [
    { id: 'checkout-pos-happy', title: 'Complete checkout with valid cart', objective: 'A user completes checkout end-to-end and receives an order confirmation.', coverageType: 'positive', priority: 'P0', riskArea: 'Revenue / order completion', core: true },
    { id: 'checkout-neg-empty-cart', title: 'Checkout blocked for empty cart', objective: 'Attempting checkout with an empty cart is prevented with clear messaging.', coverageType: 'negative', priority: 'P1', riskArea: 'Order integrity' },
    { id: 'checkout-neg-invalid-address', title: 'Invalid / incomplete shipping address is rejected', objective: 'Missing or invalid address fields block progression with validation.', coverageType: 'negative', priority: 'P1', riskArea: 'Fulfilment integrity' },
    { id: 'checkout-edge-out-of-stock', title: 'Out-of-stock item during checkout', objective: 'An item going out of stock mid-checkout is surfaced and handled gracefully.', coverageType: 'edge_cases', priority: 'P1', riskArea: 'Inventory consistency', conditionalOnKeywords: ['stock', 'inventory', 'availability'] },
    { id: 'checkout-pos-promo', title: 'Valid promo / coupon is applied', objective: 'A valid promo code adjusts the total correctly.', coverageType: 'positive', priority: 'P2', riskArea: 'Pricing correctness', conditionalOnKeywords: ['promo', 'coupon', 'discount'] },
    { id: 'checkout-neg-invalid-promo', title: 'Invalid / expired promo is rejected', objective: 'An invalid or expired promo code is rejected without changing the total.', coverageType: 'negative', priority: 'P2', riskArea: 'Pricing integrity', conditionalOnKeywords: ['promo', 'coupon', 'discount'] },
    { id: 'checkout-pos-tax-shipping', title: 'Tax and shipping calculated correctly', objective: 'Tax and shipping are computed and reflected in the order total.', coverageType: 'positive', priority: 'P1', riskArea: 'Pricing correctness', conditionalOnKeywords: ['tax', 'shipping'] },
    { id: 'checkout-edge-interrupt-resume', title: 'Interrupted checkout can be resumed', objective: 'Abandoning and returning to checkout preserves cart/progress per spec.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Flow resilience' },
    { id: 'checkout-int-payment', title: 'Payment integration completes the order', objective: 'A successful payment transitions the order to confirmed/paid.', coverageType: 'integration', priority: 'P0', riskArea: 'Payment-order consistency' },
  ],
  payment: [
    { id: 'pay-pos-success', title: 'Successful payment with valid card', objective: 'A valid payment is authorised and captured and the order/record is marked paid.', coverageType: 'positive', priority: 'P0', riskArea: 'Revenue capture', core: true },
    { id: 'pay-neg-declined', title: 'Declined card is handled', objective: 'A declined card shows a clear error and does not mark the order paid.', coverageType: 'negative', priority: 'P0', riskArea: 'Payment integrity' },
    { id: 'pay-neg-expired-card', title: 'Expired / invalid card details are rejected', objective: 'Expired or malformed card details are rejected at validation.', coverageType: 'negative', priority: 'P1', riskArea: 'Payment validation' },
    { id: 'pay-edge-insufficient-funds', title: 'Insufficient funds', objective: 'An insufficient-funds response is surfaced and the order is not completed.', coverageType: 'edge_cases', priority: 'P1', riskArea: 'Payment integrity' },
    { id: 'pay-sec-no-sensitive-data', title: 'No sensitive card data is exposed / stored', objective: 'Full PAN/CVV are never logged, displayed, or stored (PCI hygiene).', coverageType: 'security', priority: 'P0', riskArea: 'PCI / data exposure' },
    { id: 'pay-edge-double-submit', title: 'Duplicate submission does not double-charge', objective: 'Re-submitting or a network retry does not create a duplicate charge (idempotency).', coverageType: 'edge_cases', priority: 'P0', riskArea: 'Double-charge / financial correctness' },
    { id: 'pay-pos-refund', title: 'Refund processes correctly', objective: 'A refund returns the correct amount and updates the transaction state.', coverageType: 'positive', priority: 'P1', riskArea: 'Refund correctness', conditionalOnKeywords: ['refund', 'return', 'chargeback'] },
    { id: 'pay-int-timeout', title: 'Gateway timeout / failure is handled', objective: 'A gateway timeout leaves the system in a consistent state (no orphaned paid order).', coverageType: 'integration', priority: 'P1', riskArea: 'Payment-order consistency' },
  ],
  admin: [
    { id: 'admin-pos-authorized', title: 'Authorized admin can perform the action', objective: 'A user with the required role completes the privileged action successfully.', coverageType: 'positive', priority: 'P0', riskArea: 'Authorized access', core: true },
    { id: 'admin-sec-unauthorized', title: 'Unauthorized role is denied', objective: 'A user without the required role/permission is denied (403) and no state changes.', coverageType: 'role_based', priority: 'P0', riskArea: 'Privilege escalation' },
    { id: 'admin-sec-direct-access', title: 'Direct URL/API access is enforced', objective: 'Bypassing the UI by hitting the endpoint/URL directly is still authorization-checked.', coverageType: 'security', priority: 'P1', riskArea: 'Broken access control' },
    { id: 'admin-pos-grant-revoke', title: 'Granting and revoking access take effect', objective: 'Granting a permission enables the action and revoking it disables the action.', coverageType: 'positive', priority: 'P1', riskArea: 'Access-control correctness', conditionalOnKeywords: ['grant', 'revoke', 'permission', 'role'] },
    { id: 'admin-neg-invalid-target', title: 'Managing a non-existent / invalid target user', objective: 'Acting on a missing or invalid target is handled gracefully.', coverageType: 'negative', priority: 'P2', riskArea: 'State handling' },
    { id: 'admin-edge-self-lockout', title: 'Admin cannot lock themselves out', objective: 'Removing the last admin / self-revoking critical access is prevented or warned.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Operational safety', conditionalOnKeywords: ['admin', 'role', 'last'] },
  ],
  workflow: [
    { id: 'wf-pos-happy-path', title: 'Complete the workflow end-to-end', objective: 'The multi-step workflow completes through every stage to the terminal state.', coverageType: 'positive', priority: 'P0', riskArea: 'Process completion', core: true },
    { id: 'wf-pos-valid-transition', title: 'Valid state transitions are allowed', objective: 'Each permitted stage-to-stage transition succeeds and updates state.', coverageType: 'positive', priority: 'P1', riskArea: 'State-machine correctness' },
    { id: 'wf-neg-invalid-transition', title: 'Invalid state transitions are blocked', objective: 'A transition not permitted from the current stage is rejected.', coverageType: 'negative', priority: 'P0', riskArea: 'State-machine integrity' },
    { id: 'wf-pos-approve', title: 'Approval advances the workflow', objective: 'An approver approving moves the item to the next stage.', coverageType: 'positive', priority: 'P1', riskArea: 'Approval correctness', conditionalOnKeywords: ['approve', 'approval'] },
    { id: 'wf-neg-reject', title: 'Rejection routes correctly', objective: 'Rejecting sends the item to the correct stage (back/terminated) per spec.', coverageType: 'negative', priority: 'P1', riskArea: 'Routing correctness', conditionalOnKeywords: ['reject', 'decline', 'deny'] },
    { id: 'wf-role-permissions', title: 'Only permitted roles can action a stage', objective: 'A user without the stage role cannot perform that stage action.', coverageType: 'role_based', priority: 'P1', riskArea: 'Segregation of duties', conditionalOnKeywords: ['role', 'approver', 'permission'] },
    { id: 'wf-edge-interrupt-resume', title: 'Interrupted workflow resumes correctly', objective: 'Leaving mid-workflow and returning preserves progress/state.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Flow resilience' },
  ],
  reporting: [
    { id: 'rep-pos-accurate', title: 'Report shows accurate data', objective: 'Figures/aggregations match the underlying source data for a known dataset.', coverageType: 'positive', priority: 'P0', riskArea: 'Data accuracy', core: true },
    { id: 'rep-pos-filters', title: 'Filters / date ranges scope the report', objective: 'Applying filters and date ranges scopes the results correctly.', coverageType: 'positive', priority: 'P1', riskArea: 'Filtering correctness', conditionalOnKeywords: ['filter', 'date range', 'range', 'period'] },
    { id: 'rep-edge-empty', title: 'Empty-data / no-rows state', objective: 'A report with no matching data shows a clear empty state, not an error or zeros mistaken for data.', coverageType: 'edge_cases', priority: 'P1', riskArea: 'Empty-state handling' },
    { id: 'rep-edge-large', title: 'Large-dataset rendering', objective: 'A large result set renders/paginates without failure within acceptable time.', coverageType: 'performance', priority: 'P2', riskArea: 'Performance at scale' },
    { id: 'rep-role-visibility', title: 'Data visibility respects role/tenant', objective: 'A user only sees data their role/tenant is entitled to.', coverageType: 'role_based', priority: 'P1', riskArea: 'Data isolation', conditionalOnKeywords: ['role', 'tenant', 'permission', 'scope'] },
    { id: 'rep-pos-export', title: 'Report export matches on-screen data', objective: 'Exported file content matches the displayed/ filtered report.', coverageType: 'positive', priority: 'P2', riskArea: 'Export fidelity', conditionalOnKeywords: ['export', 'download', 'csv', 'pdf', 'excel'] },
  ],
  import: [
    { id: 'imp-pos-valid-file', title: 'Import a valid file successfully', objective: 'A well-formed file imports all rows and reports success counts.', coverageType: 'positive', priority: 'P0', riskArea: 'Data ingestion', core: true },
    { id: 'imp-neg-invalid-format', title: 'Reject unsupported file format', objective: 'An unsupported file type/extension is rejected with a clear message.', coverageType: 'negative', priority: 'P1', riskArea: 'Input validation' },
    { id: 'imp-neg-malformed-rows', title: 'Handle malformed / partial rows', objective: 'Invalid rows are reported (row-level errors) without corrupting valid rows per spec.', coverageType: 'negative', priority: 'P0', riskArea: 'Data integrity' },
    { id: 'imp-edge-empty-file', title: 'Empty file / no data rows', objective: 'An empty file or header-only file is handled gracefully.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Edge handling' },
    { id: 'imp-boundary-large-file', title: 'Large-file / max-size boundary', objective: 'Files at, below and above the size/row limit behave per spec.', coverageType: 'boundary', priority: 'P2', riskArea: 'Boundary handling' },
    { id: 'imp-edge-duplicate-rows', title: 'Duplicate rows within / across imports', objective: 'Duplicate rows are deduped/flagged per the defined rule.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Data integrity', conditionalOnKeywords: ['duplicate', 'unique', 'dedup'] },
    { id: 'imp-sec-malicious-content', title: 'Malicious content is handled safely', objective: 'Formula-injection/script content in cells is neutralised (no CSV injection).', coverageType: 'security', priority: 'P2', riskArea: 'Injection safety' },
  ],
  export: [
    { id: 'exp-pos-content', title: 'Exported file content is correct', objective: 'The exported file contains exactly the expected rows/columns for the current view/filters.', coverageType: 'positive', priority: 'P0', riskArea: 'Export fidelity', core: true },
    { id: 'exp-pos-format', title: 'Export produces the correct format', objective: 'The generated file is valid and opens in the target format (CSV/PDF/XLSX).', coverageType: 'positive', priority: 'P1', riskArea: 'Format correctness' },
    { id: 'exp-edge-empty', title: 'Export with no data', objective: 'Exporting an empty result yields a valid file with headers / a clear empty state.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Empty-state handling' },
    { id: 'exp-edge-special-chars', title: 'Special characters / encoding are preserved', objective: 'Unicode, commas, quotes and newlines are escaped/encoded correctly.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Encoding correctness' },
    { id: 'exp-perf-large', title: 'Large-dataset export', objective: 'A large export completes within acceptable time without truncation.', coverageType: 'performance', priority: 'P2', riskArea: 'Performance at scale' },
    { id: 'exp-role-scope', title: 'Export respects role/tenant scope', objective: 'A user can only export data their role/tenant is entitled to.', coverageType: 'role_based', priority: 'P1', riskArea: 'Data isolation', conditionalOnKeywords: ['role', 'tenant', 'permission', 'scope'] },
  ],
};

/** Convenience: baseline scenarios for a category ([] for `generic`). */
export function getBaselineScenarios(category: QACategory): PlannedScenario[] {
  if (category === 'generic') return [];
  return QA_KNOWLEDGE_BASE[category] ?? [];
}

/**
 * Resolve a baseline scenario's obligation — the Knowledge Base telling the
 * Planner HOW the scenario earns its place. The Planner never decides this; it
 * reads the returned {level, condition} and applies one fixed rule.
 *
 * Explicit `obligation` metadata always wins. When absent, a default is derived
 * from the scenario's shape so uncurated categories keep working unchanged:
 *   • a `core` happy-path        → { required, always }  (the requirement itself)
 *   • everything else            → { optional, evidence } (planned only when its
 *                                    `conditionalOnKeywords` are recognised)
 *
 * Keeping this in the KB (not the Planner) is the whole point of Model C: domain
 * obligations live with the domain knowledge, expressed as data — no code tiers.
 */
export function getScenarioObligation(scenario: PlannedScenario): ScenarioObligation {
  if (scenario.obligation) return scenario.obligation;
  if (scenario.core) return { level: 'required', condition: 'always' };
  return { level: 'optional', condition: 'evidence' };
}

/**
 * Resolve a scenario's application-neutral SEMANTICS — the canonical answer to
 * "what does this scenario fundamentally mean?" that downstream consumers (Test
 * Case Lab, Script Gen, Healing, Dataset Resolver) should read instead of
 * re-inferring from the title.
 *
 * This is a pure KB lookup with a safe fallback — NOT inference. Authored
 * `semantics` always wins. When a scenario has not been curated yet, a default
 * is DERIVED from its shape so uncurated categories keep working unchanged and
 * no consumer ever receives `undefined`:
 *   • a `core`/positive happy-path → nothing is varied (`variation: 'none'`),
 *     expecting the primary success behavior.
 *   • anything else                → a generic single-variable placeholder that
 *     names the objective as the behavior, so the shape is always present even
 *     before the scenario is authored in detail.
 *
 * The default is intentionally generic (not a guess at specifics): its job is to
 * keep the contract total, not to invent domain meaning. Authoring real
 * semantics in the Knowledge Base is what makes it precise.
 */
export function getScenarioSemantics(scenario: PlannedScenario): ScenarioSemantics {
  if (scenario.semantics) return scenario.semantics;
  const isHappyPath = scenario.core === true || scenario.coverageType === 'positive';
  if (isHappyPath) {
    return {
      variableUnderTest: 'none',
      preconditions: 'all inputs and preconditions set to valid values',
      variation: 'none — the primary success path is exercised',
      expectedBehavior: scenario.objective,
      requiredDataRole: 'valid_data',
    };
  }
  return {
    variableUnderTest: 'the condition described by the scenario objective',
    preconditions: 'all inputs and preconditions set to valid values',
    variation: 'the single condition under test is applied while everything else stays valid',
    expectedBehavior: scenario.objective,
    requiredDataRole: 'valid_data',
  };
}

/**
 * Resolve a scenario's canonical, ordered ACTION TEMPLATE — the KB's answer to
 * "what does the browser do, step by step?" that Script Gen executes directly
 * instead of parsing it back out of prose.
 *
 * This is a pure KB lookup — NOT inference, and CRUCIALLY NOT a fallible default.
 * Unlike `getScenarioSemantics` (which can synthesise a safe generic default
 * because a vague-but-correct meaning is harmless), an action sequence is only
 * useful if it is RIGHT: a guessed sequence would make Script Gen emit wrong
 * automation. So this returns the authored template when present and `null`
 * otherwise — the KB never invents a sequence. On `null`, Script Gen keeps using
 * its legacy step parser, so uncurated scenarios are unaffected.
 *
 * The returned steps carry CANONICAL targets (`username`, `login_button`, …) and
 * symbolic `@dataset.*` values; grounding targets to the app and resolving
 * dataset values happens downstream (Execution Resolver in Script Gen), never here.
 */
export function getScenarioActionTemplate(scenario: PlannedScenario): ScenarioActionTemplate[] | null {
  if (scenario.actionTemplate && scenario.actionTemplate.length > 0) {
    return scenario.actionTemplate;
  }
  return null;
}

/**
 * Resolve a scenario's canonical VERIFICATION set — the KB's answer to "what must
 * be TRUE after the actions run?" that Script Gen renders directly instead of
 * inferring it back out of the natural-language `expectedResult`.
 *
 * Like {@link getScenarioActionTemplate}, this is a pure KB lookup — NOT inference
 * and NOT a fallible default. A guessed assertion is worse than none: it would make
 * Script Gen assert the wrong thing and pass/fail for the wrong reason. So this
 * returns the authored template when present and `null` otherwise — the KB never
 * invents a check. On `null`, Script Gen keeps using its legacy assertion inference,
 * so uncurated scenarios are unaffected.
 *
 * The returned entries carry CANONICAL targets (`login_error`, `logout_button`, …)
 * and symbolic `@page.*` / `@messages.*` references; grounding targets to the app
 * and resolving those references to concrete URLs/messages happens downstream
 * (Execution Resolver in Script Gen), never here.
 */
export function getScenarioAssertionTemplate(scenario: PlannedScenario): ScenarioAssertionTemplate[] | null {
  if (scenario.assertionTemplate && scenario.assertionTemplate.length > 0) {
    return scenario.assertionTemplate;
  }
  return null;
}

/**
 * Action-template coverage RATCHET — the guard against "semantics for 14, actions
 * for 3" drift.
 *
 * The rule we hold: within a module, a scenario that has authored SEMANTICS should
 * eventually also have an authored ACTION TEMPLATE. We are rolling that out module
 * by module and `authentication` FIRST. The scenarios below are the ones in the
 * authentication catalog that are KNOWINGLY not yet authored, each with the reason
 * it cannot be expressed with the current, frozen action grammar
 * (`{action, target, value?, optional?}`) — they need a richer value/flow
 * vocabulary (value transforms, repetition, multi-phase flows) that is out of
 * scope for 2D.3. This list is asserted EXACTLY by
 * `tests/unit/qa-knowledge-actions-invariant.test.ts`, so:
 *   • authoring a pending scenario fails the test until it is removed here
 *     (the list can only SHRINK — coverage can never silently regress), and
 *   • a new authentication scenario with no template must be added here with a
 *     reason (no silent gaps).
 *
 * EXPANSION RULE: no OTHER module may begin authoring action templates until this
 * list is empty (authentication at 100%). The invariant test enforces that too.
 */
export const AUTH_SCENARIOS_PENDING_ACTION_TEMPLATE: Readonly<Record<string, string>> = {
  'auth-neg-locked-user': 'same interaction as auth-pos-valid; differentiated only by data role (locked_account) + the assertion — no distinct action sequence to author until 2D.4 assertions land',
  'auth-edge-whitespace-case': 'requires a value TRANSFORM (pad/whitespace/case) on the dataset value — not expressible as a static literal or @dataset.* token',
  'auth-neg-invalid-identifier-format': 'requires a malformed-identifier value derived from the valid one — needs a value-transform grammar',
  'auth-sec-injection': 'requires an injection payload value keyed to the field under test — needs a payload/value-transform grammar',
  'auth-edge-password-masking': 'a UI/security property OBSERVATION with no distinct action sequence — pure assertion (2D.4)',
  'auth-sec-lockout-threshold': 'requires REPEATING the failed-login block N times — needs a repetition/flow construct the flat action list cannot express',
  'auth-sec-session': 'requires a protected-resource request WITHOUT a session — not a login-form interaction',
  'auth-pos-remember-me': 'requires check(remember-me) + a browser RESTART across contexts — restart is not expressible as an action',
  'auth-pos-logout': 'a multi-phase flow (log in, then log out, then re-request a protected page) that the single flat action list cannot yet express',
};

/* ============================================================================
 *  Scenario recognition — the Knowledge layer owns the vocabulary + matching.
 * ============================================================================
 *
 * The Scenario Planner decides WHICH scenarios exist, but it must not itself
 * know testing heuristics (what "lockout", "sql injection" or "expired" mean).
 * That vocabulary lives HERE, with the knowledge base that defines it. The
 * Planner assembles normalized evidence and asks this layer "does the evidence
 * recognise this scenario?"; it never inspects keywords on its own.
 *
 * This keeps the Planner dumb (evidence → scenario ids) and prevents it from
 * slowly turning into a second knowledge engine.
 */

/** The evidence bucket a piece of recognised evidence came from. */
export type EvidenceSource = 'acceptanceCriteria' | 'requirement' | 'appKnowledge' | 'testData';

/**
 * A single, strongly-typed piece of evidence that justifies a scenario. This is
 * a FOUNDATIONAL contract shared across the platform (Planner, Script Gen,
 * Healing, RCA, Impact Analysis, Explainability), so it is typed from the start
 * rather than a loose { type, value } pair:
 *
 *   • reference — a short stable code (AC-3, REQ, AK-<term>, TD-<term>) so UIs
 *     can deep-link to the originating criterion / dataset / app-knowledge rule.
 *   • excerpt   — the human-readable evidence text for explainability.
 */
export interface ScenarioEvidence {
  /** Stable id, unique within a scenario (e.g. "auth-neg-locked-user:ac-2"). */
  id: string;
  /** Which evidence bucket this came from. */
  source: EvidenceSource;
  /** Short stable reference code (AC-3, REQ, AK-lock, TD-locked_users). */
  reference: string;
  /** Human-readable evidence text. */
  excerpt: string;
}

/**
 * Normalized evidence buckets the recogniser matches against. The Planner
 * assembles this (it owns evidence COLLECTION); the Knowledge layer owns only
 * the vocabulary + MATCHING against it.
 */
export interface NormalizedEvidence {
  /** Lowercased requirement text (title + description + module + flow). */
  requirementText: string;
  /** Human-readable requirement label for citation. */
  requirementLabel: string;
  /** Acceptance-criteria split into individual clauses (original case). */
  acceptanceClauses: string[];
  /** Lowercased App-Knowledge text (page titles/types, element labels/roles). */
  appKnowledge: string;
  /** Lowercased Test-Data text (dataset names + sample keys). */
  testData: string;
}

const kbLc = (s?: string) => (s || '').toLowerCase();

/** Cap evidence text so an excerpt stays a readable citation, not a dump. */
function kbCap(s: string, n = 160): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}...` : t;
}

/** First keyword that appears in `haystack`, else null. */
function kbFirstHit(haystack: string, keywords: string[]): string | null {
  for (const k of keywords) if (k && haystack.includes(k)) return k;
  return null;
}

/**
 * Recognise which evidence (if any) justifies a NON-core scenario. Returns
 * EVERY matching evidence item, in strict priority order (Acceptance Criteria →
 * Requirement → App Knowledge → Test Data). An empty array means the evidence
 * does not justify the scenario, so the Planner must not emit it.
 *
 * The recognition vocabulary (`conditionalOnKeywords`) lives on the scenario in
 * this knowledge base — the matching logic and the vocabulary are co-located
 * here, never in the Planner.
 */
export function recognizeScenarioEvidence(
  scenario: PlannedScenario,
  ev: NormalizedEvidence,
): ScenarioEvidence[] {
  const keywords = (scenario.conditionalOnKeywords || []).map(kbLc).filter(Boolean);
  if (!keywords.length) return [];

  const out: ScenarioEvidence[] = [];
  // 1. Acceptance Criteria — cite each specific matching clause.
  ev.acceptanceClauses.forEach((clause, i) => {
    if (kbFirstHit(kbLc(clause), keywords)) {
      out.push({
        id: `${scenario.id}:ac-${i + 1}`,
        source: 'acceptanceCriteria',
        reference: `AC-${i + 1}`,
        excerpt: kbCap(clause),
      });
    }
  });
  // 2. Requirement description.
  if (kbFirstHit(ev.requirementText, keywords)) {
    out.push({
      id: `${scenario.id}:req`,
      source: 'requirement',
      reference: 'REQ',
      excerpt: ev.requirementLabel,
    });
  }
  // 3. App Knowledge.
  const ak = kbFirstHit(ev.appKnowledge, keywords);
  if (ak) {
    out.push({
      id: `${scenario.id}:ak-${ak}`,
      source: 'appKnowledge',
      reference: `AK-${ak}`,
      excerpt: `App knowledge references "${ak}"`,
    });
  }
  // 4. Test Data.
  const td = kbFirstHit(ev.testData, keywords);
  if (td) {
    out.push({
      id: `${scenario.id}:td-${td}`,
      source: 'testData',
      reference: `TD-${td}`,
      excerpt: `Test data references "${td}"`,
    });
  }
  return out;
}
