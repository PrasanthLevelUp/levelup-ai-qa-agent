/**
 * Healing Result — the canonical, explainable output of a healing operation.
 * ============================================================================
 *
 * Sprint 4.1 · Healing Explainability.
 *
 * THE PROBLEM
 * -----------
 * A QA Lead should trust *why* LevelUp healed a script, not just that it healed.
 * Today the healing output is scattered across several shapes — `HealingOutcome`
 * carries a `suggestion` (newLocator/strategy/confidence/reasoning), a separate
 * `confidenceResult` (breakdown + reasons), a `domMemoryInsight` (alternatives +
 * stability), a `decisionTrail` (which layer won) and a `validationResult`. A
 * consumer that wants to answer "what changed, why, how confident, what evidence,
 * what alternatives, how risky?" has to stitch all of that together itself.
 *
 * THE CONTRACT
 * ------------
 * `HealingResult` is a single strongly-typed shape that answers those questions:
 *
 *     originalSelector   what we started from
 *     healedSelector     what we changed it to (null when nothing was healed)
 *     confidence         0..1, the SAME deterministic score the engine computed
 *     reasonCode         a deterministic category (never AI prose)
 *     reason             a short human sentence rendered from the code
 *     evidence[]         the per-signal breakdown that produced the confidence
 *     alternatives[]     the other candidates that were considered
 *     risk               low | medium | high
 *
 * DESIGN RULES (Sprint 4.1)
 * -------------------------
 * 1. This module is PURE and DETERMINISTIC — no I/O, no engines, no DB, no LLM.
 *    `buildHealingResult()` only *re-shapes* information the orchestrator already
 *    produced. It never re-runs healing or invents a selector.
 * 2. Confidence is NOT recomputed. We pass through the engine's existing
 *    `ConfidenceResult.finalScore` (falling back to the suggestion's own
 *    confidence). The number a customer sees is the number the engine calculated.
 * 3. Reasons come from a fixed vocabulary (`HealingReasonCode`) derived by
 *    comparing the original vs. healed selector plus the deterministic failure
 *    diagnosis — never generated text.
 * 4. Risk here is a thin, deterministic first cut. Sprint 4.3 will formalise the
 *    risk rules; the field exists now so the contract is stable for consumers and
 *    analytics. We deliberately keep it minimal (no over-engineering).
 */

/* -------------------------------------------------------------------------- */
/*  Vocabulary                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic reason categories. Derived by comparing the original and healed
 * selectors (and the failure diagnosis) — NOT by asking an LLM. Add a new code
 * here rather than emitting free-form text anywhere.
 */
export type HealingReasonCode =
  | 'DATA_TESTID_REMOVED' // original relied on a data-test* attribute that is gone
  | 'ID_CHANGED' // original relied on an #id / [id=] that changed
  | 'ATTRIBUTE_CHANGED' // a non-id attribute name/value the selector relied on changed
  | 'TEXT_CHANGED' // original matched on visible text that changed
  | 'ROLE_CHANGED' // original matched on ARIA role/name that changed
  | 'ELEMENT_MOVED' // the element's structural path/nesting changed
  | 'LOCATOR_UNSTABLE' // DOM Memory shows the original selector was historically unstable
  | 'SELECTOR_UPDATED' // healed, but no more specific difference could be attributed
  | 'NO_HEAL'; // nothing was healed (no suggestion produced)

/** Coarse risk band. Sprint 4.3 formalises the classification rules. */
export type HealingRisk = 'low' | 'medium' | 'high';

/**
 * A single explainability signal that fed the confidence score. Score is 0..1.
 * These come straight from the engine's existing `ConfidenceResult.breakdown`,
 * DOM Memory stability, and the winning decision-trail layer.
 */
export interface HealingEvidence {
  /** Machine label, e.g. `selector_quality`, `similarity`, `dom_stability`. */
  dimension: string;
  /** Normalised 0..1 strength of this signal. */
  score: number;
  /** Human-readable one-liner explaining the signal. */
  detail: string;
}

/** An alternative candidate that was considered but not chosen. */
export interface HealingAlternative {
  selector: string;
  /** 0..1 — the candidate's own confidence/composite score. */
  confidence: number;
  /** Where the candidate came from (dom_memory, app_profile, rule, ai, …). */
  source: string;
  /** Why it was considered / why it lost, when known. */
  reasoning?: string;
}

