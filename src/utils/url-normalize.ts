/**
 * Canonical base-URL normalization for Application Profiles.
 *
 * WHY THIS EXISTS
 * ---------------
 * Application profiles are uniquely keyed in Postgres by
 *   (base_url, COALESCE(project_id, -1), COALESCE(company_id, 0))
 * via the `ON CONFLICT` upsert in `upsertProfile`.
 *
 * If two different write paths store the SAME logical site under two slightly
 * different `base_url` strings (e.g. "https://Example.com/" vs
 * "https://example.com"), the ON CONFLICT key does not match and Postgres
 * INSERTs a SECOND row instead of UPDATING the first. That produced the
 * "duplicate profile + original stuck in crawling" bug: the create path stored
 * the raw URL the user typed, while the crawl-completion path stored a
 * normalized URL — so the crawl result landed on a brand-new row (status
 * 'fresh') and the original row's 'crawling' status was never cleared.
 *
 * The fix is to funnel EVERY write through this single normalizer so the
 * conflict key is always computed from an identical, canonical string.
 *
 * Normalization rules (idempotent — safe to apply to an already-normalized URL):
 *   - lowercase scheme + host
 *   - drop default ports (80/443)
 *   - strip trailing slash(es) from the path (but keep a bare "/" for root)
 *   - drop query string and hash fragment
 */
export function normalizeBaseUrl(url: string): string {
  if (!url) return url;
  const trimmed = String(url).trim();
  try {
    const parsed = new URL(trimmed);
    let normalized = `${parsed.protocol}//${parsed.hostname}`;
    if (parsed.port && parsed.port !== '80' && parsed.port !== '443') {
      normalized += `:${parsed.port}`;
    }
    normalized += parsed.pathname.replace(/\/+$/, '') || '/';
    return normalized.toLowerCase();
  } catch {
    // Not an absolute URL — best-effort: strip query/hash + trailing slash, lowercase.
    return trimmed.toLowerCase().split('?')[0].split('#')[0].replace(/\/+$/, '') || trimmed.toLowerCase();
  }
}
