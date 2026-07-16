/**
 * Validation Planning — the catalog (knowledge), indexed by risk dimension.
 *
 * This is the knowledge a senior QA lead carries, expressed as OBLIGATION
 * TEMPLATES: for a given element, what must be validated, what NEW validation
 * that provides, and which business RISK it guards against. Templates carry no
 * Positive/Negative/Edge label — classification is a presentation concern the
 * planner applies at the end, derived purely from the dimension.
 *
 * Two shapes of knowledge live here:
 *   1. Per-field / per-rule templates a dimension asks for given a field's DATA
 *      TYPE or a rule's kind.
 *   2. Field-agnostic payloads (security, data integrity) that become ONE
 *      obligation each, applied across every free-text input — so a cross-field
 *      concern is expressed once, not repeated per field.
 *
 * Nothing here invents fields or rules — it expands obligations only for
 * elements the Business Model already discovered.
 */

import type { BusinessRuleKind, FieldDataType } from '../requirement-understanding/types';

/**
 * One obligation template, before it is bound to a concrete element. `concept`
 * is the dedup grouping (the business thing being validated); `intent` is the
 * specific NEW validation. Together they form the intent signature the planner
 * dedupes and matches repository reuse on.
 */
export interface ObligationTemplate {
  /** Dedup grouping — the business concept, parameterized by the element's key. */
  concept: (elementKey: string) => string;
  /** The specific validation provided — stable within a concept. */
  intent: string;
  /** Business-readable statement built from the element's display name. */
  statement: (name: string) => string;
  /** The business RISK this guards against. */
  risk: string;
}

/* ================================================================== */
/*  INPUT VALIDATION — can invalid data enter the system?             */
/* ================================================================== */

/** Emitted when a field is required — rejecting the empty value. */
const REQUIRED_EMPTY: ObligationTemplate = {
  concept: (k) => k,
  intent: 'reject-empty',
  statement: (n) => `Reject empty ${n}`,
  risk: 'A required field left blank must not create an incomplete record.',
};

const FORMAT_REJECTIONS: Partial<Record<FieldDataType, ObligationTemplate[]>> = {
  email: [
    { concept: (k) => k, intent: 'reject-malformed', statement: (n) => `Reject malformed ${n}`, risk: 'A malformed address breaks delivery and identity assumptions.' },
  ],
  phone: [
    { concept: (k) => k, intent: 'reject-non-numeric', statement: (n) => `Reject letters/symbols in ${n}`, risk: 'Non-dialable input corrupts contact data.' },
  ],
  number: [
    { concept: (k) => k, intent: 'reject-non-numeric', statement: (n) => `Reject non-numeric ${n}`, risk: 'Text in a numeric field breaks downstream arithmetic.' },
  ],
  date: [
    { concept: (k) => k, intent: 'reject-malformed', statement: (n) => `Reject malformed ${n}`, risk: 'Unparseable dates corrupt scheduling and reporting.' },
  ],
  url: [
    { concept: (k) => k, intent: 'reject-malformed', statement: (n) => `Reject malformed ${n}`, risk: 'A non-URL value breaks links and integrations.' },
  ],
  enum: [
    { concept: (k) => k, intent: 'reject-invalid-value', statement: (n) => `Reject an out-of-set ${n} value`, risk: 'A value outside the allowed set corrupts referential integrity.' },
  ],
  password: [
    { concept: (k) => k, intent: 'reject-too-weak', statement: (n) => `Reject a too-weak ${n}`, risk: 'A weak secret undermines account security.' },
  ],
};

export function inputValidationTemplates(dataType: FieldDataType, required: boolean): ObligationTemplate[] {
  const out: ObligationTemplate[] = [];
  if (required) out.push(REQUIRED_EMPTY);
  out.push(...(FORMAT_REJECTIONS[dataType] ?? []));
  return out;
}

/* ================================================================== */
/*  BOUNDARY — can limits be exceeded?                                */
/* ================================================================== */

