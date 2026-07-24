/**
 * Requirement Capability Detector
 * ================================
 *
 * WHY THIS EXISTS
 * ---------------
 * The generator was TEMPLATE-driven: every requirement was funnelled through a
 * CRUD/form playbook, so a *sorting* requirement ("Allow users to sort products
 * by different criteria") produced checkout steps (Enter First Name / Last Name
 * / Zip) and "the sorting record is created" expected results. Scored 2/10.
 *
 * The fix starts here: understand WHAT CAPABILITY the requirement describes
 * BEFORE deciding how to test it. This module answers one question and answers
 * it deterministically (zero LLM tokens):
 *
 *   Input:  "Sort products"  (title + description + acceptance criteria)
 *   Output: {
 *     primaryCapability: 'sorting',
 *     secondaryCapability: 'inventory',
 *     businessObject: 'Product',
 *     operations: ['Sort'],
 *     dimensions: ['Name', 'Price'],
 *     constraints: ['Cart preserved', 'Product unchanged', 'Selection retained'],
 *   }
 *
 * A downstream planner can then pick the SORTING playbook instead of the CRUD
 * playbook. This file does NOT touch step/data/expected-result generation — that
 * wiring is a separate, reviewable stage.
 *
 * DESIGN PRINCIPLES
 *   - Pure & synchronous. No I/O, no LLM, no globals. Same input → same output.
 *   - Explainable. Every decision is a weighted keyword signal we can point at.
 *   - Fail-open. Unknown input degrades to `generic`, never throws.
 */

export type Capability =
  | 'crud'
  | 'authentication'
  | 'search'
  | 'sorting'
  | 'filtering'
  | 'checkout'
  | 'payment'
  | 'profile'
  | 'workflow'
  | 'notification'
  | 'reporting'
  | 'inventory'
  | 'generic';

/** The structured understanding of a requirement's core capability. */
export interface CapabilityDetection {
  /** Highest-scoring capability. Drives which testing playbook is used. */
  primaryCapability: Capability;
  /** Next-highest capability when it is clearly present (context/domain). */
  secondaryCapability?: Capability;
  /** The domain noun the requirement acts on, e.g. "Product", "User". */
  businessObject: string;
  /** Verbs/actions the requirement performs, e.g. ["Sort"], ["Create","Edit"]. */
  operations: string[];
  /** Attributes the operation ranges over, e.g. ["Name","Price"] for sorting. */
  dimensions: string[];
  /** Invariants that must hold, e.g. ["Cart preserved","Product unchanged"]. */
  constraints: string[];
  /**
   * Per-capability scores (0..1-ish, unbounded upward) for transparency and
   * debugging. Present so callers / tests can inspect WHY a capability won.
   */
  scores: Partial<Record<Capability, number>>;
}

/** Minimal input contract — a subset of RequirementInput. */
export interface CapabilityInput {
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  businessFlow?: string;
  module?: string;
}

/* ------------------------------------------------------------------ */
/* Capability signals                                                  */
/* ------------------------------------------------------------------ */

interface CapabilitySignal {
  capability: Capability;
  weight: number;
  patterns: RegExp[];
}

/**
 * Signals are ordered from most-specific to least. Specific capabilities
 * (sorting, filtering, checkout) carry higher weights than the generic CRUD
 * fallback so that a genuine "sort" requirement is NOT swallowed by CRUD.
 */
