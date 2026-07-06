/**
 * Repository Intelligence Provider
 * ============================================================================
 *
 * Provides **RepositoryContext** (NOT raw DB rows or graph internals) to the
 * Orchestrator. This is the foundational intelligence source: reusable page
 * objects, helpers, assertions, wait utilities—everything Script Gen/Healing/
 * AI Review need to generate repository-aware, high-grounding code.
 *
 * Consumers never see method IDs or DB schema; they receive a domain-friendly
 * view: primary methods, supporting methods (categorized), related flows, and
 * optionally healing-specific evidence (method hits + RAG snippets).
 *
 * This provider is the ONLY module that directly queries the knowledge graph
 * and method index. All other modules consume RepositoryContext from the
 * unified Intelligence Bundle. This isolation means we can redesign the graph
 * schema or method index without breaking consumers.
 *
 * ── Priority: 10 (foundational source—runs early) ───────────────────────────
 * Repository intelligence is needed by almost every downstream source (App
 * Profile reasoning, Scenario Graph grounding checks, Pattern validation), so
 * it should complete before derived sources run.
 *
 * ── Quality Signals (Phase 2 review) ─────────────────────────────────────────
 * This provider does NOT compute confidence. It emits standardized, normalized
 * quality `signals`:
 *   • grounding  — fraction of requested categories covered by real methods
 *                  (primary + assertions + waits + data access + utilities).
 *   • coverage   — breadth of method types present (page objects, helpers, etc.).
 *   • freshness  — how recently the repository context was analyzed (optional).
 *
 * The centralized scorer combines them generically into a number. The provider
 * owns the domain facts; the orchestrator owns quality → confidence.
 *
 * Discipline:
 *   • Fail-open: errors return `available: false`, never throw.
 *   • Feature-flagged: `REPOSITORY_PROVIDER` (default false) via `enabled()`.
 *   • Dual-path migration: orchestrator will call BOTH legacy and provider,
 *     compare outputs, then delete legacy once proven identical.
 */

import { logger } from '../utils/logger';
import {
  type IntelligenceProvider,
  type IntelligenceQuery,
  type IntelligenceResult,
  type QualitySignals,
} from './intelligence-provider';
import { knowledgeGraphService, type ReusableMethod } from './knowledge-graph-service';
import { MethodIntelligenceService } from './method-intelligence-service';
import { getRAGService, type RagExample } from './rag-service';
import type { MethodSearchHit } from '../db/postgres';

const MOD = 'RepositoryProvider';

/** Provider revision — bump when behavior or emitted signals change. */
const REPOSITORY_VERSION = 1;

/**
 * Priority for the Repository source. **Low** (10) because it's a foundational
 * source that other providers may depend on (e.g., Scenario Graph checks
 * grounding against repository, App Profile cross-references page objects).
 */
const REPOSITORY_PRIORITY = 10;

/**
 * Default intent query options when fetching reuse candidates from the
 * knowledge graph. Conservative depth/limit to avoid bloating the context.
 */
const DEFAULT_INTENT_QUERY_OPTS = { limit: 5, depth: 2 };

/* ================================================================== */
/*  Repository Context — the public interface consumers receive        */
/* ================================================================== */

/**
 * A single reusable method (page object method, helper, assertion, etc.).
 * Simplified from the internal DB schema.
 */
export interface RepositoryMethod {
  id: number;
  name: string;
  filePath: string;
  methodType: string;
  sourceCode: string;
  description: string;
  usageCount: number;
}

/**
 * Supporting methods, categorized by role. Consumers care about *what kind*
 * of helper is available, not raw DB rows.
 */
export interface SupportingMethods {
  assertions: RepositoryMethod[];
  waits: RepositoryMethod[];
  dataAccess: RepositoryMethod[];
  utilities: RepositoryMethod[];
}

/**
 * Healing-specific evidence: method-index hits + RAG snippets for a broken
 * locator / failed line. Only populated when `caller='healing'` and the
 * repository source is requested. Script Gen / Test Case Lab don't need this.
 */
export interface HealingEvidence {
  methodHits: MethodSearchHit[];
  ragExamples: RagExample[];
  /** Corroboration signals for confidence scoring (repository-aware boosting). */
  signals: {
    methodIndexHit: boolean;
    pageObjectHit: boolean;
    usedByTestCount: number;
    ragHit: boolean;
    topMethodSimilarity: number;
  };
}

/**
 * Repository Context — the domain-friendly view the Orchestrator provides.
 * Consumers never see method IDs, DB cursors, or graph internals.
 *
 * This is the single source of truth for "what reusable code exists in this
 * repository for a given intent".
 */
