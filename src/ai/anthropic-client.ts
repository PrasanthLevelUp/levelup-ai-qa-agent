/**
 * Anthropic (Claude) Platform Client
 *
 * Phase 1 — Minimal Anthropic integration to validate Claude quality on the
 * generation features (Script Generation, Test Generation, Test → Script).
 *
 * This client deliberately MIRRORS the shape and responsibilities of
 * {@link ./openai-client.ts OpenAIClient} so a future migration / shared
 * provider abstraction is straightforward. It is intentionally self-contained:
 * it does NOT touch the OpenAI client, ModelSelector, cost tracker, retry
 * policy or prompt templates.
 *
 * Scope of this file:
 *   - Anthropic SDK initialization (with hard timeout, SDK retries disabled)
 *   - Model selection (friendly alias → concrete Claude model id)
 *   - Message completion (`createChatCompletion`) returning a normalized result
 *   - Semantic locator suggestion parity helper (`suggestSemanticLocator`)
 *   - Error handling + bounded retry with backoff
 *   - Logging + token-usage extraction + response parsing
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../utils/logger';

const MOD = 'anthropic-client';

/**
 * Default concrete Claude model. Kept here (not in ModelSelector) so this PR
 * does not touch shared model configuration.
 */
const DEFAULT_MODEL = 'claude-sonnet-4-5';

/**
 * Friendly aliases the rest of the codebase / env vars may use (e.g.
 * `SCRIPT_MODEL=claude-sonnet`) mapped to concrete Anthropic model ids. If the
 * provided value is already a concrete id (anything not in this map) it is used
 * verbatim, so new model ids work without a code change.
 */
const MODEL_ALIASES: Record<string, string> = {
  'claude-sonnet': 'claude-sonnet-4-5',
  'claude-opus': 'claude-opus-4-1',
  'claude-haiku': 'claude-3-5-haiku-latest',
};

/** Resolve a friendly alias (or pass through a concrete model id unchanged). */
export function resolveAnthropicModel(model?: string): string {
  if (!model) return DEFAULT_MODEL;
  return MODEL_ALIASES[model] || model;
}

/* ------------------------------------------------------------------ */
/*  Public types (mirror openai-client.ts where it overlaps)          */
/* ------------------------------------------------------------------ */

export interface LocatorSuggestionRequest {
  errorMessage: string;
  failedLine: string;
  surroundingCode: string;
  failedLocator: string;
  testName: string;
  repoContext?: string;
}

export interface LocatorSuggestionResponse {
  newLocator: string;
  confidence: number;
  reasoning: string;
  tokensUsed: number;
  model: string;
}

/** OpenAI-style chat message. System messages are supported and split out. */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Provider-neutral chat-completion parameters. The field names mirror the
 * subset of the OpenAI chat API that the generation engines actually use, so
 * call sites can route to either client with minimal change.
 */
export interface ChatCompletionParams {
  model?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /**
   * Hint that JSON output is expected. Anthropic has no native
   * `response_format`, so we satisfy this with a system nudge + assistant
   * prefill; callers already instruct JSON in their prompts.
   */
  jsonMode?: boolean;
}

/** Normalized completion result (provider-neutral). */
export interface ChatCompletionResult {
  content: string;
  tokensUsed: number;
  model: string;
}

interface AnthropicConfig {
  apiKey: string;
  model?: string;
  retries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/*  Client                                                            */
/* ------------------------------------------------------------------ */

export class AnthropicClient {
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly retries: number;

  constructor(config?: Partial<AnthropicConfig>) {
    const apiKey = config?.apiKey || process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) {
      throw new Error('ANTHROPIC_API_KEY is missing.');
    }

