/**
 * Intelligence Orchestrator
 * -------------------------
 * Single service that gathers context from ALL intelligence sources based on
 * user intent, not flat summaries. This is the foundation for moving LevelUp AI
 * from "repository summary in prompts" to "query-driven retrieval" — like Cursor.
 *
 * Instead of embedding:
 *   Framework: Playwright
 *   Helpers: 24
 *   Page Objects: 11
 *
 * Features ask:
 *   "Show me everything related to Login"
 *
 * And receive:
 *   - Repository Graph: LoginPage.login() + verifyError() + AuthenticationHelper
 *   - App Profile: Login page structure, textboxes, buttons, error messages
 *   - Test Data: locked_user dataset
 *   - Knowledge: Business rules ("locked users cannot login")
 *   - Similarity: Existing login scripts (92% similar)
 *   - Learned Patterns: Always use waitForURL(), never waitForTimeout()
 *
 * This orchestrator coordinates queries across:
 * - Repository Intelligence Graph (intent-based, relationship-traversing)
 * - App Profile (UI structure, business flows)
 * - Test Data (datasets, records)
 * - Knowledge (business rules)
 * - DOM Memory (selector history)
 * - Similarity Engine (existing scripts)
 * - Learned Patterns (best practices, anti-patterns)
 *
 * Every AI feature (Script Gen, Healing, AI Review, Test Case Lab) should call
 * this orchestrator instead of loading flat profiles or re-scanning.
 */

import type { Pool } from 'pg';
import {
  getPool,
  getProfileByUrl,
  getKnowledgeStats,
  getRepositoryContext,
  listTestDataSets,
  type MethodSearchHit,
} from '../db/postgres';
import { knowledgeGraphService, type IntentQueryResult, type ReusableMethod } from './knowledge-graph-service';
import { MethodIntelligenceService } from './method-intelligence-service';
import { getRAGService, type RagExample } from './rag-service';
import { FEATURE_FLAGS } from '../config/features';
import { logger } from '../utils/logger';
import { getRepositoryProvider } from './repository-provider';
import { evaluateRepositoryEquivalence } from './repository-equivalence';

const MOD = 'intelligence-orchestrator';

/* ──────────────────────────────────────────────────────────────────────────
 *  Types
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The intelligence sources the orchestrator can gather from. Callers pass a
 * subset via `OrchestratorQuery.sources` so they only pay for what they need:
 *   - Healing doesn't need App Knowledge
 *   - Test Case Lab doesn't always need DOM Memory
 *   - AI Review doesn't need Test Data
 */
export type OrchestratorSource =
  | 'repository'
  | 'appProfile'
  | 'testData'
  | 'knowledge'
  | 'domMemory'
  | 'similarity'
  | 'patterns';

export const ALL_SOURCES: OrchestratorSource[] = [
  'repository',
  'appProfile',
  'testData',
  'knowledge',
  'domMemory',
  'similarity',
  'patterns',
];

export interface OrchestratorQuery {
  /** User intent / test scenario (e.g., "Login", "Add to cart", "Verify error") */
  intent: string;
  /** Repository context ID (for graph queries) */
  repoContextId?: number;
  /** Company/project scope */
  companyId: number;
  projectId?: number;
  /** Target URL (for App Profile) */
  targetUrl?: string;
  /** Feature calling the orchestrator (for logging/telemetry) */
  caller: 'script-gen' | 'healing' | 'ai-review' | 'test-case-lab' | 'rca' | 'impact-analysis';
  /**
   * Which sources to gather. When omitted, ALL sources are queried (legacy
   * behaviour). Pass an explicit subset to avoid collecting unnecessary context
   * — e.g. `['repository', 'testData', 'appProfile']` for Script Generation.
   */
  sources?: OrchestratorSource[];
}

/**
 * Intelligence Score — LevelUp's signature transparency metric.
 *
 * Surfaces how much of a generation is *grounded in real intelligence*
 * (repository, knowledge, patterns, app profile, test data, …) versus produced
 * by the raw model. Powers UI badges like:
 *
 *   "94% grounded in repository intelligence. Only 6% AI-generated."
 *
 * This directly expresses LevelUp's "Rule-first. Intelligence-first. AI-last."
 * philosophy and is consumed by every AI feature (Script Gen, Test Case Lab,
 * Healing) plus the dashboard.
 */
