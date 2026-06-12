/**
 * True Reuse Engine (Repo Intelligence — Phase 3)
 *
 * Before the script generator writes a brand-new helper, the True Reuse Engine
 * checks whether an equivalent helper already exists in the indexed repository.
 * If it finds a strong match it surfaces it so the generator can *reuse* it
 * instead of producing a near-duplicate. It can also flag exact duplicates by
 * code hash and assemble a compact "available helpers" context block for the
 * generation prompt.
 *
 * It relies entirely on the data produced by the Method Intelligence Engine
 * (`repository_methods`). When that index is empty or the feature is disabled,
 * every method returns an empty / null result so generation is unchanged.
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 * Gated behind the TRUE_REUSE flag *and* the method-intelligence schema being
 * available (you can't reuse from an index that doesn't exist). Default off.
 *
 * NOTE: Adapted from a spec that referenced a non-existent `PostgresService`.
 * Uses the real functional persistence layer in `src/db/postgres.ts`.
 */

import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { FEATURE_FLAGS } from '../config/features';
import {
  isMethodIntelAvailable,
  searchMethods,
  findMethodByHash,
  type MethodSearchHit,
} from '../db/postgres';

const MOD = 'true-reuse-engine';

/** Action verbs we care about when matching test-step language to helpers. */
const ACTION_KEYWORDS: Array<{ keyword: string; pattern: RegExp }> = [
  { keyword: 'login', pattern: /\b(log\s?in|sign\s?in|authenticate|logon)\b/i },
  { keyword: 'logout', pattern: /\b(log\s?out|sign\s?out)\b/i },
  { keyword: 'click', pattern: /\b(click|press|tap|push)\b/i },
  { keyword: 'fill', pattern: /\b(fill|enter|type|input|set)\b/i },
  { keyword: 'select', pattern: /\b(select|choose|pick)\b/i },
  { keyword: 'navigate', pattern: /\b(navigate|go\s?to|open|visit|browse)\b/i },
  { keyword: 'verify', pattern: /\b(verify|assert|check|validate|expect|confirm)\b/i },
  { keyword: 'wait', pattern: /\b(wait|await|pause)\b/i },
  { keyword: 'upload', pattern: /\b(upload|attach)\b/i },
  { keyword: 'download', pattern: /\b(download|export|save)\b/i },
  { keyword: 'search', pattern: /\b(search|filter|query|find)\b/i },
  { keyword: 'add', pattern: /\b(add|create|insert|new)\b/i },
  { keyword: 'remove', pattern: /\b(remove|delete|clear)\b/i },
  { keyword: 'submit', pattern: /\b(submit|save|apply|confirm)\b/i },
  { keyword: 'cart', pattern: /\b(cart|basket|checkout)\b/i },
];

export interface ReuseSuggestion {
  method: MethodSearchHit;
  score: number;
  matchedKeywords: string[];
}

export interface DuplicateMatch {
  isDuplicate: boolean;
  existing?: MethodSearchHit;
}

export class TrueReuseEngine {
  /** Whether the reuse engine will actually do anything right now. */
  static isEnabled(): boolean {
    return FEATURE_FLAGS.REPO_INTELLIGENCE.TRUE_REUSE && isMethodIntelAvailable();
  }

  /**
   * Find an existing helper that matches a natural-language step description.
   * Returns the best suggestion above the similarity threshold, or null.
   */
  async findExistingHelper(
    description: string,
    repoContextId: number,
    opts: { minScore?: number } = {},
  ): Promise<ReuseSuggestion | null> {
    if (!TrueReuseEngine.isEnabled() || !description?.trim() || !repoContextId) return null;

    const keywords = extractActionKeywords(description);
    const searchTerms = keywords.length > 0 ? keywords : [firstSignificantWord(description)].filter(Boolean) as string[];
    if (searchTerms.length === 0) return null;

    const minScore = opts.minScore ?? 0.5;
    const candidates = new Map<number, ReuseSuggestion>();

    for (const term of searchTerms) {
      let hits: MethodSearchHit[] = [];
      try {
        hits = await searchMethods(repoContextId, term, { methodType: 'helper', limit: 10 });
        // Also consider utilities + page-object methods (broader reuse surface).
        const more = await searchMethods(repoContextId, term, { limit: 10 });
        hits = dedupeHits([...hits, ...more]);
      } catch (err) {
        logger.warn(MOD, 'searchMethods failed', { term, error: (err as Error).message });
        continue;
      }
      for (const hit of hits) {
        const score = scoreSuggestion(hit, keywords);
        const existing = candidates.get(hit.id);
        if (!existing || score > existing.score) {
          candidates.set(hit.id, {
            method: hit,
            score,
            matchedKeywords: keywordsMatchingName(hit.methodName, keywords),
          });
        }
      }
    }

    let best: ReuseSuggestion | null = null;
    for (const s of candidates.values()) {
      if (!best || s.score > best.score) best = s;
    }
    if (best && best.score >= minScore) return best;
    return null;
  }

