/**
 * Jira Issue Key parsing, normalization & validation
 * ============================================================================
 *
 * Supports the "Import by Issue Key" flow. Users paste keys in whatever form is
 * convenient — comma-separated, newline-separated, or full Jira browse URLs —
 * and we normalize them to canonical uppercase keys BEFORE calling Jira.
 *
 * Accepted input examples (all yield ["AUTH-123", "PAY-44"]):
 *   "AUTH-123, PAY-44"
 *   "AUTH-123\nPAY-44"
 *   "https://company.atlassian.net/browse/AUTH-123, PAY-44"
 *   "auth-123 pay-44"           (lowercase + space separated)
 *
 * A valid Jira issue key is PROJECT-NUMBER where PROJECT starts with a letter
 * and continues with letters/digits, followed by a hyphen and a number:
 *   AUTH-123   ✓
 *   AUTH123    ✗ (no hyphen)
 *   123        ✗ (no project prefix)
 *   ABC-       ✗ (no issue number)
 */

/** Canonical Jira issue key shape: PROJECT-NUMBER (project may contain digits). */
export const ISSUE_KEY_REGEX = /^[A-Z][A-Z0-9]*-[0-9]+$/;

export interface ParsedIssueKeys {
  /** Unique, normalized, valid keys in first-seen order. */
  valid: string[];
  /** The raw tokens that could not be parsed into a valid key. */
  invalid: string[];
}

/**
 * Pull a candidate key out of a single token. If the token is a Jira browse
 * URL (…/browse/AUTH-123), extract the key segment; otherwise return the token
 * trimmed. The result is uppercased so "auth-123" → "AUTH-123".
 */
function extractCandidate(token: string): string {
  const trimmed = token.trim();
  if (!trimmed) return '';

  // Jira browse URL — the key is the segment after "/browse/", ignoring any
  // trailing query/hash (e.g. .../browse/AUTH-123?filter=... or #comment).
  const browseMatch = trimmed.match(/\/browse\/([A-Za-z][A-Za-z0-9]*-[0-9]+)/);
  if (browseMatch) return browseMatch[1].toUpperCase();

  // Any other URL we don't recognize → not a key.
  if (/^https?:\/\//i.test(trimmed)) return '';

  return trimmed.toUpperCase();
}

/**
 * Parse a free-form string OR an array of tokens into normalized issue keys.
 * Splits on commas, newlines and whitespace, extracts keys from URLs, uppercases,
 * validates, and de-duplicates while preserving first-seen order.
 */
export function parseIssueKeys(input: string | string[] | null | undefined): ParsedIssueKeys {
  const tokens: string[] = Array.isArray(input)
    ? input.flatMap((s) => String(s ?? '').split(/[\s,]+/))
    : String(input ?? '').split(/[\s,]+/);

  const valid: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const raw = token.trim();
    if (!raw) continue;

    const candidate = extractCandidate(raw);
    if (candidate && ISSUE_KEY_REGEX.test(candidate)) {
      if (!seen.has(candidate)) {
        seen.add(candidate);
        valid.push(candidate);
      }
    } else {
      invalid.push(raw);
    }
  }

  return { valid, invalid };
}

/** True when a single already-trimmed string is a canonical valid issue key. */
export function isValidIssueKey(key: string): boolean {
  return ISSUE_KEY_REGEX.test(key.trim().toUpperCase());
}
