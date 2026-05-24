/**
 * Knowledge Optimizer — Smart Knowledge Selection & Token-Efficient Formatting
 * 
 * Enterprise-grade service that scores, ranks, and formats knowledge items
 * for AI prompt injection. Prevents token bloat as knowledge bases grow by:
 * 
 * 1. Relevance Scoring — scores items by module match, category, priority, text similarity
 * 2. Smart Selection — takes top N items within a token budget
 * 3. Efficient Formatting — extracts only essential fields, summarizes long descriptions
 * 4. Category Prioritization — workflows & business_rules ranked above domain knowledge
 * 
 * Used by both Script Gen and Test Case Lab for consistent, optimized knowledge injection.
 */

import { logger } from '../utils/logger';

const MOD = 'knowledge-optimizer';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface KnowledgeItem {
  id: number;
  category: string;
  title: string;
  description: string;
  tags: string[];
  related_modules?: string[];
  relatedModules?: string[];
  priority: string;
  metadata?: Record<string, any>;
}

export interface ScoredKnowledgeItem extends KnowledgeItem {
  relevanceScore: number;
  scoreBreakdown: {
    moduleMatch: number;
    priorityBoost: number;
    categoryBoost: number;
    relatedModuleMention: number;
    tagMatch: number;
    textRelevance: number;
  };
}

export interface OptimizationContext {
  module?: string;
  testDescription?: string;
  framework?: string;
  url?: string;
  testTypes?: string[];
  tags?: string[];
}

export interface OptimizationOptions {
  maxTokens?: number;       // Default: 1500
  maxItems?: number;        // Default: 7
  minRelevanceScore?: number; // Default: 2
  format?: 'script-gen' | 'test-case-lab'; // Controls formatting style
}

export interface OptimizedKnowledge {
  formattedContext: string;
  selectedItems: ScoredKnowledgeItem[];
  stats: {
    totalCandidates: number;
    selectedCount: number;
    estimatedTokens: number;
    avgRelevanceScore: number;
    topCategories: string[];
  };
}

/* -------------------------------------------------------------------------- */
/*  Category Configuration                                                    */
/* -------------------------------------------------------------------------- */

/** Category priority for script generation — higher = more relevant */
const CATEGORY_WEIGHTS: Record<string, number> = {
  workflow: 5,
  business_rule: 5,
  bug_pattern: 4,
  integration: 3,
  automation: 3,
  architecture: 2,
  dependency: 2,
  manual_test: 1,
  domain: 1,
};

/** Priority boost values */
const PRIORITY_WEIGHTS: Record<string, number> = {
  critical: 5,
  high: 3,
  medium: 1,
  low: 0,
};

/** Category labels for formatted output */
const CATEGORY_LABELS: Record<string, string> = {
  business_rule: 'Business Rules',
  workflow: 'Workflows',
  bug_pattern: 'Known Bug Patterns',
  integration: 'Integration Points',
  automation: 'Existing Automation',
  architecture: 'Architecture Context',
  dependency: 'Dependencies',
  manual_test: 'Manual Test Coverage',
  domain: 'Domain Knowledge',
};

/** Category prompt instructions for script gen */
const CATEGORY_INSTRUCTIONS: Record<string, string> = {
  business_rule: 'validate these rules in assertions',
  workflow: 'test each step and transitions',
  bug_pattern: 'create regression tests for these',
  integration: 'test boundary conditions',
  automation: 'avoid duplicating, extend coverage',
  architecture: 'consider technical constraints',
  dependency: 'verify integration stability',
  manual_test: 'automate these manual checks',
  domain: 'use domain terminology in tests',
};

/* -------------------------------------------------------------------------- */
/*  Knowledge Optimizer                                                       */
/* -------------------------------------------------------------------------- */

export class KnowledgeOptimizer {

