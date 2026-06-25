/**
 * AI Advisor (fallback tier)
 * --------------------------
 * LLM-backed selector reasoning. This is the ONLY advisor that spends tokens,
 * so it is marked `tier: 'fallback'` — the orchestrator consults it *only* when
 * the grounded advisors (Learning, App Profile, DOM Memory, DOM Candidate, Rule)
 * did not yield enough confident candidates. Under normal operation, when a
 * grounded layer already has a strong answer, OpenAI is never called.
 */
import type { AIEngine } from '../../engines/ai-engine';
import type { AdvisorContext, AdvisorProposal, HealingAdvisor } from './types';

export class AIAdvisor implements HealingAdvisor {
  readonly name = 'AI';
  readonly source = 'ai' as const;
  readonly tier = 'fallback' as const;

  constructor(private readonly aiEngine: AIEngine) {}

  async propose(ctx: AdvisorContext): Promise<AdvisorProposal> {
    const grounding = ctx.repoContext?.promptBlock || undefined;
    const ai = await this.aiEngine.suggest(ctx.failure, grounding);
    if (!ai) return { candidates: [] };
    return {
      candidates: [
        {
          newLocator: ai.newLocator,
          strategy: 'ai_reasoning',
          source: 'ai',
          confidence: ai.confidence,
          tokensUsed: ai.tokensUsed,
          reasoning: ai.reasoning,
          addExplicitWait: false,
        },
      ],
    };
  }
}
