/**
 * Rule Engine Advisor
 * -------------------
 * Deterministic, heuristic selector repairs (id/name/text/role rewrites, etc.).
 * Always cheap, 0 tokens. Flags candidates that also appear in the app profile.
 */
import type { RuleEngine } from '../../engines/rule-engine';
import type { AdvisorContext, AdvisorProposal, HealingAdvisor } from './types';

export class RuleEngineAdvisor implements HealingAdvisor {
  readonly name = 'Rule Engine';
  readonly source = 'rule' as const;
  readonly tier = 'grounded' as const;

  constructor(private readonly ruleEngine: RuleEngine) {}

  async propose(ctx: AdvisorContext): Promise<AdvisorProposal> {
    const ruleResult = this.ruleEngine.generate(ctx.failure, ctx.skipLocators);
    const candidates = (ruleResult.suggestions ?? []).map((s) => ({
      newLocator: s.newLocator,
      strategy: 'rule_based' as const,
      source: 'rule' as const,
      confidence: s.confidence,
      tokensUsed: 0,
      reasoning: s.reasoning,
      addExplicitWait: ruleResult.addExplicitWait,
      inAppProfile: ctx.shared.appLocatorKeys.has(ctx.norm(s.newLocator)),
    }));
    return { candidates };
  }
}
