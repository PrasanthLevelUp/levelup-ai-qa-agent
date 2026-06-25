/**
 * Learned Pattern Advisor
 * -----------------------
 * Surfaces a previously-proven heal for this exact failure from our own pattern
 * store. Highest-trust grounded source: it already worked once. 0 tokens.
 */
import type { PatternEngine } from '../../engines/pattern-engine';
import type { AdvisorContext, AdvisorProposal, HealingAdvisor } from './types';

export class LearnedPatternAdvisor implements HealingAdvisor {
  readonly name = 'Learned Pattern';
  readonly source = 'learned_pattern' as const;
  readonly tier = 'grounded' as const;

  constructor(private readonly patternEngine: PatternEngine) {}

  async propose(ctx: AdvisorContext): Promise<AdvisorProposal> {
    const pr = await this.patternEngine.findMatch(ctx.failure, ctx.scope);
    if (!pr) return { candidates: [] };
    return {
      candidates: [
        {
          newLocator: pr.newLocator,
          strategy: 'database_pattern',
          source: 'learned_pattern',
          confidence: pr.confidence,
          tokensUsed: 0,
          reasoning: `[Learned Pattern] ${pr.reasoning}`,
          addExplicitWait: false,
        },
      ],
    };
  }
}
