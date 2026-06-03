/**
 * Intelligence Health Score & Recommendations Engine
 * ---------------------------------------------------
 * Calculates a 0-100 health score for every intelligence source on the
 * platform, rolls them up into an overall platform-intelligence score, emits
 * actionable recommendations, and surfaces usage statistics.
 *
 * Design notes
 * ============
 * The schema for the various intelligence sources differs from one another and
 * a few "sources" shown in the UI (e.g. Flaky Tests, DOM Memory, Learning /
 * Similarity engines) do not have a dedicated table — they are derived from
 * existing tables (rca_analyses, dom_snapshots, learned_patterns,
 * selector_patterns). Schemas also drift between environments (migrations may
 * be pending). To stay resilient, **every** source calculation and stat query
 * is wrapped in try/catch so a missing table or column degrades gracefully to a
 * safe default instead of failing the whole health report.
 *
 * Scoping: company_id is always applied; project_id is applied only on tables
 * that actually carry the column. We reuse the audited DB helpers
 * (`listProfiles`, `getKnowledgeStats`, `listRepositories`) where they exist so
 * behaviour matches the rest of the API.
 */

import type { Pool } from 'pg';
import {
  listProfiles,
  getKnowledgeStats,
  listRepositories,
} from '../db/postgres';
import { logger } from '../utils/logger';

const MOD = 'intelligence-health';

/* ──────────────────────────────────────────────────────────────────────────
 *  Types
 * ──────────────────────────────────────────────────────────────────────── */

export type SourceStatus = 'excellent' | 'good' | 'fair' | 'poor' | 'missing';
export type ImpactLevel = 'critical' | 'high' | 'medium' | 'low';
export type Priority = 'critical' | 'high' | 'medium' | 'low';

export interface SourceHealth {
  score: number; // 0-100
  status: SourceStatus;
  metrics: Record<string, any>;
  impact: ImpactLevel;
  lastUpdated?: Date;
}

export interface Recommendation {
  id: string;
  priority: Priority;
  source: string;
  title: string;
  description: string;
  impact: string;
  actionUrl?: string;
  estimatedTime?: string;
}

export interface IntelligenceStats {
  scriptsGeneratedWithIntelligence: number;
  scriptsGeneratedWithoutIntelligence: number;
  healingSuccessWithIntelligence: number;
  healingSuccessWithoutIntelligence: number;
  intelligenceUsageBreakdown: Record<string, number>;
}

export interface IntelligenceSources {
  repositoryIntelligence: SourceHealth;
  applicationProfiles: SourceHealth;
  appKnowledge: SourceHealth;
  flakyTests: SourceHealth;
  domMemory: SourceHealth;
  learningEngine: SourceHealth;
  similarityEngine: SourceHealth;
  rcaIntelligence: SourceHealth;
}

export interface IntelligenceHealth {
  overall: number; // 0-100
  sources: IntelligenceSources;
  recommendations: Recommendation[];
  stats: IntelligenceStats;
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Service
 * ──────────────────────────────────────────────────────────────────────── */

export class IntelligenceHealthService {
  constructor(private pool: Pool) {}

  async calculateHealth(companyId: number, projectId?: number): Promise<IntelligenceHealth> {
    const [
      repositoryIntelligence,
      applicationProfiles,
      appKnowledge,
      flakyTests,
      domMemory,
      learningEngine,
      similarityEngine,
      rcaIntelligence,
    ] = await Promise.all([
      this.safeSource(() => this.calculateRepositoryHealth(companyId, projectId), 'critical'),
      this.safeSource(() => this.calculateProfileHealth(companyId, projectId), 'high'),
      this.safeSource(() => this.calculateKnowledgeHealth(companyId, projectId), 'high'),
      this.safeSource(() => this.calculateFlakyTestsHealth(companyId, projectId), 'medium'),
      this.safeSource(() => this.calculateDOMMemoryHealth(companyId, projectId), 'medium'),
      this.safeSource(() => this.calculateLearningEngineHealth(companyId, projectId), 'medium'),
      this.safeSource(() => this.calculateSimilarityEngineHealth(companyId, projectId), 'low'),
      this.safeSource(() => this.calculateRCAHealth(companyId, projectId), 'medium'),
    ]);

    const sources: IntelligenceSources = {
      repositoryIntelligence,
      applicationProfiles,
      appKnowledge,
      flakyTests,
      domMemory,
      learningEngine,
      similarityEngine,
      rcaIntelligence,
    };

    const overall = this.calculateOverallScore(sources);
    const recommendations = this.generateRecommendations(sources);
    const stats = await this.getUsageStats(companyId, projectId);

    return { overall, sources, recommendations, stats };
  }

