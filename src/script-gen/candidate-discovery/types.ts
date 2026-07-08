/**
 * Candidate Discovery — types (Sprint 2, Milestone 2A · PR 1)
 * ===========================================================
 * The first slice of Candidate Resolution. Its ONLY job is to *discover* every
 * plausible way a business step could be implemented — existing fixture,
 * existing page-object method, existing helper, existing component, and the
 * three locator families (app-profile / accessibility / DOM).
 *
 * Hard boundaries for this PR (enforced by tests):
 *   1. Discovery does NOT rank candidates.       (report.ranked === false)
 *   2. Discovery does NOT select a candidate.    (report.selected === false)
 *   3. Discovery does NOT change generated code.  It is a read-only report
 *      attached to the generation result, exactly like `repositoryIntelligence`
 *      and `locatorGrounding`.
 *
 * Ranking (PR 2), selection (PR 3) and the Existing-Code-First walk (PR 4)
 * build on this list — but none of them exist yet. Keeping discovery pure and
 * side-effect free is what makes those later PRs low-risk.
 */

/**
 * The kinds of implementation a single business step can map to. Ordered here
 * only for readability — discovery assigns NO priority between them (that is
 * Ranking's job in PR 2). The first four are *reuse* of existing repo assets;
 * the last three are locator strategies for freshly generated interactions.
 */
export type CandidateType =
  | 'existing-fixture'        // a Playwright fixture the repo already defines
  | 'existing-page-object'    // a method on an existing Page Object (e.g. LoginPage.login())
  | 'existing-helper'         // an exported helper function (e.g. loginAs())
  | 'existing-component'      // a reusable component the repo defines
  | 'app-profile-locator'     // a selector grounded in the crawled Application Profile
  | 'accessibility-locator'   // a user-facing role/label locator (getByRole / getByLabel)
  | 'dom-locator';            // a raw DOM locator fallback (css / text)

/**
 * Internal signal bag captured at discovery time for a reuse candidate. Feeds
 * the Compatibility and Quality heuristics in Ranking (PR 2B.1). Never surfaced
 * to users directly — it is raw evidence, not a decision.
 */
export interface CandidateMeta {
  /** Asset name (e.g. the page object or fixture name). */
  name?: string;
  /** Repository path of the asset (used for legacy/archived path signals). */
  path?: string;
  /** Explicit deprecation flag from the repo scan, if known. */
  deprecated?: boolean;
  /** Framework/module the asset belongs to (e.g. 'playwright', 'cypress'). */
  framework?: string;
  /** The framework/module the current project uses (for mismatch detection). */
  projectFramework?: string;
  /** Free-form tags from the repo scan (e.g. ['legacy'], ['archived']). */
  tags?: string[];
  /** Optional source snippet, scanned for quality anti-patterns (e.g. sleep()). */
  source?: string;
}

/** True for candidate types that reuse existing repository code. */
export const REUSE_TYPES: ReadonlySet<CandidateType> = new Set<CandidateType>([
  'existing-fixture',
  'existing-page-object',
  'existing-helper',
  'existing-component',
]);

/**
 * The action a step intends. Deterministic, keyword-derived — never inferred by
 * an LLM. `unknown` is honest: discovery still runs, it just cannot narrow the
 * locator families for that step.
 */
export type StepIntent =
  | 'navigate'
  | 'fill'
  | 'click'
  | 'verify'
  | 'unknown';

/**
 * One discovered implementation option for a step. `source` is a human-readable
 * label (e.g. `LoginPage.login()` or `getByRole('button', { name: /login/i })`)
 * — NOT necessarily the exact code that will be emitted. Discovery describes
 * options; it does not author code.
 */
export interface ImplementationCandidate {
  /** Which family this candidate belongs to. */
  type: CandidateType;
  /** Human-readable description of the option (method call or locator sketch). */
  source: string;
  /** Optional extra context — file path, method name, or locator strategy. */
  detail?: string;
  /** True when this candidate reuses existing repo code (derived from `type`). */
  reuse: boolean;
  /**
   * WHY this candidate exists — a short engineering rationale (e.g. "Existing
   * reusable abstraction"). Set at discovery time so Ranking can explain its
   * decision and the report is debuggable: candidate → reason → score.
   */
  reason: string;
  /**
   * Raw signals captured at discovery time (path, deprecation, framework, tags,
   * source snippet). Internal evidence for the Compatibility / Quality
   * heuristics — never surfaced to users directly.
   */
  meta?: CandidateMeta;

