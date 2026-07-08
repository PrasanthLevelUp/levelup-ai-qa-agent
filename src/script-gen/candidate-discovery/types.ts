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
   * Invariant flag — ALWAYS false in this PR. Discovery never ranks. Present so
   * downstream code (and tests) can assert the boundary explicitly.
   */
  ranked: false;
  /**
   * Invariant flag — ALWAYS false in this PR. Discovery never selects a winner.
   */
  selected: false;
}

/** Inputs discovery reads. All optional — discovery fails open to an empty report. */
export interface DiscoveryContext {
  /** Reusable page objects from the repo scan (name + methods). */
  pageObjects?: Array<{ name: string; methods?: string[]; path?: string }>;
  /** Reusable helper modules (module name + exported functions). */
  helpers?: Array<{ name: string; functions?: string[]; path?: string }>;
  /** Reusable fixtures the repo defines. */
  fixtures?: Array<{ name: string; path?: string }>;
  /** Reusable components the repo defines. */
  components?: Array<{ name: string; path?: string }>;
}