  /* ───────────── source: Repository Intelligence ───────────── */

  private async calculateRepositoryHealth(companyId: number, projectId?: number): Promise<SourceHealth> {
    let repos: any[] = [];
    if (projectId) {
      try {
        repos = await listRepositories(projectId, companyId);
      } catch {
        repos = [];
      }
    }

    if (!repos || repos.length === 0) {
      return {
        score: 0,
        status: 'missing',
        metrics: { reposConnected: 0 },
        impact: 'critical',
      };
    }

    let score = 30; // base score for having a repo connected
    const metrics: Record<string, any> = { reposConnected: repos.length, hasIntelligence: false };

    // Repository scan/intelligence is stored in repository_contexts.profile (JSONB).
    let profile: any = null;
    let lastUpdated: Date | undefined;
    try {
      const conds = ['company_id = $1'];
      const vals: any[] = [companyId];
      if (projectId) {
        conds.push('project_id = $2');
        vals.push(projectId);
      }
      const ctx = await this.pool.query(
        `SELECT profile, updated_at FROM repository_contexts
         WHERE ${conds.join(' AND ')}
         ORDER BY updated_at DESC LIMIT 1`,
        vals
      );
      if (ctx.rows.length > 0) {
        const raw = ctx.rows[0].profile;
        profile = typeof raw === 'string' ? JSON.parse(raw) : raw;
        lastUpdated = ctx.rows[0].updated_at ? new Date(ctx.rows[0].updated_at) : undefined;
      }
    } catch {
      profile = null;
    }

    // Fallback: some deployments stash scan output on the repo row.
    if (!profile && repos[0]?.scan_results) {
      try {
        profile = typeof repos[0].scan_results === 'string'
          ? JSON.parse(repos[0].scan_results)
          : repos[0].scan_results;
      } catch {
        profile = null;
      }
    }

    if (profile) {
      metrics.hasIntelligence = true;

      const framework = profile.framework || profile.testingFramework || null;
      if (framework) {
        score += 15;
        metrics.framework = framework;
      }

      const patternsCount = profile.patterns?.length ?? profile.testPatterns?.length ?? 0;
      metrics.patternsCount = patternsCount;
      if (patternsCount > 0) score += 15;
      if (patternsCount > 5) score += 10;

      const helpersCount = profile.helpers?.length ?? profile.helperFunctions?.length ?? 0;
      metrics.helpersCount = helpersCount;
      if (helpersCount > 0) score += 10;

      const pageObjectsCount = profile.pageObjects?.length ?? profile.page_objects?.length ?? 0;
      metrics.pageObjectsCount = pageObjectsCount;
      if (pageObjectsCount > 0) score += 10;

      const daysSinceUpdate = lastUpdated
        ? Math.floor((Date.now() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24))
        : 999;
      metrics.daysSinceUpdate = daysSinceUpdate;
      if (daysSinceUpdate > 30) score -= 10;
      if (daysSinceUpdate > 60) score -= 10;
    }

    score = this.clamp(score);
    return {
      score,
      status: this.getStatus(score),
      metrics,
      impact: 'critical',
      lastUpdated,
    };
  }

  /* ───────────── source: Application Profiles ───────────── */

  private async calculateProfileHealth(companyId: number, projectId?: number): Promise<SourceHealth> {
    const { profiles } = await listProfiles(companyId, { projectId, limit: 200 });

    if (!profiles || profiles.length === 0) {
      return {
        score: 0,
        status: 'missing',
        metrics: { profilesCount: 0 },
        impact: 'high',
      };
    }

    const len = (v: any) => (Array.isArray(v) ? v.length : 0);

    let totalScore = 0;
    let totalScreenshots = 0;
    let totalFlows = 0;
    let totalFields = 0;

    for (const p of profiles as any[]) {
      let profileScore = 20; // base score for existing

      const screenshots = len(p.screenshots);
      totalScreenshots += screenshots;
      if (screenshots > 0) profileScore += 15;
      if (screenshots >= 3) profileScore += 10;

      const flows = len(p.business_flows);
      totalFlows += flows;
      if (flows > 0) profileScore += 15;
      if (flows >= 3) profileScore += 10;

      const fields = len(p.form_fields);
      totalFields += fields;
      if (fields > 0) profileScore += 10;
      if (fields >= 5) profileScore += 10;

      // Crawl data present
      const crawl = p.crawl_data;
      if (crawl && typeof crawl === 'object' && Object.keys(crawl).length > 0) {
        profileScore += 10;
      }

      // Recency — application_profiles uses crawled_at
      const daysSinceCrawl = p.crawled_at
        ? Math.floor((Date.now() - new Date(p.crawled_at).getTime()) / (1000 * 60 * 60 * 24))
        : 999;
      if (daysSinceCrawl > 30) profileScore -= 10;

      totalScore += this.clamp(profileScore);
    }

    const avgScore = totalScore / profiles.length;
    return {
      score: this.clamp(avgScore),
      status: this.getStatus(avgScore),
      metrics: {
        profilesCount: profiles.length,
        avgScreenshots: +(totalScreenshots / profiles.length).toFixed(1),
        avgFlows: +(totalFlows / profiles.length).toFixed(1),
        avgFormFields: +(totalFields / profiles.length).toFixed(1),
      },
      impact: 'high',
    };
  }

