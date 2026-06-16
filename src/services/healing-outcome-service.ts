/**
 * Healing Outcome Service — Sprint B (Healing Outcomes Learning Loop).
 *
 * Closes the self-healing feedback loop. The platform already FINDS fixes for
 * broken selectors (profile-diff fast-path, maintenance-pattern library, DOM
 * search, AI). What it did NOT do before Sprint B was learn from what happened
 * AFTER a fix was applied. This service records that outcome and folds it into a
 * per-element confidence score so future suggestions get measurably better:
 *
 *   Heal Applied → Run Result → Pass/Fail → Store Outcome → Update Confidence
 *
 * Two persisted artefacts back this loop (see src/db/postgres.ts):
 *   • `healing_outcomes`            — immutable event log, one row per heal+result.
 *   • `healing_confidence_scores`   — learned aggregate per (company, project,
 *                                     element, locator_type).
 *
 * The learned `confidence` is an EXPONENTIALLY-SMOOTHED success score in the
 * range 0–100 (learning rate α = 0.1). Each new outcome nudges the score toward
 * the ideal for that result rather than overwriting history, so a single fluke
 * pass or fail can't whipsaw a well-established score, yet a genuine regime
 * change (an element that starts consistently failing) is still tracked within
 * ~a dozen runs:
 *
 *     pass:  c ← c + α · (100 − c)      (decaying approach toward 100)
 *     fail:  c ← c − α · c              (decaying approach toward 0)
 *
 * DESIGN PRINCIPLES (carried from the rest of the codebase):
 *   • Multi-tenant isolation is non-negotiable — every read and write is scoped
 *     by company + project. A score learned in one tenant never leaks to another.
 *   • Every write is BEST-EFFORT and non-blocking. Capturing an outcome must
 *     never throw into — and so never break — a heal path or a test run. All DB
 *     calls are wrapped; failures are logged and swallowed.
 *   • The confidence maths (`calculateConfidenceUpdate`) is a PURE function with
 *     no DB dependency, so it is trivially and deterministically unit-testable.
 */

import { logger } from '../utils/logger';
import { canonicalizeLocator } from './profile-diff-engine';
import {
  insertHealingOutcome,
  getHealingConfidenceScore,
  upsertHealingConfidenceScore,
  getHealingOutcomes,
  getHealingConfidenceScores,
  getHealingLearningStats,
  HealingOutcomeRecord,
  HealingConfidenceScoreRecord,
} from '../db/postgres';

const MOD = 'HealingOutcomeService';

/** Learning rate (α) for the exponentially-smoothed confidence update. */
export const LEARNING_RATE = 0.1;
/** Confidence assigned to a brand-new element before any outcome is observed. */
export const DEFAULT_CONFIDENCE = 50;
const MIN_CONFIDENCE = 0;
const MAX_CONFIDENCE = 100;

/** Normalised heal result. Anything other than 'pass' counts as a failure. */
export type HealingResult = 'pass' | 'fail' | 'timeout' | 'error';

/** Everything we know about a single applied heal + its re-run result. */
export interface HealingOutcomeInput {
  companyId?: number | null;
  projectId?: number | null;
  /** Optional link back to the profile_changes diff that produced the fix. */
  profileChangeId?: number | null;
  baseUrl?: string | null;
  /**
   * Stable identity of the element being healed. When omitted we derive it by
   * canonicalising the original (or healed) selector, so the same logical
   * element maps to the same learned score regardless of selector phrasing.
   */
  elementId?: string | null;
  /** Locator family, e.g. 'css' | 'data-testid' | 'xpath'. Optional. */
  locatorType?: string | null;
  originalSelector?: string | null;
  healedSelector?: string | null;
  /** Healing strategy that produced the fix (profile-diff, data-testid, …). */
  strategy?: string | null;
  /** Confidence the engine assigned to the suggestion at apply time (0–1 or 0–100). */
  suggestedConfidence?: number | null;
  result: HealingResult | string;
  testName?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
}

/** Result of capturing an outcome — both the event row id and updated score. */
export interface CaptureResult {
  outcomeId: number | null;
  elementId: string;
  locatorType: string;
  previousConfidence: number;
  newConfidence: number;
  success: boolean;
  score: HealingConfidenceScoreRecord | null;
}

export class HealingOutcomeService {
  /* ── Pure learning maths (no DB — unit-testable in isolation) ─────────── */

