/**
 * Multi-Intelligence Fusion Service
 * ---------------------------------
 * Gathers EVERY available intelligence source for a script-generation request,
 * computes a 0-100 confidence score, and produces an "additional intelligence"
 * context block that is injected into the AI test-plan prompt.
 *
 * Why this exists
 * ===============
 * The script-gen route already loads Repository Intelligence and App Knowledge
 * directly (and uses the Application-Profile crawl cache). This service layers
 * in the remaining signals the generator was NOT using — Flaky Tests, DOM
 * Memory, Learning Engine, Similarity Engine and RCA Intelligence — and rolls
 * everything up into a single confidence score + metadata so the API can tell
 * the user how well-informed a generation was and what to improve.
 *
 * Schema resilience
 * =================
 * Intelligence "sources" map onto a heterogeneous (and drifting) schema. A few
 * sources have no dedicated table and are derived from existing ones:
 *   - Flaky Tests      → rca_analyses WHERE is_flaky = TRUE
 *   - DOM Memory       → dom_snapshots JOIN generated_scripts (no own scope cols)
 *   - Learning Engine  → learned_patterns (GLOBAL — no company/project cols)
 *   - Similarity Engine→ selector_patterns
 *   - RCA Intelligence → rca_analyses (recent)
 * Every query is wrapped in try/catch so a missing table/column degrades
 * gracefully to "source unavailable" instead of failing the whole generation.
 *
 * Scoping: company_id is always applied; project_id only on tables that carry it.
 */

import type { Pool } from 'pg';
import {
  getPool,
  getProfileByUrl,
  listRepositories,
  getKnowledgeStats,
  getRepositoryContext,
} from '../db/postgres';
import { logger } from '../utils/logger';

const MOD = 'intelligence-fusion';

/* ──────────────────────────────────────────────────────────────────────────
 *  Types
 * ──────────────────────────────────────────────────────────────────────── */

export interface FusedIntelligence {
  repository?: any;
  /**
   * Sprint 4 — structured test-case data fused as a first-class intelligence
   * source (steps, expected results, preconditions). Drives both the prompt's
   * "TEST CASE" section and locator resolution.
   */
  testCaseData?: {
    id?: number;
    title?: string;
    stepCount: number;
    steps: Array<{ action?: string; expected?: string; raw?: any }>;
    preconditions?: string | null;
    expectedResult?: string | null;
    priority?: string | null;
    tags?: string[];
  } | null;
  appKnowledge?: { itemsCount: number; categoriesCount: number } | null;
  applicationProfile?: any;
  flakyTests?: any[];
  domMemory?: any[];
  learningPatterns?: any[];
  similarTests?: any[];
  rcaInsights?: any[];
  confidenceScore: number; // 0-100
  fusionMetadata: {
    sourcesUsed: string[];
    missingCritical: string[];
    warnings: string[];
    /**
     * Sprint 4 — per-source contribution breakdown (source name, weight, and
     * whether it actually contributed) for metadata tracking + UI display.
     */
    sourceBreakdown?: Array<{ source: string; weight: number; contributed: boolean }>;
  };
}

export interface FuseParams {
  companyId: number;
  projectId?: number;
  /** repo_id identifier (string) used by repository_contexts; number tolerated. */
  repositoryId?: number | string;
  targetUrl: string;
  testScenario?: string;
  framework?: string;
  /**
   * Optional hints from the caller to avoid re-querying sources it has already
   * resolved (keeps the confidence score consistent with what the generation
   * actually used).
   */
  preloadedRepoProfile?: any;
  knowledgeItemsCount?: number;
  /**
   * Sprint 4 — structured test case (from getTestCaseById). When supplied, the
   * test-case data is fused as a first-class source and steered into the prompt
   * and locator resolution. Loose shape to avoid a hard dependency on the DB row type.
   */
  testCase?: {
    id?: number;
    title?: string;
    steps?: any;
    preconditions?: string | null;
    expected_result?: string | null;
    priority?: string | null;
    tags?: any;
  } | null;
}

