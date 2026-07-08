/**
 * Engineering Heuristics — the single home for deterministic decisions
 * ====================================================================
 * Over time, EVERY deterministic engineering decision the Script Composer makes
 * lives here: candidate priority, compatibility rules, quality standards,
 * confidence thresholds — and later assertion-expansion rules, naming
 * conventions, humanization rules, TODO thresholds, "Existing Code First".
 *
 * The point: the Script Composer becomes an *executor* of these heuristics
 * rather than embedding engineering rules throughout the codebase. One place to
 * evolve behaviour without touching architecture.
 *
 * Hard rules (unchanged across the whole project):
 *   • NO AI, NO LLM, NO prompts, NO embeddings, NO fuzzy/semantic matching.
 *   • Pure & deterministic — same input → same output, forever.
 *   • Constants are DATA, not code. Enterprise customers override the priority
 *     table via `configureCandidatePriority()` — no code change required.
 */

import type { CandidateType, ImplementationCandidate } from './candidate-discovery/types';

// ───────────────────────────────────────────────────────────────────────────
// 1. Candidate priority (the engineering-value-first table, now configurable)
// ───────────────────────────────────────────────────────────────────────────

/** The two intrinsic dimensions of a candidate type. */
export interface CandidatePriority {
  /** Engineering value (0–100) — PRIMARY. Reuse beats generation. */
  engineering: number;
  /** Locator quality (0–100) — SECONDARY tie-breaker only. */
  locator: number;
}

/**
 * The default priority table. `engineering` is the primary key (reuse-first);
 * `locator` is the tie-breaker.
 *
 * Deliberate inversion: an app-profile (`data-testid`-class) locator has HIGHER
 * locator quality (96) than a reused fixture (85) — yet the fixture still wins,
 * because engineering value (100 vs 92) decides first. That inversion is the
 * whole point: a senior engineer reuses the fixture instead of hand-rolling a
 * shiny new selector.
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

/** Deep-clone the frozen default into a mutable working table. */
function cloneDefault(): Record<CandidateType, CandidatePriority> {
  const out = {} as Record<CandidateType, CandidatePriority>;
  for (const k of Object.keys(DEFAULT_CANDIDATE_PRIORITY) as CandidateType[]) {
    out[k] = { ...DEFAULT_CANDIDATE_PRIORITY[k] };
  }
  return out;
}

/** The active table (starts as the default; can be overridden at runtime). */
let activePriority: Record<CandidateType, CandidatePriority> = cloneDefault();

/**
 * Override part (or all) of the priority table — e.g. an enterprise customer
 * that weights helpers above page objects. Only the keys/dimensions provided
 * are changed; everything else keeps its default. Configuration, not code.
 */
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

/** The priority for one candidate type (falls back to the DOM floor if unknown). */
export function getCandidatePriority(type: CandidateType): CandidatePriority {
  return activePriority[type] ?? activePriority['dom-locator'];
}

/** The full active table (read-only snapshot). */
export function getCandidatePriorityTable(): Readonly<Record<CandidateType, CandidatePriority>> {
  return activePriority;
}

/** Restore every heuristic to its built-in default (used by tests / reloads). */
export function resetEngineeringHeuristics(): void {
  activePriority = cloneDefault();
}

// ───────────────────────────────────────────────────────────────────────────
// 2. Compatibility — "is this reuse compatible with the CURRENT project?"
// ───────────────────────────────────────────────────────────────────────────

/**
 * A reuse candidate scoring below this is NOT compatible enough to win on
 * engineering value alone — it drops behind freshly-generated locators.
 */
export const COMPATIBILITY_MIN = 50;

/** Full marks — freshly generated locators target the current app by definition. */
const COMPAT_OK = 100;
/** Explicitly deprecated asset — effectively unusable. */
const COMPAT_DEPRECATED = 10;
/** Legacy / obsolete / archived signal in name or path. */
const COMPAT_LEGACY = 20;
/** Belongs to a different framework/module than the project uses. */
const COMPAT_FRAMEWORK_MISMATCH = 15;

/**
 * Signals that a repo asset is stale and should NOT be blindly reused:
 * legacy/obsolete page objects, archived or backup code, v1/old duplicates.
 */
