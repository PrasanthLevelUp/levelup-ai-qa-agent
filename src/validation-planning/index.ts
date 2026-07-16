/**
 * Validation Planning — public surface.
 *
 * The component that decides WHAT to validate by walking a QA taxonomy
 * (Category → applicable Rules/Fields → Point), so coverage balance stops being
 * GPT's guess and positives stop scaling with field count. Consumes a
 * BusinessModel from the Requirement Understanding Engine; feeds the Scenario
 * Planner.
 */

export * from './types';
export { planValidations } from './validation-planner';
export {
  inputValidationTemplates,
  boundaryTemplates,
  businessRuleTemplate,
  permissionTemplate,
  SECURITY_PAYLOADS,
  DATA_INTEGRITY_CHECKS,
  FREE_TEXT_TYPES,
  type ValidationTemplate,
} from './validation-catalog';