/**
 * Per-source confidence weighting (sums to 100).
 *
 * Sprint 4 rebalance — introduces `testCaseData` (15) as a first-class source
 * and reduces repository (30→25) and appKnowledge (20→15) so the totals still
 * sum to 100 while structured test-case data gets meaningful weight:
 *   repository 25 + testCaseData 15 + appKnowledge 15 + applicationProfile 15
 *   + flakyTests 8 + domMemory 8 + learningPatterns 5 + similarTests 5 + rcaInsights 4 = 100
 */
const WEIGHTS = {
  repository: 25,
  testCaseData: 15,
  appKnowledge: 15,
  applicationProfile: 15,
  flakyTests: 8,
  domMemory: 8,
  learningPatterns: 5,
  similarTests: 5,
  rcaInsights: 4,
} as const;

/* ──────────────────────────────────────────────────────────────────────────
 *  Service
 * ──────────────────────────────────────────────────────────────────────── */

export class IntelligenceFusionService {
  private readonly pool: Pool;

  /** Pool is optional — defaults to the shared application pool. */
  constructor(pool?: Pool) {
    this.pool = pool ?? getPool();
  }

  async fuseIntelligenceForScriptGen(params: FuseParams): Promise<FusedIntelligence> {
    logger.info(MOD, '=== Intelligence Fusion Start ===', {
      companyId: params.companyId,
      projectId: params.projectId,
      repositoryId: params.repositoryId,
      targetUrl: params.targetUrl,
    });

    const intelligence: FusedIntelligence = {
      confidenceScore: 0,
      fusionMetadata: { sourcesUsed: [], missingCritical: [], warnings: [], sourceBreakdown: [] },
    };

    /* 1. Repository Intelligence (CRITICAL) */
    try {
      intelligence.repository = params.preloadedRepoProfile
        ? this.summarizeRepoProfile(params.preloadedRepoProfile)
        : await this.loadRepositoryIntelligence(
            params.companyId,
            params.projectId,
            params.repositoryId
          );
      if (intelligence.repository) {
        intelligence.confidenceScore += WEIGHTS.repository;
        intelligence.fusionMetadata.sourcesUsed.push('Repository Intelligence');
      } else {
        intelligence.fusionMetadata.missingCritical.push('Repository Intelligence');
        intelligence.fusionMetadata.warnings.push(
          'No repository intelligence found. Generated code may not match your existing test patterns, helpers, or page objects.'
        );
      }
    } catch (error) {
      logger.warn(MOD, 'Repository Intelligence error', { error: (error as Error).message });
    }

    /* 1b. Test Case Data (Sprint 4 — first-class source) */
    try {
      if (params.testCase) {
        intelligence.testCaseData = this.summarizeTestCase(params.testCase);
        if (intelligence.testCaseData && intelligence.testCaseData.stepCount > 0) {
          intelligence.confidenceScore += WEIGHTS.testCaseData;
          intelligence.fusionMetadata.sourcesUsed.push(
            `Test Case Data (${intelligence.testCaseData.stepCount} steps)`
          );
        }
      }
    } catch (error) {
      logger.warn(MOD, 'Test Case Data error', { error: (error as Error).message });
    }

    /* 2. App Knowledge (HIGH) */
    try {
      intelligence.appKnowledge =
        typeof params.knowledgeItemsCount === 'number'
          ? { itemsCount: params.knowledgeItemsCount, categoriesCount: 0 }
          : await this.loadAppKnowledge(params.companyId, params.projectId);
      if (intelligence.appKnowledge && intelligence.appKnowledge.itemsCount > 0) {
        intelligence.confidenceScore += WEIGHTS.appKnowledge;
        intelligence.fusionMetadata.sourcesUsed.push(
          `App Knowledge (${intelligence.appKnowledge.itemsCount} items)`
        );
      }
    } catch (error) {
      logger.warn(MOD, 'App Knowledge error', { error: (error as Error).message });
    }

    /* 3. Application Profile (HIGH) */
    try {
      intelligence.applicationProfile = await this.loadApplicationProfile(
        params.targetUrl,
        params.companyId,
        params.projectId
      );
      if (intelligence.applicationProfile) {
        intelligence.confidenceScore += WEIGHTS.applicationProfile;
        intelligence.fusionMetadata.sourcesUsed.push('Application Profile');
      }
    } catch (error) {
      logger.warn(MOD, 'Application Profile error', { error: (error as Error).message });
    }

    /* 4. Flaky Tests Intelligence (MEDIUM) */
    try {
      intelligence.flakyTests = await this.loadFlakyTests(params.companyId, params.projectId);
      if (intelligence.flakyTests && intelligence.flakyTests.length > 0) {
        intelligence.confidenceScore += WEIGHTS.flakyTests;
        intelligence.fusionMetadata.sourcesUsed.push(
          `Flaky Tests (${intelligence.flakyTests.length} patterns to avoid)`
        );
      }
    } catch (error) {
      logger.warn(MOD, 'Flaky Tests error', { error: (error as Error).message });
    }

    /* 5. DOM Memory (MEDIUM) */
    try {
      intelligence.domMemory = await this.loadDOMMemory(
        params.targetUrl,
        params.companyId,
        params.projectId
      );
      if (intelligence.domMemory && intelligence.domMemory.length > 0) {
        intelligence.confidenceScore += WEIGHTS.domMemory;
        intelligence.fusionMetadata.sourcesUsed.push('DOM Memory');
      }
    } catch (error) {
      logger.warn(MOD, 'DOM Memory error', { error: (error as Error).message });
    }

    /* 6. Learning Engine (MEDIUM) */
    try {
      intelligence.learningPatterns = await this.loadLearningPatterns();
      if (intelligence.learningPatterns && intelligence.learningPatterns.length > 0) {
        intelligence.confidenceScore += WEIGHTS.learningPatterns;
        intelligence.fusionMetadata.sourcesUsed.push('Learning Engine');
      }
    } catch (error) {
      logger.warn(MOD, 'Learning Engine error', { error: (error as Error).message });
    }

    /* 7. Similarity Engine (LOW) */
    try {
      intelligence.similarTests = await this.loadSimilarPatterns(
        params.companyId,
        params.projectId
      );
      if (intelligence.similarTests && intelligence.similarTests.length > 0) {
        intelligence.confidenceScore += WEIGHTS.similarTests;
        intelligence.fusionMetadata.sourcesUsed.push(
          `Similarity Engine (${intelligence.similarTests.length} patterns)`
        );
      }
    } catch (error) {
      logger.warn(MOD, 'Similarity Engine error', { error: (error as Error).message });
    }

    /* 8. RCA Intelligence (MEDIUM) */
    try {
      intelligence.rcaInsights = await this.loadRCAInsights(params.companyId, params.projectId);
      if (intelligence.rcaInsights && intelligence.rcaInsights.length > 0) {
        intelligence.confidenceScore += WEIGHTS.rcaInsights;
        intelligence.fusionMetadata.sourcesUsed.push('RCA Intelligence');
      }
    } catch (error) {
      logger.warn(MOD, 'RCA Intelligence error', { error: (error as Error).message });
    }

    intelligence.confidenceScore = Math.min(100, Math.max(0, Math.round(intelligence.confidenceScore)));

    /* Sprint 4 — record the per-source contribution breakdown for metadata tracking. */
    intelligence.fusionMetadata.sourceBreakdown = [
      { source: 'repository', weight: WEIGHTS.repository, contributed: !!intelligence.repository },
      { source: 'testCaseData', weight: WEIGHTS.testCaseData, contributed: !!(intelligence.testCaseData && intelligence.testCaseData.stepCount > 0) },
      { source: 'appKnowledge', weight: WEIGHTS.appKnowledge, contributed: !!(intelligence.appKnowledge && intelligence.appKnowledge.itemsCount > 0) },
      { source: 'applicationProfile', weight: WEIGHTS.applicationProfile, contributed: !!intelligence.applicationProfile },
      { source: 'flakyTests', weight: WEIGHTS.flakyTests, contributed: !!(intelligence.flakyTests && intelligence.flakyTests.length > 0) },
      { source: 'domMemory', weight: WEIGHTS.domMemory, contributed: !!(intelligence.domMemory && intelligence.domMemory.length > 0) },
      { source: 'learningPatterns', weight: WEIGHTS.learningPatterns, contributed: !!(intelligence.learningPatterns && intelligence.learningPatterns.length > 0) },
      { source: 'similarTests', weight: WEIGHTS.similarTests, contributed: !!(intelligence.similarTests && intelligence.similarTests.length > 0) },
      { source: 'rcaInsights', weight: WEIGHTS.rcaInsights, contributed: !!(intelligence.rcaInsights && intelligence.rcaInsights.length > 0) },
    ];

    logger.info(MOD, '=== Intelligence Fusion Complete ===', {
      confidenceScore: intelligence.confidenceScore,
      sourcesUsed: intelligence.fusionMetadata.sourcesUsed,
      missingCritical: intelligence.fusionMetadata.missingCritical,
    });

    return intelligence;
  }