  /**
   * Score a single knowledge item's relevance to the given context.
   */
  scoreRelevance(item: KnowledgeItem, context: OptimizationContext): ScoredKnowledgeItem {
    const breakdown = {
      moduleMatch: 0,
      priorityBoost: 0,
      categoryBoost: 0,
      relatedModuleMention: 0,
      tagMatch: 0,
      textRelevance: 0,
    };

    const modules = item.related_modules || item.relatedModules || [];

    // Module match: exact match in related_modules array (+10)
    if (context.module) {
      const moduleLower = context.module.toLowerCase();
      if (modules.some(m => m.toLowerCase() === moduleLower)) {
        breakdown.moduleMatch = 10;
      } else if (modules.some(m => m.toLowerCase().includes(moduleLower) || moduleLower.includes(m.toLowerCase()))) {
        breakdown.moduleMatch = 5; // partial module match
      }
    }

    // Priority boost (+0 to +5)
    breakdown.priorityBoost = PRIORITY_WEIGHTS[item.priority] ?? 0;

    // Category boost (+0 to +5)
    breakdown.categoryBoost = CATEGORY_WEIGHTS[item.category] ?? 0;

    // Related module mention in test description (+2)
    if (context.testDescription && modules.length > 0) {
      const descLower = context.testDescription.toLowerCase();
      if (modules.some(m => descLower.includes(m.toLowerCase()))) {
        breakdown.relatedModuleMention = 2;
      }
    }

    // Tag match: check if item tags match context tags, test types, or appear in description (+1 per match, max 3)
    const contextTerms = new Set<string>();
    if (context.tags) context.tags.forEach(t => contextTerms.add(t.toLowerCase()));
    if (context.testTypes) context.testTypes.forEach(t => contextTerms.add(t.toLowerCase()));
    if (context.framework) contextTerms.add(context.framework.toLowerCase());

    if (item.tags?.length && contextTerms.size > 0) {
      let tagMatches = 0;
      for (const tag of item.tags) {
        if (contextTerms.has(tag.toLowerCase())) {
          tagMatches++;
        }
      }
      breakdown.tagMatch = Math.min(tagMatches, 3);
    }

    // Text relevance: keyword overlap between item title/description and test description (+0 to +5)
    if (context.testDescription) {
      breakdown.textRelevance = this.computeTextRelevance(
        item.title + ' ' + item.description,
        context.testDescription,
      );
    }

    // URL-based relevance: if URL path segments match item keywords
    if (context.url) {
      const urlSegments = this.extractUrlKeywords(context.url);
      const itemText = (item.title + ' ' + item.tags?.join(' ')).toLowerCase();
      for (const seg of urlSegments) {
        if (itemText.includes(seg)) {
          breakdown.textRelevance = Math.min(breakdown.textRelevance + 1, 5);
        }
      }
    }

    const totalScore = breakdown.moduleMatch + breakdown.priorityBoost +
      breakdown.categoryBoost + breakdown.relatedModuleMention +
      breakdown.tagMatch + breakdown.textRelevance;

    return {
      ...item,
      relevanceScore: totalScore,
      scoreBreakdown: breakdown,
    };
  }

