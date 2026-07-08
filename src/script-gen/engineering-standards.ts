/**
 * Engineering Standards — the single deterministic decision for a candidate
 * =========================================================================
 * These are STANDARDS, not heuristics. Heuristics imply guessing; this is the
 * opposite — fixed, deterministic engineering rules, exactly like ESLint rules
 * or compiler passes. The rules encoded here are the ones a senior automation
 * engineer applies without thinking:
 *
 *   • Existing Code First — reuse beats generation.
 *   • Prefer role/label locators over raw DOM.
 *   • Don't reuse stale code — deprecated / legacy / wrong-framework loses.
 *   • Don't reuse bad code — sleep() / waitForTimeout() / pause() loses.
 *
 * Everything is ONE decision. `evaluateCandidate()` returns the whole verdict —
 * candidateScore, locatorQuality, compatibility, quality, confidence — in a
 * single call. Ranking then does nothing but `sort(candidateScore)`, and
 * Selection does nothing but take the top. All the thinking happens here.
 *
 * Hard rules (unchanged across the whole project):
 *   • NO AI, NO LLM, NO prompts, NO embeddings, NO fuzzy/semantic matching.
 *   • Pure & deterministic — same input → same output, forever.
 *   • This is the ONE place engineering behaviour evolves. New rules are added
 *     here (+1 rule, adjust a weight) — never spread across the codebase.
 */

import type { CandidateType, ImplementationCandidate } from './candidate-discovery/types';

// ───────────────────────────────────────────────────────────────────────────
// Candidate priority — the engineering-value-first base table
// ───────────────────────────────────────────────────────────────────────────

/** The two intrinsic dimensions of a candidate type. */
export interface CandidatePriority {
  /** Engineering value (0–100) — PRIMARY. Reuse beats generation. */
  engineering: number;
  /** Locator quality (0–100) — SECONDARY tie-breaker only. */
  locator: number;
}

/**
 * The base priority table. `engineering` is the primary key (reuse-first);
 * `locator` is the tie-breaker.
 *
 * Deliberate inversion: an app-profile (`data-testid`-class) locator has HIGHER
 * locator quality (96) than a reused fixture (85) — yet the fixture still wins,
 * because engineering value (100 vs 92) decides first. A senior engineer reuses
 * the fixture instead of hand-rolling a shiny new selector.
 */
export const DEFAULT_CANDIDATE_PRIORITY: Readonly<Record<CandidateType, CandidatePriority>> = Object.freeze({
  'existing-fixture':       { engineering: 100, locator: 85 },
  'existing-page-object':   { engineering: 98,  locator: 90 },
  'existing-helper':        { engineering: 96,  locator: 88 },
  'existing-component':     { engineering: 94,  locator: 86 },
  'app-profile-locator':    { engineering: 92,  locator: 96 },
  'accessibility-locator':  { engineering: 90,  locator: 93 },
  'dom-locator':            { engineering: 75,  locator: 70 },
});

// Override capability exists but is kept INTERNAL — not surfaced through the
// public barrel. We don't optimise for enterprise customers we don't have yet;
// when one asks for custom ranking, we expose these. Until then they only serve
// tests and future work.
function cloneDefault(): Record<CandidateType, CandidatePriority> {
  const out = {} as Record<CandidateType, CandidatePriority>;
  for (const k of Object.keys(DEFAULT_CANDIDATE_PRIORITY) as CandidateType[]) {
    out[k] = { ...DEFAULT_CANDIDATE_PRIORITY[k] };
  }
  return out;
}
let activePriority: Record<CandidateType, CandidatePriority> = cloneDefault();

/** @internal Override part of the priority table (config, not code). */
export function configureCandidatePriority(
  overrides: Partial<Record<CandidateType, Partial<CandidatePriority>>>,
): void {
  for (const key of Object.keys(overrides) as CandidateType[]) {
    const o = overrides[key];
    if (!o) continue;
    const base = activePriority[key] ?? DEFAULT_CANDIDATE_PRIORITY[key];
    activePriority[key] = {
      engineering: typeof o.engineering === 'number' ? o.engineering : base.engineering,
      locator: typeof o.locator === 'number' ? o.locator : base.locator,
    };
  }
}

/** @internal Restore every standard to its built-in default. */
export function resetEngineeringStandards(): void {
  activePriority = cloneDefault();
}

/** The priority for one candidate type (falls back to the DOM floor if unknown). */
function priorityFor(type: CandidateType): CandidatePriority {
  return activePriority[type] ?? activePriority['dom-locator'];
}

// ───────────────────────────────────────────────────────────────────────────
// Compatibility — "is this reuse compatible with the CURRENT project?"
// ───────────────────────────────────────────────────────────────────────────

/** Below this, a reuse candidate is considered incompatible with the project. */
export const COMPATIBILITY_MIN = 50;

const COMPAT_OK = 100;            // generated locators + clean reuse
const COMPAT_DEPRECATED = 10;     // explicitly deprecated asset
const COMPAT_LEGACY = 20;         // legacy / obsolete / archived signal
const COMPAT_FRAMEWORK_MISMATCH = 15; // wrong framework / module

/** Strong, unambiguous staleness words — match anywhere, incl. camelCase. */
const LEGACY_SIGNAL = /(legacy|obsolete|deprecated|archived?|superseded|backup)/i;
/** Ambiguous signals ("old", "v1", "bak") — only when clearly delimited. */
const LEGACY_SIGNAL_WEAK = /(?:^|[._\-\/\s])(old|bak|v1)(?=$|[._\-\/\s])/i;