export interface RepositoryContext {
  available: boolean;
  intent: string;
  /** Primary methods — page objects / main helpers matching the intent. */
  primaryMethods: RepositoryMethod[];
  /** Supporting methods — assertions, waits, data access, utilities. */
  supportingMethods: SupportingMethods;
  /** Related business flows (from profile, future enhancement). */
  relatedFlows: string[];
  /**
   * Healing-specific evidence (method hits + RAG snippets + corroboration
   * signals). Only present when `caller='healing'`.
   */
  healingEvidence?: HealingEvidence;
}

/* ================================================================== */
/*  Provider Implementation                                            */
/* ================================================================== */

/**
 * RepositoryProvider — gathers repository intelligence for a given intent
 * and returns it as RepositoryContext.
 */
export class RepositoryProvider implements IntelligenceProvider<RepositoryContext> {
  readonly name = 'repository';
  readonly version = REPOSITORY_VERSION;
  readonly priority = REPOSITORY_PRIORITY;

  /** Feature flag — default false for safe rollout during migration. */
  enabled(): boolean {
    return process.env.REPOSITORY_PROVIDER === 'true';
  }

  async gather(query: IntelligenceQuery): Promise<IntelligenceResult<RepositoryContext>> {
    // Guard: feature flag off → unavailable immediately.
    if (!this.enabled()) {
      return this.unavailable('Feature flag REPOSITORY_PROVIDER is off', 0);
    }
    return this.doGather(query);
  }

  /**
   * Run the provider's real gathering logic, **bypassing the `enabled()` gate**.
   *
   * This exists solely for the **dual-path migration validator**: the
   * orchestrator runs the provider in shadow (comparing its output against the
   * legacy inline path) BEFORE `REPOSITORY_PROVIDER` is switched on for
   * production consumption. Without this, shadow comparison would always see an
   * `available: false` provider result and report false mismatches.
   *
   * Consumers must NEVER call this — they read the unified bundle. Only the
   * orchestrator's dual-path shadow uses it, and only for comparison/logging.
   */
  async gatherForDualPath(
    query: IntelligenceQuery,
  ): Promise<IntelligenceResult<RepositoryContext>> {
    return this.doGather(query);
  }

  /** Core gathering logic shared by `gather()` (gated) and `gatherForDualPath()`. */
  private async doGather(
    query: IntelligenceQuery,
  ): Promise<IntelligenceResult<RepositoryContext>> {
    const startMs = Date.now();

    // Guard: no repoContextId → can't query the knowledge graph
    if (!query.repoContextId) {
      return this.unavailable(
        'No repoContextId provided — Repository intelligence unavailable',
        Date.now() - startMs,
      );
    }

    try {
      // Query the knowledge graph for intent-based reuse candidates
      const reuseCandidates = await knowledgeGraphService.getReuseCandidatesForIntent(
        query.repoContextId,
        query.intent,
        DEFAULT_INTENT_QUERY_OPTS,
      );

      // Healing-specific evidence: method-index + RAG hits for broken locators.
      // Only gathered when caller='healing', to avoid needless retrieval for
      // Script Gen / Test Case Lab / AI Review.
      let healingEvidence: HealingEvidence | undefined;
      if (query.caller === 'healing') {
        const [methodHits, ragExamples] = await Promise.all([
          this.loadMethodHitsForHealing(query.repoContextId, query.intent),
          this.loadRagExamplesForHealing(query.repoContextId, query.intent),
        ]);
        if (methodHits.length > 0 || ragExamples.length > 0) {
          healingEvidence = {
            methodHits,
            ragExamples,
            signals: this.deriveHealingSignals(methodHits, ragExamples),
          };
        }
      }

      // Project the internal graph result into the public RepositoryContext
      const context = this.projectToContext(reuseCandidates, healingEvidence);

      if (!context.available || context.primaryMethods.length === 0) {
        return this.unavailable(
          'Repository graph returned no candidates for this intent',
          Date.now() - startMs,
        );
      }

      logger.info(MOD, 'Repository intelligence gathered', {
        intent: query.intent,
        repoContextId: query.repoContextId,
        primaryCount: context.primaryMethods.length,
        supportingCount:
          context.supportingMethods.assertions.length +
          context.supportingMethods.waits.length +
          context.supportingMethods.dataAccess.length +
          context.supportingMethods.utilities.length,
      });

      return {
        available: true,
        context,
        metadata: {
          provider: this.name,
          providerVersion: this.version,
          durationMs: Date.now() - startMs,
          cacheHit: false, // Graph queries are live (no caching yet)
          items: context.primaryMethods.length,
          warnings: [],
          signals: this.qualitySignals(context),
          version: {
            id: query.repoContextId,
          },
        },
      };
    } catch (err: any) {
      logger.warn(MOD, 'Repository gather failed (fail-open)', { error: err?.message });
      return this.unavailable(
        `Repository provider error: ${err?.message || 'unknown'}`,
        Date.now() - startMs,
      );
    }
  }