const LEGACY_SIGNAL =
  // Strong, unambiguous staleness words — match anywhere, incl. camelCase
  // (e.g. "LegacyLoginPage", "loginArchived").
  /(legacy|obsolete|deprecated|archived?|superseded|backup)/i;
/** Ambiguous signals ("old", "v1", "bak") — only when clearly delimited. */
const LEGACY_SIGNAL_WEAK = /(?:^|[._\-\/\s])(old|bak|v1)(?=$|[._\-\/\s])/i;

/**
 * Assess whether a candidate is compatible with the current project. Pure,
 * deterministic, signal-based (name/path/tags + explicit metadata) — never
 * inspects intent with an LLM. Non-reuse (generated locators) are always
 * compatible: they are authored for the app as it exists now.
 *
 * Answers: deprecated helper? obsolete page object? wrong framework/module?
 * archived / duplicate code? → low compatibility, so it can't win by default.
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
// 3. Quality — "does existing code meet our engineering standards?"
// ───────────────────────────────────────────────────────────────────────────

/** The verdict from a quality check. */
export interface QualityVerdict {
  ok: boolean;
  issues: string[];
}

/**
 * Anti-patterns that disqualify existing code from blind reuse. If a helper
 * `login()` is full of `sleep(5000)`, we do NOT reuse it — we generate a better
 * implementation. Deterministic source scan; only runs when a source snippet is
 * available (fails open to `ok` when we can't see the code).
 */
const QUALITY_ANTI_PATTERNS: ReadonlyArray<{ re: RegExp; label: string }> = [
  { re: /\bsleep\s*\(/i,                       label: 'blocking sleep() — flaky, use web-first assertions' },
  { re: /waitForTimeout\s*\(/i,                label: 'hard-coded waitForTimeout — flaky, use auto-waiting locators' },
  { re: /page\.waitFor\s*\(\s*\d/i,            label: 'fixed-duration wait — non-deterministic' },
  { re: /\.pause\s*\(\s*\)/i,                  label: 'debugger .pause() left in code' },
  { re: /setTimeout\s*\(\s*[^,]*,\s*\d{4,}/i,  label: 'long setTimeout — brittle timing dependency' },
  { re: /\b(fixme|xxx|hack)\b/i,               label: 'unresolved FIXME/HACK marker' },
];

/**
 * Judge whether an existing-code candidate is good enough to reuse. Only reuse
 * candidates are gated (generation quality is the composer's own job). Fails
 * open: when no source snippet is captured, the candidate passes.
 */
export function assessQuality(c: ImplementationCandidate): QualityVerdict {
  if (!c.reuse) return { ok: true, issues: [] };

  const src = c.meta?.source;
  if (!src) return { ok: true, issues: [] }; // can't see the code → don't block

  const issues: string[] = [];
  for (const { re, label } of QUALITY_ANTI_PATTERNS) {
    if (re.test(src)) issues.push(label);
  }
  return { ok: issues.length === 0, issues };
}

// ───────────────────────────────────────────────────────────────────────────
// 4. Confidence — the EXTERNAL-facing summary (raw scores stay internal)
// ───────────────────────────────────────────────────────────────────────────

export type Confidence = 'high' | 'medium' | 'low';

/**
 * Collapse the internal numbers (engineering value, compatibility, quality gate)
 * into a single user-facing label. Users see `reason` + `confidence`; they never
 * need to see engineeringValue / locatorQuality directly.
 */
export function deriveConfidence(args: {
  engineeringValue: number;
  compatibility: number;
  quality: QualityVerdict;
  gatePass: boolean;
}): Confidence {
  const { engineeringValue, compatibility, quality, gatePass } = args;
  if (!gatePass || !quality.ok) return 'low';
  if (engineeringValue >= 90 && compatibility >= 80) return 'high';
  if (engineeringValue >= 75 && compatibility >= COMPATIBILITY_MIN) return 'medium';
  return 'low';
}

/**
 * The single gate deciding whether a candidate is eligible to win on
 * engineering value. Generated locators always pass; reuse must be BOTH
 * compatible enough AND meet quality standards. This is the
 * `Reuse Candidate → Quality Check → Ranking` rule, in one place.
 */
export function passesGate(compatibility: number, quality: QualityVerdict): boolean {
  return compatibility >= COMPATIBILITY_MIN && quality.ok;
}
