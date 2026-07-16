/**
 * Validation Planning — the catalog (knowledge), indexed by QA category.
 *
 * This is the knowledge a QA lead carries, organized the way the planner now
 * consumes it: by CATEGORY first, then "which fields/rules does this category
 * touch?". It is pure data + tiny selectors, kept apart from the planner loop so
 * "what an experienced QA engineer knows" lives in one reviewable place.
 *
 * Two shapes of knowledge live here:
 *   1. Per-field templates a category asks for given a field's DATA TYPE
 *      (Input Validation → format rejection; Boundary → length/range).
 *   2. Category-level payloads that are field-agnostic and get applied ACROSS
 *      the free-text fields as a single point each (Security → SQL/XSS/script;
 *      Data Integrity → unicode/emoji/whitespace). This is what stops
 *      cross-field concerns from repeating once per field.
 *
 * Nothing here invents fields or rules — it only expands validations for
 * elements the Business Model already discovered. The planner can only ever be
 * as rich as the understanding it was given.
 */

import type { BusinessRuleKind, FieldDataType } from '../requirement-understanding/types';
import type { CoverageFamily } from '../engines/generation-quality-engine';

/**
 * One catalog entry, before it is bound to a concrete field/rule name. `family`
 * is stated explicitly (not derived from the category) because a single QA
 * category legitimately produces points of different coverage families — the
 * two axes are independent. The values here are exactly the CoverageFamily
 * union the Quality Validator grades on, so planner intent and auditor grading
 * speak the same language.
 */
export interface ValidationTemplate {
  /** Stable slug fragment, unique within a (target, category). */
  key: string;
  /** The coverage family the Quality Validator will grade this under. */
  family: CoverageFamily;
  /** Builds the business-readable title from the element's display name. */
  title: (name: string) => string;
  /** WHY this validation exists — the knowledge justification. */
  rationale: string;
}

/* ================================================================== */
/*  INPUT VALIDATION — per-field rejection of invalid input            */
/* ================================================================== */

/** The empty-rejection negative, added when a field is required. */
const REQUIRED_EMPTY: ValidationTemplate = {
  key: 'empty',
  family: 'negative',
  title: (n) => `Reject empty ${n}`,
  rationale: 'A required field must be rejected when left blank.',
};

/** Format-rejection negatives implied by a field's data type (no boundary here). */
const FORMAT_REJECTIONS: Partial<Record<FieldDataType, ValidationTemplate[]>> = {
  email: [
    { key: 'invalid-format', family: 'negative', title: (n) => `Reject malformed ${n}`, rationale: 'Email must match an address format; malformed input is rejected.' },
  ],
  phone: [
    { key: 'non-numeric', family: 'negative', title: (n) => `Reject letters/symbols in ${n}`, rationale: 'A phone must contain only permitted digits/format characters.' },
  ],
  number: [
    { key: 'non-numeric', family: 'negative', title: (n) => `Reject non-numeric ${n}`, rationale: 'Numeric fields must reject text input.' },
  ],
  date: [
    { key: 'invalid-format', family: 'negative', title: (n) => `Reject malformed ${n}`, rationale: 'Non-date input must be rejected.' },
  ],
  url: [
    { key: 'invalid-format', family: 'negative', title: (n) => `Reject malformed ${n}`, rationale: 'Non-URL input must be rejected.' },
  ],
  enum: [
    { key: 'invalid-value', family: 'negative', title: (n) => `Reject an invalid ${n} value`, rationale: 'A value outside the allowed set must be rejected.' },
  ],
  password: [
    { key: 'too-short', family: 'negative', title: (n) => `Reject a too-short ${n}`, rationale: 'Below the minimum strength/length must be rejected.' },
  ],
};

/**
 * Input-Validation templates for one field: the empty-rejection (when required)
 * plus any type-specific format rejections. All negative-family.
 */
export function inputValidationTemplates(dataType: FieldDataType, required: boolean): ValidationTemplate[] {
  const out: ValidationTemplate[] = [];
  if (required) out.push(REQUIRED_EMPTY);
  out.push(...(FORMAT_REJECTIONS[dataType] ?? []));
  return out;
}

/* ================================================================== */
/*  BOUNDARY — per-field limits (edge family)                          */
/* ================================================================== */