  // ── Ranking fields (added by PR 2B — Candidate Ranking) ────────────────────
  // Absent on raw discovery output; populated by rankReport(). Discovery itself
  // never sets these (the Discovery → Ranking boundary stays explicit).
  /**
   * Engineering value (0–100) — the PRIMARY ranking dimension. Reflects the
   * *engineering decision*, not the locator: reuse of an existing abstraction
   * outranks generating a brand-new locator, even a perfect one. This is how a
   * senior automation engineer thinks.
   */
  engineeringValue?: number;
  /**
   * Locator quality (0–100) — the SECONDARY dimension, used only to break ties
   * between candidates of equal engineering value. A great locator does not
   * beat reuse; it only sorts amongst equals.
   */
  locatorQuality?: number;
  /**
   * Compatibility (0–100) — the THIRD dimension (added PR 2B.1). Answers "is
   * this reuse compatible with the CURRENT project?" A deprecated helper,
   * obsolete page object, wrong-framework module or archived/duplicate code
   * scores low, so it cannot win on engineering value alone. Generated locators
   * are always 100 (authored for the app as it exists now).
   */
  compatibility?: number;
  /**
   * Quality verdict for reuse candidates (added PR 2B.1). Existing code must
   * meet engineering standards to be reused — code full of `sleep(5000)` fails
   * and is out-ranked by a freshly generated implementation. Fails open when no
   * source snippet is available.
   */
  quality?: { ok: boolean; issues: string[] };
  /** 1-based position after ranking (1 = strongest). Present only once ranked. */
  rank?: number;
  /**
   * The EXTERNAL-facing summary (added PR 2B.1). Users see `reason` +
   * `confidence`; the raw numeric dimensions stay internal. Derived from
   * engineering value, compatibility and the quality gate.
   */
  confidence?: 'high' | 'medium' | 'low';
}

/** All candidates discovered for one business step. */
export interface StepCandidates {
  /** The original business-step text (verbatim). */
  step: string;
  /** Deterministic action intent derived from the step. */
  intent: StepIntent;
  /** Every plausible implementation, in no particular order (unranked). */
  candidates: ImplementationCandidate[];
}

/**
 * The read-only report attached to a generation result. Mirrors the shape of
 * the other transparency reports (`repositoryIntelligence`, `locatorGrounding`)
 * so the API/UI can surface it without special-casing.
 */
export interface CandidateDiscoveryReport {
  /** Per-step discovered candidates. */
  steps: StepCandidates[];
  /** Total candidates discovered across all steps. */
  totalCandidates: number;
  /** Count of steps for which at least one candidate was discovered. */
  stepsWithCandidates: number;
  /** Count of candidates that reuse existing repo code. */
  reuseCandidates: number;
  /**
   * False on raw discovery output; true after `rankReport()` has scored and
   * ordered the candidates (PR 2B). When true, each candidate carries
   * engineeringValue / locatorQuality / rank and each step's candidates are
   * sorted strongest-first.
   */
  ranked: boolean;
  /**
   * Invariant flag — ALWAYS false through PR 2B. Ranking orders candidates but
   * does NOT pick a winner or change generation; that is Selection (PR 2C).
   */
  selected: false;
}

/**
 * Optional metadata the repo scan may attach to a reusable asset. Fields are
 * best-effort: when absent, the Compatibility/Quality heuristics fall back to
 * name/path signals and fail open. Enables real "don't reuse stale code"
 * decisions without any new plumbing.
 */
export interface AssetMeta {
  /** Explicit deprecation flag. */
  deprecated?: boolean;
  /** Framework/module this asset belongs to. */
  framework?: string;
  /** Free-form tags (e.g. ['legacy'], ['archived']). */
  tags?: string[];
  /** Source snippet, scanned for quality anti-patterns. */
  source?: string;
}

/** Inputs discovery reads. All optional — discovery fails open to an empty report. */
export interface DiscoveryContext {
  /** Reusable page objects from the repo scan (name + methods). */
  pageObjects?: Array<{ name: string; methods?: string[]; path?: string } & AssetMeta>;
  /** Reusable helper modules (module name + exported functions). */
  helpers?: Array<{ name: string; functions?: string[]; path?: string } & AssetMeta>;
  /** Reusable fixtures the repo defines. */
  fixtures?: Array<{ name: string; path?: string } & AssetMeta>;
  /** Reusable components the repo defines. */
  components?: Array<{ name: string; path?: string } & AssetMeta>;
  /** The framework/module the current project uses (for mismatch detection). */
  projectFramework?: string;
}
