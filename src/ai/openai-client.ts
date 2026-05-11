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
  retries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class OpenAIClient {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly retries: number;

  constructor(config?: Partial<OpenAIConfig>) {
    const apiKey = config?.apiKey || process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is missing.');
    }

    this.client = new OpenAI({ apiKey });
    this.model = config?.model || DEFAULT_MODEL;
    this.retries = config?.retries ?? 2;
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
          max_tokens: 180,
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
    return [
      'Suggest a semantic Playwright locator to replace the broken one.',
      '',
      `Test: ${req.testName}`,
      `Broken locator: ${req.failedLocator}`,
      `Error: ${req.errorMessage.slice(0, 450)}`,
      `Failed line: ${req.failedLine || 'N/A'}`,
      'Surrounding code:',
      req.surroundingCode.slice(0, 1200),
      '',
      'Rules:',
      '- Return ONLY JSON (no markdown).',
      '- Prefer getByRole/getByLabel/getByText/getByPlaceholder.',
      '- Avoid CSS/XPath unless absolutely required.',
      '- Include confidence between 0 and 1.',
      '',
      'JSON schema:',
      '{"newLocator":"page.getByRole(...)","confidence":0.95,"reasoning":"short reason"}',
    ].join('\n');
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
}