  /**
   * Detect whether a piece of generated code is an exact duplicate (by
   * normalized hash) of an already-indexed method in the repo.
   */
  async isDuplicate(code: string, repoContextId: number): Promise<DuplicateMatch> {
    if (!TrueReuseEngine.isEnabled() || !code?.trim() || !repoContextId) {
      return { isDuplicate: false };
    }
    const hash = hashCode(code);
    try {
      const existing = await findMethodByHash(repoContextId, hash);
      return existing ? { isDuplicate: true, existing } : { isDuplicate: false };
    } catch (err) {
      logger.warn(MOD, 'findMethodByHash failed', { error: (err as Error).message });
      return { isDuplicate: false };
    }
  }

  /**
   * Build a compact prompt block listing reusable helpers relevant to the given
   * test steps. Returns '' when disabled or nothing relevant is found, so it can
   * be concatenated into a prompt unconditionally.
   */
  async buildReuseContext(
    testSteps: string[],
    repoContextId: number,
    opts: { maxHelpers?: number } = {},
  ): Promise<string> {
    if (!TrueReuseEngine.isEnabled() || !repoContextId || !Array.isArray(testSteps)) return '';

    const maxHelpers = opts.maxHelpers ?? 6;
    const picked = new Map<number, ReuseSuggestion>();

    for (const step of testSteps) {
      const suggestion = await this.findExistingHelper(step, repoContextId, { minScore: 0.45 });
      if (suggestion && !picked.has(suggestion.method.id)) {
        picked.set(suggestion.method.id, suggestion);
      }
      if (picked.size >= maxHelpers) break;
    }

    if (picked.size === 0) return '';

    const lines: string[] = [
      '## Existing Reusable Helpers (prefer these over writing new ones)',
      '',
      'The target repository already contains the following helpers. If one of',
      'them fits a step, CALL it instead of writing a new equivalent helper:',
      '',
    ];
    for (const s of picked.values()) {
      const m = s.method;
      const loc = m.className ? `${m.className} (${m.filePath})` : m.filePath;
      const sig = firstLineOf(m.sourceCode);
      lines.push(`- \`${m.methodName}\` — ${m.methodType}, in ${loc}${m.usageCount ? `, used ${m.usageCount}×` : ''}`);
      if (sig) lines.push(`    ${sig}`);
    }
    lines.push('');
    return lines.join('\n');
  }
}

/* ------------------------------------------------------------------ */
/*  Pure helpers (exported for unit testing)                          */
/* ------------------------------------------------------------------ */

/** Extract canonical action keywords present in a free-text description. */
export function extractActionKeywords(text: string): string[] {
  if (!text) return [];
  const found: string[] = [];
  for (const { keyword, pattern } of ACTION_KEYWORDS) {
    if (pattern.test(text) && !found.includes(keyword)) found.push(keyword);
  }
  return found;
}

/** Score a candidate helper: name relevance (0..1) boosted by log usage. */
export function scoreSuggestion(hit: MethodSearchHit, keywords: string[]): number {
  const matched = keywordsMatchingName(hit.methodName, keywords);
  // Base = fuzzy similarity from the index (0..1).
  let score = Math.max(0, Math.min(1, hit.similarity || 0));
  // Strong boost when the method name literally contains a matched action verb.
  if (matched.length > 0) {
    score = Math.max(score, 0.55 + 0.1 * matched.length);
  }
  // Mild usage-based boost (popular helpers are more likely the canonical one).
  const usageBoost = Math.log1p(Math.max(0, hit.usageCount || 0)) * 0.05;
  return Math.min(1, score + usageBoost);
}

function keywordsMatchingName(methodName: string, keywords: string[]): string[] {
  const lower = methodName.toLowerCase();
  return keywords.filter(k => lower.includes(k));
}

/** SHA-256 of normalized source — must match MethodIntelligenceService.hashCode. */
export function hashCode(source: string): string {
  const normalized = source.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

function dedupeHits(hits: MethodSearchHit[]): MethodSearchHit[] {
  const byId = new Map<number, MethodSearchHit>();
  for (const h of hits) {
    const prev = byId.get(h.id);
    if (!prev || (h.similarity || 0) > (prev.similarity || 0)) byId.set(h.id, h);
  }
  return Array.from(byId.values());
}

function firstSignificantWord(text: string): string | null {
  const stop = new Set(['the', 'a', 'an', 'to', 'and', 'or', 'of', 'in', 'on', 'for', 'with', 'should', 'when', 'then', 'user']);
  for (const raw of text.split(/[^A-Za-z]+/)) {
    const w = raw.trim().toLowerCase();
    if (w.length > 2 && !stop.has(w)) return w;
  }
  return null;
}

function firstLineOf(code: string): string {
  if (!code) return '';
  const line = code.split('\n').map(l => l.trim()).find(l => l.length > 0) || '';
  return line.slice(0, 160);
}
