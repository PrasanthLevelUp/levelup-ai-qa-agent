/**
 * OpenAI Platform Client
 * Provides resilient minimal-context semantic locator suggestions.
 */

import OpenAI from 'openai';
import { logger } from '../utils/logger';

const MOD = 'openai-client';
const DEFAULT_MODEL = 'gpt-4o-mini';

export interface LocatorSuggestionRequest {
  errorMessage: string;
  failedLine: string;
  surroundingCode: string;
  failedLocator: string;
  testName: string;
  /**
   * Optional repository-grounding block (Sprint 2 — Healing Intelligence).
   * When present, lists real selectors/methods that already exist in the
   * repository so the model prefers reusing them. Built by
   * HealingIntelligenceContext and only populated when the feature is enabled;
   * absent => the prompt is byte-for-byte identical to the legacy prompt.
   */
  repoContext?: string;
}

export interface LocatorSuggestionResponse {
  newLocator: string;
  confidence: number;
  reasoning: string;
  tokensUsed: number;
  model: string;
}

interface OpenAIConfig {
  apiKey: string;
  model?: string;
  embeddingModel?: string;
  retries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAIClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly embeddingModel: string;
  private readonly retries: number;

  constructor(config?: Partial<OpenAIConfig>) {
    const apiKey = config?.apiKey || process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing.');
    }

