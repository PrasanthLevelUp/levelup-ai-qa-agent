/**
 * Prompt Optimizer Engine
 * =======================
 *
 * QA-first, DETERMINISTIC, ZERO-LLM-token prompt shaping.
 *
 * Motivation (measured, not guessed): reducing OUTPUT test cases barely moved
 * total tokens because the INPUT prompt is the dominant cost. The generation
 * prompt ships the ENTIRE application profile (every page/form/element), every
 * test-data set, and the full knowledge block on every run — even for a tiny
 * "User Login" requirement that only needs the login page + credential fields.
 *
 * This engine trims the *grounding context* to what the requirement's QA
 * category actually needs, BEFORE the prompt is assembled and BEFORE any model
 * call. It uses the same category classifier that drives the Scenario Planner,
 * so the pipeline stays QA-first: the deterministic layer decides what context
 * is relevant; the LLM only expands within it.
 *
 * Guarantees:
 *   • Pure & synchronous — no I/O, no LLM, no randomness.
 *   • Fail-open — if trimming would remove everything, the original context is
 *     kept (never strip the app profile down to nothing).
 *   • Additive — callers opt in; when disabled or for `generic` categories the
 *     knowledge is returned byte-for-byte unchanged (legacy behaviour).
 *   • Never invents context — it can only DROP irrelevant items, never add.
 *
 * It also exposes deterministic prompt-accounting helpers so the pipeline can
 * SHOW where prompt tokens go (requirement / app profile / knowledge / test
 * data / instructions / scenario plan) instead of reporting one opaque number.
 */

import type { QACategory } from './qa-knowledge-engine';
import { classifyQACategory } from './qa-knowledge-engine';

/* ------------------------------------------------------------------ */
/*  Token estimation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Cheap, provider-neutral token estimate. ~4 chars/token is the well-known
 * rule-of-thumb for English + JSON-ish text and is accurate enough for a
 * "where do my tokens go" breakdown (we still report the ground-truth usage
 * from the API for the real prompt/completion totals).
 */
export function estimateTokens(chars: number): number {
  if (!chars || chars < 0) return 0;
  return Math.round(chars / 4);
}

/* ------------------------------------------------------------------ */
/*  Prompt section breakdown (analytics)                               */
/* ------------------------------------------------------------------ */

/** One measured region of the assembled generation prompt. */
export interface PromptSection {
  /** Stable id (e.g. "appProfile", "instructions"). */
  key: string;
  /** Human label for UI. */
  label: string;
  /** Raw character count of the section as it appears in the prompt. */
  chars: number;
  /** Estimated tokens (chars / 4). */
  estimatedTokens: number;
  /** Percentage of the whole prompt (0-100, one decimal). */
  pctOfPrompt: number;
}

export interface PromptSectionBreakdown {
  totalChars: number;
  totalEstimatedTokens: number;
  sections: PromptSection[];
}

/**
 * Build a deterministic per-section breakdown of the assembled prompt. Accepts
 * a map of section-key → { label, text }. Sections with empty text are still
 * reported (chars 0) so the UI can show "0 — not sent this run".
 */
export function buildPromptBreakdown(
  sections: Array<{ key: string; label: string; text: string }>,
): PromptSectionBreakdown {
  const measured = sections.map((s) => ({
    key: s.key,
    label: s.label,
    chars: s.text ? s.text.length : 0,
  }));
  const totalChars = measured.reduce((a, s) => a + s.chars, 0);
  const out: PromptSection[] = measured.map((s) => ({
    key: s.key,
    label: s.label,
    chars: s.chars,
    estimatedTokens: estimateTokens(s.chars),
    pctOfPrompt: totalChars > 0 ? Math.round((s.chars / totalChars) * 1000) / 10 : 0,
  }));
  return {
    totalChars,
    totalEstimatedTokens: estimateTokens(totalChars),
    sections: out,
  };
}

/* ------------------------------------------------------------------ */
/*  Estimated cost                                                     */
/* ------------------------------------------------------------------ */

/**
 * Very rough USD cost estimate from a prompt/completion split. Rates are
 * per-1K tokens and intentionally conservative defaults; overridable via env so
 * the UI can show an at-a-glance figure without a hard dependency on the exact
 * live price. Returns 0 when tokens are unknown.
 */
export function estimateCostUsd(
  promptTokens: number,
  completionTokens: number,
  rates?: { inputPer1k?: number; outputPer1k?: number },
): number {
  const inputPer1k = rates?.inputPer1k
    ?? parseFloat(process.env['TOKEN_COST_INPUT_PER_1K'] || '0.003');
  const outputPer1k = rates?.outputPer1k
    ?? parseFloat(process.env['TOKEN_COST_OUTPUT_PER_1K'] || '0.015');
  const cost = (Math.max(0, promptTokens) / 1000) * inputPer1k
    + (Math.max(0, completionTokens) / 1000) * outputPer1k;
  // Round to 6 decimals — costs are tiny per generation.
  return Math.round(cost * 1e6) / 1e6;
}