/**
 * The canonical, explainable healing result. Becomes the standard contract for
 * future UI and analytics. Additive — it does not replace the existing
 * `HealingOutcome` fields, so current consumers keep working.
 */
export interface HealingResult {
  /** The selector we started from (the failing locator). */
  originalSelector: string;
  /** The selector we healed to, or null when nothing was healed. */
  healedSelector: string | null;
  /** True when a healed selector was produced. */
  healed: boolean;
  /** The producing strategy/layer label (e.g. rule_based, ai_reasoning). */
  strategy: string | null;
  /** Deterministic confidence, 0..1 — passed through from the engine, never re-derived. */
  confidence: number;
  /** Letter grade for quick scanning (A..F), when the engine provided one. */
  grade?: string;
  /** True when confidence clears the engine's auto-apply threshold. */
  autoApply: boolean;
  /** Deterministic reason category. */
  reasonCode: HealingReasonCode;
  /** Short human sentence rendered from `reasonCode`. */
  reason: string;
  /** Per-signal evidence that produced the confidence score. */
  evidence: HealingEvidence[];
  /** Other candidates that were considered, best-first. */
  alternatives: HealingAlternative[];
  /** Coarse risk band (thin first cut in 4.1; formalised in 4.3). */
  risk: HealingRisk;
}

/* -------------------------------------------------------------------------- */
/*  Builder inputs (structural — decoupled from the orchestrator types)       */
/* -------------------------------------------------------------------------- */

/**
 * Minimal structural views of the data the orchestrator already produced. We
 * type these locally (rather than importing the concrete orchestrator/engine
 * interfaces) so this module stays pure and trivially unit-testable, and so a
 * shape tweak upstream does not ripple a compile error through here.
 */
export interface HealingResultSuggestionView {
  newLocator: string;
  strategy?: string;
  confidence?: number;
  reasoning?: string;
  stabilityScore?: number;
}

export interface HealingResultConfidenceView {
  finalScore: number;
  grade?: string;
  autoApply?: boolean;
  breakdown?: {
    selectorQuality?: number;
    similarityScore?: number;
    strategyReliability?: number;
    validationBonus?: number;
    historicalBonus?: number;
    contextBonus?: number;
  };
  reasons?: string[];
}

export interface HealingResultAlternativeView {
  selector: string;
  source?: string;
  compositeScore?: number;
  stabilityScore?: number;
  score?: number;
  reasoning?: string;
}

export interface HealingResultDomMemoryView {
  alternatives?: HealingResultAlternativeView[];
  selectorHistory?: { stabilityScore?: number; assessment?: string };
}

