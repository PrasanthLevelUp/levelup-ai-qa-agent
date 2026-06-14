/**
 * Healing Intelligence Context — Sprint 2 (Healing Intelligence).
 *
 * Builds a repository-grounded evidence bundle for a single healing attempt:
 *   • Method-index hits for the failed locator / failed line (METHOD_INTELLIGENCE)
 *   • RAG-retrieved page-object / source snippets    (RAG_ENABLED + VECTOR_SEARCH)
 *
 * The bundle is consumed in two places (both flag-gated, default-OFF):
 *   1. Repository-grounded AI healing — `promptBlock` is injected into the
 *      OpenAI locator-suggestion prompt so the model can prefer selectors that
 *      already exist in the repository's page objects / helpers.
 *   2. Repository-aware confidence — `evidence` lets the orchestrator boost the
 *      confidence of a proposed locator that the repository corroborates.
 *
 * Hard contract: when `HEALING_INTELLIGENCE` is OFF this class performs ZERO
 * work and ZERO database calls — `load()` returns an empty, inert context so
 * the default healing path is byte-for-byte unchanged. Every sub-source is
 * additionally independently flag-gated, and the whole thing is wrapped in
 * try/catch so any failure degrades gracefully to "no extra context".
 */

import { FEATURE_FLAGS } from '../config/features';
import { logger } from '../utils/logger';
import { getRepositoryContextIdByRepo, type MethodSearchHit } from '../db/postgres';
import { MethodIntelligenceService } from './method-intelligence-service';
import { getRAGService, type RagExample } from './rag-service';
import type { FailureDetails } from '../core/failure-analyzer';

const MOD = 'healing-intelligence-context';

/** Inputs needed to ground a healing attempt in its repository. */
export interface HealingContextInput {
  /** Repo identifier as stored in repository_contexts.repo_id (url / full_name / id). */
  repoId: string | null | undefined;
  companyId?: number;
  projectId?: number;
  failure: FailureDetails;
}

/**
 * Boolean/numeric corroboration signals derived from the repository. Drives the
 * repository-aware confidence boost (Sprint 2.3). All default to "no evidence".
 */
export interface HealingEvidence {
  /** The failed locator / line matched a method in the repository's index. */
  methodIndexHit: boolean;
  /** A matching method is a page-object method (strongest grounding). */
  pageObjectHit: boolean;
  /** How many tests reference the best-matching method (usage_count). */
  usedByTestCount: number;
  /** RAG returned at least one similar source/page-object chunk. */
  ragHit: boolean;
  /** Similarity (0–1) of the strongest method-index hit, if any. */
  topMethodSimilarity: number;
}

/** Result of building the healing intelligence context. */
export interface HealingContextResult {
  /** Resolved repository_contexts.id, or null when unavailable. */
  contextId: number | null;
  /** Whether any repository grounding was produced. */
  hasEvidence: boolean;
  /** Method-index hits (already similarity-sorted), capped. */
  methodHits: MethodSearchHit[];
  /** RAG source/page-object examples, capped. */
  ragExamples: RagExample[];
  /** Corroboration signals for confidence scoring. */
  evidence: HealingEvidence;
  /** Prompt-ready evidence block for AI prompt injection ('' when none). */
  promptBlock: string;
}

const EMPTY_EVIDENCE: HealingEvidence = {
  methodIndexHit: false,
  pageObjectHit: false,
  usedByTestCount: 0,
  ragHit: false,
  topMethodSimilarity: 0,
};

/** A fully inert context — used for the flag-OFF / no-repo / error paths. */
export function emptyHealingContext(): HealingContextResult {
  return {
    contextId: null,
    hasEvidence: false,
    methodHits: [],
    ragExamples: [],
    evidence: { ...EMPTY_EVIDENCE },
    promptBlock: '',
  };
}

/** Page-object-ish method types — selectors here are the most trustworthy. */
const PAGE_OBJECT_TYPES = new Set(['page_object_method', 'helper']);

export class HealingIntelligenceContext {
  /** Master gate for the whole feature. */
  static isEnabled(): boolean {
    return FEATURE_FLAGS.REPO_INTELLIGENCE.HEALING_INTELLIGENCE === true;
  }

  /**
   * Build a search term from the failure. We combine the failed locator and the
   * failed line of code — both are strong signals for the relevant page object /
   * helper that owns the broken selector.
   */
  static buildSearchTerm(failure: FailureDetails): string {
    const parts = [failure.failedLocator, failure.failedLineCode]
      .map((p) => (p || '').trim())
      .filter(Boolean);
    // De-dupe if locator is a substring of the line.
    if (parts.length === 2 && parts[1].includes(parts[0])) return parts[1].slice(0, 400);
    return parts.join(' ').slice(0, 400);
  }