export interface IntelligenceScore {
  /** Overall grounding 0-100 (weighted across the sources that returned data). */
  grounded: number;
  /** Share attributed to raw AI generation — the inverse of `grounded`. */
  aiContribution: number;
  /**
   * Per-source grounding breakdown with UI-friendly labels, e.g.
   * `{ 'Repository Match': 95, 'Knowledge Match': 87, 'Pattern Match': 98 }`.
   * Only includes sources that returned usable data.
   */
  bySource: Record<string, number>;
  /** Human-readable one-liner for direct UI display. */
  summary: string;
}

export interface OrchestratedIntelligence {
  available: boolean;
  intent: string;
  /** Repository Graph — intent-based reuse candidates (page objects, helpers, assertions, waits) */
  repositoryGraph: {
    available: boolean;
    primaryMethods: ReusableMethod[];
    supportingMethods: {
      assertions: ReusableMethod[];
      waits: ReusableMethod[];
      dataAccess: ReusableMethod[];
      utilities: ReusableMethod[];
    };
    relatedFlows: string[];
    /**
     * Phase 3 — Healing evidence. Method-index hits + RAG snippets for the intent,
     * plus corroboration signals (methodIndexHit, pageObjectHit, etc.) that the
     * Healing orchestrator uses for repository-aware confidence boosting. Only
     * populated when caller='healing' and the 'repository' source is requested.
     */
    healingEvidence?: {
      methodHits: MethodSearchHit[];
      ragExamples: RagExample[];
      /** Corroboration signals for confidence scoring (same contract as HealingIntelligenceContext). */
      signals: {
        methodIndexHit: boolean;
        pageObjectHit: boolean;
        usedByTestCount: number;
        ragHit: boolean;
        topMethodSimilarity: number;
      };
    };
  };
  /** App Profile — UI structure, business flows (from crawl) */
  appProfile: {
    available: boolean;
    name?: string;
    businessFlows?: string[];
    formFields?: any[];
    pageCount?: number;
    totalElements?: number;
  } | null;
  /** Test Data — datasets and records relevant to intent */
  testData: {
    available: boolean;
    datasets: Array<{ name: string; recordCount: number; sampleRecords: string[] }>;
  };
  /** Knowledge — business rules, domain knowledge */
  knowledge: {
    available: boolean;
    itemsCount: number;
    categoriesCount: number;
    relevantItems?: any[];
  } | null;
  /** DOM Memory — selector history for the URL */
  domMemory: {
    available: boolean;
    selectors: any[];
  };
  /** Similarity — existing scripts similar to intent */
  similarity: {
    available: boolean;
    similarScripts: any[];
  };
  /** Learned Patterns — best practices, anti-patterns */
  learnedPatterns: {
    available: boolean;
    patterns: any[];
  };
  /** Metadata — source breakdown, warnings, confidence, timing */
  metadata: {
    /** Sources explicitly requested by the caller (after defaulting). */
    sourcesRequested: OrchestratorSource[];
    /** Sources that actually returned usable data. */
    sourcesUsed: string[];
    missingCritical: string[];
    warnings: string[];
    /** Overall confidence (0-100), weighted across the sources that returned data. */
    confidenceScore: number;
    /**
     * Per-source confidence (0-100). Lets the model reason differently about
     * each source — e.g. trust testData=100 but treat patterns=60 as advisory.
     * Only includes sources that returned usable data.
     */
    confidenceBySource: Partial<Record<OrchestratorSource, number>>;
    /**
     * Per-source wall-clock timing in ms (+ a `total` key + `promptBuild` once
     * buildPromptContext runs). Surfaces which source is becoming slow.
     */
    timingsMs: Record<string, number>;
    /**
     * Counts of what each source actually returned. If Script Generation
     * suddenly degrades you'll see `repositoryMethods: 0` instead of `9` — an
     * immediate signal that retrieval (not the model) regressed.
     */
    retrievalMetrics: {
      repositoryMethods: number;
      testDatasets: number;
      knowledgeRules: number;
      learnedPatterns: number;
      appProfilePages: number;
      domSelectors: number;
    };
    /**
     * The actual items selected for the prompt (names only). This is gold for
     * answering "why did Claude generate this?" — you see exactly which methods,
     * datasets and patterns it received, not just how many.
     */
    selected: {
      repositoryMethods: string[];
      datasets: string[];
      patterns: string[];
    };
    /**
     * Signature transparency metric — grounded vs AI-generated, with a
     * per-source breakdown. Always present (grounded=0 / aiContribution=100
     * when no source returned data). Consumed by the API + dashboard.
     */
    intelligenceScore: IntelligenceScore;
    /**
     * Which snapshot of each source was used, so two differing generations can
     * be explained. Lightweight: identifiers/timestamps already on the rows
     * (full numeric versioning of knowledge/datasets is deferred — needs schema).
     */
    sourceVersions: {
      repoContextId?: number;
      appProfileId?: string;
      appProfileFingerprint?: string;
      appProfileCrawledAt?: string;
      appProfileUpdatedAt?: string;
    };
  };
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Service
 * ────────────────────────────────────────────────────────────────────────── */

export class IntelligenceOrchestrator {
  private readonly pool: Pool;

