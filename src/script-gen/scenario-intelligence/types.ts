/**
 * Scenario Intelligence — shared contracts.
 *
 * Flow:  Test Case → ScenarioTransformer (self-matching) → Script Generation
 *
 * Each transformer is fully self-describing: it decides BOTH whether it applies
 * to a test case (`matches`) AND how that scenario is realised in the generated
 * script — the credential expressions it feeds into `login(...)`, the error
 * fragment it expects, and the coverage categories it contributes. There is no
 * central classifier to keep in sync: the registry simply asks each transformer,
 * in precedence order, whether it matches and uses the first that does. Adding a
 * new scenario type (SQL Injection, XSS, MFA, Session Timeout, …) is therefore a
 * single-file change — drop in a new transformer that owns its own detection —
 * with zero edits to the generator or any classifier.
 */

/** The built-in scenario kinds. Extend the union when adding a transformer. */
export type ScenarioKind =
  | 'empty'
  | 'whitespace'
  | 'special'
  | 'maxlength'
  | 'invalid'
  | 'normal';

/**
 * What a transformer's `matches` reports when it claims a case: the scenario
 * kind plus any parameters it mined while matching (so detection and parameter
 * extraction stay co-located in the transformer that owns them).
 */
export interface ScenarioClassification {
  kind: ScenarioKind;
  /** Explicit special-character value authored in a step, e.g. "@locked_user". */
  literal?: string;
  /** Boundary length for the max-length scenario. */
  length?: number;
}

/**
 * Generator-agnostic view of a test case, so a transformer's detection never
 * depends on the engine's internal `GenerationConfig` shape.
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
   * Detection precedence. Lower values = higher priority (checked first). The
   * registry sorts transformers by this property, so precedence is explicit and
   * self-documenting. The most specific, testable mutation should win.
   */
  readonly priority: number;
  /**
   * Self-describing detection. Given a generator-agnostic view of the case and
   * its parsed steps, return this scenario's {@link ScenarioClassification}
   * (including any parameters mined while matching, e.g. a special-char literal
   * or boundary length) when the case belongs to this transformer, or `null`
   * when it does not. The registry consults transformers in precedence order and
   * uses the first non-null result, so each transformer owns its own detection
   * logic and no central classifier is required.
   */
  matches(
    input: ScenarioCaseInput | undefined,
    steps: string[],
  ): ScenarioClassification | null;
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
