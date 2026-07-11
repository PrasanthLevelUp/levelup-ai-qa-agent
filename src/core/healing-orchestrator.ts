/**
 * Healing Orchestrator v3 (DOM Memory Enhanced)
 * Integrates: DOM Memory → Strategy Selector → Rule/Pattern/AI Engines → Validation → AST Patch → Rerun
 * Features: Confidence-based routing, token budget management, rollback support,
 *           DOM Memory stability scoring, historical selector ranking.
 *
 * KEY DIFFERENTIATOR: Before generating new fixes, queries DOM Memory for:
 *  1. Selector stability history (how often has this selector changed?)
 *  2. Alternative selectors with stability scores
 *  3. Ranks ALL suggestions (engine-generated + DOM Memory alternatives) by stability
 *  4. Records healing observations for future learning
 */

import type { FailureDetails } from './failure-analyzer';
import { HealingStrategySelector, type SelectedStrategy } from './healing-strategy-selector';
import { RuleEngine } from '../engines/rule-engine';
import { PatternEngine, type PatternTenantScope } from '../engines/pattern-engine';
import { AIEngine } from '../engines/ai-engine';
import { DOMCandidateExtractor, type DOMExtractionResult } from '../engines/dom-candidate-extractor';
import { SemanticSimilarityEngine } from '../engines/semantic-similarity-engine';
import { ConfidenceEngine, type ConfidenceResult } from '../engines/confidence-engine';
import { ValidationEngine, type ValidationResult } from '../engines/validation-engine';
import { PatchEngine, type PatchResult } from '../engines/patch-engine';
import { RerunEngine, type RerunResult } from '../engines/rerun-engine';
import { DOMMemoryQuery, type DOMMemoryInsight, type AlternativeSelector } from '../services/dom-memory-query';
import { buildHealingResult, type HealingResult } from './healing-result';
import {
  HealingIntelligenceContext,
  emptyHealingContext,
  type HealingContextResult,
} from '../services/healing-intelligence-context';
import type { AppProfileHealingInput } from '../services/app-profile-healing';
import {
  classifyFailureFile,
  type PageObjectSource,
} from '../services/repo-intelligence-healing';
import { logger } from '../utils/logger';
import {
  logHealing,
  storePattern,
} from '../db/postgres';
import {
  rankCandidates,
  type RankableCandidate,
  type ScoredCandidate,
  type CandidateSource,
} from './candidate-ranker';
import {
  buildDefaultAdvisors,
  type HealingAdvisor,
  type AdvisorContext,
} from './advisors';

const MOD = 'healing-orchestrator';