  constructor(pool?: Pool) {
    this.pool = pool ?? getPool();
  }

  /**
   * Whether the orchestrator should be consulted by AI features right now.
   * Gated behind the INTELLIGENCE_ORCHESTRATOR flag so integration is fully
   * opt-in and backward-compatible (off → legacy prompt path is unchanged).
   */
  static isEnabled(): boolean {
    return FEATURE_FLAGS.REPO_INTELLIGENCE.INTELLIGENCE_ORCHESTRATOR;
  }

  /** UI-friendly labels for the per-source Intelligence Score breakdown. */
  static readonly SOURCE_LABELS: Record<OrchestratorSource, string> = {
    repository: 'Repository Match',
    appProfile: 'App Profile',
    testData: 'Test Data',
    knowledge: 'Knowledge Match',
    domMemory: 'DOM Memory',
    similarity: 'Similarity Match',
    patterns: 'Pattern Match',
  };

  /** Natural-language phrases used in the Intelligence Score one-liner. */
  static readonly SOURCE_PHRASES: Record<OrchestratorSource, string> = {
    repository: 'repository intelligence',
    appProfile: 'app profile intelligence',
    testData: 'test data intelligence',
    knowledge: 'knowledge intelligence',
    domMemory: 'DOM memory',
    similarity: 'similarity intelligence',
    patterns: 'pattern intelligence',
  };

  /**
   * Compute the signature Intelligence Score from the overall confidence and
   * per-source confidence already gathered. Pure/deterministic so it is trivial
   * to unit-test and reuse across callers (API, prompt block, dashboard).
   *
   *   grounded        → overall grounding (weighted confidence, 0-100)
   *   aiContribution  → 100 - grounded (the raw-model share)
   *   bySource        → per-source match %, UI-labelled
   *   summary         → "94% grounded in repository intelligence. Only 6% AI-generated."
   */
  static computeIntelligenceScore(
    confidenceScore: number,
    confidenceBySource: Partial<Record<OrchestratorSource, number>>,
  ): IntelligenceScore {
    const grounded = Math.max(0, Math.min(100, Math.round(confidenceScore)));
    const aiContribution = Math.max(0, Math.min(100, 100 - grounded));

    const bySource: Record<string, number> = {};
    let topSource: OrchestratorSource | null = null;
    let topVal = -1;
    for (const [k, v] of Object.entries(confidenceBySource) as [OrchestratorSource, number][]) {
      if (v == null) continue;
      bySource[IntelligenceOrchestrator.SOURCE_LABELS[k] ?? k] = v;
      if (v > topVal) {
        topVal = v;
        topSource = k;
      }
    }

    let summary: string;
    if (grounded <= 0 || topSource == null) {
      summary = 'No grounding intelligence available — 100% AI-generated.';
    } else {
      const phrase = IntelligenceOrchestrator.SOURCE_PHRASES[topSource] ?? 'repository intelligence';
      summary = `${grounded}% grounded in ${phrase}. Only ${aiContribution}% AI-generated.`;
    }

    return { grounded, aiContribution, bySource, summary };
  }