  /**
   * Sprint 4 — normalise a raw test-case row (from getTestCaseById) into the
   * compact `testCaseData` summary. Tolerates `steps` being a JSON array of
   * strings, an array of objects ({ action/step/expected }), or a JSON string.
   */
  private summarizeTestCase(tc: FuseParams['testCase']): NonNullable<FusedIntelligence['testCaseData']> {
    let rawSteps: any = tc?.steps ?? [];
    if (typeof rawSteps === 'string') {
      try { rawSteps = JSON.parse(rawSteps); } catch { rawSteps = []; }
    }
    if (!Array.isArray(rawSteps)) rawSteps = [];

    const steps = rawSteps.map((s: any) => {
      if (s && typeof s === 'object') {
        return {
          action: s.action ?? s.step ?? s.description ?? s.text ?? undefined,
          expected: s.expected ?? s.expectedResult ?? s.expected_result ?? undefined,
          raw: s,
        };
      }
      return { action: String(s), raw: s };
    });

    let tags: string[] = [];
    const rawTags = tc?.tags;
    if (Array.isArray(rawTags)) tags = rawTags.map((t) => String(t));
    else if (typeof rawTags === 'string') {
      try { const p = JSON.parse(rawTags); if (Array.isArray(p)) tags = p.map((t) => String(t)); } catch { /* ignore */ }
    }

    return {
      id: tc?.id,
      title: tc?.title,
      stepCount: steps.length,
      steps,
      preconditions: tc?.preconditions ?? null,
      expectedResult: tc?.expected_result ?? null,
      priority: tc?.priority ?? null,
      tags,
    };
  }