/**
 * Compatibility score (0–100). Generated locators are always 100 (authored for
 * the app as it exists now). Reuse is penalised when deprecated, legacy /
 * obsolete / archived, or from a different framework/module. Signal-based; never
 * inspects intent with an LLM.
 */
export function assessCompatibility(c: ImplementationCandidate): number {
  if (!c.reuse) return COMPAT_OK;

  const meta = c.meta ?? {};
  if (meta.deprecated === true) return COMPAT_DEPRECATED;

  const hay = `${c.source} ${c.detail ?? ''} ${meta.path ?? ''} ${(meta.tags ?? []).join(' ')}`;
  if (LEGACY_SIGNAL.test(hay) || LEGACY_SIGNAL_WEAK.test(hay)) return COMPAT_LEGACY;

  if (meta.framework && meta.projectFramework && meta.framework !== meta.projectFramework) {
    return COMPAT_FRAMEWORK_MISMATCH;
  }
  return COMPAT_OK;
}

// ───────────────────────────────────────────────────────────────────────────
// Quality — "does existing code meet our engineering standards?"
// ───────────────────────────────────────────────────────────────────────────

/** The verdict from a quality check. */
export interface QualityVerdict {
  ok: boolean;
  issues: string[];
}

/** Anti-patterns that disqualify existing code from blind reuse. */
const QUALITY_ANTI_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bsleep\s*\(/i,                       label: 'blocking sleep() — flaky, use web-first assertions' },
  { re: /waitForTimeout\s*\(/i,                label: 'hard-coded waitForTimeout — flaky, use auto-waiting locators' },
  { re: /page\.waitFor\s*\(\s*\d/i,            label: 'fixed-duration wait — non-deterministic' },
  { re: /\.pause\s*\(\s*\)/i,                  label: 'debugger .pause() left in code' },
  { re: /setTimeout\s*\(\s*[^,]*,\s*\d{4,}/i,  label: 'long setTimeout — brittle timing dependency' },
  { re: /\b(fixme|xxx|hack)\b/i,               label: 'unresolved FIXME/HACK marker' },
];

/**
 * Quality verdict for a reuse candidate. Only reuse is gated (generation
 * quality is the composer's own job). Fails open when no source snippet is
 * captured, so it never blocks.
 */
export function assessQuality(c: ImplementationCandidate): QualityVerdict {
  if (!c.reuse) return { ok: true, issues: [] };
  const src = c.meta?.source;
  if (!src) return { ok: true, issues: [] };

  const issues: string[] = [];
  for (const { re, label } of QUALITY_ANTI_PATTERNS) {
    if (re.test(src)) issues.push(label);
  }
  return { ok: issues.length === 0, issues };
}

// ───────────────────────────────────────────────────────────────────────────
// The ONE decision — evaluateCandidate()
// ───────────────────────────────────────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low';

/** The complete verdict for a candidate — one object, one decision. */
export interface CandidateEvaluation {
  /**
   * Final candidate score = base priority + compatibility adjustment +
   * quality adjustment. THE sort key. A clean, compatible candidate keeps its
   * base (fixture 100); a stale or low-quality reuse candidate is driven below
   * the generated-locator floor so it can never win by merely existing.
   */
  candidateScore: number;
  /** Locator quality — the only tie-breaker between equal engineering value. */
  locatorQuality: number;
  /** Compatibility with the current project (0–100). Kept for transparency. */
  compatibility: number;
  /** Quality verdict (issues found in the reused source, if any). */
  quality: QualityVerdict;
  /** External-facing summary. Users see this + reason; never the raw numbers. */
  confidence: Confidence;
}

/** How hard a failed quality check pushes a reuse candidate down. */
const QUALITY_PENALTY = 40;

/**
 * Evaluate a candidate against every engineering standard in ONE call. This is
 * the single decision point: compatibility and quality fold into the final
 * candidateScore as adjustments, so downstream Ranking is just a sort and
 * Selection is just "take the top". No branching lives outside this function.
 */
export function evaluateCandidate(c: ImplementationCandidate): CandidateEvaluation {
  const base = priorityFor(c.type);
  const compatibility = assessCompatibility(c);
  const quality = assessQuality(c);

  // Adjustments only ever apply to reuse; generated locators are compatible and
  // ungated by definition.
  const compatibilityAdjustment = c.reuse ? -(COMPAT_OK - compatibility) : 0;
  const qualityAdjustment = c.reuse && !quality.ok ? -QUALITY_PENALTY : 0;

  const candidateScore = base.engineering + compatibilityAdjustment + qualityAdjustment;
  const confidence = deriveConfidence(base.engineering, compatibility, quality, c.reuse);

  return { candidateScore, locatorQuality: base.locator, compatibility, quality, confidence };
}

/**
 * Collapse the raw signals into a user-facing label. Internal to the module —
 * users only ever see the result via the candidate's `confidence`.
 */
function deriveConfidence(
  basePriority: number,
  compatibility: number,
  quality: QualityVerdict,
  reuse: boolean,
): Confidence {
  const gatePass = reuse ? compatibility >= COMPATIBILITY_MIN && quality.ok : true;
  if (!gatePass) return 'low';
  if (basePriority >= 90 && compatibility >= 80) return 'high';
  if (basePriority >= 75 && compatibility >= COMPATIBILITY_MIN) return 'medium';
  return 'low';
}
