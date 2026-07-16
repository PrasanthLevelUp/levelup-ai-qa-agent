/**
 * Requirement Understanding — domain knowledge (L3 + L4).
 *
 * This module holds the two WEAKER evidence sources, kept apart from the engine
 * so the strong deterministic extraction (repository = L1, requirement = L2)
 * never mixes with heuristic knowledge in the same file:
 *
 *   • Knowledge Base (L3) — UNIVERSAL QA best-practice validations attached to a
 *     field whose TYPE is already known. It never invents a field; it only says
 *     "an email field implies a format rule". Safe: it decorates facts.
 *
 *   • Domain Inference (L4) — likely-by-domain TEMPLATES ("an Employee usually
 *     has name, email, department, role"). This DOES introduce elements the
 *     requirement never stated, so it is the highest-risk source and is only
 *     admitted by profiles whose maxEvidenceLevel reaches L4 (Deep Research).
 *
 * L5 (llm_guess) is intentionally absent — reserved in the type system, not
 * produced by any deterministic path.
 */

import type { BusinessRuleKind, FieldDataType } from './types';

/* ------------------------------------------------------------------ */
/*  Field data-type inference (shared by all sources)                  */
/* ------------------------------------------------------------------ */

/**
 * Ordered rules mapping a field name (or a raw type hint) to a data type. First
 * match wins. Deterministic and case-insensitive. Used by the engine when a
 * source hands it a field with no explicit type.
 */
const FIELD_TYPE_HINTS: Array<[RegExp, FieldDataType]> = [
  [/\b(e-?mail)\b/i, 'email'],
  [/\b(password|passwd|pwd)\b/i, 'password'],
  [/\b(phone|mobile|telephone|tel|fax)\b/i, 'phone'],
  [/\b(url|website|web site|link|homepage)\b/i, 'url'],
  [/\b(date|dob|birth|birthday|deadline|expiry|expiration)\b/i, 'date'],
  [/\b(price|amount|salary|cost|quantity|qty|number|count|age|total|balance|rate)\b/i, 'number'],
  [/\b(status|role|department|type|category|gender|country|state|priority|stage)\b/i, 'enum'],
  [/\b(is[_-]?\w+|active|enabled|disabled|verified|approved)\b/i, 'boolean'],
  // Common free-text nouns — kept last so more specific hints above win first.
  [/\b(name|title|description|address|city|company|username|comment|note|label|subject|remarks?)\b/i, 'text'],
];

/** Map a raw type hint from a crawl/schema to our data type. */
const RAW_TYPE_MAP: Record<string, FieldDataType> = {
  email: 'email',
  password: 'password',
  tel: 'phone',
  phone: 'phone',
  number: 'number',
  numeric: 'number',
  date: 'date',
  datetime: 'date',
  url: 'url',
  checkbox: 'boolean',
  radio: 'enum',
  select: 'enum',
  'select-one': 'enum',
  text: 'text',
  textarea: 'text',
};

/**
 * Infer a field's data type. Prefers an explicit raw type hint (from the
 * repository), falls back to name-based inference, else 'unknown'.
 */
export function inferFieldDataType(name: string, rawType?: string): FieldDataType {
  if (rawType) {
    const key = rawType.trim().toLowerCase();
    if (RAW_TYPE_MAP[key]) return RAW_TYPE_MAP[key];
  }
  for (const [re, type] of FIELD_TYPE_HINTS) {
    if (re.test(name)) return type;
  }
  return 'unknown';
}

/* ------------------------------------------------------------------ */
/*  Knowledge Base (L3) — best-practice rules per data type            */
/* ------------------------------------------------------------------ */

/**
 * Universal validations implied by a field's DATA TYPE. These attach to fields
 * that were already discovered from stronger evidence — they never create a
 * field. E.g. any email field implies a format rule; any password implies
 * format + length. This is category-universal knowledge, not feature-specific
 * invention (the same principle as the planner's keyword-gating line).
 */
const KB_RULES_BY_TYPE: Partial<Record<FieldDataType, BusinessRuleKind[]>> = {
  email: ['format'],
  phone: ['format'],
  url: ['format'],
  date: ['format'],
  password: ['format', 'length'],
  number: ['range'],
};

/**
 * The best-practice rule kinds the KB attaches to a field of the given type.
 * Returns [] for types with no universal implied rule (text/enum/boolean/unknown).
 */
export function knowledgeBaseRulesFor(dataType: FieldDataType): BusinessRuleKind[] {
  return KB_RULES_BY_TYPE[dataType] ?? [];
}

/* ------------------------------------------------------------------ */
/*  Domain Inference (L4) — likely fields per entity template          */
/* ------------------------------------------------------------------ */

/**
 * Domain templates: for a recognized entity, the fields it USUALLY has. Every
 * field emitted from here is an assumption (source 'domain_inference',
 * confidence 50) and is only admitted when the profile reaches L4. Keys are
 * normalized (lower-case, singular) entity names; matching is substring-tolerant
 * so "new employee" still hits "employee".
 */
const DOMAIN_TEMPLATES: Record<string, string[]> = {
  employee: ['Name', 'Email', 'Phone', 'Department', 'Role', 'Manager', 'Start Date'],
  user: ['Name', 'Email', 'Username', 'Password', 'Role'],
  customer: ['Name', 'Email', 'Phone', 'Address', 'Company'],
  person: ['Name', 'Email', 'Phone', 'Address'],
  product: ['Name', 'SKU', 'Price', 'Category', 'Description', 'Quantity'],
  order: ['Order Number', 'Customer', 'Total', 'Status', 'Date'],
  invoice: ['Invoice Number', 'Customer', 'Amount', 'Due Date', 'Status'],
  account: ['Name', 'Email', 'Password', 'Status'],
  project: ['Name', 'Owner', 'Start Date', 'Status', 'Description'],
  ticket: ['Title', 'Description', 'Priority', 'Status', 'Assignee'],
};

/**
 * Likely fields for an entity, from the domain template. Returns [] when the
 * entity is unknown to the templates (the engine will simply not infer fields —
 * it does not guess blindly).
 */
export function domainFieldsForEntity(entityNormalized: string): string[] {
  if (DOMAIN_TEMPLATES[entityNormalized]) return DOMAIN_TEMPLATES[entityNormalized];
  // substring tolerance: "new employee" / "employee record" → employee
  for (const key of Object.keys(DOMAIN_TEMPLATES)) {
    if (entityNormalized.includes(key)) return DOMAIN_TEMPLATES[key];
  }
  return [];
}