  /* ───────────── source: App Knowledge ───────────── */

  private async calculateKnowledgeHealth(companyId: number, projectId?: number): Promise<SourceHealth> {
    const stats = await getKnowledgeStats(companyId, projectId);
    const count = stats.total || 0;

    if (count === 0) {
      return {
        score: 0,
        status: 'missing',
        metrics: { itemsCount: 0, categoriesCount: 0 },
        impact: 'high',
      };
    }

    const categoriesCount = Object.keys(stats.byCategory || {}).length;
    let score = Math.min(80, count * 8); // 8 pts/item, capped at 80
    score += categoriesCount * 5; // diversity bonus

    score = this.clamp(score);
    return {
      score,
      status: this.getStatus(score),
      metrics: { itemsCount: count, categoriesCount },
      impact: 'high',
    };
  }

  /* ───────────── source: Flaky Tests (derived from rca_analyses) ───────────── */

  private async calculateFlakyTestsHealth(companyId: number, projectId?: number): Promise<SourceHealth> {
    const count = await this.scopedCount(
      'rca_analyses',
      { companyId, projectId },
      ['is_flaky = TRUE']
    );
    return {
      score: count > 0 ? 80 : 50,
      status: count > 0 ? 'good' : 'fair',
      metrics: { flakyTestsDetected: count },
      impact: 'medium',
    };
  }

  /* ───────────── source: DOM Memory (derived from dom_snapshots) ───────────── */

  private async calculateDOMMemoryHealth(companyId: number, projectId?: number): Promise<SourceHealth> {
    // dom_snapshots has no company/project columns; it links through
    // generated_scripts (script_id → generated_scripts.id).
    let count = 0;
    try {
      const conds = ['gs.company_id = $1'];
      const vals: any[] = [companyId];
      if (projectId) {
        conds.push('gs.project_id = $2');
        vals.push(projectId);
      }
      const r = await this.pool.query(
        `SELECT COUNT(*)::int AS c
         FROM dom_snapshots ds
         JOIN generated_scripts gs ON gs.id = ds.script_id
         WHERE ${conds.join(' AND ')}`,
        vals
      );
      count = r.rows[0]?.c || 0;
    } catch {
      count = 0;
    }
    return {
      score: count > 0 ? 85 : 60,
      status: count > 0 ? 'good' : 'fair',
      metrics: { snapshotsCaptured: count },
      impact: 'medium',
    };
  }

  /* ───────────── source: Learning Engine (derived from learned_patterns) ───────────── */

  private async calculateLearningEngineHealth(_companyId: number, _projectId?: number): Promise<SourceHealth> {
    // learned_patterns is a global pattern store (no company/project columns).
    let count = 0;
    try {
      const r = await this.pool.query(`SELECT COUNT(*)::int AS c FROM learned_patterns`);
      count = r.rows[0]?.c || 0;
    } catch {
      count = 0;
    }
    return {
      score: count > 0 ? 90 : 70,
      status: count > 0 ? 'excellent' : 'good',
      metrics: { learnedPatterns: count },
      impact: 'medium',
    };
  }

  /* ───────────── source: Similarity Engine (derived from selector_patterns) ───────────── */

  private async calculateSimilarityEngineHealth(companyId: number, projectId?: number): Promise<SourceHealth> {
    const count = await this.scopedCount('selector_patterns', { companyId, projectId });
    return {
      score: count > 0 ? 85 : 65,
      status: count > 0 ? 'good' : 'fair',
      metrics: { indexedPatterns: count },
      impact: 'low',
    };
  }

  /* ───────────── source: RCA Intelligence (rca_analyses, last 30 days) ───────────── */