    // Bound every request with a hard timeout and disable the SDK's own
    // internal retries (we manage retries ourselves below) — mirrors the
    // OpenAI client's resilience posture.
    const timeoutMs = (() => {
      const v = Number(process.env['ANTHROPIC_TIMEOUT_MS']);
      return Number.isFinite(v) && v > 0 ? v : 60_000; // 60s default (gen is larger than healing)
    })();
    this.client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 });

    this.model = resolveAnthropicModel(
      config?.model || process.env['ANTHROPIC_PRIMARY_MODEL'],
    );

    const envRetries = Number(process.env['ANTHROPIC_MAX_RETRIES']);
    const resolvedRetries = config?.retries ?? (Number.isFinite(envRetries) ? envRetries : 1);
    this.retries = Number.isFinite(resolvedRetries) && resolvedRetries >= 0 ? resolvedRetries : 1;
  }

  /**
   * Provider-neutral chat completion. Accepts OpenAI-style messages (system
   * role allowed) and returns a normalized `{ content, tokensUsed, model }`.
   *
   * Bounded-retry with backoff; throws after retries are exhausted so callers
   * can implement their own fallback (e.g. OpenAI) around it.
   */
  async createChatCompletion(params: ChatCompletionParams): Promise<ChatCompletionResult> {
    const model = resolveAnthropicModel(params.model) || this.model;

    // Anthropic takes `system` as a separate top-level param; collapse all
    // system-role messages into it and pass only user/assistant turns.
    const systemParts: string[] = [];
    const turns: Anthropic.MessageParam[] = [];
    for (const m of params.messages) {
      if (m.role === 'system') {
        systemParts.push(m.content);
      } else {
        turns.push({ role: m.role, content: m.content });
      }
    }
    if (params.jsonMode) {
      systemParts.push('Respond with valid JSON only. No markdown, no code fences, no commentary.');
    }
    const system = systemParts.join('\n\n');

    // Anthropic requires max_tokens. Default conservatively if unset.
    const maxTokens = params.maxTokens && params.maxTokens > 0 ? params.maxTokens : 4000;
    const temperature = typeof params.temperature === 'number' ? params.temperature : 0.3;

    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        logger.info(MOD, 'Calling Anthropic messages API', {
          model,
          attempt: attempt + 1,
          maxTokens,
        });

        const resp = await this.client.messages.create({
          model,
          max_tokens: maxTokens,
          temperature,
          ...(system ? { system } : {}),
          messages: turns,
        });

        const content = this.extractText(resp);
        const tokensUsed = (resp.usage?.input_tokens || 0) + (resp.usage?.output_tokens || 0);

        return { content, tokensUsed, model: resp.model || model };
      } catch (error) {
        const message = (error as Error).message;
        logger.warn(MOD, 'Anthropic call failed', {
          attempt: attempt + 1,
          retries: this.retries + 1,
          error: message,
        });

        if (attempt === this.retries) {
          throw new Error(`Anthropic request failed after retries: ${message}`);
        }
        await sleep(500 * (attempt + 1));
      }
    }

    throw new Error('Unreachable Anthropic fallback path reached.');
  }

  /**
   * Semantic locator suggestion — parity with {@link OpenAIClient}. Not used by
   * the Phase 1 generation wiring (healing stays on OpenAI), but included so the
   * two clients are interchangeable for future work.
   */
  async suggestSemanticLocator(req: LocatorSuggestionRequest): Promise<LocatorSuggestionResponse> {
    const prompt = this.buildPrompt(req);
    const result = await this.createChatCompletion({
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      maxTokens: req.repoContext ? 240 : 180,
    });
    const parsed = this.parseLocatorResponse(result.content);
    return { ...parsed, tokensUsed: result.tokensUsed, model: result.model };
  }

  /* ---------------------------------------------------------------- */
  /*  Internal helpers                                                 */
  /* ---------------------------------------------------------------- */

  /** Concatenate all text blocks from an Anthropic message response. */
  private extractText(resp: Anthropic.Message): string {
    if (!resp?.content?.length) return '';
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
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

  private parseLocatorResponse(content: string): Omit<LocatorSuggestionResponse, 'tokensUsed' | 'model'> {
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
      logger.error(MOD, 'Failed to parse JSON response from Anthropic', { content: cleaned.slice(0, 500) });
      return { newLocator: '', confidence: 0, reasoning: 'Invalid JSON from model.' };
    }
  }
}

/** True when an Anthropic key is configured (cheap guard for provider routing). */
export function isAnthropicConfigured(): boolean {
  return Boolean(process.env['ANTHROPIC_API_KEY']);
}
