/**
 * Provider Migration State
 * ============================================================================
 *
 * A single source of truth for **where each intelligence source is in its
 * legacy → provider migration**. This replaces the sprawl of per-source boolean
 * flags (`REPOSITORY_PROVIDER`, `REPOSITORY_DUAL_PATH`, …) with an explicit
 * three-phase lifecycle, and it drives BOTH:
 *
 *   1. Runtime behavior — the orchestrator asks `resolveMode('repository')` and
 *      chooses legacy-only, shadow-compare, or provider-as-production.
 *   2. Architecture discipline — the architecture-contract test reads this
 *      registry to enforce the *current* migration phase (e.g. "at most one
 *      source may be mid-migration at a time") instead of a hardcoded, soon-to-
 *      rot "no new providers" rule.
 *
 * ── The lifecycle (per source) ───────────────────────────────────────────────
 *
 *   Legacy   → only the legacy inline implementation runs. Provider dormant.
 *   Shadow   → legacy is production; the provider runs in PARALLEL, outputs are
 *              compared for semantic equivalence, and metrics are persisted.
 *              Provider has ZERO production impact.
 *   Provider → the provider is the production path. (During a rollback window
 *              legacy may still be shadowed in reverse.) Legacy is deleted once
 *              confidence is high and `legacyPresent` flips to false.
 *
 * The migration loop we follow for every source:
 *   Provider → Register → Shadow → Metrics → 99.9% → Provider → Delete Legacy →
 *   Merge → Next source.
 *
 * ── Why a registry (not scattered enums) ─────────────────────────────────────
 * When we migrate Knowledge, Similarity, Patterns, App Profile, and DOM, each
 * simply gets one entry here declaring its phase. The orchestrator and the
 * discipline test need no edits — they iterate this registry. Enterprise-grade,
 * and impossible to "half migrate" silently.
 */

/**
 * The three explicit phases of a source's migration. Cleaner than juggling
 * `PROVIDER=true` + `DUAL_PATH=true` combinations, and it scales to every
 * future intelligence source.
 */
export enum MigrationMode {
  /** Legacy inline implementation only; provider dormant. */
  Legacy = 'legacy',
  /** Legacy is production; provider runs in parallel and is compared + measured. */
  Shadow = 'shadow',
  /** Provider is the production path (legacy may be shadowed for rollback). */
  Provider = 'provider',
}

/** All valid mode strings, for validation of env overrides. */
const VALID_MODES = new Set<string>([
  MigrationMode.Legacy,
  MigrationMode.Shadow,
  MigrationMode.Provider,
]);

/**
 * Declares one source's migration. `mode` is the DEFAULT phase baked into the
 * code; an env override (`envVar`) can move a source forward/back at runtime
 * without a deploy. `legacyPresent` records whether the legacy inline code
 * still exists — it flips to false only in the PR that deletes legacy.
 */
export interface ProviderMigration {
  /** Registry key (matches OrchestratorSource / provider intent domain). */
  key: string;
  /** The `*-provider.ts` module basename (used by the architecture test). */
  module: string;
  /** The provider's registered `name` (matches IntelligenceProvider.name). */
  providerName: string;
  /** Default migration phase when no env override is set. */
  mode: MigrationMode;
  /** Env var that overrides the phase at runtime (values: legacy|shadow|provider). */
  envVar: string;
  /** Whether a legacy inline path still exists for this source. */
  legacyPresent: boolean;
}

/**
 * THE registry. Every intelligence source that has (or is getting) a provider
 * appears here exactly once. Adding a source = adding one entry (a deliberate,
 * reviewable act that declares its migration phase).
 *
 * Current state:
 *   • repository   — mid-migration in SHADOW. Legacy still present. This is the
 *                    ONE source actively migrating right now.
 *   • scenarioGraph — additive/advisory provider with NO legacy inline path
 *                     (it was born as a provider). Not a legacy→provider
 *                     migration, so it never counts as "mid-migration".
 */
