/**
 * Execution Provider — the abstraction that makes the *source* of a test
 * execution an implementation detail, and OWNS the entire execution lifecycle.
 *
 * ── The inverted architecture this enables ─────────────────────────────────
 *
 *                      ExecutionProvider
 *          ┌────────────────┼──────────────────┐
 *          │                │                  │
 *     LocalProvider   GitHubActions       Future providers
 *                      Provider           (Jenkins, GitLab, …)
 *          │                │
 *          │  clone → execute → download artifacts → parse artifacts
 *          │  → build ExecutionRecords → assemble ExecutionResult
 *          └───────┬────────┘
 *                  ▼
 *            ExecutionResult   ← records + artifacts + repoPath + exitCode
 *                  │             + resultsFile + metadata + providerInfo
 *                  ▼
 *          Healing pipeline  →  Diagnosis · Healing · Validation · Learning
 *                  ▼
 *              Pull Request
 *
 * EVERYTHING below `ExecutionResult` is identical regardless of where the test
 * physically ran. The provider does ALL the work of producing a run: it clones,
 * executes (locally or via CI), downloads + parses artifacts, builds the
 * finalized pass/skip ExecutionRecords, and returns one canonical
 * {@link ExecutionResult}. The healing worker becomes provider-independent — it
 * consumes an ExecutionResult and never learns where execution came from.
 *
 * ── Hybrid validation (deliberate) ─────────────────────────────────────────
 * `execute()` may run remotely (e.g. GitHub Actions) so DIAGNOSIS is grounded in
 * the real CI failure. `validate()` re-runs a single healed test and, for speed,
 * defaults to the Local Runner — a locator fix validates in seconds, not a 2–5
 * minute CI round-trip. Because validation lives *on the provider*, a provider
 * can later override it to validate remotely with ZERO change to the healing
 * pipeline. The pipeline never learns where execution came from.
 */
import type { ExecutionProfile } from './execution-profile';
import type { RunResult } from '../execution-engine';
import type { ExecutionResult, ProviderInfo } from './execution-result';

/** Where a test execution physically ran. Open-ended for future providers. */
export type ExecutionSource = 'local' | 'github_actions' | 'jenkins' | 'gitlab_ci' | 'azure_devops';

/** Everything a provider needs to run the suite once and materialize a workspace. */
export interface ExecutionContext {
  /** Clone URL of the repo under test. */
  repoUrl: string;
  /** Branch / ref to run against. */
  branch: string;
  /** Local path the provider should clone into / find the repo at. */
  repoPath: string;
  /** Optional single spec file to scope the run to (blank ⇒ whole suite). */
  testFile?: string;
  /** Capture profile (fast | standard | healing | debug). */
  profile: ExecutionProfile;
  /** Whether to force trace/video capture for healing. */
  collectHealingArtifacts: boolean;
  /** Wall-clock budget (ms) for this execution. */
  budgetMs: number;
  /**
   * Owning job id — used to mint deterministic synthetic execution ids for the
   * finalized pass/skip records the provider builds (so reruns upsert in place).
   */
  jobId?: string | number;
  /** Tenant identity — used by remote providers to resolve stored credentials. */
  companyId?: number;
  userId?: number;
  /**
   * Provider-specific configuration. For GitHub Actions: `{ workflowId, ref }`.
   * Kept as an open bag so the core seam never grows provider-specific fields.
   */
  providerConfig?: Record<string, unknown>;
}

/** Everything a provider needs to re-run a single (healed) test for validation. */
export interface ValidationContext {
  /** Local repo path the healed code lives in. */
  repoPath: string;
  /** Spec file to re-run (relative to the repo's tests dir, as the worker passes today). */
  testFile?: string;
  /** Optional grep filter to scope to a single test title. */
  grepFilter?: string;
  /** Capture profile for the rerun. */
  profile: ExecutionProfile;
  /** Wall-clock budget (ms) for this rerun. */
  budgetMs: number;
  /** Whether to force healing artifacts on the rerun. */
  collectHealingArtifacts?: boolean;
  /** Whether this rerun is itself a healing attempt (affects artifact flags). */
  isHealingRun?: boolean;
}

/**
 * The provider contract. `execute()` owns the WHOLE execution lifecycle and
 * returns a canonical {@link ExecutionResult}. `validate()` reruns one healed
 * test (Hybrid: locally for speed). The remaining two are the composable steps a
 * remote provider's `execute()` is built from (and that tests can exercise in
 * isolation); the Local provider treats them as no-ops because its results are
 * already on disk.
 */
export interface ExecutionProvider {
  /** Stable identifier for this provider's execution source. */
  readonly source: ExecutionSource;

  /**
   * Run the suite (or scoped `testFile`) ONCE and return a complete
   * {@link ExecutionResult}: the provider clones, executes, downloads + parses
   * artifacts, builds the finalized pass/skip records, and packs the container.
   * Throws {@link ExecutionSetupError} for setup-level failures (clone/install/
   * dispatch) so the worker can surface an actionable message without knowing the
   * provider.
   */
  execute(ctx: ExecutionContext): Promise<ExecutionResult>;

  /**
   * Re-run a single test to confirm a fix held up. Hybrid default: run locally
   * for speed. Returns the same {@link RunResult} the worker already understands,
   * so the validation loop is unchanged regardless of provider.
   */
  validate(ctx: ValidationContext): Promise<RunResult>;

  /**
   * Provider-native artifact download: fetch the run's artifacts into `destDir`
   * and return the directory the bytes were extracted to (or null if none).
   * No-op for the Local provider (its artifacts are already on disk).
   */
  downloadArtifacts(info: ProviderInfo, destDir: string, ctx: ExecutionContext): Promise<string | null>;

  /**
   * Locate the Playwright `test-results.json` produced by the run. For the Local
   * provider this is just the path the runner wrote. For remote providers it is
   * resolved from the downloaded/extracted artifact directory.
   */
  collectResults(outcomeDir: string): Promise<string | null>;
}

// Re-export the canonical result types so consumers can import the whole provider
// contract (context + result) from one module.
export type {
  ExecutionResult,
  ProviderInfo,
  ExecutionRunMetadata,
  ExecutionSetupStage,
} from './execution-result';
export { ExecutionSetupError } from './execution-result';