  /**
   * Orchestrate intelligence gathering based on user intent.
   * Returns a compact, structured bundle ready for prompt injection.
   */
  async gatherIntelligence(query: OrchestratorQuery): Promise<OrchestratedIntelligence> {
    const start = Date.now();

    // Resolve which sources to gather. Omitted → all (legacy behaviour).
    const requested: OrchestratorSource[] =
      query.sources && query.sources.length > 0 ? query.sources : ALL_SOURCES.slice();
    const wanted = (s: OrchestratorSource) => requested.includes(s);

    logger.info(MOD, 'Intelligence orchestration start', {
      intent: query.intent,
      caller: query.caller,
      repoContextId: query.repoContextId,
      sources: requested,
    });

    const sourcesUsed: string[] = [];
    const missingCritical: string[] = [];
    const warnings: string[] = [];
    const timingsMs: Record<string, number> = {};
    const confidenceBySource: Partial<Record<OrchestratorSource, number>> = {};
    // Source versioning — which snapshot of each source fed this generation.
    const sourceVersions: OrchestratedIntelligence['metadata']['sourceVersions'] = {
      repoContextId: query.repoContextId,
    };

    /** Time an async source-gathering step, recording its ms into `timingsMs`. */
    const timed = async <T>(name: OrchestratorSource, fn: () => Promise<T>): Promise<T> => {
      const t0 = Date.now();
      try {
        return await fn();
      } finally {
        timingsMs[name] = Date.now() - t0;
      }
    };

    // 1. Repository Graph — intent-based queries (relationship-traversing, not name-match)
    let repoGraph: IntentQueryResult = {
      available: false,
      intent: query.intent,
      primaryMethods: [],
      supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
      relatedFlows: [],
    };
    if (wanted('repository')) {
      if (query.repoContextId) {
        await timed('repository', async () => {
          try {
            repoGraph = await knowledgeGraphService.getReuseCandidatesForIntent(
              query.repoContextId!,
              query.intent,
              { limit: 5, depth: 2 },
            );
            
            // Phase 3 — Healing-specific evidence: method-index + RAG hits for the
            // failed locator/line. Only gathered when caller='healing', to avoid
            // needless retrieval for Script Gen / Test Case Lab.
            if (query.caller === 'healing') {
              const [methodHits, ragExamples] = await Promise.all([
                this.loadMethodHitsForHealing(query.repoContextId!, query.intent),
                this.loadRagExamplesForHealing(query.repoContextId!, query.intent),
              ]);
              if (methodHits.length > 0 || ragExamples.length > 0) {
                (repoGraph as any).healingEvidence = {
                  methodHits,
                  ragExamples,
                  signals: this.deriveHealingSignals(methodHits, ragExamples),
                };
              }
            }

            if (repoGraph.available && repoGraph.primaryMethods.length > 0) {
              sourcesUsed.push('repository-graph');
              // Confidence scales with how many primary candidates matched the intent.
              const n = repoGraph.primaryMethods.length;
              confidenceBySource.repository = Math.min(100, 60 + n * 10);
            } else {
              warnings.push('Repository graph returned no candidates for this intent');
            }
          } catch (err: any) {
            logger.warn(MOD, 'Repository graph query failed', { error: err?.message });
            warnings.push('Repository graph query failed');
          }
        });

        // ── Dual-path migration validation (shadow) ──────────────────────────
        // Run the RepositoryProvider ALONGSIDE the legacy path above, normalize
        // both, and compare them for semantic equivalence. The legacy result
        // (`repoGraph`) remains the SOLE source of truth consumed downstream —
        // the provider output is observed, never trusted, until the match rate
        // proves equivalence and legacy can be deleted. Fully fail-open: any
        // error here can never affect the production (legacy) result.
        await this.runRepositoryDualPathShadow(query, repoGraph);
      } else {
        missingCritical.push('repository-context-id');
      }
    }

    // 2. App Profile — UI structure, business flows
    let appProfile: OrchestratedIntelligence['appProfile'] = null;
    if (wanted('appProfile') && query.targetUrl) {
      await timed('appProfile', async () => {
        try {
          const baseUrl = this.safeOrigin(query.targetUrl!);
          if (baseUrl) {
            const profile = await getProfileByUrl(baseUrl, query.companyId, query.projectId);
            if (profile) {
              appProfile = {
                available: true,
                name: profile.name ?? undefined,
                businessFlows: profile.business_flows ?? [],
                formFields: profile.form_fields ?? [],
                pageCount: profile.page_count,
                totalElements: profile.total_elements,
              };
              sourcesUsed.push('app-profile');
              const flows = (profile.business_flows ?? []).length;
              confidenceBySource.appProfile = Math.min(100, 70 + flows * 5);
              // Versioning: record which crawl snapshot was used.
              sourceVersions.appProfileId = profile.id;
              sourceVersions.appProfileFingerprint = profile.app_fingerprint ?? undefined;
              sourceVersions.appProfileCrawledAt = profile.crawled_at;
              sourceVersions.appProfileUpdatedAt = profile.updated_at;
            }
          }
        } catch (err: any) {
          logger.warn(MOD, 'App profile load failed', { error: err?.message });
        }
      });
    }

    // 3. Test Data — datasets relevant to intent
    const testData: OrchestratedIntelligence['testData'] = {
      available: false,
      datasets: [],
    };
    if (wanted('testData') && query.projectId) {
      await timed('testData', async () => {
        try {
          const datasets = await listTestDataSets(query.companyId, query.projectId);
          // Filter datasets by intent keywords (fuzzy match on dataset name)
          const intentTokens = query.intent.toLowerCase().split(/\s+/);
          const relevant = datasets.filter((ds: any) => {
            const name = (ds.name ?? '').toLowerCase();
            return intentTokens.some(t => name.includes(t));
          }).slice(0, 5);
          if (relevant.length > 0) {
            testData.available = true;
            testData.datasets = relevant.map((ds: any) => ({
              name: ds.name,
              recordCount: (ds.records ?? []).length,
              sampleRecords: (ds.records ?? []).slice(0, 3).map((r: any) => JSON.stringify(r)),
            }));
            sourcesUsed.push('test-data');
            // Test data matched by name is a strong, concrete signal.
            confidenceBySource.testData = 100;
          }
        } catch (err: any) {
          logger.warn(MOD, 'Test data load failed', { error: err?.message });
        }
      });
    }

    // 4. Knowledge — business rules
    let knowledge: OrchestratedIntelligence['knowledge'] = null;
    if (wanted('knowledge')) {
      await timed('knowledge', async () => {
        try {
          const stats = await getKnowledgeStats(query.companyId, query.projectId);
          if (stats.total > 0) {
            knowledge = {
              available: true,
              itemsCount: stats.total,
              categoriesCount: Object.keys(stats.byCategory || {}).length,
              relevantItems: [], // TODO: query knowledge by intent keywords
            };
            sourcesUsed.push('knowledge');
            // Knowledge is org-wide (not intent-scoped yet) → advisory confidence.
            confidenceBySource.knowledge = 80;
          }
        } catch (err: any) {
          logger.warn(MOD, 'Knowledge load failed', { error: err?.message });
        }
      });
    }

    // 5. DOM Memory — selector history
    const domMemory: OrchestratedIntelligence['domMemory'] = {
      available: false,
      selectors: [],
    };
    if (wanted('domMemory') && query.targetUrl) {
      await timed('domMemory', async () => {
        try {
          const baseUrl = this.safeOrigin(query.targetUrl!);
          if (baseUrl) {
            const res = await this.pool.query(
              `SELECT selector, xpath, last_used_at, success_rate
                 FROM dom_snapshots
                WHERE url = $1 AND (company_id = $2 OR company_id IS NULL)
                ORDER BY last_used_at DESC LIMIT 10`,
              [baseUrl, query.companyId],
            );
            if (res.rows.length > 0) {
              domMemory.available = true;
              domMemory.selectors = res.rows;
              sourcesUsed.push('dom-memory');
              confidenceBySource.domMemory = 75;
            }
          }
        } catch (err: any) {
          logger.debug(MOD, 'DOM memory query failed (non-critical)', { error: err?.message });
        }
      });
    }

    // 6. Similarity — existing scripts similar to intent
    const similarity: OrchestratedIntelligence['similarity'] = {
      available: false,
      similarScripts: [],
    };
    // TODO: integrate semantic-similarity-engine or RAG search
    // For now return empty

    // 7. Learned Patterns — best practices, anti-patterns
    const learnedPatterns: OrchestratedIntelligence['learnedPatterns'] = {
      available: false,
      patterns: [],
    };
    if (wanted('patterns')) {
      await timed('patterns', async () => {
        try {
          const res = await this.pool.query(
            `SELECT pattern_type, pattern_description, confidence_score, usage_count
               FROM learned_patterns
              WHERE pattern_type IN ('best_practice', 'anti_pattern')
              ORDER BY usage_count DESC LIMIT 10`,
          );
          if (res.rows.length > 0) {
            learnedPatterns.available = true;
            learnedPatterns.patterns = res.rows;
            sourcesUsed.push('learned-patterns');
            // Patterns are heuristic/advisory → lower confidence.
            confidenceBySource.patterns = 60;
          }
        } catch (err: any) {
          logger.debug(MOD, 'Learned patterns query failed (non-critical)', { error: err?.message });
        }
      });
    }

    // Confidence score (weighted by sources used)
    const weights = {
      'repository-graph': 30,
      'app-profile': 20,
      'test-data': 15,
      'knowledge': 10,
      'dom-memory': 10,
      'similarity': 10,
      'learned-patterns': 5,
    };
    let confidenceScore = 0;
    for (const src of sourcesUsed) {
      confidenceScore += (weights as any)[src] ?? 0;
    }

    // ── Intelligence Score — signature "grounded vs AI" transparency metric.
    const intelligenceScore = IntelligenceOrchestrator.computeIntelligenceScore(
      confidenceScore,
      confidenceBySource,
    );

    const durationMs = Date.now() - start;
    timingsMs.total = durationMs;

    // ── Selected items (names only) — answers "what did Claude actually receive?"
    const allRepoMethods: ReusableMethod[] = [
      ...repoGraph.primaryMethods,
      ...repoGraph.supportingMethods.assertions,
      ...repoGraph.supportingMethods.waits,
      ...repoGraph.supportingMethods.dataAccess,
      ...repoGraph.supportingMethods.utilities,
    ];
    const selected = {
      repositoryMethods: allRepoMethods.map(m => m.name),
      datasets: testData.datasets.map(d => d.name),
      patterns: learnedPatterns.patterns.map((p: any) => p.pattern_description),
    };

    // ── Retrieval metrics — counts of what each source returned.
    const retrievalMetrics = {
      repositoryMethods: allRepoMethods.length,
      testDatasets: testData.datasets.length,
      knowledgeRules: (knowledge as OrchestratedIntelligence['knowledge'])?.itemsCount ?? 0,
      learnedPatterns: learnedPatterns.patterns.length,
      appProfilePages: (appProfile as OrchestratedIntelligence['appProfile'])?.pageCount ?? 0,
      domSelectors: domMemory.selectors.length,
    };

    logger.info(MOD, 'Intelligence orchestration complete', {
      intent: query.intent,
      caller: query.caller,
      sourcesRequested: requested,
      sourcesUsed,
      confidenceScore,
      confidenceBySource,
      intelligenceScore,
      timingsMs,
      durationMs,
      retrievalMetrics,
      selected,
      sourceVersions,
    });

    return {
      available: sourcesUsed.length > 0,
      intent: query.intent,
      repositoryGraph: {
        available: repoGraph.available,
        primaryMethods: repoGraph.primaryMethods,
        supportingMethods: repoGraph.supportingMethods,
        relatedFlows: repoGraph.relatedFlows,
      },
      appProfile,
      testData,
      knowledge,
      domMemory,
      similarity,
      learnedPatterns,
      metadata: {
        sourcesRequested: requested,
        sourcesUsed,
        missingCritical,
        warnings,
        confidenceScore,
        confidenceBySource,
        intelligenceScore,
        timingsMs,
        retrievalMetrics,
        selected,
        sourceVersions,
      },
    };
  }