  /**
   * Treat any result other than an explicit 'pass' as a failure. 'timeout' and
   * 'error' mean the healed selector did NOT yield a green run, so they must
   * pull confidence down exactly like a 'fail'.
   */
  static isSuccess(result: HealingResult | string): boolean {
    return String(result).toLowerCase() === 'pass';
  }

  /**
   * Compute the next confidence from the current one and a single outcome using
   * exponential smoothing with learning rate α (default {@link LEARNING_RATE}).
   *
   *   pass:  c + α · (100 − c)   — moves a fraction α of the remaining gap to 100
   *   fail:  c − α · c           — moves a fraction α of the way down toward 0
   *
   * The result is clamped to [0, 100] and rounded to one decimal place to match
   * the DECIMAL(5,2) column. Pure and deterministic: same inputs → same output.
   *
   * @param current  Current confidence (0–100). Non-finite/῾undefined → default.
   * @param success  Whether the heal's re-run passed.
   * @param rate     Learning rate α in (0, 1]. Defaults to {@link LEARNING_RATE}.
   */
  static calculateConfidenceUpdate(
    current: number,
    success: boolean,
    rate: number = LEARNING_RATE,
  ): number {
    const c = Number.isFinite(current) ? current : DEFAULT_CONFIDENCE;
    const clampedCurrent = Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, c));
    const alpha = Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : LEARNING_RATE;

    const next = success
      ? clampedCurrent + alpha * (MAX_CONFIDENCE - clampedCurrent)
      : clampedCurrent - alpha * clampedCurrent;

    const clamped = Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, next));
    return Math.round(clamped * 10) / 10;
  }

  /**
   * Derive a stable element identity for confidence bucketing. Prefers an
   * explicit `elementId`; otherwise canonicalises the original selector (and
   * falls back to the healed selector), so '#email', 'getById("email")' and
   * '[id="email"]'-style phrasings all collapse to the same learned score.
   */
  static resolveElementId(input: HealingOutcomeInput): string {
    const explicit = (input.elementId ?? '').trim();
    if (explicit) return explicit;
    const source = input.originalSelector || input.healedSelector || '';
    const canonical = canonicalizeLocator(source);
    return canonical || 'unknown';
  }

  /* ── DB-backed operations (all best-effort, all tenant-scoped) ─────────── */

  /**
   * Read the current learned confidence for an element, or {@link DEFAULT_CONFIDENCE}
   * when nothing has been learned yet. Never throws — a lookup failure degrades
   * gracefully to the neutral default so callers can always rank suggestions.
   */
  async getConfidenceScore(
    elementId: string,
    companyId?: number | null,
    projectId?: number | null,
    locatorType?: string | null,
  ): Promise<number> {
    try {
      const row = await getHealingConfidenceScore(elementId, companyId, projectId, locatorType ?? '');
      if (!row) return DEFAULT_CONFIDENCE;
      const val = Number(row.confidence);
      return Number.isFinite(val) ? val : DEFAULT_CONFIDENCE;
    } catch (err: any) {
      logger.warn(MOD, `getConfidenceScore failed: ${err?.message || err}`);
      return DEFAULT_CONFIDENCE;
    }
  }

  /**
   * Persist the recomputed confidence + counters for an element (UPSERT). Pure
   * maths is done by {@link HealingOutcomeService.calculateConfidenceUpdate}
   * before we get here. Best-effort: returns null on failure without throwing.
   */
  async updateConfidenceScore(args: {
    companyId?: number | null;
    projectId?: number | null;
    elementId: string;
    locatorType?: string | null;
    confidence: number;
    success: boolean;
    lastResult?: string | null;
    lastStrategy?: string | null;
  }): Promise<HealingConfidenceScoreRecord | null> {
    try {
      return await upsertHealingConfidenceScore(args);
    } catch (err: any) {
      logger.warn(MOD, `updateConfidenceScore failed: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * THE core entry point of the learning loop. Given a single applied heal and
   * its re-run result, this:
   *   1. records the immutable outcome row (`healing_outcomes`),
   *   2. reads the element's current learned confidence,
   *   3. recomputes it via the pure smoothing function,
   *   4. UPSERTs the updated aggregate (`healing_confidence_scores`).
   *
   * Entirely best-effort and non-blocking: ANY failure is logged and swallowed,
   * and a partial result (e.g. event logged but score update failed) is still
   * returned so callers/telemetry can see what happened. It NEVER throws.
   */
  async captureHealingOutcome(input: HealingOutcomeInput): Promise<CaptureResult> {
    const elementId = HealingOutcomeService.resolveElementId(input);
    const locatorType = (input.locatorType ?? '').trim();
    const success = HealingOutcomeService.isSuccess(input.result);

    const fallback: CaptureResult = {
      outcomeId: null,
      elementId,
      locatorType,
      previousConfidence: DEFAULT_CONFIDENCE,
      newConfidence: DEFAULT_CONFIDENCE,
      success,
      score: null,
    };

    if (!input.result) {
      logger.warn(MOD, 'captureHealingOutcome called without a result — skipping');
      return fallback;
    }

    // 1) Append the immutable event log row (best-effort).
    let outcomeId: number | null = null;
    try {
      outcomeId = await insertHealingOutcome({
        companyId: input.companyId,
        projectId: input.projectId,
        profileChangeId: input.profileChangeId ?? null,
        baseUrl: input.baseUrl ?? null,
        elementId,
        locatorType: locatorType || null,
        originalSelector: input.originalSelector ?? null,
        healedSelector: input.healedSelector ?? null,
        strategy: input.strategy ?? null,
        suggestedConfidence: input.suggestedConfidence ?? null,
        result: String(input.result),
        testName: input.testName ?? null,
        errorMessage: input.errorMessage ?? null,
        durationMs: input.durationMs ?? null,
      });
    } catch (err: any) {
      logger.warn(MOD, `insertHealingOutcome failed: ${err?.message || err}`);
    }

    // 2) Read current learned confidence (defaults to neutral when absent).
    const previousConfidence = await this.getConfidenceScore(
      elementId, input.companyId, input.projectId, locatorType,
    );

    // 3) Recompute via the pure smoothing function.
    const newConfidence = HealingOutcomeService.calculateConfidenceUpdate(previousConfidence, success);

    // 4) Persist the updated aggregate (best-effort).
    const score = await this.updateConfidenceScore({
      companyId: input.companyId,
      projectId: input.projectId,
      elementId,
      locatorType,
      confidence: newConfidence,
      success,
      lastResult: String(input.result),
      lastStrategy: input.strategy ?? null,
    });

    logger.info(MOD, 'Captured healing outcome', {
      elementId, result: input.result, previousConfidence, newConfidence, outcomeId,
    });

    return { outcomeId, elementId, locatorType, previousConfidence, newConfidence, success, score };
  }

  /* ── Read helpers for the API / dashboard (tenant-scoped) ──────────────── */

  /** List recent healing outcomes for a scope (newest first). */
  async listOutcomes(opts: {
    companyId?: number | null;
    projectId?: number | null;
    elementId?: string;
    result?: string;
    strategy?: string;
    limit?: number;
  }): Promise<HealingOutcomeRecord[]> {
    try {
      return await getHealingOutcomes(opts);
    } catch (err: any) {
      logger.warn(MOD, `listOutcomes failed: ${err?.message || err}`);
      return [];
    }
  }

  /** Full learned confidence row(s) for an element (all locator-type buckets). */
  async getElementConfidence(
    elementId: string,
    companyId?: number | null,
    projectId?: number | null,
  ): Promise<HealingConfidenceScoreRecord[]> {
    try {
      const all = await getHealingConfidenceScores({ companyId, projectId, limit: 2000 });
      return all.filter((r) => r.element_id === elementId);
    } catch (err: any) {
      logger.warn(MOD, `getElementConfidence failed: ${err?.message || err}`);
      return [];
    }
  }

  /** Aggregate learning stats (success rate, mean confidence, per-strategy). */
  async getLearningStats(companyId?: number | null, projectId?: number | null) {
    try {
      return await getHealingLearningStats(companyId, projectId);
    } catch (err: any) {
      logger.warn(MOD, `getLearningStats failed: ${err?.message || err}`);
      return {
        totalOutcomes: 0, successes: 0, failures: 0, successRate: 0,
        elementsTracked: 0, avgConfidence: 0, byStrategy: [],
      };
    }
  }
}

/** Shared singleton — stateless, safe to reuse across requests. */
export const healingOutcomeService = new HealingOutcomeService();
