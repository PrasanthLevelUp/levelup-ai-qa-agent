/**
 * DOM Candidate Advisor
 * ---------------------
 * Extracts candidate selectors from a live DOM snapshot (when one is available)
 * for the failed element. Enriches each with DOM Memory stability (read from
 * shared state) and app-profile membership. 0 tokens.
 */
import type { DOMCandidateExtractor } from '../../engines/dom-candidate-extractor';
import type { AdvisorContext, AdvisorProposal, HealingAdvisor } from './types';

export class DomCandidateAdvisor implements HealingAdvisor {
  readonly name = 'DOM Candidate';
  readonly source = 'dom_candidate' as const;
  readonly tier = 'grounded' as const;

  constructor(private readonly domExtractor: DOMCandidateExtractor) {}

  async propose(ctx: AdvisorContext): Promise<AdvisorProposal> {
    if (!ctx.domHtml || !ctx.failure.failedLocator) return { candidates: [] };

    const dom = this.domExtractor.extractFromHTML(
      ctx.domHtml,
      ctx.failure.failedLocator,
      ctx.failure.failedLineCode || '',
    );

    const candidates = (dom.candidates ?? []).map((dc) => {
      const stability = ctx.shared.domMemoryInsight?.alternatives.find(
        (a) => a.selector === dc.selector,
      )?.stabilityScore;
      return {
        newLocator: dc.selector,
        strategy: 'rule_based' as const,
        source: 'dom_candidate' as const,
        confidence: dc.score,
        tokensUsed: 0,
        reasoning: `[DOM Candidate] ${dc.reasoning}`,
        addExplicitWait: false,
        domMemoryStability: stability,
        inAppProfile: ctx.shared.appLocatorKeys.has(ctx.norm(dc.selector)),
      };
    });

    return { candidates };
  }
}