  /**
   * Build a compact prompt block from orchestrated intelligence.
   * This replaces the old "repository summary" approach with structured,
   * intent-scoped facts.
   */
  buildPromptContext(intel: OrchestratedIntelligence): string {
    const t0 = Date.now();
    const lines: string[] = [];

    if (!intel.available) {
      // Still record prompt-build timing for observability.
      intel.metadata.timingsMs.promptBuild = Date.now() - t0;
      return '(No intelligence available for this request)';
    }

    const cbs = intel.metadata.confidenceBySource;
    const conf = (s: OrchestratorSource): string =>
      cbs[s] != null ? ` (confidence: ${cbs[s]}%)` : '';

    lines.push(`=== INTELLIGENCE FOR: ${intel.intent.toUpperCase()} ===`);
    lines.push(`Overall Confidence: ${intel.metadata.confidenceScore}%`);
    // Signature transparency line — grounded vs raw-model contribution.
    const score = intel.metadata.intelligenceScore;
    if (score) {
      lines.push(`Intelligence Score: ${score.grounded}% grounded / ${score.aiContribution}% AI-generated`);
    }
    // Surface per-source confidence so the model trusts concrete signals (test
    // data, repository) more than advisory ones (patterns).
    const cbsEntries = Object.entries(cbs);
    if (cbsEntries.length > 0) {
      lines.push(`Source Confidence: ${cbsEntries.map(([k, v]) => `${k}=${v}%`).join(', ')}`);
    }
    lines.push('');

    // Repository Graph — reusable code
    if (intel.repositoryGraph.available && intel.repositoryGraph.primaryMethods.length > 0) {
      lines.push(`** REPOSITORY — Existing Code to Reuse${conf('repository')} **`);
      lines.push('Primary Methods:');
      for (const m of intel.repositoryGraph.primaryMethods.slice(0, 3)) {
        lines.push(`  - ${m.name} (${m.filePath})`);
        if (m.description) lines.push(`    ${m.description}`);
        lines.push(`    \`\`\`\n${m.sourceCode.slice(0, 500)}\n    \`\`\``);
      }
      const { assertions, waits, dataAccess, utilities } = intel.repositoryGraph.supportingMethods;
      if (assertions.length > 0) {
        lines.push('Assertions:');
        assertions.slice(0, 3).forEach(a => lines.push(`  - ${a.name}()`));
      }
      if (waits.length > 0) {
        lines.push('Wait/Sync Helpers:');
        waits.slice(0, 3).forEach(w => lines.push(`  - ${w.name}()`));
      }
      if (dataAccess.length > 0) {
        lines.push('Test Data Helpers:');
        dataAccess.slice(0, 3).forEach(d => lines.push(`  - ${d.name}()`));
      }
      
      // Phase 3 — Healing evidence: method-index + RAG hits for broken locators.
      // This block is only present when caller='healing' and evidence was gathered.
      if (intel.repositoryGraph.healingEvidence) {
        const { methodHits, ragExamples } = intel.repositoryGraph.healingEvidence;
        if (methodHits.length > 0 || ragExamples.length > 0) {
          lines.push('Repository context (selectors that ALREADY exist in this codebase).');
          lines.push('Prefer reusing these real locators/methods over inventing new ones.');
          
          if (methodHits.length > 0) {
            lines.push('', 'Existing page-object / helper methods:');
            methodHits.slice(0, 4).forEach((m, i) => {
              const sim = Math.round((m.similarity || 0) * 100);
              const loc = m.className ? `${m.className}.${m.methodName}` : m.methodName;
              const body = m.sourceCode && m.sourceCode.length > 600
                ? `${m.sourceCode.slice(0, 600)}\n// ...(truncated)`
                : m.sourceCode || '';
              lines.push(`${i + 1}. ${loc} [${m.methodType}] (${m.filePath}) — ${sim}% match, used by ${m.usageCount} test(s)`);
              if (body.trim()) {
                lines.push('```', body.trim(), '```');
              }
            });
          }
          
          if (ragExamples.length > 0) {
            lines.push('', 'Related source / page-object snippets:');
            ragExamples.slice(0, 2).forEach((ex, i) => {
              const sim = Math.round((ex.similarity || 0) * 100);
              const body = ex.content && ex.content.length > 600
                ? `${ex.content.slice(0, 600)}\n// ...(truncated)`
                : ex.content || '';
              lines.push(`${i + 1}. ${ex.chunkName} (${ex.filePath}) — ${sim}% similar`);
              if (body.trim()) {
                lines.push('```', body.trim(), '```');
              }
            });
          }
        }
      }
      
      lines.push('');
    }

    // App Profile — UI structure
    if (intel.appProfile?.available) {
      lines.push(`** APP PROFILE — UI Structure${conf('appProfile')} **`);
      if (intel.appProfile.businessFlows && intel.appProfile.businessFlows.length > 0) {
        lines.push(`Business Flows: ${intel.appProfile.businessFlows.slice(0, 5).join(', ')}`);
      }
      if (intel.appProfile.formFields && intel.appProfile.formFields.length > 0) {
        lines.push(`Form Fields: ${intel.appProfile.formFields.slice(0, 10).map((f: any) => f.name || f.id || f.label).join(', ')}`);
      }
      lines.push('');
    }

    // Test Data
    if (intel.testData.available && intel.testData.datasets.length > 0) {
      lines.push(`** TEST DATA — Available Datasets${conf('testData')} **`);
      for (const ds of intel.testData.datasets) {
        lines.push(`  - ${ds.name} (${ds.recordCount} records)`);
        if (ds.sampleRecords.length > 0) {
          lines.push(`    Sample: ${ds.sampleRecords[0]}`);
        }
      }
      lines.push('');
    }

    // Learned Patterns
    if (intel.learnedPatterns.available && intel.learnedPatterns.patterns.length > 0) {
      lines.push(`** LEARNED PATTERNS — Best Practices${conf('patterns')} **`);
      intel.learnedPatterns.patterns.slice(0, 5).forEach((p: any) => {
        lines.push(`  - [${p.pattern_type}] ${p.pattern_description}`);
      });
      lines.push('');
    }

    // Warnings
    if (intel.metadata.warnings.length > 0) {
      lines.push('⚠️ Warnings:');
      intel.metadata.warnings.forEach(w => lines.push(`  - ${w}`));
      lines.push('');
    }

    lines.push('=== REUSE EXISTING CODE ABOVE WHENEVER POSSIBLE ===');
    intel.metadata.timingsMs.promptBuild = Date.now() - t0;
    return lines.join('\n');
  }

