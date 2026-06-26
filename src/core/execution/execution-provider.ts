/**
 * Execution Provider — the abstraction that makes the *source* of a test
 * execution an implementation detail.
 *
 * ── The architecture this enables ──────────────────────────────────────────
 *
 *                      ExecutionProvider
 *          ┌────────────────┼──────────────────┐
 *          │                │                  │
 *     LocalProvider   GitHubActions       Future providers
 *                      Provider           (Jenkins, GitLab, …)
 *          │                │
 *          └───────┬────────┘
 *                  ▼
 *           ExecutionOutcome   ← test-results.json on disk + local repo + exitCode
 *                  ▼
 *            ExecutionRecord
 *                  ▼
 *       Diagnosis · Healing · Learning
 *                  ▼
 *           Validation Engine   ← provider.validate()  (Hybrid: local for speed)
 *                  ▼
 *              Pull Request
 *
 * EVERYTHING below `ExecutionOutcome` is identical regardless of where the test
 * physically ran. The healing worker consumes exactly two things from a run —
 * the Playwright `resultsFile` (test-results.json) and a local `repoPath` (for
 * code context + fast validation reruns). That pair IS the provider boundary:
 * a provider's only job is to *materialize* that pair, however it sources it.
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

/** Where a test execution physically ran. Open-ended for future providers. */
export type ExecutionSource = 'local' | 'github_actions' | 'jenkins' | 'gitlab_ci' | 'azure_devops';

/**
 * Provider-native references to the remote execution, when applicable. Lets the
 * dashboard deep-link to the CI run and lets debugging trace where bytes came
 * from. Absent/empty for the Local provider.
 */
export interface ExecutionProviderRef {
  /** CI run id (e.g. GitHub Actions workflow-run id). */
  runId?: number | string;
  /** Human-facing URL of the run (e.g. the Actions run page). */
  runUrl?: string;
  /** Local directory the provider downloaded/extracted remote artifacts into. */
  artifactDir?: string;
  /** Conclusion as reported by the provider (e.g. success | failure | cancelled). */
  conclusion?: string | null;
}

/**
 * The canonical, source-agnostic outcome of running the test suite ONCE. This is
 * the contract every provider must satisfy — the single hand-off point into the
 * existing healing pipeline (`ArtifactCollector.collect(resultsFile, repoPath)`).
 */
export interface ExecutionOutcome {
  /** Absolute path to the Playwright `test-results.json` on the local disk. */
  resultsFile: string;
  /**
   * Absolute path to a LOCAL clone of the repo under test. Required even for
   * remote providers because diagnosis reads source (`failed_line_code`,
   * surrounding code, Page Object resolution) and Hybrid validation reruns here.
   */
  repoPath: string;
  /** Process exit semantics for the run: 0 ⇒ all tests passed. */
  exitCode: number;
  /** Where the execution physically ran. */
  source: ExecutionSource;
  /** ISO start/end + duration of the underlying run, best-effort. */
  startTime?: string;
  endTime?: string;
  durationMs?: number;
  /** Provider-native references (CI run id/url, artifact dir). */
  ref?: ExecutionProviderRef;
  /**
   * Optional captured stdout/stderr (local runs populate these; remote providers
   * may leave them blank — the authoritative signal is `resultsFile`).
   */
  stdout?: string;
  stderr?: string;
}

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
 * The provider contract. `execute()` is the high-level orchestration; the other
 * three are the composable steps it is built from (and that tests can exercise
 * in isolation). Remote providers implement all four; the Local provider
 * implements `execute`/`validate` and treats download/collect as no-ops because
 * its results are already on disk.
 */
export interface ExecutionProvider {
  /** Stable identifier for this provider's execution source. */
  readonly source: ExecutionSource;

  /**
   * Run the suite (or scoped `testFile`) ONCE and materialize a local workspace
   * the healing pipeline can consume. MUST return an {@link ExecutionOutcome}
   * whose `resultsFile` + `repoPath` are present on the local disk.
   */
  execute(ctx: ExecutionContext): Promise<ExecutionOutcome>;

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
  downloadArtifacts(ref: ExecutionProviderRef, destDir: string, ctx: ExecutionContext): Promise<string | null>;

  /**
   * Locate the Playwright `test-results.json` produced by the run. For the Local
   * provider this is just the path the runner wrote. For remote providers it is
   * resolved from the downloaded/extracted artifact directory.
   */
  collectResults(outcomeDir: string): Promise<string | null>;
}