  /* ────────────────────────── source loaders ────────────────────────── */

  /**
   * Repository Intelligence: prefer an explicit repository, otherwise the most
   * recent repository_contexts.profile for the company/project. Returns a
   * compact summary object (not the whole profile).
   */
  private async loadRepositoryIntelligence(
    companyId: number,
    projectId?: number,
    repositoryId?: number | string
  ): Promise<any | null> {
    // Direct repository context lookup (by repo_id) when available.
    if (repositoryId !== undefined && repositoryId !== null) {
      try {
        const profile = await getRepositoryContext(String(repositoryId), companyId);
        if (profile) return this.summarizeRepoProfile(profile);
      } catch {
        /* fall through to context-table lookup */
      }
    }

    // Most-recent repository_contexts.profile for this scope.
    try {
      const conds = ['company_id = $1'];
      const vals: any[] = [companyId];
      if (projectId) {
        conds.push('project_id = $2');
        vals.push(projectId);
      }
      const ctx = await this.pool.query(
        `SELECT profile FROM repository_contexts
         WHERE ${conds.join(' AND ')}
         ORDER BY updated_at DESC LIMIT 1`,
        vals
      );
      if (ctx.rows.length > 0) {
        const raw = ctx.rows[0].profile;
        const profile = typeof raw === 'string' ? JSON.parse(raw) : raw;
        if (profile) return this.summarizeRepoProfile(profile);
      }
    } catch {
      /* ignore */
    }

    // Last resort: do we even have a repo connected?
    if (projectId) {
      try {
        const repos = await listRepositories(projectId, companyId);
        if (repos && repos.length > 0) {
          return { reposConnected: repos.length, hasProfile: false };
        }
      } catch {
        /* ignore */
      }
    }

    return null;
  }

