/**
 * Healing Advisors — public surface + default registry.
 *
 * To add a new intelligence source (Knowledge Graph, Component Intelligence,
 * API Intelligence, Framework Intelligence, …):
 *   1. Create `my-advisor.ts` implementing `HealingAdvisor`.
 *   2. Export it here.
 *   3. Add it to the array returned by `buildDefaultAdvisors`.
 * No changes are needed in the orchestrator or the ranker.
 */
import type { PatternEngine } from '../../engines/pattern-engine';
import type { RuleEngine } from '../../engines/rule-engine';
import type { AIEngine } from '../../engines/ai-engine';
import type { DOMCandidateExtractor } from '../../engines/dom-candidate-extractor';
import type { DOMMemoryQuery } from '../../services/dom-memory-query';

import { LearnedPatternAdvisor } from './learned-pattern-advisor';
import { AppProfileAdvisor } from './app-profile-advisor';
import { DomMemoryAdvisor } from './dom-memory-advisor';
import { DomCandidateAdvisor } from './dom-candidate-advisor';
import { RuleEngineAdvisor } from './rule-engine-advisor';
import { AIAdvisor } from './ai-advisor';
import type { HealingAdvisor } from './types';

export * from './types';
export { LearnedPatternAdvisor } from './learned-pattern-advisor';
export { AppProfileAdvisor } from './app-profile-advisor';
export { DomMemoryAdvisor } from './dom-memory-advisor';
export { DomCandidateAdvisor } from './dom-candidate-advisor';
export { RuleEngineAdvisor } from './rule-engine-advisor';
export { AIAdvisor } from './ai-advisor';

/** Engines/services the default advisors depend on (constructor-injected). */
export interface AdvisorDeps {
  patternEngine: PatternEngine;
  ruleEngine: RuleEngine;
  aiEngine: AIEngine;
  domExtractor: DOMCandidateExtractor;
  domMemory: DOMMemoryQuery;
}

/**
 * Build the default advisor pipeline, in collection order. Grounded advisors
 * run first (cheap, 0-token); the AI fallback advisor runs last and only when
 * grounded advisors were thin (the orchestrator enforces that gate).
 *
 * Order matters only for the shared-state hints (App Profile seeds the locator
 * key set before DOM Memory / DOM Candidate / Rule read it); ranking is order-
 * independent and deterministic.
 */
export function buildDefaultAdvisors(deps: AdvisorDeps): HealingAdvisor[] {
  return [
    new LearnedPatternAdvisor(deps.patternEngine),
    new AppProfileAdvisor(),
    new DomMemoryAdvisor(deps.domMemory),
    new DomCandidateAdvisor(deps.domExtractor),
    new RuleEngineAdvisor(deps.ruleEngine),
    new AIAdvisor(deps.aiEngine),
  ];
}
