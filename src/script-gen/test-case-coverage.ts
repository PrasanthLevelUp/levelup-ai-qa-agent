/**
 * Test-Case Page-Coverage
 * ────────────────────────────────────────────────────────────────────────────
 * Locator grounding only works when the crawl (App Profile) actually contains
 * the DOM of the page a test case operates on. A login test case navigates to
 * `/login` and references `input[name='email']` — if the cached profile only
 * captured the site's home page, EVERY selector silently falls back and the UI
 * dishonestly reports "cached real DOM · REAL LOCATORS 0/N".
 *
 * These pure helpers let Script Generation:
 *   1. discover WHICH pages a set of test cases actually touch
 *      (`deriveTestCaseTargetUrls`), and
 *   2. check whether a crawl/profile already covers those pages
 *      (`profileCoversTargets`).
 *
 * With this the engine can seed the missing URLs into the crawl (so grounding
 * has the real DOM) and the route can invalidate a cache that doesn't cover the
 * pages the test cases need — instead of grounding login selectors against a
 * home-page-only profile.
 *
 * Everything here is deterministic and dependency-free so it is trivially
 * unit-testable without a browser.
 */

/** A minimal shape for the test cases we read (steps + text fields). */
export interface CoverageTestCaseLike {
  steps?: unknown;
  preconditions?: unknown;
  expected_result?: unknown;
  title?: unknown;
}

/** Normalize a URL (or path) to a canonical `pathname` for comparison. */
export function normalizeUrlPath(input: string, baseUrl?: string): string | null {
  const raw = (input || '').trim();
  if (!raw) return null;
  try {
    // Absolute URL.
    const u = new URL(raw);
    return stripTrailingSlash(u.pathname) || '/';
  } catch {
    // Relative path (or garbage). Only accept things that look like a path.
    if (baseUrl) {
      try {
        const u = new URL(raw, baseUrl);
        return stripTrailingSlash(u.pathname) || '/';
      } catch {
        /* fall through */
      }
    }
    if (raw.startsWith('/')) return stripTrailingSlash(raw.split(/[?#]/)[0]!) || '/';
    return null;
  }
}

function stripTrailingSlash(p: string): string {
  if (!p) return p;
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Flatten the many step shapes (string, array of strings/objects) to lines. */
function stepsToLines(steps: unknown): string[] {
  let s: any = steps;
  if (typeof s === 'string') {
    try {
      s = JSON.parse(s);
    } catch {
      /* keep as string */
    }
  }
  if (Array.isArray(s)) {
    return s
      .map((x: any) =>
        typeof x === 'string' ? x : (x?.action ?? x?.step ?? x?.description ?? ''),
      )
      .map((x: any) => String(x))
      .filter(Boolean);
  }
  if (typeof s === 'string') return s.split(/\r?\n/).filter(Boolean);
  return [];
}

// Matches absolute URLs (http/https) and bare same-origin paths like `/login`.
const ABS_URL_RE = /https?:\/\/[^\s"'()<>]+/gi;
const REL_PATH_RE = /(?:^|[\s("'])(\/[a-z0-9][a-z0-9._~\-/]*)/gi;

/**
 * Extract the distinct set of page URLs a batch of test cases actually visits.
 * Reads navigation intent from steps, preconditions and expected results
 * (e.g. "Navigate to the Login page (https://site/login)" → "https://site/login").
 *
 * The returned URLs are absolute (resolved against `baseUrl` when the source
 * was a relative path) and de-duplicated by pathname, with the baseUrl's own
 * page filtered out (it is always crawled).
 */
export function deriveTestCaseTargetUrls(
  testCases: CoverageTestCaseLike[],
  baseUrl: string,
): string[] {
  if (!Array.isArray(testCases) || testCases.length === 0) return [];

  let base: URL | null = null;
  try {
    base = new URL(baseUrl);
  } catch {
    base = null;
  }
  const basePath = base ? stripTrailingSlash(base.pathname) || '/' : '/';

  const byPath = new Map<string, string>(); // pathname → absolute URL

  const consider = (rawUrl: string) => {
    const trimmed = rawUrl.replace(/[).,;'"]+$/, '').trim();
    if (!trimmed) return;
    let abs: URL | null = null;
    try {
      abs = new URL(trimmed);
    } catch {
      if (base) {
        try {
          abs = new URL(trimmed, base.origin);
        } catch {
          abs = null;
        }
      }
    }
    if (!abs) return;
    // Same-origin only — never crawl a third-party URL mentioned in prose.
    if (base && abs.origin !== base.origin) return;
    const path = stripTrailingSlash(abs.pathname) || '/';
    if (path === basePath) return; // baseUrl page is always crawled
    if (!byPath.has(path)) {
      abs.hash = '';
      byPath.set(path, abs.toString());
    }
  };

  for (const tc of testCases) {
    const text = [
      ...stepsToLines(tc.steps),
      ...(tc.preconditions != null ? [String(tc.preconditions)] : []),
      ...(tc.expected_result != null ? [String(tc.expected_result)] : []),
    ].join('\n');
    if (!text) continue;

    let m: RegExpExecArray | null;
    ABS_URL_RE.lastIndex = 0;
    while ((m = ABS_URL_RE.exec(text)) !== null) consider(m[0]);

    REL_PATH_RE.lastIndex = 0;
    while ((m = REL_PATH_RE.exec(text)) !== null) {
      if (m[1]) consider(m[1]);
    }
  }

  return Array.from(byPath.values());
}

/** Collect every page URL present in a crawl/profile payload (any shape). */
export function collectCrawledUrls(crawlData: any): string[] {
  if (!crawlData) return [];
  const urls: string[] = [];
  const push = (u: unknown) => {
    if (typeof u === 'string' && u) urls.push(u);
  };
  push(crawlData.url);
  push(crawlData.finalUrl);
  // Multi-page profile blobs record the entry page under `entryUrl` (see
  // CrawlOrchestrator.saveDeepCrawlResult) rather than `url`.
  push(crawlData.entryUrl);
  push(crawlData.baseUrl);
  if (Array.isArray(crawlData.pages)) {
    for (const p of crawlData.pages) {
      push(p?.url);
      push(p?.finalUrl);
    }
  }
  return urls;
}

/**
 * Given a crawl/profile payload and the URLs a test batch needs, report which
 * target pages are covered by the crawl and which are missing. Comparison is by
 * normalized pathname so `https://site/login` matches a crawled
 * `https://site/login/` (or with a query string).
 */
export function profileCoversTargets(
  crawlData: any,
  targetUrls: string[],
): { covered: string[]; missing: string[] } {
  const covered: string[] = [];
  const missing: string[] = [];
  if (!Array.isArray(targetUrls) || targetUrls.length === 0) {
    return { covered, missing };
  }
  const crawledPaths = new Set(
    collectCrawledUrls(crawlData)
      .map((u) => normalizeUrlPath(u))
      .filter((p): p is string => !!p),
  );
  for (const t of targetUrls) {
    const path = normalizeUrlPath(t);
    if (path && crawledPaths.has(path)) covered.push(t);
    else missing.push(t);
  }
  return { covered, missing };
}