/* ------------------------------------------------------------------ */
/*  Context trimming (the optimizer proper)                            */
/* ------------------------------------------------------------------ */

/**
 * Per-category relevance vocabulary. Used to score whether a crawled page /
 * form / element / dataset is relevant to the requirement's QA category. These
 * are HINTS, not hard filters — items are also kept when they match the
 * requirement's own tokens, so a well-named page is never dropped by accident.
 */
const CATEGORY_RELEVANCE: Record<Exclude<QACategory, 'generic'>, string[]> = {
  authentication: ['login', 'log in', 'signin', 'sign in', 'signup', 'sign up', 'register', 'auth', 'password', 'credential', 'session', 'logout', 'account', 'otp', '2fa', 'mfa', 'forgot', 'reset', 'email', 'username'],
  crud: ['create', 'add', 'new', 'edit', 'update', 'delete', 'remove', 'form', 'save', 'submit', 'record', 'detail', 'list', 'manage', 'entry'],
  search: ['search', 'filter', 'query', 'sort', 'result', 'autocomplete', 'suggest', 'facet', 'find', 'lookup'],
  checkout: ['checkout', 'cart', 'basket', 'order', 'shipping', 'address', 'place order', 'purchase', 'promo', 'coupon', 'tax', 'quantity', 'product'],
  payment: ['payment', 'pay', 'card', 'billing', 'invoice', 'transaction', 'refund', 'wallet', 'charge', 'stripe', 'cvv', 'expiry'],
  admin: ['admin', 'role', 'permission', 'access', 'rbac', 'user management', 'privilege', 'grant', 'revoke', 'settings', 'config'],
  workflow: ['workflow', 'approval', 'approve', 'reject', 'step', 'wizard', 'status', 'stage', 'transition', 'submit', 'review'],
  reporting: ['report', 'dashboard', 'analytic', 'chart', 'metric', 'kpi', 'summary', 'statistics', 'graph'],
  import: ['import', 'upload', 'bulk', 'csv', 'file', 'ingest', 'attach'],
  export: ['export', 'download', 'csv', 'pdf', 'excel', 'xlsx', 'report'],
};

/**
 * Minimum number of items of a given kind to keep even when scoring finds few
 * matches — prevents over-trimming and preserves navigational context.
 */
const KEEP_MIN = { pages: 3, forms: 3, elements: 6, testData: 2 };

/** Loose structural shapes so the optimizer stays decoupled from the engine. */
interface ProfileLike {
  pages?: Array<any>;
  forms?: Array<any>;
  keyElements?: Array<any>;
  [k: string]: any;
}
interface KnowledgeLike {
  applicationProfile?: ProfileLike;
  testData?: Array<any>;
  [k: string]: any;
}

export interface OptimizeStats {
  applied: boolean;
  category: QACategory;
  confidence: number;
  pages: { before: number; after: number };
  forms: { before: number; after: number };
  elements: { before: number; after: number };
  testData: { before: number; after: number };
  reason: string;
}

export interface OptimizeResult<K> {
  knowledge: K;
  stats: OptimizeStats;
}

/** Lowercase concatenation of the "searchable" fields of an object. */
function haystack(obj: any, fields: string[]): string {
  if (!obj) return '';
  const parts: string[] = [];
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join(' ').toLowerCase();
}

/** True when `text` contains any of the vocabulary terms. */
function matchesAny(text: string, vocab: string[]): boolean {
  for (const term of vocab) {
    if (term && text.includes(term)) return true;
  }
  return false;
}

/**
 * Trim a knowledge context to the grounding relevant for the requirement's QA
 * category. Deterministic, pure, fail-open. Returns the (shallow-cloned)
 * knowledge plus before/after stats. When `category` is generic, confidence is
 * below `minConfidence`, or the profile is small, the input is returned as-is.
 */