  /** Build a standardized unavailable result with consistent, empty signals. */
  private unavailable(warning: string, durationMs: number): IntelligenceResult<RepositoryContext> {
    return {
      available: false,
      context: null,
      metadata: {
        provider: this.name,
        providerVersion: this.version,
        durationMs,
        cacheHit: false,
        items: 0,
        warnings: [warning],
        signals: {},
      },
    };
  }

  /**
   * Derive standardized, NORMALIZED quality signals (0-1) from the repository
   * context. The centralized scorer turns these into a confidence number — this
   * provider never scores itself.
   *
   *   • grounding — fraction of requested categories (primary, assertions, waits,
   *                 data access, utilities) that returned at least one method.
   *   • coverage  — breadth of method types present (distinct types / total types).
   */
  private qualitySignals(context: RepositoryContext): QualitySignals {
    const categories = [
      context.primaryMethods.length > 0,
      context.supportingMethods.assertions.length > 0,
      context.supportingMethods.waits.length > 0,
      context.supportingMethods.dataAccess.length > 0,
      context.supportingMethods.utilities.length > 0,
    ];
    const coveredCategories = categories.filter(Boolean).length;
    const grounding = coveredCategories / categories.length;

    // Coverage: distinct method types present
    const allMethods = [
      ...context.primaryMethods,
      ...context.supportingMethods.assertions,
      ...context.supportingMethods.waits,
      ...context.supportingMethods.dataAccess,
      ...context.supportingMethods.utilities,
    ];
    const distinctTypes = new Set(allMethods.map(m => m.methodType)).size;
    const coverage = allMethods.length > 0 ? Math.min(1, distinctTypes / 5) : 0; // 5 expected types

    return { grounding, coverage };
  }

  /**
   * Project the internal knowledge graph result into the public RepositoryContext.
   * This is the isolation layer: consumers never see DB schema or graph internals.
   */
  private projectToContext(
    reuseCandidates: {
      available: boolean;
      intent: string;
      primaryMethods: ReusableMethod[];
      supportingMethods: {
        assertions: ReusableMethod[];
        waits: ReusableMethod[];
        dataAccess: ReusableMethod[];
        utilities: ReusableMethod[];
      };
      relatedFlows: string[];
    },
    healingEvidence?: HealingEvidence,
  ): RepositoryContext {
    return {
      available: reuseCandidates.available,
      intent: reuseCandidates.intent,
      primaryMethods: reuseCandidates.primaryMethods,
      supportingMethods: reuseCandidates.supportingMethods,
      relatedFlows: reuseCandidates.relatedFlows,
      healingEvidence,
    };
  }

  /**
   * Load method-index hits for healing (existing page-object / helper methods
   * that match the broken locator / failed line).
   */
  private async loadMethodHitsForHealing(
    repoContextId: number,
    intent: string,
  ): Promise<MethodSearchHit[]> {
    try {
      const methodService = new MethodIntelligenceService();
      const hits = await methodService.search(repoContextId, intent, { limit: 4 });
      return hits || [];
    } catch (err: any) {
      logger.warn(MOD, 'Method hits for healing failed', { error: err?.message });
      return [];
    }
  }

  /**
   * Load RAG examples for healing (semantic snippets of existing code that
   * used similar locators / patterns).
   */
  private async loadRagExamplesForHealing(
    repoContextId: number,
    intent: string,
  ): Promise<RagExample[]> {
    try {
      const ragService = getRAGService();
      const examples = await ragService.retrieve(repoContextId, intent, { limit: 3 });
      return examples || [];
    } catch (err: any) {
      logger.warn(MOD, 'RAG examples for healing failed', { error: err?.message });
      return [];
    }
  }

  /**
   * Derive healing-specific corroboration signals from method hits + RAG
   * examples. These are NOT quality signals for the centralized scorer — they're
   * healing-specific metadata that the Healing orchestrator uses for
   * repository-aware confidence boosting.
   */
  private deriveHealingSignals(
    methodHits: MethodSearchHit[],
    ragExamples: RagExample[],
  ): HealingEvidence['signals'] {
    const methodIndexHit = methodHits.length > 0;
    const pageObjectHit = methodHits.some(
      m => m.methodType === 'page_object' || m.className != null,
    );
    const usedByTestCount = methodHits.reduce((sum, m) => sum + (m.usageCount || 0), 0);
    const ragHit = ragExamples.length > 0;
    const topMethodSimilarity = methodHits.length > 0 ? methodHits[0].similarity || 0 : 0;

    return {
      methodIndexHit,
      pageObjectHit,
      usedByTestCount,
      ragHit,
      topMethodSimilarity,
    };
  }
}

/**
 * Singleton provider instance (matches orchestrator pattern).
 */
let providerInstance: RepositoryProvider | undefined;

export function getRepositoryProvider(): RepositoryProvider {
  if (!providerInstance) {
    providerInstance = new RepositoryProvider();
  }
  return providerInstance;
}