export const MIGRATION_REGISTRY: Record<string, ProviderMigration> = {
  repository: {
    key: 'repository',
    module: 'repository-provider',
    providerName: 'repository',
    mode: MigrationMode.Shadow,
    envVar: 'REPOSITORY_MIGRATION_MODE',
    legacyPresent: true,
  },
  scenarioGraph: {
    key: 'scenarioGraph',
    module: 'scenario-graph-provider',
    providerName: 'scenarioGraph',
    // Advisory source that never had a legacy inline path. It is dormant by
    // default (historically SCENARIO_GRAPH_PROVIDER=false) and is switched ON
    // via its flag / mode env — so its baked-in default is Legacy (dormant),
    // NOT Provider. Because legacyPresent=false it never counts as a
    // legacy→provider migration (sourcesMidMigration always excludes it).
    mode: MigrationMode.Legacy,
    envVar: 'SCENARIO_GRAPH_MIGRATION_MODE',
    legacyPresent: false,
  },
};

/**
 * Resolve the effective migration mode for a source at runtime.
 *
 * Precedence:
 *   1. The source's dedicated env var (`REPOSITORY_MIGRATION_MODE=shadow`).
 *   2. **Backward-compat** for repository's original boolean flags:
 *        REPOSITORY_PROVIDER=true   → Provider
 *        REPOSITORY_DUAL_PATH=true  → Shadow
 *      (so existing deployments keep working unchanged).
 *   3. **Backward-compat** for scenarioGraph's original flag:
 *        SCENARIO_GRAPH_PROVIDER=true → Provider, else Legacy.
 *   4. The declared default `mode` in the registry.
 */
export function resolveMode(key: string): MigrationMode {
  const decl = MIGRATION_REGISTRY[key];
  if (!decl) return MigrationMode.Legacy;

  // 1. Explicit mode env var wins.
  const raw = process.env[decl.envVar]?.toLowerCase().trim();
  if (raw && VALID_MODES.has(raw)) return raw as MigrationMode;

  // 2/3. Backward-compat with the pre-migration-state boolean flags. These
  // ONLY override when the old flag is explicitly set — otherwise we fall
  // through to the declared default so a source's baked-in phase is honored.
  if (key === 'repository') {
    if (process.env.REPOSITORY_PROVIDER === 'true') return MigrationMode.Provider;
    if (process.env.REPOSITORY_DUAL_PATH === 'true') return MigrationMode.Shadow;
  } else if (key === 'scenarioGraph') {
    if (process.env.SCENARIO_GRAPH_PROVIDER === 'true') return MigrationMode.Provider;
  }

  // 4. Declared default.
  return decl.mode;
}

/** True when the source's provider should be consulted as the PRODUCTION path. */
export function isProviderProduction(key: string): boolean {
  return resolveMode(key) === MigrationMode.Provider;
}

/**
 * True when the provider should run in SHADOW alongside legacy (compare +
 * measure). Both Shadow and Provider modes shadow-compare: in Provider mode we
 * keep comparing against the still-present legacy as a rollback safety net.
 */
export function isShadowActive(key: string): boolean {
  const mode = resolveMode(key);
  const decl = MIGRATION_REGISTRY[key];
  if (mode === MigrationMode.Shadow) return true;
  // In Provider mode, only keep shadowing while a legacy path still exists.
  if (mode === MigrationMode.Provider && decl?.legacyPresent) return true;
  return false;
}

/**
 * Sources that are actively mid-migration: declared `Shadow` AND still have a
 * legacy path. Used by the architecture-contract test to enforce "one migration
 * at a time" — the discipline that keeps regression risk low.
 */
export function sourcesMidMigration(): ProviderMigration[] {
  return Object.values(MIGRATION_REGISTRY).filter(
    m => m.mode === MigrationMode.Shadow && m.legacyPresent,
  );
}
