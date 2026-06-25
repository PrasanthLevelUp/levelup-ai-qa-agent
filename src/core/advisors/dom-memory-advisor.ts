/**
 * DOM Memory Advisor
 * ------------------
 * Surfaces historically-stable alternative selectors recorded from past
 * healings/crawls. Publishes the resolved `DOMMemoryInsight` to shared state
 * (so the DOM Candidate advisor can reuse stability scores) and returns it as
 * an artifact for observability. 0 tokens.
 */
import type { DOMMemoryQuery } from '../../services/dom-memory-query';
import type { AdvisorContext, AdvisorProposal, HealingAdvisor } from './types';

export class DomMemoryAdvisor implements HealingAdvisor {
  readonly name = 'DOM Memory';
  readonly source = 'dom_memory' as const;
  readonly tier = 'grounded' as const;

  constructor(private readonly domMemory: DOMMemoryQuery) {}

  async propose(ctx: AdvisorContext): Promise<AdvisorProposal> {
    if (!ctx.failure.failedLocator) return { candidates: [] };

    const insight = await this.domMemory.getInsight(
      ctx.failure.failedLocator,
      ctx.projectId,
      ctx.companyId,
    );
    // Share with later advisors (DOM Candidate looks up stability by selector).
    ctx.shared.domMemoryInsight = insight;

    const candidates = (insight?.alternatives ?? []).map((alt) => ({
      newLocator: alt.selector,
      strategy: 'database_pattern' as const,
      source: 'dom_memory' as const,
      confidence: alt.compositeScore,
      tokensUsed: 0,
      reasoning: `[DOM Memory] ${alt.reasoning}`,
      addExplicitWait: false,
      domMemoryStability: alt.stabilityScore,
      inAppProfile: ctx.shared.appLocatorKeys.has(ctx.norm(alt.selector)),
    }));

    return { candidates, domMemoryInsight: insight };
  }
}
