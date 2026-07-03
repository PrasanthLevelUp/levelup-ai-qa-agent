/**
 * Scenario Intelligence — shared contracts.
 *
 * Flow:  Test Case → ScenarioClassifier → ScenarioTransformer → Script Generation
 *
 * The classifier decides WHAT kind of scenario a test case exercises; a
 * transformer decides HOW that scenario is realised in the generated script
 * (the credential expressions it feeds into `login(...)`, the error fragment it
 * expects, and the coverage categories it contributes). Each scenario type is an
 * independent transformer, so new types (SQL Injection, XSS, MFA, Session
 * Timeout, …) can be added by dropping in a new transformer + one classifier
 * rule — without touching the generator.
 */

/** The built-in scenario kinds. Extend the union when adding a transformer. */
export type ScenarioKind =
  | 'empty'
  | 'whitespace'
  | 'special'
  | 'maxlength'
  | 'invalid'
  | 'normal';

/** Output of the classifier: the scenario kind plus any extracted parameters. */
export interface ScenarioClassification {
  kind: ScenarioKind;
  /** Explicit special-character value authored in a step, e.g. "@locked_user". */
  literal?: string;
  /** Boundary length for the max-length scenario. */
  length?: number;
}

/**
 * Generator-agnostic view of a test case, so the classifier never depends on the
 * engine's internal `GenerationConfig` shape.
 */
export interface ScenarioCaseInput {
  title?: string | null;
  scenario?: string | null;
  coverage_type?: string | null;
  expected_result?: string | null;
  test_data?: string | null;
  tags?: string[] | string | null;
}

/** A pair of ready-to-emit code expressions for `login(username, password)`. */
export interface CredentialPair {
  username: string;
  password: string;
}

/**
 * Everything a transformer needs to build data-faithful credential expressions
 * WITHOUT knowing how the engine resolves records. The engine supplies these as
 * closures/values; transformers stay pure code-expression builders (no I/O, no
 * engine state). This is what keeps each transformer independently testable.
 */
export interface CredentialResolver {
  /** Data-bound base username/password code expressions (record or env fallback). */
  base(): CredentialPair;
  /** A VALID counterpart for negative pairing (one field invalid, the other valid). */
  validCounterpart(): { username?: string; password?: string };
  /** Env-backed username expression (last-resort fallback). */
  envUsername(): string;
  /** Env-backed password expression (last-resort fallback). */
  envPassword(): string;
  /** Explicit, non-empty, non-record-key username literal authored in a step (code expr), else null. */
  authoredUsername: string | null;
  /** Explicit, non-empty, non-record-key password literal authored in a step (code expr), else null. */
  authoredPassword: string | null;
  /** True when the writer explicitly authored EMPTY values for BOTH fields. */
  authoredBothEmpty: boolean;
  /** Escape a raw string for embedding inside a single-quoted code literal. */
  escape(s: string): string;
}

/**
 * One scenario type = one transformer. Implementations are pure and stateless.
 */
export interface ScenarioTransformer {
  /** The kind this transformer handles (also its registry key). */
  readonly kind: ScenarioKind;
  /**
   * Coverage categories (Functional / Negative / Boundary / Validation / …) this
   * scenario contributes to the spec header. Empty means "contributes nothing"
   * (the generator's text heuristics decide).
   */
  readonly coverageCategories: readonly string[];
  /** Build the `login(...)` credential expressions for this scenario. */
  transformCredentials(
    classification: ScenarioClassification,
    resolver: CredentialResolver,
  ): CredentialPair;
  /**
   * Deterministic expected-error fragment for negative assertions:
   *   - a non-empty string → assert `toContainText(fragment)`
   *   - `''`               → assert the error surface only (ambiguous mutation,
   *                           no safe message to guess)
   *   - `null`             → the scenario dictates nothing; the generator should
   *                           derive the message from the Expected Result text
   */
  errorFragment(): string | null;
}