  private summarizeRepoProfile(profile: any): any {
    return {
      framework: profile.framework || profile.testingFramework || null,
      language: profile.language || null,
      testPattern: profile.testPattern || null,
      helpersCount: profile.helperFunctions?.length ?? profile.helpers?.length ?? 0,
      pageObjectsCount: profile.pageObjects?.length ?? profile.page_objects?.length ?? 0,
      fixturesCount: profile.fixtures?.length ?? 0,
      hasProfile: true,
    };
  }

  private async loadAppKnowledge(
    companyId: number,
    projectId?: number
  ): Promise<{ itemsCount: number; categoriesCount: number }> {
    const stats = await getKnowledgeStats(companyId, projectId);
    return {
      itemsCount: stats.total || 0,
      categoriesCount: Object.keys(stats.byCategory || {}).length,
    };
  }

  private async loadApplicationProfile(
    url: string,
    companyId: number,
    projectId?: number
  ): Promise<any | null> {
    const baseUrl = this.safeOrigin(url);
    if (!baseUrl) return null;
    const profile = await getProfileByUrl(baseUrl, companyId, projectId);
    if (!profile) return null;
    const len = (v: any) => (Array.isArray(v) ? v.length : 0);
    return {
      id: profile.id,
      name: profile.name ?? null,
      status: profile.status,
      businessFlows: profile.business_flows ?? [],
      formFields: profile.form_fields ?? [],
      screenshots: len(profile.screenshots),
      pageCount: profile.page_count,
      totalElements: profile.total_elements,
    };
  }

  /** Flaky patterns to AVOID — derived from rca_analyses (is_flaky = TRUE). */
  private async loadFlakyTests(companyId: number, projectId?: number): Promise<any[]> {
    const conds = ['company_id = $1', 'is_flaky = TRUE'];
    const vals: any[] = [companyId];
    if (projectId) {
      conds.push(`project_id = $${vals.length + 1}`);
      vals.push(projectId);
    }
    const r = await this.pool.query(
      `SELECT test_name, flaky_reason, root_cause, classification, severity
       FROM rca_analyses
       WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT 10`,
      vals
    );
    return r.rows;
  }

  /**
   * DOM Memory: proven page snapshots for this URL. dom_snapshots has no
   * company/project columns, so we scope through generated_scripts.
   */
  private async loadDOMMemory(url: string, companyId: number, projectId?: number): Promise<any[]> {
    const conds = ['gs.company_id = $1'];
    const vals: any[] = [companyId];
    if (projectId) {
      conds.push(`gs.project_id = $${vals.length + 1}`);
      vals.push(projectId);
    }
    const baseUrl = this.safeOrigin(url);
    if (baseUrl) {
      conds.push(`ds.page_url ILIKE $${vals.length + 1}`);
      vals.push(`${baseUrl}%`);
    }
    const r = await this.pool.query(
      `SELECT ds.page_url, ds.page_type, ds.elements_count, ds.created_at
       FROM dom_snapshots ds
       JOIN generated_scripts gs ON gs.id = ds.script_id
       WHERE ${conds.join(' AND ')}
       ORDER BY ds.created_at DESC
       LIMIT 5`,
      vals
    );
    return r.rows;
  }