  /**
   * Filter, rank, and select the most relevant knowledge items within a token budget.
   */
  selectRelevantKnowledge(
    items: KnowledgeItem[],
    context: OptimizationContext,
    options: OptimizationOptions = {},
  ): OptimizedKnowledge {
    const maxTokens = options.maxTokens ?? 1500;
    const maxItems = options.maxItems ?? 7;
    const minScore = options.minRelevanceScore ?? 2;
    const format = options.format ?? 'script-gen';

    if (!items || items.length === 0) {
      return {
        formattedContext: '',
        selectedItems: [],
        stats: {
          totalCandidates: 0,
          selectedCount: 0,
          estimatedTokens: 0,
          avgRelevanceScore: 0,
          topCategories: [],
        },
      };
    }

    // Score all items
    const scored = items.map(item => this.scoreRelevance(item, context));

    // Filter by minimum relevance score
    const relevant = scored.filter(item => item.relevanceScore >= minScore);

    // Sort by relevance (descending), then by priority, then by category weight
    relevant.sort((a, b) => {
      if (b.relevanceScore !== a.relevanceScore) return b.relevanceScore - a.relevanceScore;
      const aPri = PRIORITY_WEIGHTS[a.priority] ?? 0;
      const bPri = PRIORITY_WEIGHTS[b.priority] ?? 0;
      if (bPri !== aPri) return bPri - aPri;
      const aCat = CATEGORY_WEIGHTS[a.category] ?? 0;
      const bCat = CATEGORY_WEIGHTS[b.category] ?? 0;
      return bCat - aCat;
    });

    // Select top items within token budget
    const selected: ScoredKnowledgeItem[] = [];
    let estimatedTokens = 0;

    for (const item of relevant) {
      if (selected.length >= maxItems) break;

      const itemTokens = this.estimateTokens(item, format);
      if (estimatedTokens + itemTokens > maxTokens && selected.length > 0) {
        break; // Don't exceed budget (but always include at least 1 item)
      }

      selected.push(item);
      estimatedTokens += itemTokens;
    }

    // If no items passed the min score filter, take the top 3 anyway
    // (they might still be useful even if not highly relevant)
    if (selected.length === 0 && scored.length > 0) {
      const fallback = scored.slice(0, Math.min(3, scored.length));
      for (const item of fallback) {
        const itemTokens = this.estimateTokens(item, format);
        if (estimatedTokens + itemTokens > maxTokens && selected.length > 0) break;
        selected.push(item);
        estimatedTokens += itemTokens;
      }
    }

    // Format the selected knowledge
    const formattedContext = format === 'script-gen'
      ? this.formatForScriptGen(selected)
      : this.formatForTestCaseLab(selected);

    // Compute stats
    const categories = [...new Set(selected.map(i => i.category))];
    const avgScore = selected.length > 0
      ? selected.reduce((sum, i) => sum + i.relevanceScore, 0) / selected.length
      : 0;

    logger.info(MOD, 'Knowledge optimization complete', {
      totalCandidates: items.length,
      passedFilter: relevant.length,
      selected: selected.length,
      estimatedTokens,
      avgRelevanceScore: avgScore.toFixed(1),
      topCategories: categories,
    });

    return {
      formattedContext,
      selectedItems: selected,
      stats: {
        totalCandidates: items.length,
        selectedCount: selected.length,
        estimatedTokens,
        avgRelevanceScore: Math.round(avgScore * 10) / 10,
        topCategories: categories,
      },
    };
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Formatting                                                              */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Format knowledge for Script Gen prompts — concise, action-oriented bullets.
   */
  formatForScriptGen(items: ScoredKnowledgeItem[]): string {
    if (items.length === 0) return '';

    // Group by category
    const groups = new Map<string, ScoredKnowledgeItem[]>();
    for (const item of items) {
      const list = groups.get(item.category) || [];
      list.push(item);
      groups.set(item.category, list);
    }

    const sections: string[] = [];

    // Sort categories by weight (most important first)
    const sortedCategories = [...groups.entries()].sort((a, b) => {
      return (CATEGORY_WEIGHTS[b[0]] ?? 0) - (CATEGORY_WEIGHTS[a[0]] ?? 0);
    });

    for (const [category, catItems] of sortedCategories) {
      const label = CATEGORY_LABELS[category] || category;
      const instruction = CATEGORY_INSTRUCTIONS[category] || 'incorporate into tests';
      const bullets = catItems.map(item => {
        const desc = this.summarizeDescription(item.description, 150);
        const priority = item.priority === 'critical' || item.priority === 'high'
          ? ` [${item.priority.toUpperCase()}]` : '';
        return `  - ${item.title}${priority}: ${desc}`;
      }).join('\n');
      sections.push(`${label} (${instruction}):\n${bullets}`);
    }

    return sections.join('\n\n');
  }

  /**
   * Format knowledge for Test Case Lab prompts — preserves more detail for test case generation.
   */
  formatForTestCaseLab(items: ScoredKnowledgeItem[]): string {
    if (items.length === 0) return '';

    const groups = new Map<string, ScoredKnowledgeItem[]>();
    for (const item of items) {
      const list = groups.get(item.category) || [];
      list.push(item);
      groups.set(item.category, list);
    }

    const sections: string[] = [];

    const sortedCategories = [...groups.entries()].sort((a, b) => {
      return (CATEGORY_WEIGHTS[b[0]] ?? 0) - (CATEGORY_WEIGHTS[a[0]] ?? 0);
    });

    for (const [category, catItems] of sortedCategories) {
      const label = CATEGORY_LABELS[category] || category;
      const instruction = CATEGORY_INSTRUCTIONS[category] || 'incorporate into test cases';
      const bullets = catItems.map(item => {
        const desc = this.summarizeDescription(item.description, 250);
        const priority = item.priority === 'critical' || item.priority === 'high'
          ? ` [${item.priority.toUpperCase()}]` : '';
        const tags = item.tags?.length ? ` (tags: ${item.tags.slice(0, 5).join(', ')})` : '';
        return `  - [${item.priority.toUpperCase()}] ${item.title}: ${desc}${tags}`;
      }).join('\n');
      sections.push(`${label} (${instruction}):\n${bullets}`);
    }

    return sections.join('\n\n');
  }

  /* ──────────────────────────────────────────────────────────────────────── */
  /*  Helpers                                                                 */
  /* ──────────────────────────────────────────────────────────────────────── */

  /**
   * Estimate token count for a knowledge item in the prompt.
   * Uses the ~4 chars per token heuristic for English text.
   */
  private estimateTokens(item: KnowledgeItem, format: string): number {
    const descLength = format === 'script-gen' ? 150 : 250;
    const desc = this.summarizeDescription(item.description, descLength);
    const text = `${item.title}: ${desc} ${item.tags?.join(', ') || ''}`;
    return Math.ceil(text.length / 4);
  }

  /**
   * Summarize a description to a max character length, breaking at sentence boundaries.
   */
  private summarizeDescription(description: string, maxChars: number): string {
    if (!description) return '';
    if (description.length <= maxChars) return description.trim();

    // Try to break at sentence boundary
    const truncated = description.slice(0, maxChars);
    const lastPeriod = truncated.lastIndexOf('.');
    const lastSemicolon = truncated.lastIndexOf(';');
    const breakPoint = Math.max(lastPeriod, lastSemicolon);

    if (breakPoint > maxChars * 0.5) {
      return truncated.slice(0, breakPoint + 1).trim();
    }

    // Fall back to word boundary
    const lastSpace = truncated.lastIndexOf(' ');
    if (lastSpace > maxChars * 0.7) {
      return truncated.slice(0, lastSpace).trim() + '...';
    }

    return truncated.trim() + '...';
  }

  /**
   * Compute text relevance score (0-5) based on keyword overlap.
   */
  private computeTextRelevance(itemText: string, contextText: string): number {
    if (!itemText || !contextText) return 0;

    // Extract significant keywords (>3 chars, not stop words)
    const stopWords = new Set([
      'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
      'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'would',
      'this', 'that', 'with', 'from', 'they', 'will', 'each', 'make',
      'should', 'could', 'when', 'what', 'there', 'their', 'which', 'about',
      'test', 'testing', 'should', 'must', 'also', 'into', 'more', 'than',
    ]);

    const extractKeywords = (text: string): Set<string> => {
      return new Set(
        text.toLowerCase()
          .replace(/[^a-z0-9\s]/g, ' ')
          .split(/\s+/)
          .filter(w => w.length > 3 && !stopWords.has(w))
      );
    };

    const itemKeywords = extractKeywords(itemText);
    const contextKeywords = extractKeywords(contextText);

    if (contextKeywords.size === 0) return 0;

    let matches = 0;
    for (const word of contextKeywords) {
      if (itemKeywords.has(word)) matches++;
    }

    // Scale to 0-5 based on match ratio
    const ratio = matches / contextKeywords.size;
    return Math.min(Math.round(ratio * 10), 5);
  }

  /**
   * Extract meaningful keywords from a URL path.
   */
  private extractUrlKeywords(url: string): string[] {
    try {
      const parsed = new URL(url);
      return parsed.pathname
        .split('/')
        .filter(s => s.length > 2)
        .map(s => s.toLowerCase().replace(/[-_]/g, ' '))
        .flatMap(s => s.split(' '))
        .filter(s => s.length > 2);
    } catch {
      return [];
    }
  }
}
