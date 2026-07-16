/**
 * ============================================================================
 * COVERAGE MATCH — the shared "is this concept covered?" detector
 * ============================================================================
 *
 * A single, sealed token-aware matcher used by BOTH the loss-audit harness
 * (test-case-audit.ts) and the QA-Architect scorer (qa-architect-scorer.ts),
 * so a concept is judged "covered" by exactly the same rule everywhere.
 *
 * It stems words and matches on TOKEN boundaries (equals / startsWith) rather
 * than raw substrings, which fixes naive false-negatives ("search" →
 * "searchable") WITHOUT loosening the sealed gold expectations toward the
 * generator: "all" still does NOT match inside "manually". Short tokens with
 * no significant words (e.g. "cvv", "zip") fall back to a raw substring test.
 * ============================================================================
 */

export interface MatchableExpectation {
  /** Keyword alternatives (lowercase); any one satisfied ⇒ covered. */
  match: string[];
}

const MATCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'and', 'or', 'in', 'on', 'for', 'is', 'are', 'by', 'with', 'no',
]);

export function stem(w: string): string {
  return w.replace(/(ing|edly|ed|es|s)$/i, '');
}

export function significantWords(phrase: string): string[] {
  return phrase
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !MATCH_STOPWORDS.has(w))
    .map(stem);
}

export function hayTokens(hay: string): string[] {
  return hay
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3)
    .map(stem);
}

/** A phrase word is present when a hay TOKEN equals it or begins with it
 *  (stemmed): "search"→"searchable" matches, but "all" does NOT match inside
 *  "manually" (token boundary, not raw substring). */
export function wordPresent(w: string, toks: string[]): boolean {
  return toks.some((t) => t === w || t.startsWith(w));
}

export function phraseSatisfied(phrase: string, toks: string[], rawHay: string): boolean {
  const words = significantWords(phrase);
  if (words.length === 0) return rawHay.includes(phrase); // short tokens like "cvv", "zip"
  return words.every((w) => wordPresent(w, toks));
}

/** True when any of the expectation's match phrases is satisfied by the haystack. */
export function isCovered(expectation: MatchableExpectation, hay: string): boolean {
  const toks = hayTokens(hay);
  return expectation.match.some((m) => phraseSatisfied(m, toks, hay));
}
