/**
 * DOM Similarity Engine using embeddings.
 * Cost: 99 % cheaper than LLM-based similarity.
 *
 * Use for:
 * - Finding similar locators after DOM changes
 * - Historical comparison of test failures
 * - Intelligent healing suggestions
 * - DOM pattern matching
 */

import { OpenAIClient } from './openai-client';
import { logger } from '../utils/logger';

const MOD = 'similarity-engine';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SimilarityMatch {
  item: string;
  similarity: number;
  metadata?: any;
}

export interface SimilaritySearchOptions {
  threshold?: number;
  limit?: number;
}

/* ------------------------------------------------------------------ */
/*  Engine                                                             */
/* ------------------------------------------------------------------ */

export class SimilarityEngine {
  constructor(private readonly openaiClient: OpenAIClient) {}

  /**
   * Find the most similar locators to a failed one using embeddings.
   */
  async findSimilarLocators(
    failedLocator: string,
    candidateLocators: string[],
    options: SimilaritySearchOptions = {},
  ): Promise<SimilarityMatch[]> {
    const { threshold = 0.75, limit = 10 } = options;

    logger.info(MOD, 'Finding similar locators', {
      failedLocator,
      candidates: candidateLocators.length,
      threshold,
    });

    const failedEmbedding = await this.openaiClient.generateEmbedding(failedLocator);

    const candidates = await Promise.all(
      candidateLocators.map(async (locator) => {
        const embedding = await this.openaiClient.generateEmbedding(locator);
        const similarity = this.openaiClient.cosineSimilarity(failedEmbedding, embedding);
        return { item: locator, similarity };
      }),
    );

    const matches = candidates
      .filter((c) => c.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);

    logger.info(MOD, 'Similarity search complete', {
      matches: matches.length,
      bestMatch: matches[0]?.similarity.toFixed(3),
    });

    return matches;
  }

  /**
   * Find similar error messages in historical failures (useful for RCA / flaky detection).
   */
  async findSimilarErrors(
    currentError: string,
    historicalErrors: Array<{ error: string; resolution?: string; metadata?: any }>,
    options: SimilaritySearchOptions = {},
  ): Promise<Array<SimilarityMatch & { resolution?: string }>> {
    const { threshold = 0.80, limit = 5 } = options;

    const currentEmb = await this.openaiClient.generateEmbedding(
      this.normalizeError(currentError),
    );

    const matches = await Promise.all(
      historicalErrors.map(async (item) => {
        const emb = await this.openaiClient.generateEmbedding(this.normalizeError(item.error));
        const similarity = this.openaiClient.cosineSimilarity(currentEmb, emb);
        return { item: item.error, similarity, resolution: item.resolution, metadata: item.metadata };
      }),
    );

    return matches
      .filter((m) => m.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /**
   * Find similar DOM elements for intelligent healing.
   */
  async findSimilarDOMElements(
    target: { tag: string; attributes: Record<string, string>; text?: string },
    candidates: Array<{
      tag: string;
      attributes: Record<string, string>;
      text?: string;
      selector: string;
    }>,
    options: SimilaritySearchOptions = {},
  ): Promise<Array<SimilarityMatch & { selector: string }>> {
    const { threshold = 0.70, limit = 5 } = options;

    const targetText = this.elementToText(target);
    const targetEmb = await this.openaiClient.generateEmbedding(targetText);

    const matches = await Promise.all(
      candidates.map(async (el) => {
        const emb = await this.openaiClient.generateEmbedding(this.elementToText(el));
        const similarity = this.openaiClient.cosineSimilarity(targetEmb, emb);
        return { item: this.elementToText(el), similarity, selector: el.selector };
      }),
    );

    return matches
      .filter((m) => m.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, limit);
  }

  /* ---------------------------------------------------------------- */
  /*  Helpers                                                          */
  /* ---------------------------------------------------------------- */

  private normalizeError(error: string): string {
    return error
      .toLowerCase()
      .replace(/\d+/g, 'N')
      .replace(/['"]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 1000);
  }

  private elementToText(el: { tag: string; attributes: Record<string, string>; text?: string }): string {
    const attrs = Object.entries(el.attributes)
      .map(([k, v]) => `${k}="${v}"`)
      .join(' ');
    return `<${el.tag} ${attrs}>${el.text || ''}</${el.tag}>`;
  }
}
