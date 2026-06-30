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
} from '../db/postgres';
import { knowledgeGraphService, type IntentQueryResult, type ReusableMethod } from './knowledge-graph-service';
import { logger } from '../utils/logger';

const MOD = 'intelligence-orchestrator';

/* ──────────────────────────────────────────────────────────────────────────
 *  Types
 * ────────────────────────────────────────────────────────────────────────── */

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
  /** Metadata — source breakdown, warnings, confidence */
  metadata: {
    sourcesUsed: string[];
    missingCritical: string[];
    warnings: string[];
    confidenceScore: number; // 0-100
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
   * Orchestrate intelligence gathering based on user intent.
   * Returns a compact, structured bundle ready for prompt injection.
   */
  async gatherIntelligence(query: OrchestratorQuery): Promise<OrchestratedIntelligence> {
    const start = Date.now();
    logger.info(MOD, 'Intelligence orchestration start', {
      intent: query.intent,
      caller: query.caller,
      repoContextId: query.repoContextId,
    });

    const sourcesUsed: string[] = [];
    const missingCritical: string[] = [];
    const warnings: string[] = [];

    // 1. Repository Graph — intent-based queries (relationship-traversing, not name-match)
    let repoGraph: IntentQueryResult = {
      available: false,
      intent: query.intent,
      primaryMethods: [],
      supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
      relatedFlows: [],
    };
    if (query.repoContextId) {
      try {
        repoGraph = await knowledgeGraphService.getReuseCandidatesForIntent(
          query.repoContextId,
          query.intent,
          { limit: 5, depth: 2 },
        );
        if (repoGraph.available && repoGraph.primaryMethods.length > 0) {
          sourcesUsed.push('repository-graph');
        } else {
          warnings.push('Repository graph returned no candidates for this intent');
        }
      } catch (err: any) {
        logger.warn(MOD, 'Repository graph query failed', { error: err?.message });
        warnings.push('Repository graph query failed');
      }
    } else {
      missingCritical.push('repository-context-id');
    }

    // 2. App Profile — UI structure, business flows
    let appProfile: OrchestratedIntelligence['appProfile'] = null;
    if (query.targetUrl) {
      try {
        const baseUrl = this.safeOrigin(query.targetUrl);
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
          }
        }
      } catch (err: any) {
        logger.warn(MOD, 'App profile load failed', { error: err?.message });
      }
    }

    // 3. Test Data — datasets relevant to intent
    const testData: OrchestratedIntelligence['testData'] = {
      available: false,
      datasets: [],
    };
    if (query.projectId) {
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
        }
      } catch (err: any) {
        logger.warn(MOD, 'Test data load failed', { error: err?.message });
      }
    }

    // 4. Knowledge — business rules
    let knowledge: OrchestratedIntelligence['knowledge'] = null;
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
      }
    } catch (err: any) {
      logger.warn(MOD, 'Knowledge load failed', { error: err?.message });
    }

    // 5. DOM Memory — selector history
    const domMemory: OrchestratedIntelligence['domMemory'] = {
      available: false,
      selectors: [],
    };
    if (query.targetUrl) {
      try {
        const baseUrl = this.safeOrigin(query.targetUrl);
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
          }
        }
      } catch (err: any) {
        logger.debug(MOD, 'DOM memory query failed (non-critical)', { error: err?.message });
      }
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
      }
    } catch (err: any) {
      logger.debug(MOD, 'Learned patterns query failed (non-critical)', { error: err?.message });
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

    const durationMs = Date.now() - start;
    logger.info(MOD, 'Intelligence orchestration complete', {
      intent: query.intent,
      sourcesUsed,
      confidenceScore,
      durationMs,
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
        sourcesUsed,
        missingCritical,
        warnings,
        confidenceScore,
      },
    };
  }

  /**
   * Build a compact prompt block from orchestrated intelligence.
   * This replaces the old "repository summary" approach with structured,
   * intent-scoped facts.
   */
  buildPromptContext(intel: OrchestratedIntelligence): string {
    const lines: string[] = [];

    if (!intel.available) {
      return '(No intelligence available for this request)';
    }

    lines.push(`=== INTELLIGENCE FOR: ${intel.intent.toUpperCase()} ===`);
    lines.push(`Confidence: ${intel.metadata.confidenceScore}%\n`);

    // Repository Graph — reusable code
    if (intel.repositoryGraph.available && intel.repositoryGraph.primaryMethods.length > 0) {
      lines.push('** REPOSITORY — Existing Code to Reuse **');
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
      lines.push('');
    }

    // App Profile — UI structure
    if (intel.appProfile?.available) {
      lines.push('** APP PROFILE — UI Structure **');
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
      lines.push('** TEST DATA — Available Datasets **');
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
      lines.push('** LEARNED PATTERNS — Best Practices **');
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
    return lines.join('\n');
  }

  private safeOrigin(url: string): string | null {
    try {
      return new URL(url).origin;
    } catch {
      return null;
    }
  }
}

/** Singleton instance — lazy init to avoid eagerly requiring DATABASE_URL at import time. */
let _singleton: IntelligenceOrchestrator | null = null;
export function getIntelligenceOrchestrator(): IntelligenceOrchestrator {
  if (!_singleton) _singleton = new IntelligenceOrchestrator();
  return _singleton;
}
