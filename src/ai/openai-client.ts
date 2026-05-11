/**
 * OpenAI Client — Level 3 AI reasoning for locator healing.
 * Only called when rule-based and DB pattern strategies fail.
 * Designed for minimal token usage: sends only the error, failed line, and a small DOM snippet.
 *
 * CLI: ts-node src/ai/openai-client.ts <failure-context.json>
 * Requires: OPENAI_API_KEY env var
 */

import OpenAI from 'openai';
import * as fs from 'fs';
import { logger } from '../utils/logger';

const MOD = 'openai-client';

// ─── Types ─────────────────────────────────────────────────────

export interface AIHealRequest {
  failedLocator: string;
  errorMessage: string;
  failedCodeLine: string | null;
  domSnippet: string;        // minimal DOM around failure point
  testFileName: string;
  siteUrl: string;
}

export interface AIHealResponse {
  newLocator: string;
  confidence: number;
  reasoning: string;
  tokensUsed: number;
  model: string;
}

// ─── Prompt Construction (token-optimized) ─────────────────────

function buildPrompt(req: AIHealRequest): string {
  return `You are a Playwright test automation expert. A locator broke. Fix it.

FAILED LOCATOR: ${req.failedLocator}
ERROR: ${req.errorMessage.slice(0, 300)}
CODE LINE: ${req.failedCodeLine ?? 'N/A'}
SITE: ${req.siteUrl}

RELEVANT DOM (near failure):
${req.domSnippet.slice(0, 1500)}

Reply with ONLY a JSON object (no markdown):
{"newLocator": "page.xxx(...)", "confidence": 0.0-1.0, "reasoning": "brief explanation"}

Prefer semantic locators: getByRole > getByLabel > getByText > getByTestId > CSS.`;
}

// ─── API Call ──────────────────────────────────────────────────

export async function healWithAI(req: AIHealRequest): Promise<AIHealResponse> {
  const apiKey = process.env['OPENAI_API_KEY'];
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY not set — Level 3 healing unavailable');
  }

  const openai = new OpenAI({ apiKey });
  const prompt = buildPrompt(req);

  logger.info(MOD, 'Calling OpenAI for locator healing', {
    failedLocator: req.failedLocator,
    promptLength: prompt.length,
  });

  const response = await openai.chat.completions.create({
    model: 'gpt-4o-mini',   // cost-optimized model
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 200,          // strict limit for cost control
    temperature: 0.1,         // deterministic
  });

  const content = response.choices[0]?.message?.content ?? '';
  const tokensUsed =
    (response.usage?.prompt_tokens ?? 0) + (response.usage?.completion_tokens ?? 0);

  logger.info(MOD, `OpenAI response: ${tokensUsed} tokens used`, { model: response.model });

  // Parse the JSON response
  try {
    // Strip markdown code fences if present
    const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(cleaned) as { newLocator: string; confidence: number; reasoning: string };

    return {
      newLocator: parsed.newLocator,
      confidence: parsed.confidence,
      reasoning: parsed.reasoning,
      tokensUsed,
      model: response.model,
    };
  } catch {
    logger.error(MOD, 'Failed to parse OpenAI response', { content });
    return {
      newLocator: '',
      confidence: 0,
      reasoning: `Parse error: ${content.slice(0, 200)}`,
      tokensUsed,
      model: response.model,
    };
  }
}

// ─── CLI ───────────────────────────────────────────────────────

if (require.main === module) {
  const ctxFile = process.argv[2];
  if (!ctxFile) {
    console.error('Usage: openai-client.ts <failure-context.json>');
    console.error('  Context JSON needs: failedLocator, errorMessage, failedCodeLine, domSnippet, testFileName, siteUrl');
    process.exit(1);
  }

  (async () => {
    const ctx = JSON.parse(fs.readFileSync(ctxFile, 'utf-8')) as AIHealRequest;
    const result = await healWithAI(ctx);
    const outPath = '/tmp/ai_heal_result.json';
    fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  })();
}
