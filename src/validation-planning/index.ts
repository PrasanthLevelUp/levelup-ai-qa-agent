/**
 * Validation Planning — public surface.
 *
 * The engine that discovers VALIDATION OBLIGATIONS from business risk: what must
 * be validated, deduplicated by intent, sized dynamically from a risk profile,
 * and reconciled against what the repository already covers. Positive / Negative
 * / Edge exists only in the derived presentation layer. Consumes a BusinessModel
 * from the Requirement Understanding Engine; feeds the Scenario Planner.
 */

export * from './types';
export { planValidations } from './validation-planner';
export {
  inputValidationTemplates,
  boundaryTemplates,
  businessRuleTemplate,
  authorizationTemplate,
  SECURITY_PAYLOADS,
  DATA_INTEGRITY_CHECKS,
  FREE_TEXT_TYPES,
  type ObligationTemplate,
} from './validation-catalog';