const CAPABILITY_SIGNALS: CapabilitySignal[] = [
  {
    capability: 'sorting',
    weight: 1.0,
    patterns: [
      /\bsort(s|ed|ing)?\b/,
      /\border(ing|ed)?\s+by\b/,
      /\bascending\b/,
      /\bdescending\b/,
      /\ba\s*(?:to|-|–)\s*z\b/,
      /\bz\s*(?:to|-|–)\s*a\b/,
      /\b(low|high)\s*(?:to|-|–)\s*(low|high)\b/,
      /\bre-?order\b/,
      /\bsort\s+(?:by|order|criteria|option|dropdown)\b/,
    ],
  },
  {
    capability: 'filtering',
    weight: 0.98,
    patterns: [
      /\bfilter(s|ed|ing)?\b/,
      /\bnarrow\s+(?:down|by)\b/,
      /\brefine\s+(?:results|by)\b/,
      /\bfacet(s|ed)?\b/,
      /\bby\s+(?:category|price\s+range|brand|status)\b/,
    ],
  },
  {
    capability: 'search',
    weight: 0.9,
    patterns: [
      // NOTE: deliberately no bare "find" — "so I can find X" is a benefit/goal
      // clause, not evidence of a search capability. Require a real search verb.
      /\bsearch(es|ed|ing)?\b/,
      /\blook\s*up\b/,
      /\bsearch\s+(?:box|bar|field|query)\b/,
      /\bquery\b/,
      /\bautocomplete\b/,
      /\bsearch\s+suggest(ions?)?\b/,
    ],
  },
  {
    capability: 'authentication',
    weight: 0.95,
    patterns: [
      /\blog\s*in\b/,
      /\blogin\b/,
      /\bsign\s*in\b/,
      /\bsign\s*up\b/,
      /\bregister\b/,
      /\bauthenticat/,
      /\bcredential/,
      /\bpassword\b/,
      /\blog\s*out\b/,
      /\bsession\b/,
      /\b(otp|2fa|mfa|two[-\s]?factor)\b/,
    ],
  },
  {
    capability: 'payment',
    weight: 0.96,
    patterns: [
      /\bpay(ment|s|ing)?\b/,
      /\bcredit\s*card\b/,
      /\bdebit\s*card\b/,
      /\bbilling\b/,
      /\brefund\b/,
      /\bcharge\b/,
      /\btransaction\b/,
      /\binvoice\b/,
      /\b(paypal|stripe|razorpay)\b/,
    ],
  },
  {
    capability: 'checkout',
    weight: 0.94,
    patterns: [
      /\bcheck\s*out\b/,
      /\bcheckout\b/,
      /\bplace\s+(?:an?\s+)?order\b/,
      /\bshopping\s*cart\b/,
      /\bshipping\b/,
      /\bpurchase\b/,
      /\bcart\s+(?:total|summary)\b/,
    ],
  },
  {
    capability: 'profile',
    weight: 0.85,
    patterns: [
      /\bprofile\b/,
      /\bmy\s+account\b/,
      /\baccount\s+settings\b/,
      /\bpersonal\s+(?:details|information)\b/,
      /\bpreferences\b/,
      /\bavatar\b/,
    ],
  },
  {
    capability: 'notification',
    weight: 0.85,
    patterns: [
      /\bnotif(y|ication)/,
      /\balert(s|ed|ing)?\b/,
      /\breminder\b/,
      /\bemail\s+(?:notification|alert|is\s+sent)\b/,
      /\bpush\s+notification\b/,
      /\bsms\b/,
    ],
  },
  {
    capability: 'workflow',
    weight: 0.8,
    patterns: [
      /\bapprove(s|d)?\b/,
      /\bapproval\b/,
      /\breject(s|ed|ion)?\b/,
      /\bmulti[-\s]?step\b/,
      /\bstate\s+(?:transition|machine)\b/,
      /\bstatus\s+(?:change|transition)\b/,
      /\bescalat/,
      /\bwizard\b/,
    ],
  },
  {
    capability: 'reporting',
    weight: 0.8,
    patterns: [
      /\breport(s|ing)?\b/,
      /\bdashboard\b/,
      /\banalytics\b/,
      /\bexport\s+(?:to\s+)?(?:csv|pdf|excel)\b/,
      /\bchart(s)?\b/,
      /\bmetric(s)?\b/,
    ],
  },
  {
    capability: 'inventory',
    weight: 0.55,
    patterns: [
      /\binventory\b/,
      /\bstock\b/,
      /\bcatalog(ue)?\b/,
      /\bproduct\s+(?:list|listing|page)\b/,
      /\bsku\b/,
    ],
  },
  {
    capability: 'crud',
    weight: 0.6,
    patterns: [
      /\b(create|creates|creating)\b/,
      /\badd(s|ing)?\b/,
      /\bnew\s+\w+/,
      /\bedit(s|ing)?\b/,
      /\bupdate(s|d|ing)?\b/,
      /\bmodif(y|ies|ication)/,
      /\bdelete(s|d|ing)?\b/,
      /\bremove(s|d|ing)?\b/,
      /\bsubmit\b/,
      /\bform\b/,
      /\bsave(s|d|ing)?\b/,
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Operations                                                          */
/* ------------------------------------------------------------------ */

interface OperationSignal {
  operation: string;
  patterns: RegExp[];
}

const OPERATION_SIGNALS: OperationSignal[] = [
  { operation: 'Sort', patterns: [/\bsort/, /\border\s+by/, /\bascending/, /\bdescending/, /\bre-?order/] },
  { operation: 'Filter', patterns: [/\bfilter/, /\bnarrow/, /\brefine/, /\bfacet/] },
  { operation: 'Search', patterns: [/\bsearch/, /\blook\s*up/, /\bquery/, /\bautocomplete/] },
  { operation: 'Create', patterns: [/\bcreate/, /\badd\b/, /\bnew\b/, /\bregister/, /\bsign\s*up/] },
  { operation: 'Read', patterns: [/\bview/, /\bdisplay/, /\bshow/, /\bread\b/, /\blist\b/] },
  { operation: 'Update', patterns: [/\bedit/, /\bupdate/, /\bmodif/, /\bchange/] },
  { operation: 'Delete', patterns: [/\bdelete/, /\bremove/, /\bcancel/] },
  { operation: 'Login', patterns: [/\blog\s*in/, /\blogin/, /\bsign\s*in/, /\bauthenticat/] },
  { operation: 'Logout', patterns: [/\blog\s*out/, /\blogout/, /\bsign\s*out/] },
  { operation: 'Checkout', patterns: [/\bcheck\s*out/, /\bplace\s+.*order/, /\bpurchase/] },
  { operation: 'Pay', patterns: [/\bpay/, /\bbilling/, /\bcharge/] },
  { operation: 'Approve', patterns: [/\bapprove/, /\bapproval/] },
  { operation: 'Reject', patterns: [/\breject/] },
  { operation: 'Export', patterns: [/\bexport/, /\bdownload/] },
  { operation: 'Notify', patterns: [/\bnotif/, /\balert/, /\bremind/] },
];

/* ------------------------------------------------------------------ */
/* Constraints (invariants that must hold)                             */
/* ------------------------------------------------------------------ */

interface ConstraintSignal {
  label: string;
  patterns: RegExp[];
}

const CONSTRAINT_SIGNALS: ConstraintSignal[] = [
  {
    label: 'Cart preserved',
    patterns: [
      /\bcart\s+(?:is\s+)?(?:preserved|retained|unchanged|not\s+affected|remains?)/,
      /\bdoes\s+not\s+(?:affect|change|clear|empty)\s+.*cart/,
      /\bcart\s+(?:contents?|items?)\s+(?:remain|persist)/,
    ],
  },
  {
    label: 'Product unchanged',
    patterns: [
      /\bproduct\s+(?:information|details?|data|info)\s+(?:is\s+)?(?:unchanged|not\s+(?:altered|changed|modified)|remains?)/,
      /\bno\s+change\s+to\s+(?:the\s+)?product/,
      /\bproduct\s+(?:is\s+)?(?:unchanged|not\s+modified)/,
    ],
  },
  {
    label: 'Selection retained',
    patterns: [
      /\bselection\s+(?:is\s+)?(?:retained|preserved|remembered|kept|maintained)/,
      /\b(?:sort|filter)\s+(?:order|selection|option)\s+(?:is\s+)?(?:retained|persist|remember|maintained)/,
      /\bcurrent\s+(?:sort|filter|selection)\s+(?:is\s+)?(?:highlighted|retained|shown)/,
    ],
  },
  {
    label: 'State persists across navigation',
    patterns: [
      /\bpersist(s|ed)?\s+(?:while|when|across|during)\s+navigat/,
      /\b(?:remains?|retained)\s+(?:when|while|after)\s+(?:navigat|browsing|returning)/,
      /\bmaintained\s+across\s+pages/,
    ],
  },
  {
    label: 'Mandatory fields required',
    patterns: [
      /\bmandatory\b/,
      /\brequired\s+field/,
      /\bcannot\s+be\s+(?:empty|blank)/,
      /\bmust\s+be\s+(?:provided|entered|filled)/,
    ],
  },
  {
    label: 'Unique value enforced',
    patterns: [/\bunique\b/, /\bno\s+duplicate/, /\balready\s+exists/, /\bduplicate\s+not\s+allowed/],
  },
  {
    label: 'Authorization enforced',
    patterns: [
      /\bonly\s+(?:admin|authorized|authenticated)/,
      /\bpermission\b/,
      /\brole[-\s]?based/,
      /\baccess\s+(?:control|denied)/,
    ],
  },
];

/* ------------------------------------------------------------------ */
/* Dimensions (attributes the operation ranges over)                   */
/* ------------------------------------------------------------------ */

/**
 * Common, unambiguous dimension nouns. We only surface dimensions we can name
 * confidently from the text so we never invent attributes that aren't there.
 */
const KNOWN_DIMENSIONS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Name', pattern: /\bname\b/ },
  { label: 'Price', pattern: /\bprice\b/ },
  { label: 'Date', pattern: /\bdate\b/ },
  { label: 'Rating', pattern: /\brating\b/ },
  { label: 'Popularity', pattern: /\bpopularity\b/ },
  { label: 'Relevance', pattern: /\brelevance\b/ },
  { label: 'Quantity', pattern: /\bquantity\b/ },
  { label: 'Category', pattern: /\bcategory\b/ },
  { label: 'Brand', pattern: /\bbrand\b/ },
  { label: 'Status', pattern: /\bstatus\b/ },
  { label: 'Size', pattern: /\bsize\b/ },
  { label: 'Color', pattern: /\bcolou?r\b/ },
];

/* ------------------------------------------------------------------ */
/* Business object extraction                                          */
/* ------------------------------------------------------------------ */

const STOP_OBJECT_WORDS = new Set([
  'the', 'a', 'an', 'their', 'its', 'my', 'your', 'our', 'this', 'that', 'these', 'those',
  'different', 'various', 'multiple', 'all', 'any', 'some', 'each', 'every',
  'new', 'existing', 'available', 'valid', 'invalid', 'current',
]);

/** Verbs that typically precede the business object. */
const OBJECT_LEADING_VERBS = [
  'sort', 'filter', 'search', 'search for', 'create', 'add', 'edit', 'update', 'modify',
  'delete', 'remove', 'view', 'display', 'manage', 'list', 'browse', 'select', 'order',
];

function singularize(word: string): string {
  if (/(ss|us|is)$/i.test(word)) return word; // address, status, analysis
  if (/ies$/i.test(word)) return word.replace(/ies$/i, 'y');
  if (/(ches|shes|xes|ses|zes)$/i.test(word)) return word.replace(/es$/i, '');
  if (/s$/i.test(word)) return word.replace(/s$/i, '');
  return word;
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

/**
 * Extract the domain noun the requirement operates on. Strategy:
 *   1. Look for "<verb> [the] <noun>" (sort products → Product).
 *   2. Fall back to a known domain noun anywhere in the text.
 *   3. Fall back to the module name.
 *   4. Fall back to "Item".
 */
function extractBusinessObject(text: string, module?: string): string {
  const lower = text.toLowerCase();

  for (const verb of OBJECT_LEADING_VERBS) {
    // <verb> (optional articles/adjectives) <noun>
    const re = new RegExp(
      `\\b${verb}\\s+(?:the\\s+|a\\s+|an\\s+|their\\s+|my\\s+|your\\s+|all\\s+)?` +
        `(?:(?:different|various|multiple|available|existing|new)\\s+)?([a-z][a-z-]{2,})`,
    );
    const m = lower.match(re);
    if (m && m[1] && !STOP_OBJECT_WORDS.has(m[1])) {
      return titleCase(singularize(m[1]));
    }
  }

  // Known domain nouns anywhere in the text.
  const domainNouns = ['product', 'order', 'user', 'customer', 'employee', 'invoice',
    'account', 'item', 'cart', 'ticket', 'report', 'document', 'record', 'transaction',
    'notification', 'category', 'profile'];
  for (const noun of domainNouns) {
    if (new RegExp(`\\b${noun}s?\\b`).test(lower)) {
      return titleCase(noun);
    }
  }

  if (module && module.trim()) {
    return titleCase(singularize(module.trim().split(/\s+/)[0]));
  }
  return 'Item';
}

/* ------------------------------------------------------------------ */
/* Main detector                                                       */
/* ------------------------------------------------------------------ */

function countMatches(patterns: RegExp[], text: string): number {
  let hits = 0;
  for (const p of patterns) {
    if (p.test(text)) hits += 1;
  }
  return hits;
}

/**
 * Detect the primary capability + structured facets of a requirement.
 * Pure, deterministic, fail-open.
 */
export function detectCapability(input: CapabilityInput): CapabilityDetection {
  const title = (input.title || '').trim();
  const parts = [
    input.title,
    input.description,
    input.acceptanceCriteria,
    input.businessFlow,
  ].filter(Boolean) as string[];
  const text = parts.join('\n').toLowerCase();

  // ---- 1. Score capabilities ----
  const scores: Partial<Record<Capability, number>> = {};
  for (const sig of CAPABILITY_SIGNALS) {
    const hits = countMatches(sig.patterns, text);
    if (hits > 0) {
      // Weight × (1 + small bonus per extra hit). Title matches count double.
      const titleHits = countMatches(sig.patterns, title.toLowerCase());
      const score = sig.weight * (1 + 0.15 * (hits - 1)) + 0.25 * titleHits;
      scores[sig.capability] = Number(score.toFixed(3));
    }
  }

  // ---- 1b. Damp capabilities that only fired via a preservation invariant ----
  // A sorting requirement that says "must not affect the shopping cart" mentions
  // the cart as an INVARIANT, not as a checkout capability. If the cart signal is
  // consumed by a "Cart preserved" constraint (below), we discount checkout so
  // the domain context (Inventory) surfaces as the real secondary capability.
  const cartPreserved = CONSTRAINT_SIGNALS.find((c) => c.label === 'Cart preserved');
  if (cartPreserved && countMatches(cartPreserved.patterns, text) > 0 && scores.checkout) {
    // Re-score checkout WITHOUT the cart-only patterns.
    const checkoutSig = CAPABILITY_SIGNALS.find((s) => s.capability === 'checkout')!;
    const nonCartPatterns = checkoutSig.patterns.filter(
      (p) => !/cart/.test(p.source),
    );
    const remaining = countMatches(nonCartPatterns, text);
    if (remaining === 0) {
      delete scores.checkout;
    } else {
      scores.checkout = Number(
        (checkoutSig.weight * (1 + 0.15 * (remaining - 1))).toFixed(3),
      );
    }
  }

  // ---- 2. Rank ----
  const ranked = (Object.entries(scores) as Array<[Capability, number]>)
    .sort((a, b) => b[1] - a[1]);

  const primaryCapability: Capability = ranked.length ? ranked[0][0] : 'generic';
  let secondaryCapability: Capability | undefined =
    ranked.length > 1 ? ranked[1][0] : undefined;

  // Don't report a near-noise secondary (below 25% of the primary's score).
  if (
    secondaryCapability &&
    ranked[1][1] < 0.25 * ranked[0][1]
  ) {
    secondaryCapability = undefined;
  }

  // ---- 3. Operations ----
  const operations: string[] = [];
  for (const op of OPERATION_SIGNALS) {
    if (countMatches(op.patterns, text) > 0) operations.push(op.operation);
  }

  // ---- 4. Dimensions ----
  const dimensions: string[] = [];
  for (const dim of KNOWN_DIMENSIONS) {
    if (dim.pattern.test(text)) dimensions.push(dim.label);
  }

  // ---- 5. Constraints ----
  const constraints: string[] = [];
  for (const c of CONSTRAINT_SIGNALS) {
    if (countMatches(c.patterns, text) > 0) constraints.push(c.label);
  }

  // ---- 6. Business object ----
  const businessObject = extractBusinessObject(parts.join(' '), input.module);

  return {
    primaryCapability,
    secondaryCapability,
    businessObject,
    operations,
    dimensions,
    constraints,
    scores,
  };
}

/**
 * Human-readable one-line summary, matching the format the QA architect asked
 * for in review:
 *   "Primary Capability: Sorting | Secondary: Inventory | Business Object:
 *    Product | Operations: Sort | Dimensions: Name, Price | Constraints: ..."
 */
export function summarizeCapability(d: CapabilityDetection): string {
  const cap = (c?: Capability) =>
    c ? c.charAt(0).toUpperCase() + c.slice(1) : '—';
  const list = (a: string[]) => (a.length ? a.join(', ') : '—');
  const segs = [
    `Primary Capability: ${cap(d.primaryCapability)}`,
    d.secondaryCapability ? `Secondary: ${cap(d.secondaryCapability)}` : null,
    `Business Object: ${d.businessObject}`,
    `Operations: ${list(d.operations)}`,
    `Dimensions: ${list(d.dimensions)}`,
    `Constraints: ${list(d.constraints)}`,
  ].filter(Boolean);
  return segs.join(' | ');
}
