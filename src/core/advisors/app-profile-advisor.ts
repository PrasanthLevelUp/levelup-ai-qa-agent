/**
 * App Profile Advisor
 * -------------------
 * Emits grounded candidates backed by the Application Profile crawl (real DOM
 * evidence from the target app). Also seeds `shared.appLocatorKeys` so later
 * advisors can flag their candidates as "also present in the app profile".
 * 0 tokens.
 */
import type { AdvisorContext, AdvisorProposal, HealingAdvisor } from './types';

export class AppProfileAdvisor implements HealingAdvisor {
  readonly name = 'App Profile';
  readonly source = 'app_profile' as const;
  readonly tier = 'grounded' as const;

  async propose(ctx: AdvisorContext): Promise<AdvisorProposal> {
    const appCandidates = ctx.appProfile?.candidates ?? [];

    // Seed shared state for downstream advisors (DOM Memory, DOM Candidate, Rule).
    for (const c of appCandidates) {
      ctx.shared.appLocatorKeys.add(ctx.norm(c.locator));
    }

    return {
      candidates: appCandidates.map((c) => ({
        newLocator: c.locator,
        strategy: 'rule_based',
        source: 'app_profile',
        confidence: c.confidence,
        tokensUsed: 0,
        reasoning: `[App Profile] ${c.reasoning}`,
        addExplicitWait: false,
        inAppProfile: true,
      })),
    };
  }
}
