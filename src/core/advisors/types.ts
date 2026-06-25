/**
 * Healing Advisor contract
 * ========================
 *
 * A *Healing Advisor* is an independent source of healing candidates. Each
 * intelligence layer (Learning, App Profile, DOM Memory, DOM Candidates,
 * Rule Engine, AI, and — in future — Knowledge Graph, Component / Framework /
 * API Intelligence) implements this single interface.
 *
 *      Advisor 1 ┐
 *      Advisor 2 ┤
 *      Advisor 3 ┼──▶  Candidate Ranker  ──▶  Healing Runner (browser)
 *      Advisor N ┘
 *
 * The orchestrator does NOT know about any concrete advisor — it only iterates
 * a list of `HealingAdvisor`s. Adding a new intelligence source therefore means
 * writing a new advisor class and registering it; **no orchestrator changes**.
 *
 * Cross-cutting concerns (dedup, syntax validation, similarity scoring, ranking)
 * are intentionally NOT the advisor's job — they are applied uniformly by the
 * orchestrator after collection so every advisor stays small and focused on the
 * single question: "where do candidates come from?".
 */

import type { FailureDetails } from '../failure-analyzer';
import type { HealingContextResult } from '../../services/healing-intelligence-context';
import type { AppProfileHealingInput } from '../../services/app-profile-healing';
import type { PatternTenantScope } from '../../engines/pattern-engine';
import type { DOMMemoryInsight } from '../../services/dom-memory-query';
import type { HealingStrategy } from '../healing-orchestrator';
import type { CandidateSource } from '../candidate-ranker';

/**
 * Advisor tier. `grounded` advisors are cheap / evidence-based (0 tokens) and
 * always run. `fallback` advisors (currently AI) are only consulted when the
 * grounded advisors did not yield enough confident candidates — this is what
 * keeps OpenAI from being called on every heal.
 */
export type AdvisorTier = 'grounded' | 'fallback';

/**
 * A raw candidate proposed by an advisor. This is the advisor's only output
 * shape — it is deliberately close to the engine outputs and carries no scoring
 * (the ranker adds that later). `inAppProfile` / `domMemoryStability` are
 * optional cross-advisor hints an advisor may set when it knows them.
 */
export interface AdvisorCandidate {
  newLocator: string;
  strategy: HealingStrategy;
  source: CandidateSource;
  confidence: number;
  tokensUsed: number;
  reasoning: string;
  addExplicitWait: boolean;
  inAppProfile?: boolean;
  domMemoryStability?: number;
}

/** What an advisor returns: its candidates plus any artifacts worth sharing. */
export interface AdvisorProposal {
  candidates: AdvisorCandidate[];
  /**
   * DOM Memory insight for the failed selector, when this advisor produced one.
   * Surfaced so the orchestrator can attach it to the result and later advisors
   * (e.g. DOM Candidate) can reuse stability scores.
   */
  domMemoryInsight?: DOMMemoryInsight;
}

/**
 * Mutable scratchpad shared across advisors within a single collection pass.
 * Advisors run in order, so a later advisor may read hints an earlier one wrote
 * (e.g. App Profile populates `appLocatorKeys`; DOM Memory populates
 * `domMemoryInsight`). Sharing is optional — an advisor that ignores it is still
 * perfectly valid.
 */
export interface AdvisorSharedState {
  /** Normalised locator keys present in the Application Profile crawl. */
  appLocatorKeys: Set<string>;
  /** DOM Memory insight for the failed selector, once the DOM Memory advisor ran. */
  domMemoryInsight?: DOMMemoryInsight;
  /** True when the failing file is a shared Page Object (Repo Intelligence). */
  matchesPageObject: boolean;
}

/**
 * Everything an advisor may read for one failure. Engines/services are injected
 * into the advisor's constructor (not here) — this context carries only the
 * per-failure request data plus the shared scratchpad and a `norm` helper.
 */
export interface AdvisorContext {
  failure: FailureDetails;
  domHtml?: string;
  skipLocators?: Set<string>;
  projectId?: number;
  companyId?: number;
  repoContext: HealingContextResult;
  appProfile?: AppProfileHealingInput;
  scope: PatternTenantScope;
  shared: AdvisorSharedState;
  /** Normalise a locator to its comparable "core" (used for dedup / app-profile match). */
  norm(locator: string): string;
}

/**
 * The plugin contract. Implement this once per intelligence source.
 *
 * Implementations should NOT throw for "no candidates" — return an empty array.
 * Unexpected errors may be thrown; the orchestrator isolates each advisor in a
 * try/catch so one failing advisor never aborts the whole collection.
 */
export interface HealingAdvisor {
  /** Human-readable name shown in logs / the decision trail (e.g. "DOM Memory"). */
  readonly name: string;
  /** Primary candidate source this advisor emits (for trail/telemetry). */
  readonly source: CandidateSource;
  /** `grounded` (always run) or `fallback` (run only when grounded is thin). */
  readonly tier: AdvisorTier;
  /** Produce candidates for the given failure. */
  propose(ctx: AdvisorContext): Promise<AdvisorProposal>;
}
