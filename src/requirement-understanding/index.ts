/**
 * Requirement Understanding — public surface.
 *
 * The single foundational engine that turns Requirement + Repository Context
 * into a deterministic, evidence-attributed Business Model. Consumed by the
 * future Coverage Matrix Builder, Scenario Planner, Script Generation, RTM, and
 * Release Intelligence — one intelligence engine, many consumers.
 */

export * from './types';
export { understandRequirement } from './requirement-understanding-engine';
export {
  inferFieldDataType,
  knowledgeBaseRulesFor,
  domainFieldsForEntity,
} from './domain-knowledge';