  private safeOrigin(url: string): string | null {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }

  /**
   * Dual-path migration validation for Repository intelligence.
   *
   * Gated by `REPOSITORY_DUAL_PATH` (default off). When on, runs the
   * RepositoryProvider in SHADOW — its output is compared against the legacy
   * inline path (`legacyRepoGraph`) that production actually consumed — and the
   * running match rate is logged. This is how we earn the right to delete the
   * legacy path: only once the shadow provider matches legacy for enough real
   * traffic (target ≥ 99.9%) do we flip `REPOSITORY_PROVIDER` on and remove the
   * inline code.
   *
   * Guarantees:
   *   • The provider is invoked via `gatherForDualPath` so it runs even while
   *     `REPOSITORY_PROVIDER` is off (shadow precedes production enablement).
   *   • FULLY fail-open — wrapped in try/catch; a bug here never touches the
   *     legacy `repoGraph` that downstream generation depends on.
   *   • Zero effect on the returned bundle: comparison only logs + counts.
   */
  private async runRepositoryDualPathShadow(
    query: OrchestratorQuery,
    legacyRepoGraph: IntentQueryResult,
  ): Promise<void> {
    if (process.env.REPOSITORY_DUAL_PATH !== 'true') return;
    try {
      const providerResult = await getRepositoryProvider().gatherForDualPath({
        intent: query.intent,
        companyId: query.companyId,
        projectId: query.projectId,
        repoContextId: query.repoContextId,
        targetUrl: query.targetUrl,
        caller: query.caller,
      });
      evaluateRepositoryEquivalence(
        legacyRepoGraph as IntentQueryResult & { healingEvidence?: { signals?: any } },
        providerResult.context,
        { intent: query.intent, caller: query.caller },
      );
    } catch (err: any) {
      // Shadow comparison must never affect production. Log and move on.
      logger.warn(MOD, 'Repository dual-path shadow failed (non-critical)', {
        error: err?.message,
      });
    }
  }

