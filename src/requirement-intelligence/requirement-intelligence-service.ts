/**
 * Requirement Intelligence Service.
 *
 * The orchestration seam for a single requirement. It composes the small,
 * single-responsibility layers into ONE object (RequirementIntelligence) so no
 * consumer has to know they exist or wire them together:
 *
 *     Requirement
 *        │
 *        ├─▶ RequirementCoverageEngine  → coverage   (the FACT)
 *        └─▶ GenerationPolicy           → generation (the DECISION over the fact)
 *        │
 *        ▼
 *     RequirementIntelligence  ──▶ consumed by Script Generation / RTM / Release Center
 *
 * Responsibilities (deliberately narrow):
 *   • Call the Coverage Engine to measure coverage.
 *   • Ask the Generation Policy what to do about that coverage.
 *   • Return both, composed, alongside the requirement.
 *
 * What it does NOT do:
 *   • It does NOT contain routing logic — that lives in GenerationPolicy.
 *   • It does NOT contain matching logic — that lives in the Coverage Engine.
 *   • It does NOT call Generation Intelligence (the scenario-level reuse/extend/
 *     generate router in src/coverage-intelligence). That module answers a
 *     different question over scenarios; this service answers over requirements.
 *   • It does NOT generate, persist, or call an LLM. Deterministic and pure.
 *
 * The GenerationPolicy is constructor-injected (defaulting to the coverage-based
 * policy) so richer policies can be swapped in later without touching this
 * service or any consumer.
 */

import { assessRequirementCoverage } from '../requirement-coverage/requirement-coverage-engine';
import type { RequirementInput } from '../requirement-coverage/types';
import type { CoverageModel } from '../context/types';
import { defaultGenerationPolicy, type GenerationPolicy } from './generation-policy';
import type { RequirementIntelligence } from './types';

export class RequirementIntelligenceService {
  private readonly policy: GenerationPolicy;

  constructor(policy: GenerationPolicy = defaultGenerationPolicy) {
    this.policy = policy;
  }

  /**
   * Compose the full intelligence for one requirement against the repository's
   * Coverage Model.
   *
   * @param requirement The requirement to analyze.
   * @param models      The repository Coverage Model (from the Repository
   *                    Context Engine) to measure coverage against.
   */
  analyze(requirement: RequirementInput, models: CoverageModel[]): RequirementIntelligence {
    const coverage = assessRequirementCoverage(requirement, models);
    const generation = this.policy.decide(coverage);
    return { requirement, coverage, generation };
  }
}