    // Bound every OpenAI request with a hard timeout and disable the SDK's own
    // internal retries (we manage retries ourselves below). Without a timeout the
    // SDK default is ~10 min PER request with built-in retries — a single stuck
    // call could hang a healing iteration for many minutes and, multiplied across
    // the retry loops, was a contributor to runaway healing jobs.
    const timeoutMs = (() => {
      const v = Number(process.env['OPENAI_TIMEOUT_MS']);
      return Number.isFinite(v) && v > 0 ? v : 30_000; // 30s default
    })();
    this.client = new OpenAI({ apiKey, timeout: timeoutMs, maxRetries: 0 });
    this.model = config?.model || process.env['OPENAI_PRIMARY_MODEL'] || DEFAULT_MODEL;
    this.embeddingModel = config?.embeddingModel || process.env['OPENAI_EMBEDDING_MODEL'] || 'text-embedding-3-small';
    // Our own bounded retry count (default 1 = 2 total attempts).
    const envRetries = Number(process.env['OPENAI_MAX_RETRIES']);
    const resolvedRetries = config?.retries ?? (Number.isFinite(envRetries) ? envRetries : 1);
    this.retries = Number.isFinite(resolvedRetries) && resolvedRetries >= 0 ? resolvedRetries : 1;
  }

  async suggestSemanticLocator(req: LocatorSuggestionRequest): Promise<LocatorSuggestionResponse> {
    const prompt = this.buildPrompt(req);

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        logger.info(MOD, 'Calling OpenAI platform API', {
          model: this.model,
          attempt: attempt + 1,
          testName: req.testName,
        });

        const completion = await this.client.chat.completions.create({
          model: this.model,
          temperature: 0.1,
          // Slightly larger budget when grounded so the model can name the
          // reused repository selector; unchanged for the legacy path.
          max_tokens: req.repoContext ? 240 : 180,
          messages: [{ role: 'user', content: prompt }],
        });

        const content = completion.choices[0]?.message?.content || '';
        const parsed = this.parseResponse(content);
        const tokensUsed = (completion.usage?.prompt_tokens || 0) + (completion.usage?.completion_tokens || 0);

        return {
          ...parsed,
          tokensUsed,
          model: completion.model,
        };
      } catch (error) {
        const message = (error as Error).message;
        logger.warn(MOD, 'OpenAI call failed', {
          attempt: attempt + 1,
          retries: this.retries + 1,
          error: message,
        });

        if (attempt === this.retries) {
          throw new Error(`OpenAI request failed after retries: ${message}`);
        }

        await sleep(500 * (attempt + 1));
      }
    }

    throw new Error('Unreachable OpenAI fallback path reached.');
  }

  private buildPrompt(req: LocatorSuggestionRequest): string {
    const lines: string[] = [
      'Suggest a semantic Playwright locator to replace the broken one.',
      '',
      `Test: ${req.testName}`,
      `Broken locator: ${req.failedLocator}`,
      `Error: ${req.errorMessage.slice(0, 450)}`,
      `Failed line: ${req.failedLine || 'N/A'}`,
      'Surrounding code:',
      req.surroundingCode.slice(0, 1200),
    ];

    // Repository grounding (Sprint 2). Only present when the feature is enabled
    // AND the repository produced evidence — otherwise the prompt is unchanged.
    if (req.repoContext && req.repoContext.trim()) {
      lines.push(
        '',
        '----- REPOSITORY CONTEXT -----',
        req.repoContext.slice(0, 4000),
        '------------------------------',
      );
    }

    lines.push(
      '',
      'Rules:',
      '- Return ONLY JSON (no markdown).',
      '- Prefer getByRole/getByLabel/getByText/getByPlaceholder.',
      ...(req.repoContext && req.repoContext.trim()
        ? ['- Prefer a selector/method already present in the repository context above when it fits.']
        : []),
      '- Avoid CSS/XPath unless absolutely required.',
      '- Include confidence between 0 and 1.',
      '',
      'JSON schema:',
      '{"newLocator":"page.getByRole(...)","confidence":0.95,"reasoning":"short reason"}',
    );

    return lines.join('\n');
  }

  private parseResponse(content: string): Omit<LocatorSuggestionResponse, 'tokensUsed' | 'model'> {
    const cleaned = content.replace(/```json/g, '').replace(/```/g, '').trim();
    try {
      const parsed = JSON.parse(cleaned) as {
        newLocator?: string;
        confidence?: number;
        reasoning?: string;
      };

      return {
        newLocator: parsed.newLocator || '',
        confidence: Math.max(0, Math.min(1, parsed.confidence ?? 0)),
        reasoning: parsed.reasoning || 'No reasoning provided.',
      };
    } catch {
      logger.error(MOD, 'Failed to parse JSON response from OpenAI', { content: cleaned.slice(0, 500) });
      return {
        newLocator: '',
        confidence: 0,
        reasoning: 'Invalid JSON from model.',
      };
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Embedding Support (99 % cheaper than LLM calls)                   */
  /* ------------------------------------------------------------------ */

  /**
   * Generate an embedding vector for a piece of text.
   * Cost: ~$0.02 per 1 M tokens vs $0.15 per 1 M for gpt-4o-mini.
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const truncated = text.slice(0, 8000);
    try {
      logger.debug(MOD, 'Generating embedding', { model: this.embeddingModel, len: truncated.length });
      const resp = await this.client.embeddings.create({
        model: this.embeddingModel,
        input: truncated,
      });
      return resp.data[0].embedding;
    } catch (error) {
      const msg = (error as Error).message;
      logger.error(MOD, 'Embedding generation failed', { error: msg });
      throw new Error(`Failed to generate embedding: ${msg}`);
    }
  }

  /**
   * Batch-generate embeddings (up to 2 048 inputs per request).
   */
  async batchGenerateEmbeddings(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const batchSize = 2048;
    const results: number[][] = [];

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize).map((t) => t.slice(0, 8000));
      try {
        const resp = await this.client.embeddings.create({ model: this.embeddingModel, input: batch });
        results.push(...resp.data.map((d) => d.embedding));
      } catch (error) {
        const msg = (error as Error).message;
        logger.error(MOD, 'Batch embedding failed', { error: msg, batchIdx: i });
        throw new Error(`Failed to generate batch embeddings: ${msg}`);
      }
    }
    return results;
  }

  /**
   * Cosine similarity between two embedding vectors (0 = unrelated, 1 = identical).
   */
  cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
      dot  += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }
    magA = Math.sqrt(magA);
    magB = Math.sqrt(magB);
    return magA === 0 || magB === 0 ? 0 : dot / (magA * magB);
  }
}