  /** Learned healing patterns (GLOBAL store — high confidence, proven fixes). */
  private async loadLearningPatterns(): Promise<any[]> {
    const r = await this.pool.query(
      `SELECT error_pattern, failed_locator, healed_locator, solution_strategy,
              confidence, success_count, usage_count
       FROM learned_patterns
       WHERE confidence > 0.7
       ORDER BY success_count DESC, usage_count DESC
       LIMIT 10`
    );
    return r.rows;
  }

  /** Similar reusable UI patterns from the Similarity Engine (selector_patterns). */
  private async loadSimilarPatterns(companyId: number, projectId?: number): Promise<any[]> {
    const conds = ['company_id = $1'];
    const vals: any[] = [companyId];
    if (projectId) {
      conds.push(`(project_id = $${vals.length + 1} OR is_shared = TRUE)`);
      vals.push(projectId);
    }
    const r = await this.pool.query(
      `SELECT pattern_type, pattern_name, confidence_score, success_rate, usage_count
       FROM selector_patterns
       WHERE ${conds.join(' AND ')}
       ORDER BY success_rate DESC NULLS LAST, usage_count DESC
       LIMIT 5`,
      vals
    );
    return r.rows;
  }

  /** Known failure patterns to avoid — recent RCA analyses (last 30 days). */
  private async loadRCAInsights(companyId: number, projectId?: number): Promise<any[]> {
    const conds = ['company_id = $1', `created_at > NOW() - INTERVAL '30 days'`];
    const vals: any[] = [companyId];
    if (projectId) {
      conds.push(`project_id = $${vals.length + 1}`);
      vals.push(projectId);
    }
    const r = await this.pool.query(
      `SELECT root_cause, classification, suggested_fix, affected_component, severity
       FROM rca_analyses
       WHERE ${conds.join(' AND ')}
       ORDER BY created_at DESC
       LIMIT 10`,
      vals
    );
    return r.rows;
  }

  /* ────────────────────────── prompt building ────────────────────────── */

