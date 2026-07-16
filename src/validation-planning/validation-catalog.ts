/**
 * Validation Planning — the catalog (knowledge).
 *
 * This is the QA knowledge the planner reads: for a field of a given DATA TYPE,
 * what validations should a complete suite exercise? For a business RULE of a
 * given kind, what does violating it look like? Pure data + tiny builders, kept
 * apart from the planner logic so the "what a QA engineer knows" lives in one
 * reviewable place.
 *
 * Nothing here invents fields or rules — it only expands validations for
 * elements the Business Model already discovered. That keeps the no-invention
 * invariant: the planner can only be as rich as the understanding it was given.
 */

import type { BusinessRuleKind, FieldDataType } from '../requirement-understanding/types';
import type { ValidationCategory } from './types';

/** One catalog entry, before it is bound to a concrete field/rule name. */
export interface ValidationTemplate {
  /** Stable slug fragment, unique within a (target, category). */
  key: string;
  category: ValidationCategory;
  /** Builds the business-readable title from the element's display name. */
  title: (name: string) => string;
  /** WHY this validation exists — the knowledge justification. */
  rationale: string;
}

/* ------------------------------------------------------------------ */
/*  Field-type validations                                             */
/* ------------------------------------------------------------------ */

const REQUIRED_EMPTY: ValidationTemplate = {
  key: 'empty',
  category: 'negative',
  title: (n) => `Reject empty ${n}`,
  rationale: 'A required field must be rejected when left blank.',
};

/** Input-safety edges universal to any free-text input a user can type into. */
const INPUT_SAFETY_EDGES: ValidationTemplate[] = [
  { key: 'whitespace', category: 'edge', title: (n) => `Trim leading/trailing spaces in ${n}`, rationale: 'Whitespace-only or padded input is a common data-quality edge.' },
  { key: 'unicode', category: 'edge', title: (n) => `Accept unicode/emoji in ${n}`, rationale: 'International names and symbols must be handled, not corrupted.' },
  { key: 'sql-ish', category: 'edge', title: (n) => `Neutralize SQL-like input in ${n}`, rationale: "User-editable text must not be interpreted as a query (e.g. \"' OR 1=1\").' " },
  { key: 'xss-ish', category: 'edge', title: (n) => `Neutralize script injection in ${n}`, rationale: 'User-editable text must not execute as markup/script (e.g. <script>).' },
];

/**
 * Non-safety validations implied purely by a field's data type. The empty/
 * required negative is added separately (it depends on whether the field is
 * required), and input-safety edges are added separately (they depend on the
 * includeInputSafetyEdges option and on the field being free-text).
 */