  /**
   * Resolve repo context + gather grounding evidence. Cheap no-op when the
   * feature flag is OFF. Never throws — degrades to an empty context.
   */
  async load(input: HealingContextInput): Promise<HealingContextResult> {
    if (!HealingIntelligenceContext.isEnabled()) return emptyHealingContext();

    const { repoId, companyId, projectId, failure } = input;
    if (!repoId) return emptyHealingContext();

    try {
      const contextId = await getRepositoryContextIdByRepo(repoId, companyId, projectId);
      if (!contextId) {
        logger.debug(MOD, 'No repository context for repo — skipping grounding', { repoId });
        return emptyHealingContext();
      }

      const term = HealingIntelligenceContext.buildSearchTerm(failure);
      if (!term) {
        return { ...emptyHealingContext(), contextId };
      }

      // Gather method-index hits and RAG examples in parallel; each is
      // independently flag-gated inside its own service and guarded here.
      const [methodHits, ragExamples] = await Promise.all([
        this.loadMethodHits(contextId, term),
        this.loadRagExamples(contextId, term),
      ]);

      const evidence = HealingIntelligenceContext.deriveEvidence(methodHits, ragExamples);
      const promptBlock = HealingIntelligenceContext.buildPromptBlock(methodHits, ragExamples);
      const hasEvidence = methodHits.length > 0 || ragExamples.length > 0;

      if (hasEvidence) {
        logger.info(MOD, 'Repository grounding assembled', {
          contextId,
          methodHits: methodHits.length,
          ragExamples: ragExamples.length,
          methodIndexHit: evidence.methodIndexHit,
          pageObjectHit: evidence.pageObjectHit,
          usedByTestCount: evidence.usedByTestCount,
        });
      }

      return { contextId, hasEvidence, methodHits, ragExamples, evidence, promptBlock };
    } catch (err: any) {
      logger.warn(MOD, 'Failed to build healing context (non-critical)', {
        error: err?.message,
        repoId,
      });
      return emptyHealingContext();
    }
  }

  /** Method-index search, guarded by its own feature flag. */
  private async loadMethodHits(contextId: number, term: string): Promise<MethodSearchHit[]> {
    if (!MethodIntelligenceService.isEnabled()) return [];
    try {
      const svc = new MethodIntelligenceService();
      return await svc.search(contextId, term, { limit: 5, minSimilarity: 0.3 });
    } catch (err: any) {
      logger.debug(MOD, 'Method-index search failed (non-critical)', { error: err?.message });
      return [];
    }
  }

  /** RAG source/page-object retrieval, guarded by the RAG service's own gate. */
  private async loadRagExamples(contextId: number, term: string): Promise<RagExample[]> {
    const rag = getRAGService();
    if (!rag.isEnabled()) return [];
    try {
      return await rag.findSimilarCode(contextId, term, { limit: 3, minSimilarity: 0.3 });
    } catch (err: any) {
      logger.debug(MOD, 'RAG retrieval failed (non-critical)', { error: err?.message });
      return [];
    }
  }

  /** Translate raw hits into the corroboration signals used for confidence. */
  static deriveEvidence(methodHits: MethodSearchHit[], ragExamples: RagExample[]): HealingEvidence {
    if (methodHits.length === 0 && ragExamples.length === 0) {
      return { ...EMPTY_EVIDENCE };
    }
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

  /**
   * Build a compact, prompt-ready evidence block. Returns '' when there is no
   * grounding so callers can concatenate unconditionally.
   */
  static buildPromptBlock(
    methodHits: MethodSearchHit[],
    ragExamples: RagExample[],
    opts: { maxMethods?: number; maxRag?: number; maxCharsPerSnippet?: number } = {},
  ): string {
    if (methodHits.length === 0 && ragExamples.length === 0) return '';

    const maxMethods = opts.maxMethods ?? 4;
    const maxRag = opts.maxRag ?? 2;
    const maxChars = opts.maxCharsPerSnippet ?? 600;

    const sections: string[] = [
      'Repository context (selectors that ALREADY exist in this codebase).',
      'Prefer reusing these real locators/methods over inventing new ones.',
    ];

    if (methodHits.length > 0) {
      sections.push('', 'Existing page-object / helper methods:');
      methodHits.slice(0, maxMethods).forEach((m, i) => {
        const sim = Math.round((m.similarity || 0) * 100);
        const loc = m.className ? `${m.className}.${m.methodName}` : m.methodName;
        const body =
          m.sourceCode && m.sourceCode.length > maxChars
            ? `${m.sourceCode.slice(0, maxChars)}\n// ...(truncated)`
            : m.sourceCode || '';
        sections.push(
          `${i + 1}. ${loc} [${m.methodType}] (${m.filePath}) — ${sim}% match, used by ${m.usageCount} test(s)`,
        );
        if (body.trim()) {
          sections.push('```', body.trim(), '```');
        }
      });
    }

    if (ragExamples.length > 0) {
      sections.push('', 'Related source / page-object snippets:');
      ragExamples.slice(0, maxRag).forEach((ex, i) => {
        const sim = Math.round((ex.similarity || 0) * 100);
        const body =
          ex.content && ex.content.length > maxChars
            ? `${ex.content.slice(0, maxChars)}\n// ...(truncated)`
            : ex.content || '';
        sections.push(`${i + 1}. ${ex.chunkName} (${ex.filePath}) — ${sim}% similar`);
        if (body.trim()) {
          sections.push('```', body.trim(), '```');
        }
      });
    }

    return sections.join('\n');
  }
}

let _instance: HealingIntelligenceContext | null = null;
/** Shared singleton (stateless — safe to reuse). */
export function getHealingIntelligenceContext(): HealingIntelligenceContext {
  if (!_instance) _instance = new HealingIntelligenceContext();
  return _instance;
}