  private async calculateRCAHealth(companyId: number, projectId?: number): Promise<SourceHealth> {
    const count = await this.scopedCount(
      'rca_analyses',
      { companyId, projectId },
      [`created_at > NOW() - INTERVAL '30 days'`]
    );
    return {
      score: count > 0 ? 80 : 55,
      status: count > 0 ? 'good' : 'fair',
      metrics: { recentAnalyses: count },
      impact: 'medium',
    };
  }

  /* ───────────── overall + status helpers ───────────── */

  private calculateOverallScore(sources: IntelligenceSources): number {
    const weights: Record<keyof IntelligenceSources, number> = {
      repositoryIntelligence: 25,
      applicationProfiles: 20,
      appKnowledge: 20,
      flakyTests: 10,
      domMemory: 10,
      learningEngine: 5,
      similarityEngine: 5,
      rcaIntelligence: 5,
    };

    let totalScore = 0;
    let totalWeight = 0;
    (Object.keys(weights) as (keyof IntelligenceSources)[]).forEach((key) => {
      totalScore += (sources[key]?.score ?? 0) * weights[key];
      totalWeight += weights[key];
    });

    return totalWeight === 0 ? 0 : Math.round(totalScore / totalWeight);
  }

  private getStatus(score: number): SourceStatus {
    if (score <= 0) return 'missing';
    if (score >= 80) return 'excellent';
    if (score >= 60) return 'good';
    if (score >= 40) return 'fair';
    return 'poor';
  }

  private clamp(score: number): number {
    return Math.min(100, Math.max(0, Math.round(score)));
  }

  /* ───────────── recommendations ───────────── */

  private generateRecommendations(sources: IntelligenceSources): Recommendation[] {
    const recommendations: Recommendation[] = [];

    // Repository Intelligence
    if (sources.repositoryIntelligence.score === 0) {
      recommendations.push({
        id: 'connect-repo',
        priority: 'critical',
        source: 'Repository Intelligence',
        title: 'Connect Your Repository',
        description:
          'Repository intelligence is the foundation for code-aligned test generation. Connect your test repository to match existing patterns.',
        impact: '40% improvement in code quality and consistency',
        actionUrl: '/repo-intelligence',
        estimatedTime: '15 minutes',
      });
    } else if ((sources.repositoryIntelligence.metrics.daysSinceUpdate ?? 0) > 30) {
      recommendations.push({
        id: 'rescan-repo',
        priority: 'high',
        source: 'Repository Intelligence',
        title: 'Re-scan Repository',
        description: `Repository was last scanned ${sources.repositoryIntelligence.metrics.daysSinceUpdate} days ago. Re-scan to capture the latest patterns.`,
        impact: 'Ensures generated code matches the current codebase',
        actionUrl: '/repo-intelligence',
        estimatedTime: '5 minutes',
      });
    }

    // Application Profiles
    if (sources.applicationProfiles.score === 0) {
      recommendations.push({
        id: 'create-profile',
        priority: 'high',
        source: 'Application Profiles',
        title: 'Create Application Profile',
        description:
          'Application profiles dramatically improve element targeting and healing success. Create your first profile.',
        impact: '60% improvement in healing success rate',
        actionUrl: '/profiles',
        estimatedTime: '30 minutes',
      });
    } else if ((sources.applicationProfiles.metrics.avgScreenshots ?? 0) < 3) {
      recommendations.push({
        id: 'add-screenshots',
        priority: 'medium',
        source: 'Application Profiles',
        title: 'Add Profile Screenshots',
        description:
          'Add screenshots to application profiles for better visual context and element identification.',
        impact: 'Better element targeting and visual validation',
        actionUrl: '/profiles',
        estimatedTime: '10 minutes',
      });
    }

    // App Knowledge
    if (sources.appKnowledge.score === 0) {
      recommendations.push({
        id: 'add-knowledge',
        priority: 'high',
        source: 'App Knowledge',
        title: 'Add App Knowledge Items',
        description:
          'App Knowledge provides business context to the AI. Add 10-15 items covering credentials, workflows, and domain rules.',
        impact: '35% improvement in test scenario accuracy',
        actionUrl: '/app-knowledge',
        estimatedTime: '1 hour',
      });
    } else if ((sources.appKnowledge.metrics.itemsCount ?? 0) < 10) {
      const itemsCount = sources.appKnowledge.metrics.itemsCount ?? 0;
      recommendations.push({
        id: 'expand-knowledge',
        priority: 'medium',
        source: 'App Knowledge',
        title: 'Expand App Knowledge',
        description: `You have ${itemsCount} knowledge item(s). Add ${Math.max(1, 10 - itemsCount)} more for comprehensive coverage.`,
        impact: 'Better test scenario generation',
        actionUrl: '/app-knowledge',
        estimatedTime: '30 minutes',
      });
    }

    // Flaky Tests
    if (sources.flakyTests.metrics.flakyTestsDetected === 0) {
      recommendations.push({
        id: 'enable-flaky-detection',
        priority: 'low',
        source: 'Flaky Tests',
        title: 'Run Tests to Detect Flakiness',
        description:
          'No flaky tests detected yet. Run your suite a few times so the engine can identify unstable tests.',
        impact: 'Surfaces unreliable tests that erode trust in CI',
        actionUrl: '/flaky-tests',
        estimatedTime: '20 minutes',
      });
    }

    const priorityOrder: Record<Priority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);
    return recommendations;
  }