const TYPE_VALIDATIONS: Record<FieldDataType, ValidationTemplate[]> = {
  text: [
    { key: 'valid', category: 'positive', title: (n) => `Accept a valid ${n}`, rationale: 'The happy path for the field.' },
    { key: 'max-length', category: 'boundary', title: (n) => `Enforce maximum length on ${n}`, rationale: 'Fields have an upper length bound that must be enforced.' },
    { key: 'min-length', category: 'boundary', title: (n) => `Enforce minimum length on ${n}`, rationale: 'Very short input at the lower bound must behave correctly.' },
  ],
  email: [
    { key: 'valid', category: 'positive', title: (n) => `Accept a valid ${n}`, rationale: 'The happy path for the field.' },
    { key: 'invalid-format', category: 'negative', title: (n) => `Reject malformed ${n}`, rationale: 'Email must match an address format; malformed input is rejected.' },
    { key: 'max-length', category: 'boundary', title: (n) => `Enforce maximum ${n} length (254)`, rationale: 'RFC-bounded address length must be enforced.' },
  ],
  phone: [
    { key: 'valid', category: 'positive', title: (n) => `Accept a valid ${n}`, rationale: 'The happy path for the field.' },
    { key: 'non-numeric', category: 'negative', title: (n) => `Reject letters/symbols in ${n}`, rationale: 'A phone must contain only permitted digits/format characters.' },
    { key: 'min-digits', category: 'boundary', title: (n) => `Enforce minimum digits in ${n}`, rationale: 'Too-few digits at the lower bound must be rejected.' },
    { key: 'max-digits', category: 'boundary', title: (n) => `Enforce maximum digits in ${n}`, rationale: 'Too-many digits at the upper bound must be rejected.' },
    { key: 'country-code', category: 'edge', title: (n) => `Handle country code / leading zero in ${n}`, rationale: 'International prefixes and leading zeros are a common edge.' },
  ],
  number: [
    { key: 'valid', category: 'positive', title: (n) => `Accept a valid ${n}`, rationale: 'The happy path for the field.' },
    { key: 'non-numeric', category: 'negative', title: (n) => `Reject non-numeric ${n}`, rationale: 'Numeric fields must reject text input.' },
    { key: 'min', category: 'boundary', title: (n) => `Enforce minimum ${n}`, rationale: 'Lower numeric bound must be enforced.' },
    { key: 'max', category: 'boundary', title: (n) => `Enforce maximum ${n}`, rationale: 'Upper numeric bound must be enforced.' },
    { key: 'zero-negative', category: 'edge', title: (n) => `Handle zero / negative ${n}`, rationale: 'Zero and negative values are common numeric edges.' },
  ],
  date: [
    { key: 'valid', category: 'positive', title: (n) => `Accept a valid ${n}`, rationale: 'The happy path for the field.' },
    { key: 'invalid-format', category: 'negative', title: (n) => `Reject malformed ${n}`, rationale: 'Non-date input must be rejected.' },
    { key: 'range', category: 'boundary', title: (n) => `Enforce allowed ${n} range`, rationale: 'Past/future bounds on the date must be enforced.' },
    { key: 'impossible-date', category: 'edge', title: (n) => `Reject impossible ${n} (e.g. Feb 30)`, rationale: 'Calendar-invalid dates are a classic edge.' },
  ],
  enum: [
    { key: 'valid', category: 'positive', title: (n) => `Accept an existing ${n} value`, rationale: 'A valid option from the allowed set is accepted.' },
    { key: 'invalid-value', category: 'negative', title: (n) => `Reject an invalid ${n} value`, rationale: 'A value outside the allowed set must be rejected.' },
    { key: 'inactive-value', category: 'edge', title: (n) => `Reject a deleted/inactive ${n}`, rationale: 'A once-valid but now-inactive option is a common edge.' },
  ],
  boolean: [
    { key: 'valid', category: 'positive', title: (n) => `Toggle ${n} on and off`, rationale: 'Both boolean states must behave correctly.' },
  ],
  password: [
    { key: 'valid', category: 'positive', title: (n) => `Accept a valid ${n}`, rationale: 'The happy path for the field.' },
    { key: 'too-short', category: 'negative', title: (n) => `Reject a too-short ${n}`, rationale: 'Below the minimum strength/length must be rejected.' },
    { key: 'min-length', category: 'boundary', title: (n) => `Enforce minimum ${n} length`, rationale: 'Lower length bound must be enforced.' },
    { key: 'max-length', category: 'boundary', title: (n) => `Enforce maximum ${n} length`, rationale: 'Upper length bound must be enforced.' },
  ],
  url: [
    { key: 'valid', category: 'positive', title: (n) => `Accept a valid ${n}`, rationale: 'The happy path for the field.' },
    { key: 'invalid-format', category: 'negative', title: (n) => `Reject malformed ${n}`, rationale: 'Non-URL input must be rejected.' },
  ],
  unknown: [
    { key: 'valid', category: 'positive', title: (n) => `Accept a valid ${n}`, rationale: 'The happy path for the field.' },
  ],
};

/** Data types treated as free-text for the purpose of input-safety edges. */
const FREE_TEXT_TYPES: ReadonlySet<FieldDataType> = new Set<FieldDataType>(['text', 'email', 'url', 'password']);

/**
 * The validation templates for one field. `required` adds the empty-rejection
 * negative; `includeInputSafety` adds the universal input-safety edges for
 * free-text fields.
 */
export function templatesForField(
  dataType: FieldDataType,
  required: boolean,
  includeInputSafety: boolean,
): ValidationTemplate[] {
  const out: ValidationTemplate[] = [...(TYPE_VALIDATIONS[dataType] ?? TYPE_VALIDATIONS.unknown)];
  if (required) out.push(REQUIRED_EMPTY);
  if (includeInputSafety && FREE_TEXT_TYPES.has(dataType)) out.push(...INPUT_SAFETY_EDGES);
  return out;
}

/* ------------------------------------------------------------------ */
/*  Rule validations                                                   */
/* ------------------------------------------------------------------ */

/**
 * The validation a business rule demands be tested — chiefly its VIOLATION.
 * `targetName` is the field/entity the rule applies to (for the title). Returns
 * [] for rule kinds already fully covered by field-type templates (so we don't
 * double-emit).
 */
export function templatesForRule(ruleKind: BusinessRuleKind, targetName: string): ValidationTemplate[] {
  switch (ruleKind) {
    case 'unique':
      return [{ key: 'duplicate', category: 'negative', title: () => `Reject duplicate ${targetName}`, rationale: 'A uniqueness rule must reject a value that already exists.' }];
    case 'permission':
      return [{ key: 'unauthorized', category: 'permission', title: () => `Block unauthorized user from ${targetName}`, rationale: 'A permission rule must deny users who lack the role.' }];
    case 'dependency':
      return [{ key: 'missing-prerequisite', category: 'negative', title: () => `Reject ${targetName} when prerequisite is missing`, rationale: 'A dependency rule must be enforced when its precondition is unmet.' }];
    case 'range':
      return [{ key: 'out-of-range', category: 'boundary', title: () => `Reject out-of-range ${targetName}`, rationale: 'A range rule must reject values outside its bounds.' }];
    // mandatory / format / length are already expressed by field-type templates
    // (empty / invalid-format / min-max length) — no separate emission needed.
    case 'mandatory':
    case 'format':
    case 'length':
    case 'other':
    default:
      return [];
  }
}
