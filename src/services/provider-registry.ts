/**
 * Intelligence Provider Registry
 * ============================================================================
 *
 * A lightweight registry that lets the Orchestrator become **data-driven**
 * instead of **code-driven**. Rather than:
 *
 *   if (repository) …
 *   if (dom) …
 *   if (scenarioGraph) …
 *
 * the Orchestrator will (in a later PR) simply do:
 *
 *   const bundle = await registry.gatherAll(query);
 *
 * New sources — Repository, App Profile, Knowledge, and one day external
 * plugins (Jira, Azure DevOps, SAP, Salesforce) — become "register once", with
 * NO orchestrator edits.
 *
 * ── Scope discipline (Phase 2 review) ────────────────────────────────────────
 * This PR introduces the registry and registers ONLY `ScenarioGraphProvider`.
 * The Orchestrator is NOT yet rewired to consume it (that's a separate PR), and
 * no other providers are migrated. This keeps regression risk minimal: existing
 * intelligence flows are untouched; the registry is additive infrastructure.
 *
 * Responsibilities:
 *   • register()   — add a provider (dupe-safe).
 *   • get()/list() — retrieve providers, ordered by priority (lower first).
 *   • gatherAll()  — run enabled providers in priority order, fail-open, and
 *                    attach centrally-computed confidence to each result.
 */

import { logger } from '../utils/logger';
import {
  type IntelligenceProvider,
  type IntelligenceQuery,
  type IntelligenceResult,
  unavailableResult,
} from './intelligence-provider';
import { scoreResult } from './intelligence-confidence';

const MOD = 'ProviderRegistry';

export class ProviderRegistry {
  private readonly providers = new Map<string, IntelligenceProvider>();

  /**
   * Register a provider. Throws on duplicate names to catch wiring mistakes
   * early (two providers claiming the same source is always a bug).
   */
  register(provider: IntelligenceProvider): this {
    if (this.providers.has(provider.name)) {
      throw new Error(`ProviderRegistry: duplicate provider name "${provider.name}"`);
    }
    this.providers.set(provider.name, provider);
    logger.info(MOD, 'Registered intelligence provider', {
      name: provider.name,
      priority: provider.priority,
    });
    return this;
  }

  /** Remove a provider (mainly for tests / hot-swapping). */
  unregister(name: string): boolean {
    return this.providers.delete(name);
  }

  /** Whether a provider with this name is registered. */
  has(name: string): boolean {
    return this.providers.has(name);
  }

  /** Get a single provider by name. */
  get(name: string): IntelligenceProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * All registered providers, ordered by ascending `priority` (lower first).
   * Ties break by name for deterministic ordering.
   */
  list(): IntelligenceProvider[] {
    return [...this.providers.values()].sort(
      (a, b) => a.priority - b.priority || a.name.localeCompare(b.name),
    );
  }

  /** Only the providers whose `enabled()` returns true, in priority order. */
  listEnabled(): IntelligenceProvider[] {
    return this.list().filter(p => {
      try {
        return p.enabled();
      } catch {
        return false; // fail-open: a broken enabled() must not crash gathering
      }
    });
  }

  /** Number of registered providers. */
  get size(): number {
    return this.providers.size;
  }

  /**
   * Gather intelligence from every ENABLED provider, in priority order.
   *
   * Guarantees:
   *   • Fail-open — a throwing/rejecting provider yields an `available: false`
   *     result with a warning; it never breaks the batch.
   *   • Centralized confidence — each result's `confidence` is filled by the
   *     scorer here, never by the provider.
   *
   * Returns a Map keyed by provider name for easy lookup by consumers.
   */
  async gatherAll(query: IntelligenceQuery): Promise<Map<string, IntelligenceResult>> {
    const results = new Map<string, IntelligenceResult>();

    for (const provider of this.listEnabled()) {
      const startMs = Date.now();
      let result: IntelligenceResult;
      try {
        result = await provider.gather(query);
      } catch (err: any) {
        // Defense-in-depth: providers should already fail-open, but never let a
        // rogue provider abort the whole gather.
        logger.warn(MOD, 'Provider threw during gather (fail-open)', {
          name: provider.name,
          error: err?.message,
        });
        result = unavailableResult(
          provider.name,
          provider.version,
          `Provider error: ${err?.message || 'unknown'}`,
          Date.now() - startMs,
        );
      }
      results.set(provider.name, scoreResult(result));
    }

    return results;
  }
}

/* ================================================================== */
/*  Singleton                                                          */
/* ================================================================== */

let registryInstance: ProviderRegistry | undefined;

/**
 * The process-wide registry. Providers register themselves against this on
 * first access (see `registerDefaultProviders`).
 */
export function getProviderRegistry(): ProviderRegistry {
  if (!registryInstance) {
    registryInstance = new ProviderRegistry();
    registerDefaultProviders(registryInstance);
  }
  return registryInstance;
}

/**
 * Wire up the built-in providers. Kept intentionally tiny: this PR registers
 * ONLY the Scenario Graph provider. Future PRs add Repository, App Profile,
 * Knowledge, DOM Memory, etc. — one provider per PR to bound regression risk.
 */
function registerDefaultProviders(registry: ProviderRegistry): void {
  // Lazy import avoids a static import cycle (provider → registry → provider).
  const { getScenarioGraphProvider } = require('./scenario-graph-provider');
  registry.register(getScenarioGraphProvider());
}

/** Test-only: reset the singleton so each test starts from a clean registry. */
export function __resetProviderRegistryForTests(): void {
  registryInstance = undefined;
}