/** Parse a non-negative float env var, falling back to a default. */
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Parse a non-negative integer env var, falling back to a default. */
function envIntLocal(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Method types whose selectors are the most trustworthy grounding signal. */
const PAGE_OBJECT_METHOD_TYPES = new Set(['page_object_method', 'helper']);

/**
 * Normalize a locator / source snippet for robust substring corroboration:
 * lowercases, unifies quote styles, and strips all whitespace so cosmetic
 * differences (spacing inside getByRole(...), single vs double quotes) don't
 * defeat the "is this selector present in the repo?" check.
 *
 * Exported for unit testing.
 */
export function normalizeSelectorText(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/["'`]/g, '"')
    .replace(/\s+/g, '');
}

/**
 * Reduce a locator/source snippet to its "core" selector call for direction-
 * insensitive corroboration: normalizes, then strips Playwright framework
 * prefixes (`await`, `this.page.`, `page.`, `this.`) so an AI suggestion like
 * `page.getByRole('button')` matches a page-object body written as
 * `this.page.getByRole("button")`. Exported for unit testing.
 */
export function selectorCore(text: string): string {
  return normalizeSelectorText(text)
    .replace(/await/g, '')
    .replace(/this\.page\./g, '')
    .replace(/page\./g, '')
    .replace(/this\./g, '');
}

/**
 * Pure computation of the repository-aware confidence boost (Sprint 2.3).
 * Given a proposed locator and the repository grounding evidence, returns the
 * additive boost (0–1 scale, before capping) and human-readable reasons.
 *
 * Returns `{ boost: 0, reasons: [] }` when there is no evidence. Exported and
 * side-effect-free so the scoring policy can be unit-tested without a DB.
 */
export function computeRepositoryConfidenceBoost(
  newLocator: string,
  repoContext: HealingContextResult,
): { boost: number; reasons: string[] } {
  if (!repoContext || !repoContext.hasEvidence) return { boost: 0, reasons: [] };

  const target = selectorCore(newLocator);
  if (!target) return { boost: 0, reasons: [] };

  const matchingMethod = repoContext.methodHits.find((m) =>
    selectorCore(m.sourceCode || '').includes(target),
  );
  const ragCorroborated = repoContext.ragExamples.some((e) =>
    selectorCore(e.content || '').includes(target),
  );

  let boost = 0;
  const reasons: string[] = [];

  if (matchingMethod) {
    if (PAGE_OBJECT_METHOD_TYPES.has(matchingMethod.methodType)) {
      boost += 0.2;
      reasons.push(`reuses page-object method ${matchingMethod.methodName}`);
    } else {
      boost += 0.15;
      reasons.push(`matches indexed method ${matchingMethod.methodName}`);
    }
    if ((matchingMethod.usageCount || 0) > 0) {
      boost += 0.1;
      reasons.push(`used by ${matchingMethod.usageCount} existing test(s)`);
    }
  } else if (ragCorroborated) {
    boost += 0.1;
    reasons.push('found in related repository source');
  } else {
    // Grounding was available to the model but the exact locator was not found
    // verbatim — a small, conservative boost only.
    boost += 0.03;
    reasons.push('repository grounding available');
  }

  return { boost, reasons };
}

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export type HealingStrategy = 'rule_based' | 'database_pattern' | 'ai_reasoning';

export interface HealingSuggestion {
  newLocator: string;
  strategy: HealingStrategy;
  confidence: number;
  tokensUsed: number;
  reasoning: string;
  addExplicitWait: boolean;
  /** Stability score from DOM Memory (0–1, higher = more stable) */
  stabilityScore?: number;
  /** Human-readable stability assessment */
  stabilityAssessment?: string;
}

/**
 * Decision trail entry — captures whether a healing layer won, was tried and
 * missed, was skipped (because an earlier layer won), or errored.
 */
export interface DecisionTrailEntry {
  layer: string; // e.g. "Learned Pattern", "App Profile", "DOM Memory", "AI"
  outcome: 'hit' | 'miss' | 'skipped' | 'not_reached' | 'error';
  confidence?: number; // present when outcome='hit'
  reasoning?: string; // why it won, why it missed, or error message
}

/**
 * Repo Intelligence targeting (Phase 4 / PR #160 — "Patch the Page Object").
 *
 * When the broken selector lives inside a shared Page Object / helper, the
 * failure's own stack file (`failure.filePath` + `lineNumber`) already points at
 * that abstraction. Repo Intelligence is a deterministic *router*: it does not
 * invent a selector (the waterfall already grounded one) — it decides WHERE the
 * patch should be written and how many tests one patch repairs.
 *
 * When present on a `HealingOutcome`, the apply flow patches `targetFile` (the
 * shared Page Object) instead of grepping for an individual spec.
 */
export interface PageObjectPatchTarget {
  /** Shared file to patch — the failing file when it is a Page Object/helper. */
  targetFile: string;
  /** Line within `targetFile` to patch (from the failure stack), when known. */
  targetLine?: number;
  /** Owning class (e.g. "LoginPage"), when known. */
  className?: string | null;
  /** Owning method (e.g. "login"), when known. */
  methodName?: string | null;
  /** Tests repaired by this single patch (0 when the count is unknown). */
  impactedTests: number;
  /** How the Page Object was detected. */
  source: PageObjectSource;
  /** Human-readable explanation for the decision trail / PR body. */
  reasoning: string;
}

/**
 * Map a healing outcome's Repo Intelligence targeting onto the `healing_actions`
 * persistence fields. Keeps the four columns in lock-step across every
 * `logHealing` call site (returns NULL/false/0 for ordinary spec heals).
 */
export function pageObjectPatchLogFields(outcome: Pick<HealingOutcome, 'pageObjectPatch'>): {
  target_file_path: string | null;
  target_line: number | null;
  is_page_object_patch: boolean;
  page_object_impact: number;
} {
  const p = outcome.pageObjectPatch;
  return {
    target_file_path: p?.targetFile ?? null,
    target_line: p?.targetLine ?? null,
    is_page_object_patch: !!p,
    page_object_impact: p?.impactedTests ?? 0,
  };
}

export interface HealingOutcome {
  suggestion: HealingSuggestion | null;
  attemptedStrategies: HealingStrategy[];
  validationResult?: ValidationResult;
  selectedEngine?: string;
  confidenceResult?: ConfidenceResult;
  domCandidates?: DOMExtractionResult;
  /** DOM Memory insight for the failed selector */
  domMemoryInsight?: DOMMemoryInsight;
  /**
   * Decision trail — waterfall view of which intelligence layers were tried,
   * which won, which missed, and which were skipped. Surfaced to the frontend
   * for the "Healing Decision" observability card.
   */
  decisionTrail?: DecisionTrailEntry[];
  /**
   * Repo Intelligence targeting. Present (with `isPageObject` semantics) when the
   * failing file is a shared Page Object / helper, so the apply flow patches that
   * one file and repairs every dependent test. Absent for ordinary spec heals.
   */
  pageObjectPatch?: PageObjectPatchTarget;
  /**
   * Sprint 4.1 — the canonical, explainable healing result. Additive: it
   * consolidates the already-computed suggestion / confidence / DOM-memory /
   * diagnosis into one strongly-typed shape (original + healed selector, a
   * deterministic reason, per-signal evidence, alternatives, and risk) for UI
   * and analytics. Existing consumers keep reading `suggestion` etc. unchanged.
   */
  healingResult?: HealingResult;
}

/**
 * Result of {@link HealingOrchestrator.collectRankedCandidates} — a pre-ranked,
 * already statically-validated set of candidates that the worker can try against
 * the browser best-first, plus the shared observability artifacts (decision
 * trail + Page Object targeting) that apply to the whole failure.
 */
export interface RankedCandidateSet {
  /** Candidates, best-first. Each already passed cheap syntax/static validation. */
  candidates: ScoredCandidate[];
  /** Waterfall/ranking summary for the "Healing Decision" observability card. */
  decisionTrail: DecisionTrailEntry[];
  /** Repo Intelligence targeting — present when the failing file is a Page Object. */
  pageObjectPatch?: PageObjectPatchTarget;
  /** DOM Memory insight for the failed selector (when available). */
  domMemoryInsight?: DOMMemoryInsight;
}

export interface FinalizeResult {
  success: boolean;
  patchPath?: string;
  rerunResult?: RerunResult;
  engine?: string;
  confidence?: number;
  tokensUsed?: number;
  stabilityScore?: number;
}

/* -------------------------------------------------------------------------- */
/*  Orchestrator                                                              */
/* -------------------------------------------------------------------------- */

export class HealingOrchestrator {
  private readonly validationEngine: ValidationEngine;
  private readonly patchEngine: PatchEngine;
  private readonly rerunEngine: RerunEngine;
  private readonly strategySelector: HealingStrategySelector;
  private readonly domExtractor: DOMCandidateExtractor;
  private readonly similarityEngine: SemanticSimilarityEngine;
  private readonly confidenceEngine: ConfidenceEngine;
  private readonly domMemory: DOMMemoryQuery;
  /**
   * Pluggable candidate sources. The orchestrator never references a concrete
   * intelligence layer when collecting candidates — it only iterates this list.
   * New intelligence (Knowledge Graph, Component / Framework / API Intelligence)
   * is added by registering another {@link HealingAdvisor}, with no changes here.
   */
  private readonly advisors: HealingAdvisor[];

  constructor(
    private readonly ruleEngine: RuleEngine,
    private readonly patternEngine: PatternEngine,
    private readonly aiEngine: AIEngine,
    validationEngine?: ValidationEngine,
    patchEngine?: PatchEngine,
    rerunEngine?: RerunEngine,
    strategySelector?: HealingStrategySelector,
    advisors?: HealingAdvisor[],
  ) {
    this.validationEngine = validationEngine ?? new ValidationEngine();
    this.patchEngine = patchEngine ?? new PatchEngine();
    this.rerunEngine = rerunEngine ?? new RerunEngine();
    this.strategySelector = strategySelector ?? new HealingStrategySelector();
    this.domExtractor = new DOMCandidateExtractor();
    this.similarityEngine = new SemanticSimilarityEngine();
    this.confidenceEngine = new ConfidenceEngine();
    this.domMemory = new DOMMemoryQuery();
    // Default advisor registry (override-able for testing / custom pipelines).
    this.advisors =
      advisors ??
      buildDefaultAdvisors({
        patternEngine: this.patternEngine,
        ruleEngine: this.ruleEngine,
        aiEngine: this.aiEngine,
        domExtractor: this.domExtractor,
        domMemory: this.domMemory,
      });
  }

  /**
   * Main healing flow — enhanced with DOM Memory + DOM candidate extraction.
   * Priority: DOM Memory Alternatives → DOM Candidates → Rule Engine → Pattern Engine → AI Engine
   *
   * DOM Memory integration (v3):
   *  - Before trying any engine, queries historical selector data
   *  - If a stable alternative exists from past healings, uses it immediately (0 tokens!)
   *  - After engine-generated fixes, ranks them by stability score
   *  - Records healing observation for future learning
   *
   * @param failure - Analyzed failure details
   * @param domHtml - Optional: raw DOM HTML from page.content() for DOM-based healing
   * @param skipLocators - Optional: locators to skip (already tried)
   * @param projectId - Optional: project ID for project-scoped DOM Memory queries
   * @param companyId - Optional: company ID for company-scoped queries
   */
  async heal(
    failure: FailureDetails,
    domHtml?: string,
    skipLocators?: Set<string>,
    projectId?: number,
    companyId?: number,
    repoContext?: HealingContextResult,
    appProfile?: AppProfileHealingInput,
  ): Promise<HealingOutcome> {
    // Run the full waterfall (Learning → App Profile → DOM Memory → … → AI).
    const outcome = await this.healCore(
      failure,
      domHtml,
      skipLocators,
      projectId,
      companyId,
      repoContext,
      appProfile,
    );

    // ── Repo Intelligence (Phase 4) — deterministic targeting router ──
    // Orthogonal to selector production: it does not change WHICH selector we
    // use, only WHERE the patch is written. If the failing file is a shared Page
    // Object/helper, one patch repairs every dependent test. Cheap + safe:
    // degrades to "not a page object" on any error, leaving the spec path intact.
    try {
      const target = await this.classifyPageObjectTarget(failure, repoContext);
      if (target) {
        outcome.pageObjectPatch = target;
        this.insertRepoIntelligenceTrail(outcome, target);
      } else {
        this.insertRepoIntelligenceTrail(outcome, undefined);
      }
    } catch (err: any) {
      logger.debug(MOD, 'Repo Intelligence targeting failed (non-fatal)', { error: err?.message });
    }

    // Sprint 4.1 — attach the canonical, explainable HealingResult. Pure
    // re-shaping of what the waterfall already produced (suggestion + confidence
    // + DOM-memory + diagnosis); it never re-runs healing. Non-fatal: any error
    // leaves the rest of the outcome intact for existing consumers.
    try {
      outcome.healingResult = buildHealingResult({
        originalSelector: failure.failedLocator || failure.diagnosis?.locator || '',
        suggestion: outcome.suggestion,
        confidenceResult: outcome.confidenceResult,
        domMemoryInsight: outcome.domMemoryInsight,
        diagnosisCategory: failure.diagnosis?.category ?? null,
        domValidated:
          outcome.validationResult?.isValid ??
          (outcome.confidenceResult?.breakdown?.validationBonus === 1),
      });
    } catch (err: any) {
      logger.debug(MOD, 'HealingResult assembly failed (non-fatal)', { error: err?.message });
    }

    return outcome;
  }

  /**
   * Collect ALL candidates from every intelligence layer in ONE pass, score them
   * with cheap browser-free heuristics, and return them best-first.
   *
   * This is the performance counterpart to {@link heal} (which returns only the
   * single top candidate). The worker calls this ONCE per broken locator and then
   * runs the browser on the best candidate(s) only — instead of launching a
   * browser after every single candidate. AI is consulted only to "top up" when
   * the cheap/grounded layers did not yield enough confident candidates, so token
   * cost stays bounded.
   *
   * Every returned candidate has already passed cheap static/syntax validation
   * (`syntaxValid`), so obviously-broken selectors never reach the browser.
   */
  async collectRankedCandidates(
    failure: FailureDetails,
    domHtml?: string,
    skipLocators?: Set<string>,
    projectId?: number,
    companyId?: number,
    repoContext?: HealingContextResult,
    appProfile?: AppProfileHealingInput,
  ): Promise<RankedCandidateSet> {
    const repoCtx: HealingContextResult = repoContext ?? emptyHealingContext();
    const scope: PatternTenantScope = { companyId, projectId };
    const failedValue = failure.failedLocator || failure.failedLineCode || '';

    // Repo Intelligence targeting (shared across all candidates for this failure).
    let pageObjectPatch: PageObjectPatchTarget | undefined;
    try {
      pageObjectPatch = await this.classifyPageObjectTarget(failure, repoContext);
    } catch (err: any) {
      logger.debug(MOD, 'Repo Intelligence targeting failed during collection (non-fatal)', {
        error: err?.message,
      });
    }
    const matchesPageObject = !!pageObjectPatch;

    const raw: RankableCandidate[] = [];
    const seen = new Set<string>();
    const norm = (loc: string): string => {
      try {
        return selectorCore(loc) || loc.trim();
      } catch {
        return loc.trim();
      }
    };

    const push = (input: {
      newLocator: string;
      strategy: HealingStrategy;
      source: CandidateSource;
      confidence: number;
      tokensUsed: number;
      reasoning: string;
      addExplicitWait: boolean;
      inAppProfile?: boolean;
      domMemoryStability?: number;
    }): void => {
      const loc = input.newLocator?.trim();
      if (!loc) return;
      const key = norm(loc);
      if (!key || seen.has(key)) return;
      if (skipLocators?.has(loc)) return;
      seen.add(key);

      // Cheap static/syntax validation — no browser. Invalid candidates are kept
      // but flagged so the ranker can hard-reject them (and they show in the trail).
      let syntaxValid = true;
      try {
        syntaxValid = this.validationEngine.validate({
          newLocator: loc,
          confidence: input.confidence,
          originalCode: '',
          filePath: failure.filePath,
        }).isValid;
      } catch {
        syntaxValid = false;
      }

      let similarityToFailed: number | undefined;
      if (failedValue) {
        try {
          similarityToFailed = this.similarityEngine.compare(selectorCore(failedValue), key).score;
        } catch {
          similarityToFailed = undefined;
        }
      }

      raw.push({
        newLocator: loc,
        strategy: input.strategy,
        source: input.source,
        confidence: input.confidence,
        tokensUsed: input.tokensUsed,
        reasoning: input.reasoning,
        addExplicitWait: input.addExplicitWait,
        stabilityScore: input.domMemoryStability,
        signals: {
          baseConfidence: input.confidence,
          syntaxValid,
          inAppProfile: !!input.inAppProfile,
          domMemoryStability: input.domMemoryStability,
          matchesPageObject,
          similarityToFailed,
        },
      });
    };

    // ── Advisor pipeline ──────────────────────────────────────────────────
    // The orchestrator does not know about any concrete intelligence layer; it
    // just runs the registered advisors. Grounded advisors (Learning, App
    // Profile, DOM Memory, DOM Candidate, Rule) always run. Fallback advisors
    // (AI) run ONLY when the grounded ones did not produce enough confident
    // candidates — so OpenAI is not invoked on every heal.
    let domMemoryInsight: DOMMemoryInsight | undefined;
    const ctx: AdvisorContext = {
      failure,
      domHtml,
      skipLocators,
      projectId,
      companyId,
      repoContext: repoCtx,
      appProfile,
      scope,
      shared: {
        appLocatorKeys: new Set<string>(),
        domMemoryInsight: undefined,
        matchesPageObject,
      },
      norm,
    };

    const runAdvisor = async (advisor: HealingAdvisor): Promise<void> => {
      try {
        const proposal = await advisor.propose(ctx);
        if (proposal.domMemoryInsight) domMemoryInsight = proposal.domMemoryInsight;
        for (const cand of proposal.candidates) push(cand);
      } catch (err: any) {
        logger.debug(MOD, `Advisor "${advisor.name}" failed (non-fatal)`, { error: err?.message });
      }
    };

    // Grounded advisors first (cheap, 0-token, evidence-based).
    for (const advisor of this.advisors.filter((a) => a.tier === 'grounded')) {
      await runAdvisor(advisor);
    }

    // AI gate: consult fallback advisors only when grounded candidates are thin
    // AND we have a concrete anchor to heal around. Without a failed locator the
    // AI has nothing to ground on and will fabricate a plausible-looking but
    // unrelated candidate (e.g. a login button on a framework-level crash that
    // never reached the real locator). That fabrication is always rejected by
    // validation later, so it is pure noise — we must not run the AI at all.
    const aiSkipConfidence = envFloat('HEALING_RANK_AI_SKIP_CONFIDENCE', 0.8);
    const minGrounded = envIntLocal('HEALING_RANK_MIN_GROUNDED', 2);
    const groundedCount = raw.filter(
      (c) => c.signals.syntaxValid && c.source !== 'ai' && c.confidence >= aiSkipConfidence,
    ).length;
    const hasAnchor = !!(failure.failedLocator && failure.failedLocator.trim());
    const fallbackAdvisors = this.advisors.filter((a) => a.tier === 'fallback');
    let aiSkippedNoAnchor = false;
    if (groundedCount >= minGrounded) {
      if (fallbackAdvisors.length) {
        logger.info(MOD, 'Skipping fallback (AI) advisors — enough grounded candidates', {
          testName: failure.testName,
          groundedCount,
          minGrounded,
          skipped: fallbackAdvisors.map((a) => a.name),
        });
      }
    } else if (!hasAnchor) {
      aiSkippedNoAnchor = fallbackAdvisors.length > 0;
      if (fallbackAdvisors.length) {
        logger.info(MOD, 'Skipping fallback (AI) advisors — no failed locator to anchor on', {
          testName: failure.testName,
          groundedCount,
          minGrounded,
          skipped: fallbackAdvisors.map((a) => a.name),
        });
      }
    } else {
      for (const advisor of fallbackAdvisors) await runAdvisor(advisor);
    }

    const ranked = rankCandidates(raw);

    const sources = Array.from(new Set(raw.map((c) => c.source)));
    const decisionTrail: DecisionTrailEntry[] = [
      {
        layer: 'Candidate Ranking',
        outcome: ranked.length ? 'hit' : 'miss',
        confidence: ranked[0]?.confidence,
        reasoning: ranked.length
          ? `Collected ${raw.length} candidate(s) from [${sources.join(', ')}] and ranked them ` +
            `without a browser. Best: ${ranked[0].newLocator} ` +
            `(score ${ranked[0].score.toFixed(2)}, source ${ranked[0].source}).`
          : `No syntactically valid candidate from any layer (${raw.length} raw, all rejected).`,
      },
    ];
    if (aiSkippedNoAnchor) {
      decisionTrail.push({
        layer: 'AI Reasoning',
        outcome: 'skipped',
        reasoning:
          'AI advisor not consulted: the failure has no failed locator to anchor on ' +
          '(e.g. a framework-level crash that never reached an element). With no anchor the ' +
          'AI can only fabricate an unrelated candidate, so it was deliberately skipped rather ' +
          'than producing a guess that validation would reject.',
      });
    }
    if (pageObjectPatch) {
      decisionTrail.push({
        layer: 'Repo Intelligence',
        outcome: 'hit',
        reasoning: pageObjectPatch.reasoning,
      });
    }

    logger.info(MOD, 'Ranked healing candidates (no browser)', {
      testName: failure.testName,
      failedLocator: failure.failedLocator,
      rawCount: raw.length,
      rankedCount: ranked.length,
      sources,
      top: ranked.slice(0, 3).map((c) => ({ locator: c.newLocator, score: Number(c.score.toFixed(3)), source: c.source })),
    });

    return { candidates: ranked, decisionTrail, pageObjectPatch, domMemoryInsight };
  }

  /**
   * Repo Intelligence targeting — classify the failing file and, when it is a
   * shared Page Object / helper, build the patch target (the file itself, the
   * stack line, and the dependent-test impact count). Returns `undefined` for
   * ordinary specs so the normal spec-healing path is used.
   */
  private async classifyPageObjectTarget(
    failure: FailureDetails,
    repoContext?: HealingContextResult,
  ): Promise<PageObjectPatchTarget | undefined> {
    if (!failure.filePath) return undefined;

    const classification = await classifyFailureFile({
      filePath: failure.filePath,
      brokenLocator: failure.failedLocator || failure.failedLineCode,
      repoContextId: repoContext?.contextId ?? undefined,
      source: failure.surroundingCode,
    });

    if (!classification.isPageObject || !classification.source) return undefined;

    return {
      targetFile: failure.filePath,
      targetLine: failure.lineNumber,
      className: classification.className,
      methodName: classification.methodName,
      impactedTests: classification.impactedTests,
      source: classification.source,
      reasoning: classification.reasoning,
    };
  }

  /**
   * Insert the "Repo Intelligence" entry into the decision trail, positioned
   * right after "App Profile" to honour the Phase 4 waterfall order
   * (Learning → App Profile → Repo Intelligence → DOM Memory → … → AI).
   */
  private insertRepoIntelligenceTrail(
    outcome: HealingOutcome,
    target: PageObjectPatchTarget | undefined,
  ): void {
    if (!outcome.decisionTrail) return;
    const entry: DecisionTrailEntry = target
      ? {
          layer: 'Repo Intelligence',
          outcome: 'hit',
          reasoning: target.reasoning,
        }
      : {
          layer: 'Repo Intelligence',
          outcome: 'miss',
          reasoning: 'Failing file is an individual spec — patching the test file directly',
        };
    // Place directly after the last "App Profile" entry; fall back to append.
    let idx = -1;
    for (let i = 0; i < outcome.decisionTrail.length; i++) {
      if (outcome.decisionTrail[i].layer === 'App Profile') idx = i;
    }
    if (idx >= 0) outcome.decisionTrail.splice(idx + 1, 0, entry);
    else outcome.decisionTrail.push(entry);
  }

  private async healCore(
    failure: FailureDetails,
    domHtml?: string,
    skipLocators?: Set<string>,
    projectId?: number,
    companyId?: number,
    repoContext?: HealingContextResult,
    appProfile?: AppProfileHealingInput,
  ): Promise<HealingOutcome> {
    // Repository grounding (Sprint 2 — Healing Intelligence). Inert when the
    // feature is OFF: the worker passes an empty context, so prompt building and
    // confidence scoring below are byte-for-byte unchanged.
    const repoCtx: HealingContextResult = repoContext ?? emptyHealingContext();
    const attemptedStrategies: HealingStrategy[] = [];
    let domCandidates: DOMExtractionResult | undefined;
    let domMemoryInsight: DOMMemoryInsight | undefined;

    // Decision trail — waterfall view of which intelligence layers were tried,
    // which won, which missed, and which were skipped (for observability).
    const trail: DecisionTrailEntry[] = [];

    // Tenant scope — built up-front because the learned-pattern lookup (the very
    // first thing we try) must be tenant-isolated: a healed locator from one
    // company/project is never served to another.
    const scope: PatternTenantScope = { companyId, projectId };

    // ── Step 0 (Learning Engine): reuse a previously successful heal ──
    // Learning outranks everything else. If we have already healed THIS exact
    // failure before (same test + error pattern + failed locator), nothing is
    // more reliable than our own proven history — not App Profile, not DOM
    // Memory, and certainly not an AI guess. 0 tokens, instant. The historical
    // locator is still re-validated so a pattern that no longer makes sense is
    // skipped rather than blindly re-applied.
    const learnedOutcome = await this.tryLearnedPattern(failure, scope);
    if (learnedOutcome) {
      trail.push({
        layer: 'Learning',
        outcome: 'hit',
        confidence: learnedOutcome.suggestion?.confidence,
        reasoning: learnedOutcome.suggestion?.reasoning || 'Reused a previously successful heal',
      });
      trail.push({ layer: 'App Profile', outcome: 'skipped', reasoning: 'Learning won' });
      trail.push({ layer: 'DOM Memory', outcome: 'skipped', reasoning: 'Learning won' });
      trail.push({ layer: 'Rule/Pattern', outcome: 'skipped', reasoning: 'Learning won' });
      trail.push({ layer: 'AI', outcome: 'skipped', reasoning: 'Learning won' });
      return { ...learnedOutcome, decisionTrail: trail };
    }
    // Learning miss — fall through to Application Intelligence.
    trail.push({ layer: 'Learning', outcome: 'miss', reasoning: 'No prior successful heal for this failure' });

    // ── Step 1 (Application Intelligence): Application Profile recovery ──
    // After Learning, ask the crawl we already built. The Application Profile
    // holds the real, stable selectors for this app (data-test* ids, grounded
    // role/label locators) — the most authoritative source for what exists on
    // the page *right now*, and it costs 0 tokens. It also works even when
    // `failedLocator` could not be parsed (the candidates are derived from the
    // failing source line too).
    const appProfileOutcome = this.tryAppProfile(failure, appProfile, skipLocators);
    if (appProfileOutcome) {
      // Honour the audit's "Similarity participates BEFORE AI": grounded
      // candidates are already ranked by DOM evidence; no AI was consulted.
      trail.push({
        layer: 'App Profile',
        outcome: 'hit',
        confidence: appProfileOutcome.suggestion?.confidence,
        reasoning: appProfileOutcome.suggestion?.reasoning || 'Grounded from crawl',
      });
      trail.push({ layer: 'DOM Memory', outcome: 'skipped', reasoning: 'App Profile won' });
      trail.push({ layer: 'Rule/Pattern', outcome: 'skipped', reasoning: 'App Profile won' });
      trail.push({ layer: 'AI', outcome: 'skipped', reasoning: 'App Profile won' });
      return { ...appProfileOutcome, decisionTrail: trail };
    }
    // App Profile miss
    trail.push({
      layer: 'App Profile',
      outcome: appProfile?.candidates?.length ? 'miss' : 'not_reached',
      reasoning: appProfile?.candidates?.length
        ? 'No valid candidate passed validation'
        : 'No crawl data available',
    });

    // ── Step 0a: DOM Memory Query (THE MOAT) ──────────────────
    // Query historical selector data BEFORE doing anything else.
    // This is what makes LevelUp different from every other tool.
    if (failure.failedLocator) {
      try {
        domMemoryInsight = await this.domMemory.getInsight(
          failure.failedLocator,
          projectId,
          companyId,
        );

        logger.info(MOD, 'DOM Memory insight retrieved', {
          testName: failure.testName,
          failedSelector: failure.failedLocator.slice(0, 60),
          selectorStability: domMemoryInsight.selectorHistory.stabilityScore,
          alternativesFound: domMemoryInsight.alternatives.length,
          recommendation: domMemoryInsight.recommendation.slice(0, 100),
        });

        // If DOM Memory has a high-confidence stable alternative, use it immediately!
        // This means 0 AI tokens, 0 latency — just historical knowledge.
        const bestAlt = domMemoryInsight.bestAlternative;
        if (bestAlt && bestAlt.compositeScore >= 0.75) {
          // Validate the DOM Memory suggestion
          const validation = this.validationEngine.validate({
            newLocator: bestAlt.selector,
            confidence: bestAlt.compositeScore,
            originalCode: '',
            filePath: failure.filePath,
          });

          if (validation.isValid) {
            logger.info(MOD, '🧠 DOM Memory alternative accepted — 0 AI tokens!', {
              selector: bestAlt.selector,
              compositeScore: bestAlt.compositeScore,
              stabilityScore: bestAlt.stabilityScore,
              source: bestAlt.source,
              reasoning: bestAlt.reasoning,
            });

            const suggestion: HealingSuggestion = {
              newLocator: bestAlt.selector,
              strategy: 'database_pattern', // Closest match — it's from historical data
              confidence: bestAlt.compositeScore,
              tokensUsed: 0,
              reasoning: `[DOM Memory] ${bestAlt.reasoning} — ${domMemoryInsight.recommendation}`,
              addExplicitWait: false,
              stabilityScore: bestAlt.stabilityScore,
              stabilityAssessment: domMemoryInsight.selectorHistory.assessment,
            };

            trail.push({
              layer: 'DOM Memory',
              outcome: 'hit',
              confidence: bestAlt.compositeScore,
              reasoning: bestAlt.reasoning,
            });
            trail.push({ layer: 'Rule/Pattern', outcome: 'skipped', reasoning: 'DOM Memory won' });
            trail.push({ layer: 'AI', outcome: 'skipped', reasoning: 'DOM Memory won' });

            return {
              suggestion,
              attemptedStrategies: ['database_pattern'],
              selectedEngine: 'dom_memory',
              domMemoryInsight,
              decisionTrail: trail,
            };
          }
        }
        // DOM Memory miss (no high-confidence alternative or validation failed)
        trail.push({
          layer: 'DOM Memory',
          outcome: 'miss',
          reasoning: domMemoryInsight?.bestAlternative
            ? 'Alternative found but validation failed'
            : 'No high-confidence historical alternative',
        });
      } catch (err: any) {
        // Non-critical — DOM Memory is an enhancement, not a requirement
        logger.warn(MOD, 'DOM Memory query failed (non-critical)', { error: err.message });
        trail.push({
          layer: 'DOM Memory',
          outcome: 'error',
          reasoning: err.message || 'Query failed',
        });
      }
    } else {
      // No failed locator → DOM Memory not applicable
      trail.push({
        layer: 'DOM Memory',
        outcome: 'not_reached',
        reasoning: 'No failed locator to query',
      });
    }

    // ── Step 0b: DOM Candidate Extraction (from live DOM HTML) ──
    if (domHtml && failure.failedLocator) {
      logger.info(MOD, 'Running DOM candidate extraction', {
        testName: failure.testName,
        failedLocator: failure.failedLocator,
        domLength: domHtml.length,
      });

      domCandidates = this.domExtractor.extractFromHTML(
        domHtml,
        failure.failedLocator,
        failure.failedLineCode || '',
      );

      if (domCandidates.candidates.length > 0) {
        const topCandidate = domCandidates.candidates[0];

        // Calculate enhanced confidence
        const confidenceResult = this.confidenceEngine.calculate({
          strategy: 'dom_candidate',
          rawConfidence: topCandidate.score,
          selectorType: topCandidate.matchType === 'semantic' ? 'semantic' : 'css_attribute',
          similarityScore: topCandidate.score,
          domValidated: true,
          matchType: topCandidate.matchType,
          sameTag: true,
        });

        // Boost confidence if DOM Memory says this candidate is stable
        let stabilityBoost = 0;
        let stabilityScore: number | undefined;
        if (domMemoryInsight) {
          const altMatch = domMemoryInsight.alternatives.find(
            a => a.selector === topCandidate.selector,
          );
          if (altMatch && altMatch.stabilityScore >= 0.7) {
            stabilityBoost = 0.05; // Small boost for stability-confirmed candidates
            stabilityScore = altMatch.stabilityScore;
          }
        }

        const finalScore = Math.min(1.0, confidenceResult.finalScore + stabilityBoost);

        if (finalScore >= 0.70) {
          logger.info(MOD, 'DOM candidate accepted', {
            selector: topCandidate.selector,
            score: topCandidate.score,
            confidence: finalScore,
            stabilityBoost,
            grade: confidenceResult.grade,
            reasoning: topCandidate.reasoning,
          });

          const suggestion: HealingSuggestion = {
            newLocator: topCandidate.selector,
            strategy: 'rule_based',
            confidence: finalScore,
            tokensUsed: 0,
            reasoning: `[DOM Candidate] ${topCandidate.reasoning}`,
            addExplicitWait: false,
            stabilityScore,
          };

          return {
            suggestion,
            attemptedStrategies: ['rule_based'],
            selectedEngine: 'dom_candidate',
            confidenceResult,
            domCandidates,
            domMemoryInsight,
          };
        }
      }
    }

    // `scope` (tenant isolation) is declared at the top of heal() because the
    // Step 0 learned-pattern lookup needs it before anything else runs.

    // ── Step 2: Use strategy selector to determine best approach ──
    const selected = await this.strategySelector.selectStrategy(
      failure,
      this.ruleEngine,
      this.patternEngine,
      this.aiEngine,
      scope,
    );

    logger.info(MOD, 'Strategy selected', {
      engine: selected.engine,
      confidence: selected.confidence,
      estimatedTokens: selected.estimatedTokens,
      testName: failure.testName,
    });

    // Step 2: Execute selected engine (or fall through all in priority order)
    if (selected.engine === 'none') {
      const outcome = await this.healFallbackChain(failure, attemptedStrategies, scope, repoCtx);
      // Enrich with stability scores
      if (outcome.suggestion) {
        await this.enrichWithStability(outcome.suggestion, domMemoryInsight, scope.projectId);
        this.applyRepositoryConfidenceBoost(outcome.suggestion, repoCtx, domMemoryInsight);
        // Record engine hit
        const engineName =
          outcome.suggestion.strategy === 'rule_based' ? 'Rule Engine' :
          outcome.suggestion.strategy === 'database_pattern' ? 'Pattern Engine' :
          'AI';
        trail.push({
          layer: engineName,
          outcome: 'hit',
          confidence: outcome.suggestion.confidence,
          reasoning: outcome.suggestion.reasoning || 'Engine produced valid suggestion',
        });
      } else {
        // All engines missed
        trail.push({
          layer: 'Rule/Pattern/AI',
          outcome: 'miss',
          reasoning: `Tried ${attemptedStrategies.length} engine(s), none produced valid suggestion`,
        });
      }
      outcome.domMemoryInsight = domMemoryInsight;
      outcome.decisionTrail = trail;
      return outcome;
    }

    // Try selected engine first, then fall through
    let suggestion: HealingSuggestion | null = null;

    if (selected.engine === 'rule' || selected.engine === 'pattern' || selected.engine === 'ai') {
      suggestion = await this.tryEngine(selected.engine, failure, attemptedStrategies, skipLocators, scope, repoCtx);
    }

    // If selected engine failed, try remaining engines
    if (!suggestion) {
      const engines: Array<'rule' | 'pattern' | 'ai'> = ['rule', 'pattern', 'ai'];
      for (const eng of engines) {
        if (attemptedStrategies.includes(this.engineToStrategy(eng))) continue;
        suggestion = await this.tryEngine(eng, failure, attemptedStrategies, skipLocators, scope, repoCtx);
        if (suggestion) break;
      }
    }

    if (!suggestion) {
      logger.warn(MOD, 'No healing strategy produced a valid suggestion', {
        testName: failure.testName,
        attemptedStrategies,
      });
      // All engines missed
      const engineLabel = attemptedStrategies.includes('rule_based') || attemptedStrategies.includes('database_pattern') || attemptedStrategies.includes('ai_reasoning')
        ? 'Rule/Pattern/AI'
        : 'Rule/Pattern/AI';
      trail.push({
        layer: engineLabel,
        outcome: 'miss',
        reasoning: `Tried ${attemptedStrategies.length} engine(s), none produced valid suggestion`,
      });
      return { suggestion: null, attemptedStrategies, selectedEngine: selected.engine, domCandidates, domMemoryInsight, decisionTrail: trail };
    }

    // Calculate enhanced confidence for the chosen suggestion
    const confidenceResult = this.confidenceEngine.calculate({
      strategy: suggestion.strategy === 'rule_based' ? 'rule_based'
        : suggestion.strategy === 'database_pattern' ? 'database_pattern'
        : 'ai_reasoning',
      rawConfidence: suggestion.confidence,
      selectorType: suggestion.newLocator.includes('getBy') ? 'semantic' : 'css_attribute',
      similarityScore: suggestion.confidence,
    });

    // Update confidence with enhanced score
    suggestion.confidence = confidenceResult.finalScore;

    // ── Enrich with DOM Memory stability data ──
    await this.enrichWithStability(suggestion, domMemoryInsight, scope.projectId);

    // ── Repository-aware confidence boost (Sprint 2.3) ──
    // No-op when the feature is OFF (repoCtx is empty / has no evidence).
    this.applyRepositoryConfidenceBoost(suggestion, repoCtx, domMemoryInsight);

    // Record token usage for AI calls
    if (suggestion.strategy === 'ai_reasoning' && suggestion.tokensUsed > 0) {
      await this.strategySelector.recordUsage('ai', suggestion.tokensUsed);
    }

    // Record the winning engine in the decision trail
    const engineName =
      suggestion.strategy === 'rule_based' ? 'Rule Engine' :
      suggestion.strategy === 'database_pattern' ? 'Pattern Engine' :
      'AI';
    trail.push({
      layer: engineName,
      outcome: 'hit',
      confidence: suggestion.confidence,
      reasoning: suggestion.reasoning || 'Engine produced valid suggestion',
    });

    return { suggestion, attemptedStrategies, selectedEngine: selected.engine, confidenceResult, domCandidates, domMemoryInsight, decisionTrail: trail };
  }

  /**
   * Step 0 — Learning Engine: reuse a previously successful heal.
   *
   * Looks up the learned-pattern store for an exact match to this failure
   * (test name + error pattern + failed locator, tenant-scoped). A proven past
   * fix is the single most reliable signal we have, so it runs before App
   * Profile, DOM Memory and — most importantly — before any AI call. The
   * historical locator is still re-validated, so a pattern that no longer makes
   * sense is skipped rather than blindly re-applied.
   *
   * Returns `null` when there is no usable learned pattern, in which case the
   * pipeline proceeds to Step 1 (Application Profile) exactly as before.
   */
  private async tryLearnedPattern(
    failure: FailureDetails,
    scope: PatternTenantScope,
  ): Promise<HealingOutcome | null> {
    let patternResult;
    try {
      patternResult = await this.patternEngine.findMatch(failure, scope);
    } catch (err: any) {
      // Non-critical — a learned-pattern miss must never block healing.
      logger.warn(MOD, 'Learned-pattern lookup failed (non-critical)', { error: err.message });
      return null;
    }
    if (!patternResult) return null;

    const validation = this.validationEngine.validate({
      newLocator: patternResult.newLocator,
      confidence: patternResult.confidence,
      originalCode: '',
      filePath: failure.filePath,
    });
    if (!validation.isValid) {
      logger.debug(MOD, 'Learned pattern rejected by validation', {
        locator: patternResult.newLocator,
        reason: validation.reason,
      });
      return null;
    }

    logger.info(MOD, '🎓 Learned pattern reused — 0 AI tokens!', {
      testName: failure.testName,
      locator: patternResult.newLocator,
      usageCount: patternResult.usageCount,
    });

    const suggestion: HealingSuggestion = {
      newLocator: patternResult.newLocator,
      strategy: 'database_pattern',
      confidence: patternResult.confidence,
      tokensUsed: 0,
      reasoning: `[Learned Pattern] ${patternResult.reasoning}`,
      addExplicitWait: false,
    };

    return {
      suggestion,
      attemptedStrategies: ['database_pattern'],
      selectedEngine: 'learned_pattern',
    };
  }

  /**
   * Step 1 — Application Profile recovery (Application Intelligence).
   *
   * Validates the grounded candidates the worker resolved from the crawled
   * Application Profile and, when one is syntactically valid and confident
   * enough, returns it immediately as the heal — 0 AI tokens, sourced from real
   * DOM evidence. Candidates are ranked by the Semantic Similarity engine
   * against the failed locator's intent, so the *most relevant* grounded
   * selector wins (Similarity participating BEFORE the AI layer).
   *
   * Returns `null` when there is no usable Application-Profile candidate, in
   * which case the pipeline proceeds exactly as before.
   */
  private tryAppProfile(
    failure: FailureDetails,
    appProfile?: AppProfileHealingInput,
    skipLocators?: Set<string>,
  ): HealingOutcome | null {
    const candidates = appProfile?.candidates;
    if (!candidates || candidates.length === 0) return null;

    // Rank candidates: stability/confidence is the primary signal (a grounded
    // data-test* selector beats a role/text one), and Semantic Similarity to the
    // failed locator breaks ties among comparably-confident candidates — so
    // Similarity participates BEFORE the AI layer without overriding the
    // strongest grounded evidence.
    const failedValue = failure.failedLocator || failure.failedLineCode || '';
    const ranked = [...candidates].sort((a, b) => {
      if (Math.abs(b.confidence - a.confidence) > 0.02) return b.confidence - a.confidence;
      return this.appProfileRelevance(failedValue, b.locator) - this.appProfileRelevance(failedValue, a.locator);
    });

    for (const candidate of ranked) {
      if (skipLocators?.has(candidate.locator)) continue;

      const validation = this.validationEngine.validate({
        newLocator: candidate.locator,
        confidence: candidate.confidence,
        originalCode: '',
        filePath: failure.filePath,
      });
      if (!validation.isValid) {
        logger.debug(MOD, 'App Profile candidate rejected by validation', {
          locator: candidate.locator,
          reason: validation.reason,
        });
        continue;
      }

      logger.info(MOD, '🗺️  Application Profile alternative accepted — 0 AI tokens!', {
        selector: candidate.locator,
        confidence: candidate.confidence,
        description: appProfile?.description,
        elementsScanned: appProfile?.elementsScanned,
      });

      const suggestion: HealingSuggestion = {
        newLocator: candidate.locator,
        // Deterministic, evidence-grounded recovery — surfaced as a rule-based
        // (non-AI) heal in the 3-layer trail.
        strategy: 'rule_based',
        confidence: candidate.confidence,
        tokensUsed: 0,
        reasoning: `[App Profile] ${candidate.reasoning}`,
        addExplicitWait: false,
      };

      return {
        suggestion,
        attemptedStrategies: ['rule_based'],
        selectedEngine: 'app_profile',
      };
    }

    return null;
  }

  /**
   * Lightweight relevance score (0–1) between the failed locator text and a
   * candidate locator, reusing the Semantic Similarity engine. Used only to
   * order Application-Profile candidates; never throws.
   */
  private appProfileRelevance(failedValue: string, candidateLocator: string): number {
    if (!failedValue) return 0;
    try {
      return this.similarityEngine.compare(
        selectorCore(failedValue),
        selectorCore(candidateLocator),
      ).score;
    } catch {
      return 0;
    }
  }

  /**
   * Try all engines in fallback chain order.
   */
  private async healFallbackChain(
    failure: FailureDetails,
    attemptedStrategies: HealingStrategy[],
    scope: PatternTenantScope = {},
    repoContext?: HealingContextResult,
  ): Promise<HealingOutcome> {
    // Try Rule → Pattern → AI
    for (const eng of ['rule', 'pattern', 'ai'] as const) {
      const suggestion = await this.tryEngine(eng, failure, attemptedStrategies, undefined, scope, repoContext);
      if (suggestion) {
        if (suggestion.strategy === 'ai_reasoning' && suggestion.tokensUsed > 0) {
          await this.strategySelector.recordUsage('ai', suggestion.tokensUsed);
        }
        return { suggestion, attemptedStrategies };
      }
    }

    return { suggestion: null, attemptedStrategies };
  }

  /**
   * Try a specific engine and validate its suggestion.
   */
  private async tryEngine(
    engine: 'rule' | 'pattern' | 'ai',
    failure: FailureDetails,
    attemptedStrategies: HealingStrategy[],
    skipLocators?: Set<string>,
    scope: PatternTenantScope = {},
    repoContext?: HealingContextResult,
  ): Promise<HealingSuggestion | null> {
    const strategy = this.engineToStrategy(engine);
    attemptedStrategies.push(strategy);

    switch (engine) {
      case 'rule': {
        const ruleResult = this.ruleEngine.generate(failure, skipLocators);
        if (ruleResult.suggestions.length > 0) {
          for (const suggestion of ruleResult.suggestions) {
            const healSuggestion: HealingSuggestion = {
              newLocator: suggestion.newLocator,
              strategy: 'rule_based',
              confidence: suggestion.confidence,
              tokensUsed: 0,
              reasoning: suggestion.reasoning,
              addExplicitWait: ruleResult.addExplicitWait,
            };

            const validation = this.validationEngine.validate({
              newLocator: suggestion.newLocator,
              confidence: suggestion.confidence,
              originalCode: '',
              filePath: failure.filePath,
            });

            if (validation.isValid) {
              logger.info(MOD, 'Rule engine suggestion validated', {
                testName: failure.testName,
                confidence: suggestion.confidence,
                locator: suggestion.newLocator,
              });
              return healSuggestion;
            }

            logger.debug(MOD, 'Rule suggestion rejected', { reason: validation.reason });
          }
        }
        return null;
      }

      case 'pattern': {
        const patternResult = await this.patternEngine.findMatch(failure, scope);
        if (patternResult) {
          const validation = this.validationEngine.validate({
            newLocator: patternResult.newLocator,
            confidence: patternResult.confidence,
            originalCode: '',
            filePath: failure.filePath,
          });

          if (validation.isValid) {
            logger.info(MOD, 'Pattern engine selected', {
              testName: failure.testName,
              confidence: patternResult.confidence,
            });
            return {
              newLocator: patternResult.newLocator,
              strategy: 'database_pattern',
              confidence: patternResult.confidence,
              tokensUsed: 0,
              reasoning: patternResult.reasoning,
              addExplicitWait: false,
            };
          }
        }
        return null;
      }

      case 'ai': {
        // Inject repository grounding into the prompt when available (Sprint 2.2).
        // promptBlock is '' unless the feature is enabled and the repo produced
        // evidence, so the AI call is unchanged on the default path.
        const grounding = repoContext?.promptBlock || undefined;
        const aiResult = await this.aiEngine.suggest(failure, grounding);
        if (aiResult) {
          const validation = this.validationEngine.validate({
            newLocator: aiResult.newLocator,
            confidence: aiResult.confidence,
            originalCode: '',
            filePath: failure.filePath,
          });

          if (validation.isValid) {
            logger.info(MOD, 'AI engine selected', {
              testName: failure.testName,
              confidence: aiResult.confidence,
              tokensUsed: aiResult.tokensUsed,
            });
            return {
              newLocator: aiResult.newLocator,
              strategy: 'ai_reasoning',
              confidence: aiResult.confidence,
              tokensUsed: aiResult.tokensUsed,
              reasoning: aiResult.reasoning,
              addExplicitWait: false,
            };
          }
        }
        return null;
      }
    }
  }

  private engineToStrategy(engine: 'rule' | 'pattern' | 'ai'): HealingStrategy {
    switch (engine) {
      case 'rule': return 'rule_based';
      case 'pattern': return 'database_pattern';
      case 'ai': return 'ai_reasoning';
    }
  }

  /**
   * Enrich a healing suggestion with DOM Memory stability data.
   * Looks up the proposed new locator in DOM Memory and attaches stability info.
   * Also applies a confidence boost for stable selectors.
   */
  private async enrichWithStability(
    suggestion: HealingSuggestion,
    domMemoryInsight?: DOMMemoryInsight,
    projectId?: number | null,
  ): Promise<void> {
    try {
      // Check if the proposed locator matches any DOM Memory alternative
      if (domMemoryInsight?.alternatives.length) {
        const match = domMemoryInsight.alternatives.find(
          a => a.selector === suggestion.newLocator,
        );
        if (match) {
          suggestion.stabilityScore = match.stabilityScore;
          suggestion.stabilityAssessment =
            match.stabilityScore >= 0.8 ? 'Highly stable — historically reliable' :
            match.stabilityScore >= 0.5 ? 'Moderately stable' :
            'Stability unknown — no significant history';

          // Boost confidence for stable selectors (max +0.05)
          if (match.stabilityScore >= 0.8) {
            suggestion.confidence = Math.min(1.0, suggestion.confidence + 0.05);
          } else if (match.stabilityScore < 0.3) {
            // Penalise unstable selectors slightly
            suggestion.confidence = Math.max(0.1, suggestion.confidence - 0.03);
          }

          logger.info(MOD, 'Stability data attached to suggestion', {
            selector: suggestion.newLocator.slice(0, 60),
            stabilityScore: match.stabilityScore,
            adjustedConfidence: suggestion.confidence,
          });
          return;
        }
      }

      // If no match in DOM Memory alternatives, do a direct lookup.
      // SECURITY (multi-tenant isolation): scope DOM Memory history to the
      // caller's project so one project never inherits another's selector
      // stability signal.
      const history = await this.domMemory.getSelectorHistory(suggestion.newLocator, projectId ?? undefined);
      if (history.observations > 0) {
        suggestion.stabilityScore = history.stabilityScore;
        suggestion.stabilityAssessment = history.observations > 0
          ? `Stability: ${history.stabilityScore.toFixed(2)} — ${history.changeCount} change(s) recorded`
          : 'New selector — no history available';
      }
    } catch {
      // Non-critical — don't break healing
    }
  }

  /**
   * Repository-aware confidence boost (Sprint 2.3 — Healing Intelligence).
   *
   * Raises confidence in a proposed locator when the repository corroborates it:
   *   • the locator text is present in a page-object/helper method  → strongest
   *   • the locator text is present in the method index / RAG source
   *   • the matching method is referenced by existing tests (usage_count)
   *
   * No-op when the feature is OFF or the repo produced no evidence — so the
   * default confidence score is byte-for-byte unchanged. Boosts are additive on
   * the 0–1 scale and capped at 1.0. This is intentionally separate from the DOM
   * Memory stability boost in `enrichWithStability` (different signal source).
   */
  private applyRepositoryConfidenceBoost(
    suggestion: HealingSuggestion,
    repoContext: HealingContextResult,
    _domMemoryInsight?: DOMMemoryInsight,
  ): void {
    if (!HealingIntelligenceContext.isEnabled()) return;
    if (!repoContext || !repoContext.hasEvidence) return;

    try {
      const { boost, reasons } = computeRepositoryConfidenceBoost(
        suggestion.newLocator,
        repoContext,
      );
      if (boost <= 0) return;

      const before = suggestion.confidence;
      suggestion.confidence = Math.min(1.0, suggestion.confidence + boost);
      const applied = suggestion.confidence - before;
      if (applied <= 0) return;

      const note = `[Repo-grounded +${applied.toFixed(2)}] ${reasons.join('; ')}`;
      suggestion.reasoning = suggestion.reasoning
        ? `${suggestion.reasoning} ${note}`
        : note;

      logger.info(MOD, 'Repository-aware confidence boost applied', {
        selector: suggestion.newLocator.slice(0, 60),
        boost: applied,
        adjustedConfidence: suggestion.confidence,
        reasons,
      });
    } catch (err: any) {
      // Non-critical — never break healing on a scoring enhancement.
      logger.debug(MOD, 'Repository confidence boost skipped (non-critical)', { error: err?.message });
    }
  }

  /**
   * Record a successful heal into DOM Memory so future heals get smarter.
   *
   * The iterative worker in `api/server.ts` performs its own apply/validate/
   * rollback loop and logs healings directly (it does not call `finalize()`),
   * which previously meant production heals never fed back into DOM Memory — the
   * "moat" stayed cold. Call this after a confirmed successful heal to close the
   * learning loop. Project/company scoping keeps observations isolated per tenant.
   */
  async recordHealObservation(data: {
    failedSelector: string;
    healedSelector: string;
    strategy: string;
    projectId?: number;
    companyId?: number;
    pageUrl?: string;
    elementType?: string;
  }): Promise<void> {
    try {
      await this.domMemory.recordHealingObservation({
        failedSelector: data.failedSelector,
        healedSelector: data.healedSelector,
        projectId: data.projectId,
        companyId: data.companyId,
        pageUrl: data.pageUrl,
        elementType: data.elementType,
        source: `healing:${data.strategy}`,
      });
    } catch {
      // Non-critical — never break the healing flow on a learning write.
    }
  }

  /**
   * Finalize a successful healing — generate patch, store to DB, record to DOM Memory.
   */
  async finalize(
    suggestion: HealingSuggestion,
    failure: FailureDetails,
    originalCode: string,
    fixedCode: string,
    executionId: number,
    projectId?: number,
    companyId?: number,
  ): Promise<FinalizeResult> {
    // Generate patch
    const patch = this.patchEngine.generatePatch(
      failure.filePath,
      failure.lineNumber,
      originalCode,
      fixedCode,
      `Heal: ${failure.testName} — ${suggestion.reasoning}`,
      suggestion.strategy,
    );

    // Log to database
    await logHealing({
      test_execution_id: executionId,
      test_name: failure.testName,
      failed_locator: failure.failedLocator,
      healed_locator: suggestion.newLocator,
      healing_strategy: suggestion.strategy,
      ai_tokens_used: suggestion.tokensUsed,
      success: true,
      confidence: suggestion.confidence,
      error_context: failure.errorMessage.slice(0, 500),
      validation_status: 'approved',
      validation_reason: suggestion.reasoning,
      patch_path: patch.patchPath,
    });

    // Store learned pattern — scoped to this tenant/project so it is only
    // ever reused within the same company + project namespace.
    await storePattern({
      test_name: failure.testName,
      error_pattern: failure.errorPattern,
      failed_locator: failure.failedLocator,
      healed_locator: suggestion.newLocator,
      solution_strategy: suggestion.strategy,
      confidence: suggestion.confidence,
      avg_tokens_saved: suggestion.tokensUsed,
    }, companyId ?? null, projectId ?? null);

    // ── Record to DOM Memory for future learning ──
    // This is how the system gets smarter over time
    try {
      await this.domMemory.recordHealingObservation({
        failedSelector: failure.failedLocator,
        healedSelector: suggestion.newLocator,
        projectId,
        companyId,
        pageUrl: failure.url || undefined,
        source: `healing:${suggestion.strategy}`,
      });
    } catch {
      // Non-critical — don't fail the finalize
    }

    logger.info(MOD, 'Healing finalized', {
      testName: failure.testName,
      strategy: suggestion.strategy,
      patchPath: patch.patchPath,
      confidence: suggestion.confidence,
      stabilityScore: suggestion.stabilityScore,
    });

    return {
      success: true,
      patchPath: patch.patchPath,
      engine: suggestion.strategy,
      confidence: suggestion.confidence,
      tokensUsed: suggestion.tokensUsed,
      stabilityScore: suggestion.stabilityScore,
    };
  }
}