export function optimizeKnowledgeForCategory<K extends KnowledgeLike | undefined>(
  knowledge: K,
  requirementText: string,
  opts?: { category?: QACategory; confidence?: number; minConfidence?: number },
): OptimizeResult<K> {
  const baseStats: OptimizeStats = {
    applied: false,
    category: opts?.category ?? 'generic',
    confidence: opts?.confidence ?? 0,
    pages: { before: 0, after: 0 },
    forms: { before: 0, after: 0 },
    elements: { before: 0, after: 0 },
    testData: { before: 0, after: 0 },
    reason: 'not-applied',
  };

  if (!knowledge) {
    return { knowledge, stats: { ...baseStats, reason: 'no-knowledge' } };
  }

  // Classify here if the caller didn't supply a category (keeps the optimizer
  // usable standalone). Zero tokens.
  let category = opts?.category;
  let confidence = opts?.confidence ?? 0;
  if (!category) {
    const c = classifyQACategory({ title: '', description: requirementText } as any);
    category = c.category;
    confidence = c.confidence;
  }
  const minConfidence = opts?.minConfidence ?? 0.5;

  const ap = knowledge.applicationProfile;
  const td = knowledge.testData;
  baseStats.category = category;
  baseStats.confidence = confidence;
  baseStats.pages = { before: ap?.pages?.length ?? 0, after: ap?.pages?.length ?? 0 };
  baseStats.forms = { before: ap?.forms?.length ?? 0, after: ap?.forms?.length ?? 0 };
  baseStats.elements = { before: ap?.keyElements?.length ?? 0, after: ap?.keyElements?.length ?? 0 };
  baseStats.testData = { before: td?.length ?? 0, after: td?.length ?? 0 };

  if (category === 'generic' || confidence < minConfidence) {
    return { knowledge, stats: { ...baseStats, reason: `category=${category} confidence=${confidence} < ${minConfidence}` } };
  }

  const vocab = CATEGORY_RELEVANCE[category as Exclude<QACategory, 'generic'>] || [];
  // Requirement tokens (>=3 chars) broaden the "relevant" set so a well-named
  // page matching the requirement itself is never dropped.
  const reqTokens = (requirementText || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  const relevant = Array.from(new Set([...vocab, ...reqTokens]));

  // Nothing to trim if there is no profile and no test data.
  if (!ap && !td) {
    return { knowledge, stats: { ...baseStats, reason: 'no-profile-no-testdata' } };
  }

  const nextKnowledge: any = { ...(knowledge as any) };
  let anyTrim = false;

  /* ---- Pages ---- */
  if (ap?.pages?.length) {
    const kept = filterByRelevance(
      ap.pages,
      (p) => haystack(p, ['url', 'title', 'pageType']),
      relevant,
      KEEP_MIN.pages,
    );
    if (kept.length < ap.pages.length) anyTrim = true;
    baseStats.pages.after = kept.length;
    nextKnowledge.applicationProfile = { ...ap, pages: kept };
  }

  /* ---- Forms ---- */
  if (ap?.forms?.length) {
    const currentAp = nextKnowledge.applicationProfile ?? { ...ap };
    const kept = filterByRelevance(
      ap.forms,
      (f) => {
        const fieldText = Array.isArray(f.fields)
          ? f.fields.map((fd: any) => haystack(fd, ['name', 'label', 'type'])).join(' ')
          : '';
        return `${haystack(f, ['page', 'action', 'method'])} ${fieldText}`;
      },
      relevant,
      KEEP_MIN.forms,
    );
    if (kept.length < ap.forms.length) anyTrim = true;
    baseStats.forms.after = kept.length;
    nextKnowledge.applicationProfile = { ...currentAp, forms: kept };
  }

  /* ---- Key elements ---- */
  if (ap?.keyElements?.length) {
    const currentAp = nextKnowledge.applicationProfile ?? { ...ap };
    const kept = filterByRelevance(
      ap.keyElements,
      (e) => haystack(e, ['label', 'tag', 'selector', 'role']),
      relevant,
      KEEP_MIN.elements,
    );
    if (kept.length < ap.keyElements.length) anyTrim = true;
    baseStats.elements.after = kept.length;
    nextKnowledge.applicationProfile = { ...currentAp, keyElements: kept };
  }

  /* ---- Test data ---- */
  if (td?.length) {
    const kept = filterByRelevance(
      td,
      (d) => {
        const keys = Array.isArray(d.sampleKeys) ? d.sampleKeys.join(' ') : '';
        return `${haystack(d, ['name', 'environment'])} ${keys}`.toLowerCase();
      },
      relevant,
      KEEP_MIN.testData,
    );
    if (kept.length < td.length) anyTrim = true;
    baseStats.testData.after = kept.length;
    nextKnowledge.testData = kept;
  }

  if (!anyTrim) {
    return { knowledge, stats: { ...baseStats, reason: 'nothing-irrelevant-to-trim' } };
  }

  return {
    knowledge: nextKnowledge as K,
    stats: { ...baseStats, applied: true, reason: `trimmed to ${category}-relevant context` },
  };
}

/**
 * Keep every item whose searchable text matches the relevance vocabulary. If
 * that yields fewer than `keepMin`, top up with the earliest non-matching items
 * (preserving original order) so we never over-trim below a safe floor. If
 * nothing matches at all, keep the first `keepMin` (fail-open — never empty a
 * populated section).
 */
function filterByRelevance<T>(
  items: T[],
  toText: (item: T) => string,
  vocab: string[],
  keepMin: number,
): T[] {
  if (items.length <= keepMin) return items;

  const matched: T[] = [];
  const unmatched: T[] = [];
  for (const it of items) {
    if (matchesAny(toText(it), vocab)) matched.push(it);
    else unmatched.push(it);
  }

  if (matched.length === 0) {
    // No signal — keep a safe floor rather than everything or nothing.
    return items.slice(0, keepMin);
  }
  if (matched.length >= keepMin) return matched;

  // Top up to the floor with the earliest unmatched items.
  return [...matched, ...unmatched.slice(0, keepMin - matched.length)];
}