  /* ───────────── usage stats ───────────── */

  private async getUsageStats(companyId: number, projectId?: number): Promise<IntelligenceStats> {
    const stats: IntelligenceStats = {
      scriptsGeneratedWithIntelligence: 0,
      scriptsGeneratedWithoutIntelligence: 0,
      healingSuccessWithIntelligence: 0,
      healingSuccessWithoutIntelligence: 0,
      intelligenceUsageBreakdown: {},
    };

    // Script generation: generated_scripts.intelligence_metadata (JSONB, nullable)
    try {
      const conds = ['company_id = $1'];
      const vals: any[] = [companyId];
      if (projectId) {
        conds.push('project_id = $2');
        vals.push(projectId);
      }
      const r = await this.pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE intelligence_metadata IS NOT NULL) AS with_intel,
           COUNT(*) FILTER (WHERE intelligence_metadata IS NULL)     AS without_intel
         FROM generated_scripts
         WHERE ${conds.join(' AND ')}`,
        vals
      );
      stats.scriptsGeneratedWithIntelligence = parseInt(r.rows[0]?.with_intel || '0', 10);
      stats.scriptsGeneratedWithoutIntelligence = parseInt(r.rows[0]?.without_intel || '0', 10);
    } catch (err) {
      logger.warn(MOD, 'script usage stats unavailable', { error: (err as Error).message });
    }

    // Healing success: healing_actions has success + healing_strategy (+company/project).
    // There is no explicit "intelligence used" flag, so we treat AI/pattern-assisted
    // strategies as intelligence-backed and rule-only as without.
    try {
      const conds = ['company_id = $1'];
      const vals: any[] = [companyId];
      if (projectId) {
        conds.push('project_id = $2');
        vals.push(projectId);
      }
      const r = await this.pool.query(
        `SELECT healing_strategy, COUNT(*)::int AS c
         FROM healing_actions
         WHERE ${conds.join(' AND ')} AND success = TRUE
         GROUP BY healing_strategy`,
        vals
      );
      for (const row of r.rows) {
        const strategy = String(row.healing_strategy || 'unknown').toLowerCase();
        const c = row.c as number;
        stats.intelligenceUsageBreakdown[row.healing_strategy || 'unknown'] = c;
        if (strategy.includes('rule')) {
          stats.healingSuccessWithoutIntelligence += c;
        } else {
          stats.healingSuccessWithIntelligence += c;
        }
      }
    } catch (err) {
      logger.warn(MOD, 'healing usage stats unavailable', { error: (err as Error).message });
    }

    return stats;
  }

  /* ───────────── small private utilities ───────────── */

  /**
   * Run a source calculation, returning a safe "missing/unavailable" default if
   * it throws (missing table, pending migration, etc.).
   */
  private async safeSource(
    fn: () => Promise<SourceHealth>,
    impact: ImpactLevel
  ): Promise<SourceHealth> {
    try {
      return await fn();
    } catch (err) {
      logger.warn(MOD, 'source health calculation failed; using default', {
        error: (err as Error).message,
      });
      return {
        score: 0,
        status: 'missing',
        metrics: { unavailable: true },
        impact,
      };
    }
  }

  /**
   * COUNT(*) for a table scoped by company_id (always) and project_id (only when
   * provided). Extra raw SQL conditions can be appended. Returns 0 if the table
   * or a column does not exist.
   */
  private async scopedCount(
    table: string,
    scope: { companyId: number; projectId?: number },
    extraConds: string[] = []
  ): Promise<number> {
    try {
      const conds = ['company_id = $1'];
      const vals: any[] = [scope.companyId];
      if (scope.projectId) {
        conds.push('project_id = $2');
        vals.push(scope.projectId);
      }
      conds.push(...extraConds);
      const r = await this.pool.query(
        `SELECT COUNT(*)::int AS c FROM ${table} WHERE ${conds.join(' AND ')}`,
        vals
      );
      return r.rows[0]?.c || 0;
    } catch {
      return 0;
    }
  }
}
