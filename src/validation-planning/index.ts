/**
 * Validation Planning — public surface.
 *
 * The component that decides WHAT to validate, per discovered field and rule,
 * so coverage balance stops being GPT's guess. Consumes a BusinessModel from
 * the Requirement Understanding Engine; feeds the Scenario Planner.
 */

export * from './types';
export { planValidations } from './validation-planner';
export {
  templatesForField,
  templatesForRule,
  type ValidationTemplate,
} from './validation-catalog';
