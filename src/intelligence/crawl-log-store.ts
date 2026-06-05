/**
 * In-memory crawl-log store.
 *
 * The "Crawl Now" deep crawl runs fire-and-forget in the background, so there's
 * no synchronous response that carries its progress. This tiny store keeps the
 * most recent log lines per profile in memory so the dashboard can poll
 * `GET /profiles/:id/crawl-logs` and show what the crawl is doing (and, crucially,
 * *why* it captured 0 elements when something goes wrong).
 *
 * It is intentionally process-local and ephemeral — logs are lost on restart and
 * are capped per profile. This is a diagnostic aid, not durable storage.
 */

export interface CrawlLogLine {
  /** Epoch millis when the line was recorded. */
  ts: number;
  /** Human-readable message. */
  message: string;
}

export interface CrawlLogEntry {
  profileId: string;
  url?: string;
  /** 'running' | 'success' | 'error' */
  status: 'running' | 'success' | 'error';
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  error?: string;
  lines: CrawlLogLine[];
}

const MAX_LINES_PER_PROFILE = 300;
const MAX_PROFILES = 100;
const ENTRY_TTL_MS = 60 * 60 * 1000; // 1 hour

const store = new Map<string, CrawlLogEntry>();

/** Evict the oldest entries if we exceed the cap, and drop expired ones. */
function prune(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now - entry.updatedAt > ENTRY_TTL_MS) store.delete(id);
  }
  if (store.size > MAX_PROFILES) {
    const sorted = [...store.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
    for (let i = 0; i < sorted.length - MAX_PROFILES; i++) store.delete(sorted[i][0]);
  }
}

/** Begin (or restart) a crawl-log entry for a profile. Clears previous lines. */
export function startCrawlLog(profileId: string, url?: string): void {
  const now = Date.now();
  store.set(profileId, {
    profileId,
    url,
    status: 'running',
    startedAt: now,
    updatedAt: now,
    lines: [{ ts: now, message: `Crawl queued for ${url ?? profileId}` }],
  });
  prune();
}

/** Append a log line for a profile (creating the entry if missing). */
export function appendCrawlLog(profileId: string, message: string): void {
  const now = Date.now();
  let entry = store.get(profileId);
  if (!entry) {
    entry = { profileId, status: 'running', startedAt: now, updatedAt: now, lines: [] };
    store.set(profileId, entry);
  }
  entry.lines.push({ ts: now, message });
  if (entry.lines.length > MAX_LINES_PER_PROFILE) {
    entry.lines.splice(0, entry.lines.length - MAX_LINES_PER_PROFILE);
  }
  entry.updatedAt = now;
}

/** Mark a crawl as finished (success or error). */
export function finishCrawlLog(profileId: string, status: 'success' | 'error', error?: string): void {
  const now = Date.now();
  const entry = store.get(profileId);
  if (!entry) return;
  entry.status = status;
  entry.finishedAt = now;
  entry.updatedAt = now;
  if (error) entry.error = error;
  entry.lines.push({ ts: now, message: status === 'success' ? '✅ Crawl finished' : `❌ Crawl failed: ${error ?? 'unknown error'}` });
}

/** Retrieve the crawl-log entry for a profile (or null if none recorded). */
export function getCrawlLog(profileId: string): CrawlLogEntry | null {
  return store.get(profileId) ?? null;
}