  /**
   * Phase 3 — Healing evidence: method-index search for the failed locator/line.
   * Guarded by the MethodIntelligenceService's own flag; degrades to [] on failure.
   */
  private async loadMethodHitsForHealing(contextId: number, term: string): Promise<MethodSearchHit[]> {
    if (!MethodIntelligenceService.isEnabled()) return [];
    try {
      const svc = new MethodIntelligenceService();
      return await svc.search(contextId, term, { limit: 5, minSimilarity: 0.3 });
    } catch (err: any) {
      logger.debug(MOD, 'Method-index search for healing failed (non-critical)', { error: err?.message });
      return [];
    }
  }

  /**
   * Phase 3 — Healing evidence: RAG source/page-object retrieval for the failed
   * locator/line. Guarded by the RAG service's own flag; degrades to [] on failure.
   */
  private async loadRagExamplesForHealing(contextId: number, term: string): Promise<RagExample[]> {
    const rag = getRAGService();
    if (!rag.isEnabled()) return [];
    try {
      return await rag.findSimilarCode(contextId, term, { limit: 3, minSimilarity: 0.3 });
    } catch (err: any) {
      logger.debug(MOD, 'RAG retrieval for healing failed (non-critical)', { error: err?.message });
      return [];
    }
  }

  /**
   * Phase 3 — Derive healing corroboration signals from method-index + RAG hits.
   * Same logic as HealingIntelligenceContext.deriveEvidence, so the confidence
   * boost contract is byte-for-byte preserved when Healing switches to the orchestrator.
   */
  private deriveHealingSignals(
    methodHits: MethodSearchHit[],
    ragExamples: RagExample[],
  ): {
    methodIndexHit: boolean;
    pageObjectHit: boolean;
    usedByTestCount: number;
    ragHit: boolean;
    topMethodSimilarity: number;
  } {
    if (methodHits.length === 0 && ragExamples.length === 0) {
      return {
        methodIndexHit: false,
        pageObjectHit: false,
        usedByTestCount: 0,
        ragHit: false,
        topMethodSimilarity: 0,
      };
    }
    const PAGE_OBJECT_TYPES = new Set(['page_object_method', 'helper']);
    const top = methodHits[0];
    const pageObjectHit = methodHits.some((m) => PAGE_OBJECT_TYPES.has(m.methodType));
    const usedByTestCount = methodHits.reduce((max, m) => Math.max(max, m.usageCount || 0), 0);
    return {
      methodIndexHit: methodHits.length > 0,
      pageObjectHit,
      usedByTestCount,
      ragHit: ragExamples.length > 0,
      topMethodSimilarity: top ? top.similarity : 0,
    };
  }
}

/** Singleton instance — lazy init to avoid eagerly requiring DATABASE_URL at import time. */
let _singleton: IntelligenceOrchestrator | null = null;
export function getIntelligenceOrchestrator(): IntelligenceOrchestrator {
  if (!_singleton) _singleton = new IntelligenceOrchestrator();
  return _singleton;
}