const BOUNDARY_TEMPLATES: Partial<Record<FieldDataType, ObligationTemplate[]>> = {
  text: [
    { concept: (k) => `${k}-length`, intent: 'enforce-max-length', statement: (n) => `Enforce maximum length on ${n}`, risk: 'Unbounded text overflows storage and UI.' },
    { concept: (k) => `${k}-length`, intent: 'enforce-min-length', statement: (n) => `Enforce minimum length on ${n}`, risk: 'Too-short input at the lower bound must behave correctly.' },
  ],
  email: [
    { concept: (k) => `${k}-length`, intent: 'enforce-max-length', statement: (n) => `Enforce maximum ${n} length (254)`, risk: 'Over-long addresses violate the RFC bound and break storage.' },
  ],
  phone: [
    { concept: (k) => `${k}-length`, intent: 'enforce-min-digits', statement: (n) => `Enforce minimum digits in ${n}`, risk: 'Too-few digits is not a dialable number.' },
    { concept: (k) => `${k}-length`, intent: 'enforce-max-digits', statement: (n) => `Enforce maximum digits in ${n}`, risk: 'Too-many digits is not a valid number.' },
  ],
  number: [
    { concept: (k) => `${k}-range`, intent: 'enforce-min', statement: (n) => `Enforce minimum ${n}`, risk: 'Values below the floor corrupt business logic.' },
    { concept: (k) => `${k}-range`, intent: 'enforce-max', statement: (n) => `Enforce maximum ${n}`, risk: 'Values above the ceiling corrupt business logic.' },
  ],
  date: [
    { concept: (k) => `${k}-range`, intent: 'enforce-range', statement: (n) => `Enforce allowed ${n} range`, risk: 'Out-of-range dates violate business constraints.' },
  ],
  password: [
    { concept: (k) => `${k}-length`, intent: 'enforce-min-length', statement: (n) => `Enforce minimum ${n} length`, risk: 'Below the minimum length weakens the secret.' },
    { concept: (k) => `${k}-length`, intent: 'enforce-max-length', statement: (n) => `Enforce maximum ${n} length`, risk: 'Unbounded secrets can be a denial-of-service vector.' },
  ],
};

export function boundaryTemplates(dataType: FieldDataType): ObligationTemplate[] {
  return [...(BOUNDARY_TEMPLATES[dataType] ?? [])];
}

/* ================================================================== */
/*  SECURITY — can malicious input damage the application?            */
/*  DATA INTEGRITY — can the application corrupt or lose data?        */
/*  Both are field-agnostic: ONE obligation each, across free-text.   */
/* ================================================================== */

export const SECURITY_PAYLOADS: ObligationTemplate[] = [
  { concept: () => 'input-safety', intent: 'neutralize-sql', statement: () => 'Neutralize SQL-like input in free-text fields', risk: 'Unescaped input interpreted as a query enables data theft or loss.' },
  { concept: () => 'input-safety', intent: 'neutralize-xss', statement: () => 'Neutralize script injection (XSS) in free-text fields', risk: 'Input executed as markup/script compromises other users.' },
  { concept: () => 'input-safety', intent: 'neutralize-template', statement: () => 'Neutralize template/command-like input in free-text fields', risk: 'Expression/command syntax evaluated server-side enables RCE.' },
];

export const DATA_INTEGRITY_CHECKS: ObligationTemplate[] = [
  { concept: () => 'data-integrity', intent: 'preserve-unicode', statement: () => 'Preserve unicode/accented characters in free-text fields', risk: 'Corrupting international names loses or garbles customer data.' },
  { concept: () => 'data-integrity', intent: 'preserve-emoji', statement: () => 'Preserve emoji / multibyte input in free-text fields', risk: 'Multibyte truncation corrupts stored data.' },
  { concept: () => 'data-integrity', intent: 'trim-whitespace', statement: () => 'Trim leading/trailing whitespace in free-text fields', risk: 'Padded input creates silent duplicate / lookup-miss data.' },
];

export const FREE_TEXT_TYPES: ReadonlySet<FieldDataType> = new Set<FieldDataType>(['text', 'email', 'url', 'password']);

/* ================================================================== */
/*  BUSINESS RULE & AUTHORIZATION — from discovered rules             */
/* ================================================================== */

/**
 * The obligation a business rule creates. `mandatory` intentionally emits the
 * SAME `reject-empty` intent a required field does — the planner's intent-dedup
 * then collapses them into one obligation (and counts the collapse), rather than
 * the catalog silently suppressing one. Returns null for kinds another
 * dimension owns (range → boundary; permission → authorization; format/length →
 * field templates).
 */
export function businessRuleTemplate(ruleKind: BusinessRuleKind, conceptKey: string, targetName: string): ObligationTemplate | null {
  switch (ruleKind) {
    case 'unique':
      return { concept: () => `${conceptKey}-uniqueness`, intent: 'reject-duplicate', statement: () => `Reject a duplicate ${targetName}`, risk: 'A duplicate breaks a uniqueness guarantee the business relies on.' };
    case 'dependency':
      return { concept: () => `${conceptKey}-prerequisite`, intent: 'reject-missing-prerequisite', statement: () => `Reject ${targetName} when its prerequisite is missing`, risk: 'Acting without a satisfied precondition corrupts state.' };
    case 'mandatory':
      return { concept: () => conceptKey, intent: 'reject-empty', statement: () => `Reject empty ${targetName}`, risk: 'A required field left blank must not create an incomplete record.' };
    default:
      return null;
  }
}

export function authorizationTemplate(conceptKey: string, targetName: string): ObligationTemplate {
  return { concept: () => `${conceptKey}-authorization`, intent: 'block-unauthorized', statement: () => `Block an unauthorized user from ${targetName}`, risk: 'An unauthorized action is a privilege-escalation and compliance breach.' };
}
