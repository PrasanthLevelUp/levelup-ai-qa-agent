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
   * Optional soft guard: lowercase keywords that hint this scenario is only
   * relevant when the requirement/context mentions them (e.g. "remember me",
   * "2fa"). The planner still INCLUDES the scenario but flags it as conditional
   * so the LLM only expands it when the requirement actually supports it — we
   * never hard-drop knowledge, we let grounding decide.
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
    { id: 'auth-pos-valid', title: 'Valid credentials log in successfully', objective: 'A registered user with correct credentials is authenticated and lands in the authenticated area.', coverageType: 'positive', priority: 'P0', riskArea: 'Authentication / access' },
    { id: 'auth-neg-wrong-password', title: 'Invalid password is rejected', objective: 'A wrong password does not authenticate and a clear, non-leaking error is shown.', coverageType: 'negative', priority: 'P0', riskArea: 'Unauthorized access' },
    { id: 'auth-neg-unknown-user', title: 'Unknown / non-existent user is rejected', objective: 'An unregistered identifier cannot authenticate and the error does not reveal whether the account exists.', coverageType: 'negative', priority: 'P1', riskArea: 'Account enumeration' },
    { id: 'auth-neg-empty-fields', title: 'Empty required fields are rejected', objective: 'Submitting with blank username and/or password is blocked with field-level validation.', coverageType: 'negative', priority: 'P1', riskArea: 'Input validation' },
    { id: 'auth-neg-locked-user', title: 'Locked / disabled account cannot log in', objective: 'A locked or disabled account is refused even with correct credentials.', coverageType: 'negative', priority: 'P1', riskArea: 'Account state enforcement', conditionalOnKeywords: ['lock', 'disable', 'suspend', 'attempt'] },
    { id: 'auth-edge-whitespace-case', title: 'Whitespace / case handling on identifier', objective: 'Leading/trailing whitespace is trimmed and identifier case is handled per the rule (case-insensitive email, etc.).', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Input normalization' },
    { id: 'auth-neg-invalid-identifier-format', title: 'Malformed identifier format is rejected', objective: 'A malformed identifier (missing @, spaces, or invalid characters in an email login) is rejected with field-level validation before authentication is attempted.', coverageType: 'negative', priority: 'P2', riskArea: 'Input validation' },
    { id: 'auth-sec-injection', title: 'Injection-style credentials are handled safely', objective: 'SQL/script injection strings in the username or password neither authenticate nor error out — they are treated as ordinary invalid input.', coverageType: 'security', priority: 'P1', riskArea: 'Injection safety' },
    { id: 'auth-edge-password-masking', title: 'Password input is masked and not exposed', objective: 'The password field masks entry and the value is not exposed in the DOM, page source, autocomplete, or logs.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Credential exposure' },
    { id: 'auth-sec-lockout-threshold', title: 'Account lockout after repeated failures', objective: 'After the configured number of failed attempts the account is locked / throttled.', coverageType: 'security', priority: 'P1', riskArea: 'Brute-force resistance', conditionalOnKeywords: ['lock', 'attempt', 'brute', 'throttle', 'rate'] },
    { id: 'auth-sec-session', title: 'Session established and protected', objective: 'A session/token is issued on login and protected resources reject requests without it.', coverageType: 'security', priority: 'P1', riskArea: 'Session management', conditionalOnKeywords: ['session', 'token', 'timeout', 'expire'] },
    { id: 'auth-pos-remember-me', title: 'Remember-me persists the session', objective: 'When remember-me is selected the session persists across browser restarts per policy.', coverageType: 'positive', priority: 'P2', riskArea: 'Session persistence', conditionalOnKeywords: ['remember'] },
    { id: 'auth-pos-logout', title: 'Logout ends the session', objective: 'Logging out invalidates the session and protected pages are no longer reachable.', coverageType: 'positive', priority: 'P1', riskArea: 'Session termination', conditionalOnKeywords: ['logout', 'log out', 'sign out', 'session'] },
  ],
  crud: [
    { id: 'crud-pos-create', title: 'Create a record with valid data', objective: 'A record is created and persisted with valid input and confirmation is shown.', coverageType: 'positive', priority: 'P0', riskArea: 'Data creation' },
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
    { id: 'search-pos-match', title: 'Search returns matching results', objective: 'A query with known matches returns the expected results.', coverageType: 'positive', priority: 'P0', riskArea: 'Search correctness' },
    { id: 'search-pos-no-results', title: 'No-results state for non-matching query', objective: 'A query with no matches shows a clear empty state, not an error.', coverageType: 'positive', priority: 'P1', riskArea: 'Empty-state handling' },
    { id: 'search-edge-empty-query', title: 'Empty / whitespace-only query', objective: 'An empty or whitespace query is handled per spec (all results, prompt, or blocked).', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Input handling' },
    { id: 'search-edge-special-chars', title: 'Special characters / injection-like input', objective: 'Special characters and injection-like strings are handled safely and do not break search.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Robustness' },
    { id: 'search-pos-filters', title: 'Filters / facets narrow results', objective: 'Applying and combining filters narrows results correctly and clearing restores them.', coverageType: 'positive', priority: 'P1', riskArea: 'Filtering correctness', conditionalOnKeywords: ['filter', 'facet', 'refine'] },
    { id: 'search-pos-sort', title: 'Sorting orders results correctly', objective: 'Each sort option orders the results as specified and is stable.', coverageType: 'positive', priority: 'P2', riskArea: 'Sort correctness', conditionalOnKeywords: ['sort', 'order by', 'ascending', 'descending'] },
    { id: 'search-pos-pagination', title: 'Pagination navigates result pages', objective: 'Page navigation shows the correct slice with no duplicates or gaps.', coverageType: 'positive', priority: 'P2', riskArea: 'Pagination', conditionalOnKeywords: ['page', 'pagination', 'load more', 'infinite'] },
    { id: 'search-perf-large', title: 'Search performance on large datasets', objective: 'Query returns within the acceptable time on a realistically large dataset.', coverageType: 'performance', priority: 'P2', riskArea: 'Performance at scale' },
  ],
  checkout: [
    { id: 'checkout-pos-happy', title: 'Complete checkout with valid cart', objective: 'A user completes checkout end-to-end and receives an order confirmation.', coverageType: 'positive', priority: 'P0', riskArea: 'Revenue / order completion' },
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
    { id: 'pay-pos-success', title: 'Successful payment with valid card', objective: 'A valid payment is authorised and captured and the order/record is marked paid.', coverageType: 'positive', priority: 'P0', riskArea: 'Revenue capture' },
    { id: 'pay-neg-declined', title: 'Declined card is handled', objective: 'A declined card shows a clear error and does not mark the order paid.', coverageType: 'negative', priority: 'P0', riskArea: 'Payment integrity' },
    { id: 'pay-neg-expired-card', title: 'Expired / invalid card details are rejected', objective: 'Expired or malformed card details are rejected at validation.', coverageType: 'negative', priority: 'P1', riskArea: 'Payment validation' },
    { id: 'pay-edge-insufficient-funds', title: 'Insufficient funds', objective: 'An insufficient-funds response is surfaced and the order is not completed.', coverageType: 'edge_cases', priority: 'P1', riskArea: 'Payment integrity' },
    { id: 'pay-sec-no-sensitive-data', title: 'No sensitive card data is exposed / stored', objective: 'Full PAN/CVV are never logged, displayed, or stored (PCI hygiene).', coverageType: 'security', priority: 'P0', riskArea: 'PCI / data exposure' },
    { id: 'pay-edge-double-submit', title: 'Duplicate submission does not double-charge', objective: 'Re-submitting or a network retry does not create a duplicate charge (idempotency).', coverageType: 'edge_cases', priority: 'P0', riskArea: 'Double-charge / financial correctness' },
    { id: 'pay-pos-refund', title: 'Refund processes correctly', objective: 'A refund returns the correct amount and updates the transaction state.', coverageType: 'positive', priority: 'P1', riskArea: 'Refund correctness', conditionalOnKeywords: ['refund', 'return', 'chargeback'] },
    { id: 'pay-int-timeout', title: 'Gateway timeout / failure is handled', objective: 'A gateway timeout leaves the system in a consistent state (no orphaned paid order).', coverageType: 'integration', priority: 'P1', riskArea: 'Payment-order consistency' },
  ],
  admin: [
    { id: 'admin-pos-authorized', title: 'Authorized admin can perform the action', objective: 'A user with the required role completes the privileged action successfully.', coverageType: 'positive', priority: 'P0', riskArea: 'Authorized access' },
    { id: 'admin-sec-unauthorized', title: 'Unauthorized role is denied', objective: 'A user without the required role/permission is denied (403) and no state changes.', coverageType: 'role_based', priority: 'P0', riskArea: 'Privilege escalation' },
    { id: 'admin-sec-direct-access', title: 'Direct URL/API access is enforced', objective: 'Bypassing the UI by hitting the endpoint/URL directly is still authorization-checked.', coverageType: 'security', priority: 'P1', riskArea: 'Broken access control' },
    { id: 'admin-pos-grant-revoke', title: 'Granting and revoking access take effect', objective: 'Granting a permission enables the action and revoking it disables the action.', coverageType: 'positive', priority: 'P1', riskArea: 'Access-control correctness', conditionalOnKeywords: ['grant', 'revoke', 'permission', 'role'] },
    { id: 'admin-neg-invalid-target', title: 'Managing a non-existent / invalid target user', objective: 'Acting on a missing or invalid target is handled gracefully.', coverageType: 'negative', priority: 'P2', riskArea: 'State handling' },
    { id: 'admin-edge-self-lockout', title: 'Admin cannot lock themselves out', objective: 'Removing the last admin / self-revoking critical access is prevented or warned.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Operational safety', conditionalOnKeywords: ['admin', 'role', 'last'] },
  ],
  workflow: [
    { id: 'wf-pos-happy-path', title: 'Complete the workflow end-to-end', objective: 'The multi-step workflow completes through every stage to the terminal state.', coverageType: 'positive', priority: 'P0', riskArea: 'Process completion' },
    { id: 'wf-pos-valid-transition', title: 'Valid state transitions are allowed', objective: 'Each permitted stage-to-stage transition succeeds and updates state.', coverageType: 'positive', priority: 'P1', riskArea: 'State-machine correctness' },
    { id: 'wf-neg-invalid-transition', title: 'Invalid state transitions are blocked', objective: 'A transition not permitted from the current stage is rejected.', coverageType: 'negative', priority: 'P0', riskArea: 'State-machine integrity' },
    { id: 'wf-pos-approve', title: 'Approval advances the workflow', objective: 'An approver approving moves the item to the next stage.', coverageType: 'positive', priority: 'P1', riskArea: 'Approval correctness', conditionalOnKeywords: ['approve', 'approval'] },
    { id: 'wf-neg-reject', title: 'Rejection routes correctly', objective: 'Rejecting sends the item to the correct stage (back/terminated) per spec.', coverageType: 'negative', priority: 'P1', riskArea: 'Routing correctness', conditionalOnKeywords: ['reject', 'decline', 'deny'] },
    { id: 'wf-role-permissions', title: 'Only permitted roles can action a stage', objective: 'A user without the stage role cannot perform that stage action.', coverageType: 'role_based', priority: 'P1', riskArea: 'Segregation of duties', conditionalOnKeywords: ['role', 'approver', 'permission'] },
    { id: 'wf-edge-interrupt-resume', title: 'Interrupted workflow resumes correctly', objective: 'Leaving mid-workflow and returning preserves progress/state.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Flow resilience' },
  ],
  reporting: [
    { id: 'rep-pos-accurate', title: 'Report shows accurate data', objective: 'Figures/aggregations match the underlying source data for a known dataset.', coverageType: 'positive', priority: 'P0', riskArea: 'Data accuracy' },
    { id: 'rep-pos-filters', title: 'Filters / date ranges scope the report', objective: 'Applying filters and date ranges scopes the results correctly.', coverageType: 'positive', priority: 'P1', riskArea: 'Filtering correctness', conditionalOnKeywords: ['filter', 'date range', 'range', 'period'] },
    { id: 'rep-edge-empty', title: 'Empty-data / no-rows state', objective: 'A report with no matching data shows a clear empty state, not an error or zeros mistaken for data.', coverageType: 'edge_cases', priority: 'P1', riskArea: 'Empty-state handling' },
    { id: 'rep-edge-large', title: 'Large-dataset rendering', objective: 'A large result set renders/paginates without failure within acceptable time.', coverageType: 'performance', priority: 'P2', riskArea: 'Performance at scale' },
    { id: 'rep-role-visibility', title: 'Data visibility respects role/tenant', objective: 'A user only sees data their role/tenant is entitled to.', coverageType: 'role_based', priority: 'P1', riskArea: 'Data isolation', conditionalOnKeywords: ['role', 'tenant', 'permission', 'scope'] },
    { id: 'rep-pos-export', title: 'Report export matches on-screen data', objective: 'Exported file content matches the displayed/ filtered report.', coverageType: 'positive', priority: 'P2', riskArea: 'Export fidelity', conditionalOnKeywords: ['export', 'download', 'csv', 'pdf', 'excel'] },
  ],
  import: [
    { id: 'imp-pos-valid-file', title: 'Import a valid file successfully', objective: 'A well-formed file imports all rows and reports success counts.', coverageType: 'positive', priority: 'P0', riskArea: 'Data ingestion' },
    { id: 'imp-neg-invalid-format', title: 'Reject unsupported file format', objective: 'An unsupported file type/extension is rejected with a clear message.', coverageType: 'negative', priority: 'P1', riskArea: 'Input validation' },
    { id: 'imp-neg-malformed-rows', title: 'Handle malformed / partial rows', objective: 'Invalid rows are reported (row-level errors) without corrupting valid rows per spec.', coverageType: 'negative', priority: 'P0', riskArea: 'Data integrity' },
    { id: 'imp-edge-empty-file', title: 'Empty file / no data rows', objective: 'An empty file or header-only file is handled gracefully.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Edge handling' },
    { id: 'imp-boundary-large-file', title: 'Large-file / max-size boundary', objective: 'Files at, below and above the size/row limit behave per spec.', coverageType: 'boundary', priority: 'P2', riskArea: 'Boundary handling' },
    { id: 'imp-edge-duplicate-rows', title: 'Duplicate rows within / across imports', objective: 'Duplicate rows are deduped/flagged per the defined rule.', coverageType: 'edge_cases', priority: 'P2', riskArea: 'Data integrity', conditionalOnKeywords: ['duplicate', 'unique', 'dedup'] },
    { id: 'imp-sec-malicious-content', title: 'Malicious content is handled safely', objective: 'Formula-injection/script content in cells is neutralised (no CSV injection).', coverageType: 'security', priority: 'P2', riskArea: 'Injection safety' },
  ],
  export: [
    { id: 'exp-pos-content', title: 'Exported file content is correct', objective: 'The exported file contains exactly the expected rows/columns for the current view/filters.', coverageType: 'positive', priority: 'P0', riskArea: 'Export fidelity' },
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