  /**
   * Build a context block for the ADDITIONAL intelligence sources (Flaky, DOM,
   * Learning, Similarity, RCA) plus warnings + a confidence summary.
   *
   * NOTE: Repository Intelligence and App Knowledge are intentionally NOT
   * re-emitted here — the script-gen engine already injects dedicated sections
   * for those. This method exists to enrich, not duplicate.
   *
   * Returns an empty string when there is nothing useful to add.
   */
  buildFusionContext(fused: FusedIntelligence): string {
    const parts: string[] = [];

    if (fused.fusionMetadata.warnings.length > 0) {
      parts.push(
        '⚠️ INTELLIGENCE WARNINGS:\n' +
          fused.fusionMetadata.warnings.map((w) => `- ${w}`).join('\n')
      );
    }

    /* Sprint 4 — structured test case steps drive the generated scenario. */
    if (fused.testCaseData && fused.testCaseData.stepCount > 0) {
      const tc = fused.testCaseData;
      const stepLines = tc.steps
        .map((s, i) => {
          const action = s.action ? String(s.action).trim() : `Step ${i + 1}`;
          const expected = s.expected ? ` → expected: ${String(s.expected).trim()}` : '';
          return `  ${i + 1}. ${action}${expected}`;
        })
        .join('\n');
      const meta: string[] = [];
      if (tc.title) meta.push(`Title: ${tc.title}`);
      if (tc.priority) meta.push(`Priority: ${tc.priority}`);
      if (tc.preconditions) meta.push(`Preconditions: ${tc.preconditions}`);
      if (tc.expectedResult) meta.push(`Overall expected result: ${tc.expectedResult}`);
      parts.push(
        `📋 TEST CASE (implement these steps faithfully):\n` +
          (meta.length ? meta.map((m) => `- ${m}`).join('\n') + '\n' : '') +
          `Steps:\n${stepLines}\n` +
          'Generate a script that performs EXACTLY these steps in order and asserts the expected results. ' +
          'Do not invent extra steps; do not skip steps.'
      );
    }

    if (fused.flakyTests && fused.flakyTests.length > 0) {
      const lines = fused.flakyTests
        .map((t) => {
          const reason = t.flaky_reason || t.root_cause || 'known flaky behavior';
          return `- ${t.test_name || 'test'}: ${reason}`;
        })
        .join('\n');
      parts.push(
        `⚠️ FLAKY PATTERNS TO AVOID:\n${lines}\n` +
          'DO NOT reproduce these unstable patterns. Prefer deterministic waits and resilient locators.'
      );
    }

    if (fused.domMemory && fused.domMemory.length > 0) {
      const lines = fused.domMemory
        .map(
          (d) =>
            `- ${d.page_url} (${d.page_type || 'page'}, ${d.elements_count ?? 0} elements seen)`
        )
        .join('\n');
      parts.push(
        `🎯 DOM MEMORY (previously analyzed pages):\n${lines}\n` +
          'These pages were crawled before — reuse known structure where applicable.'
      );
    }

    if (fused.learningPatterns && fused.learningPatterns.length > 0) {
      const lines = fused.learningPatterns
        .slice(0, 8)
        .map(
          (p) =>
            `- When "${p.error_pattern}" affects "${p.failed_locator}", prefer "${p.healed_locator}" (${p.solution_strategy}, ${p.success_count}× successful)`
        )
        .join('\n');
      parts.push(
        `🧠 LEARNED SUCCESS PATTERNS:\n${lines}\n` +
          'Apply these proven selector strategies when generating locators.'
      );
    }

    if (fused.similarTests && fused.similarTests.length > 0) {
      const lines = fused.similarTests
        .map(
          (s) =>
            `- ${s.pattern_name || s.pattern_type} (success rate: ${(
              (s.success_rate ?? 0) * 100
            ).toFixed(0)}%, used ${s.usage_count ?? 0}×)`
        )
        .join('\n');
      parts.push(
        `📄 SIMILAR PROVEN UI PATTERNS:\n${lines}\n` +
          'Reuse the structure of these high-success patterns where the page matches.'
      );
    }

    if (fused.rcaInsights && fused.rcaInsights.length > 0) {
      const lines = fused.rcaInsights
        .slice(0, 8)
        .map((r) => {
          const fix = r.suggested_fix ? ` → ${r.suggested_fix}` : '';
          return `- ${r.root_cause} (${r.classification})${fix}`;
        })
        .join('\n');
      parts.push(
        `🔍 KNOWN FAILURE PATTERNS (from past RCA):\n${lines}\n` +
          'Proactively avoid these root causes in the generated tests.'
      );
    }

    if (parts.length === 0) return '';

    parts.push(
      `INTELLIGENCE CONFIDENCE: ${fused.confidenceScore}/100\n` +
        `Sources Used: ${fused.fusionMetadata.sourcesUsed.join(', ') || 'none'}`
    );

    return parts.join('\n\n');
  }

  /**
   * Faithful "enhanced prompt" builder (standalone use / testing): appends the
   * full fusion context — including repository + knowledge presence — to a base
   * prompt. The route integration uses {@link buildFusionContext} instead to
   * avoid duplicating sections the engine already emits.
   */
  buildEnhancedPrompt(fused: FusedIntelligence, basePrompt: string): string {
    const ctx = this.buildFusionContext(fused);
    return ctx ? `${basePrompt}\n\n${ctx}` : basePrompt;
  }

  /**
   * Human-friendly recommendation derived from the confidence score.
   */
  static recommendationFor(confidenceScore: number): string {
    if (confidenceScore < 50) {
      return 'Low confidence. Connect a repository and add app knowledge for significantly better results.';
    }
    if (confidenceScore < 70) {
      return 'Medium confidence. Add more intelligence sources (profiles, knowledge) for better results.';
    }
    return 'High confidence. Critical intelligence sources are active.';
  }

  /* ────────────────────────── utilities ────────────────────────── */

  private safeOrigin(url: string): string | null {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }
}