const BOUNDARY_TEMPLATES: Partial<Record<FieldDataType, ValidationTemplate[]>> = {
  text: [
    { key: 'max-length', family: 'edge', title: (n) => `Enforce maximum length on ${n}`, rationale: 'Fields have an upper length bound that must be enforced.' },
    { key: 'min-length', family: 'edge', title: (n) => `Enforce minimum length on ${n}`, rationale: 'Very short input at the lower bound must behave correctly.' },
  ],
  email: [
    { key: 'max-length', family: 'edge', title: (n) => `Enforce maximum ${n} length (254)`, rationale: 'RFC-bounded address length must be enforced.' },
  ],
  phone: [
    { key: 'min-digits', family: 'edge', title: (n) => `Enforce minimum digits in ${n}`, rationale: 'Too-few digits at the lower bound must be rejected.' },
    { key: 'max-digits', family: 'edge', title: (n) => `Enforce maximum digits in ${n}`, rationale: 'Too-many digits at the upper bound must be rejected.' },
  ],
  number: [
    { key: 'min', family: 'edge', title: (n) => `Enforce minimum ${n}`, rationale: 'Lower numeric bound must be enforced.' },
    { key: 'max', family: 'edge', title: (n) => `Enforce maximum ${n}`, rationale: 'Upper numeric bound must be enforced.' },
  ],
  date: [
    { key: 'range', family: 'edge', title: (n) => `Enforce allowed ${n} range`, rationale: 'Past/future bounds on the date must be enforced.' },
  ],
  password: [
    { key: 'min-length', family: 'edge', title: (n) => `Enforce minimum ${n} length`, rationale: 'Lower length bound must be enforced.' },
    { key: 'max-length', family: 'edge', title: (n) => `Enforce maximum ${n} length`, rationale: 'Upper length bound must be enforced.' },
  ],
};

/** Boundary templates for one field (empty for types without a meaningful limit). */
export function boundaryTemplates(dataType: FieldDataType): ValidationTemplate[] {
  return [...(BOUNDARY_TEMPLATES[dataType] ?? [])];
}

/* ================================================================== */
/*  SECURITY & DATA INTEGRITY — category-level, applied across fields  */
/* ================================================================== */

/**
 * Malicious-input payloads. These are NOT per-field — one point each, listing
 * every free-text field it should be exercised against. Injection is an
 * attemptable-but-illegal input, graded under the edge family.
 */
export const SECURITY_PAYLOADS: ValidationTemplate[] = [
  { key: 'sql-injection', family: 'edge', title: () => 'Neutralize SQL-like input in free-text fields', rationale: "User-editable text must not be interpreted as a query (e.g. \"' OR 1=1\")." },
  { key: 'xss', family: 'edge', title: () => 'Neutralize script injection (XSS) in free-text fields', rationale: 'User-editable text must not execute as markup/script (e.g. <script>).' },
  { key: 'script-input', family: 'edge', title: () => 'Neutralize template/command-like input in free-text fields', rationale: 'Expression/command syntax must be treated as literal text, not evaluated.' },
];

/**
 * Data-integrity checks — unusual but LEGAL input that must be preserved, not
 * corrupted. Also category-level: one point each, across the free-text fields.
 */
export const DATA_INTEGRITY_CHECKS: ValidationTemplate[] = [
  { key: 'unicode', family: 'edge', title: () => 'Preserve unicode/accented characters in free-text fields', rationale: 'International names and symbols must round-trip without corruption.' },
  { key: 'emoji', family: 'edge', title: () => 'Preserve emoji / multibyte input in free-text fields', rationale: 'Multibyte characters are a common storage/encoding edge.' },
  { key: 'whitespace', family: 'edge', title: () => 'Trim leading/trailing whitespace in free-text fields', rationale: 'Padded or whitespace-only input is a common data-quality edge.' },
];

/** Data types treated as free-text for security / data-integrity purposes. */
export const FREE_TEXT_TYPES: ReadonlySet<FieldDataType> = new Set<FieldDataType>(['text', 'email', 'url', 'password']);

/* ================================================================== */
/*  BUSINESS RULE & PERMISSION — from discovered rules                 */
/* ================================================================== */

/**
 * The validation a business rule demands be tested — chiefly its VIOLATION.
 * Returns null for rule kinds a different category already owns, so nothing is
 * double-emitted:
 *   - mandatory  → Input Validation already emits the empty-rejection
 *   - format/length → field-type Input Validation / Boundary already cover it
 *   - range      → Boundary owns it
 *   - permission → the Permission category owns it
 */
export function businessRuleTemplate(ruleKind: BusinessRuleKind, targetName: string): ValidationTemplate | null {
  switch (ruleKind) {
    case 'unique':
      return { key: 'duplicate', family: 'negative', title: () => `Reject duplicate ${targetName}`, rationale: 'A uniqueness rule must reject a value that already exists.' };
    case 'dependency':
      return { key: 'missing-prerequisite', family: 'negative', title: () => `Reject ${targetName} when its prerequisite is missing`, rationale: 'A dependency rule must be enforced when its precondition is unmet.' };
    default:
      return null;
  }
}

/** Rule kinds the Permission category, not the Business-Rule category, owns. */
export function permissionTemplate(targetName: string): ValidationTemplate {
  return { key: 'unauthorized', family: 'advanced', title: () => `Block unauthorized user from ${targetName}`, rationale: 'A permission rule must deny users who lack the required role.' };
}