export interface BuildHealingResultInput {
  /** The failing/original selector. */
  originalSelector: string;
  /** The winning suggestion (null when nothing healed). */
  suggestion?: HealingResultSuggestionView | null;
  /** The engine's explainable confidence result, when present. */
  confidenceResult?: HealingResultConfidenceView | null;
  /** DOM Memory insight (alternatives + stability), when present. */
  domMemoryInsight?: HealingResultDomMemoryView | null;
  /** Deterministic failure diagnosis category, when present. */
  diagnosisCategory?: string | null;
  /** True when the healed selector was DOM/browser validated. */
  domValidated?: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Reason inference (pure, deterministic)                                    */
/* -------------------------------------------------------------------------- */

const DATA_TESTID_RE = /\[?\bdata-(testid|test|cy|qa|test-id)\b/i;
const ID_RE = /(^|[^\\])#[A-Za-z_][\w-]*|\[\s*id\s*=/i;
const TEXT_RE = /getByText\(|\btext\s*=|:has-text\(|:text\(/i;
const ROLE_RE = /getByRole\(|\brole\s*=|getByLabel\(|aria-/i;
const ATTR_RE = /\[[^\]]+\]/;
const PATH_RE = />|\s+\w+\s*>|:nth-|\bxpath=|\/\/|\bnth\(/i;

/** True when the selector relies on a data-test* attribute. */
function hasDataTestId(sel: string): boolean {
  return DATA_TESTID_RE.test(sel);
}

/**
 * Infer WHY a heal happened by comparing the original and healed selectors, with
 * the deterministic failure diagnosis and DOM-memory stability as tie-breakers.
 * Pure string analysis — no AI, no network. Returns 'NO_HEAL' when nothing was
 * healed.
 */
export function inferHealingReason(
  originalSelector: string,
  healedSelector: string | null,
  opts?: { stabilityScore?: number; diagnosisCategory?: string | null },
): HealingReasonCode {
  const orig = (originalSelector || '').trim();
  const healed = (healedSelector || '').trim();
  if (!healed) return 'NO_HEAL';

  // DOM Memory told us the original was historically unstable → the strongest,
  // most specific attributable reason when present.
  if (opts?.stabilityScore !== undefined && opts.stabilityScore <= 0.3) {
    return 'LOCATOR_UNSTABLE';
  }

  // Attribute-family changes (most common and most specific).
  if (hasDataTestId(orig) && !hasDataTestId(healed)) return 'DATA_TESTID_REMOVED';

  const origId = ID_RE.test(orig);
  const healedId = ID_RE.test(healed);
  if (origId && !healedId) return 'ID_CHANGED';

  const origText = TEXT_RE.test(orig);
  const healedText = TEXT_RE.test(healed);
  if (origText && !healedText) return 'TEXT_CHANGED';
  // Both match on text but the text token differs.
  if (origText && healedText && orig !== healed) return 'TEXT_CHANGED';

  const origRole = ROLE_RE.test(orig);
  const healedRole = ROLE_RE.test(healed);
  if (origRole && !healedRole) return 'ROLE_CHANGED';

  // A structural/path change (child combinators, nth, xpath) that changed.
  const origPath = PATH_RE.test(orig);
  const healedPath = PATH_RE.test(healed);
  if (origPath !== healedPath) return 'ELEMENT_MOVED';

  // Both are attribute selectors but the attribute payload changed.
  if (ATTR_RE.test(orig) && ATTR_RE.test(healed) && orig !== healed) {
    return 'ATTRIBUTE_CHANGED';
  }

  // We healed but could not attribute a more specific difference.
  return 'SELECTOR_UPDATED';
}

const REASON_TEXT: Record<HealingReasonCode, string> = {
  DATA_TESTID_REMOVED: 'The data-test attribute the selector relied on was removed.',
  ID_CHANGED: 'The element id the selector relied on changed.',
  ATTRIBUTE_CHANGED: 'An attribute the selector relied on changed.',
  TEXT_CHANGED: 'The visible text the selector matched on changed.',
  ROLE_CHANGED: 'The element role/accessible name the selector matched on changed.',
  ELEMENT_MOVED: 'The element moved in the DOM structure.',
  LOCATOR_UNSTABLE: 'The original selector was historically unstable and was replaced.',
  SELECTOR_UPDATED: 'The selector was updated to match the current DOM.',
  NO_HEAL: 'No healed selector was produced.',
};

/** Human-readable sentence for a reason code (deterministic lookup). */
export function reasonText(code: HealingReasonCode): string {
  return REASON_TEXT[code] ?? REASON_TEXT.SELECTOR_UPDATED;
}

/* -------------------------------------------------------------------------- */
/*  Risk (thin, deterministic first cut — formalised in Sprint 4.3)           */
/* -------------------------------------------------------------------------- */

/**
 * Coarse risk band from the reason and confidence. Sprint 4.3 will replace this
 * with a fuller rule set; kept intentionally small here so the field is present
 * and stable without pre-empting that work.
 *
 * Principle: attribute-only swaps on the same element are low risk; a text
 * change is medium (copy can be reworded on purpose); a moved element or a
 * low-confidence heal is high.
 */
export function deriveHealingRisk(
  reasonCode: HealingReasonCode,
  confidence: number,
  domValidated?: boolean,
): HealingRisk {
  if (reasonCode === 'NO_HEAL') return 'high';
  if (reasonCode === 'ELEMENT_MOVED') return 'high';
  if (confidence < 0.6) return 'high';

  if (reasonCode === 'TEXT_CHANGED' || reasonCode === 'ROLE_CHANGED') return 'medium';
  if (confidence < 0.85) return 'medium';
  if (!domValidated) return 'medium';

  // Attribute/id-only swap, high confidence, DOM-validated.
  return 'low';
}

/* -------------------------------------------------------------------------- */
/*  Evidence mapping (pure)                                                   */
/* -------------------------------------------------------------------------- */

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * Re-shape the engine's existing confidence breakdown + DOM-memory stability
 * into a flat `HealingEvidence[]`. Only dimensions that were actually present
 * are emitted, so the evidence list honestly reflects what informed the score.
 */
export function buildEvidence(input: BuildHealingResultInput): HealingEvidence[] {
  const evidence: HealingEvidence[] = [];
  const b = input.confidenceResult?.breakdown;

  if (b) {
    const add = (dimension: string, score: number | undefined, detail: string): void => {
      if (score === undefined) return;
      evidence.push({ dimension, score: clamp01(score), detail });
    };
    add('selector_quality', b.selectorQuality, 'Quality of the healed selector type (semantic > id > attribute > xpath).');
    add('similarity', b.similarityScore, 'How closely the healed selector matches the failed locator’s intent.');
    add('strategy_reliability', b.strategyReliability, 'Trust in the strategy that produced the heal (rule > pattern > AI).');
    add('validation', b.validationBonus, 'Whether the healed selector was DOM-validated as present and interactable.');
    add('historical', b.historicalBonus, 'Historical success rate of similar heals.');
    add('context', b.contextBonus, 'Contextual match (same tag / same action / exact attribute).');
  }

  const stability = input.domMemoryInsight?.selectorHistory?.stabilityScore;
  if (stability !== undefined) {
    evidence.push({
      dimension: 'dom_stability',
      score: clamp01(stability),
      detail:
        input.domMemoryInsight?.selectorHistory?.assessment ||
        'Historical stability of the original selector in DOM Memory.',
    });
  }

  return evidence;
}

/* -------------------------------------------------------------------------- */
/*  Alternatives mapping (pure)                                               */
/* -------------------------------------------------------------------------- */

/**
 * Re-shape DOM-memory alternatives into `HealingAlternative[]`, best-first,
 * excluding the chosen healed selector. Confidence prefers the composite score,
 * then stability, then raw score.
 */
export function buildAlternatives(
  input: BuildHealingResultInput,
  healedSelector: string | null,
  limit = 5,
): HealingAlternative[] {
  const alts = input.domMemoryInsight?.alternatives ?? [];
  const chosen = (healedSelector || '').trim();
  const out: HealingAlternative[] = [];
  const seen = new Set<string>();

  for (const a of alts) {
    const selector = (a.selector || '').trim();
    if (!selector || selector === chosen) continue;
    if (seen.has(selector)) continue;
    seen.add(selector);
    const confidence = clamp01(a.compositeScore ?? a.stabilityScore ?? a.score ?? 0);
    out.push({
      selector,
      confidence,
      source: a.source || 'dom_memory',
      reasoning: a.reasoning,
    });
    if (out.length >= limit) break;
  }

  return out.sort((x, y) => y.confidence - x.confidence);
}

/* -------------------------------------------------------------------------- */
/*  Builder                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the canonical {@link HealingResult} from information the orchestrator
 * already produced. Pure and deterministic — no healing is (re)run here.
 */
export function buildHealingResult(input: BuildHealingResultInput): HealingResult {
  const originalSelector = (input.originalSelector || '').trim();
  const healedSelector = input.suggestion?.newLocator?.trim() || null;
  const healed = !!healedSelector;

  // Confidence: pass through the engine's deterministic score. Prefer the
  // explainable ConfidenceResult; fall back to the suggestion's own confidence;
  // finally 0. NEVER recomputed here.
  const confidence = clamp01(
    input.confidenceResult?.finalScore ??
      input.suggestion?.confidence ??
      0,
  );

  const stabilityScore =
    input.suggestion?.stabilityScore ??
    input.domMemoryInsight?.selectorHistory?.stabilityScore;

  const reasonCode = inferHealingReason(originalSelector, healedSelector, {
    stabilityScore,
    diagnosisCategory: input.diagnosisCategory,
  });

  const evidence = buildEvidence(input);
  const alternatives = buildAlternatives(input, healedSelector);

  // Auto-apply: prefer the engine's own flag; else derive from its threshold.
  const autoApply = input.confidenceResult?.autoApply ?? confidence >= 0.85;

  const risk = deriveHealingRisk(reasonCode, confidence, input.domValidated);

  return {
    originalSelector,
    healedSelector,
    healed,
    strategy: input.suggestion?.strategy ?? null,
    confidence,
    grade: input.confidenceResult?.grade,
    autoApply,
    reasonCode,
    reason: reasonText(reasonCode),
    evidence,
    alternatives,
    risk,
  };
}
