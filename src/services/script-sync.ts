/**
 * Script Sync (Feature C — reactive selector repair)
 * --------------------------------------------------------------------------
 * Given a generated script and the *current* crawl of the app it targets, this
 * service finds locators in the script whose underlying selector no longer
 * exists in the live DOM, computes a replacement locator (re-resolved against
 * the new crawl), and rewrites the script content with the new selectors.
 *
 * Everything here is pure & deterministic (no DB, no network) so it can be unit
 * tested in isolation. The route layer is responsible for loading the script,
 * loading the crawl, persisting the rewritten content, and (optionally) opening
 * a PR.
 */

import { computeCrawlSignature, type CrawlSignature } from './script-maintenance';
import { LocatorResolver, type CrawlDataLike } from './locator-resolver';
import { parseScriptContent, type ParsedScriptFile } from './script-file-parser';

/** A single locator rewrite proposed/applied by the sync. */
export interface SyncChange {
  /** Repo-relative file the locator lives in. */
  file: string;
  /** Original locator string found in the script. */
  oldLocator: string;
  /** Replacement locator resolved against the new crawl. */
  newLocator: string;
  /** Why the original was considered outdated. */
  reason: string;
  /** Element description (from the locator report) when available. */
  elementDescription?: string;
  /** Confidence (0–100) of the replacement locator. */
  confidence?: number;
  /** Number of times this locator was replaced across all files. */
  occurrences: number;
}

/** Result of a (dry-run or applied) sync. */
export interface SyncResult {
  changes: SyncChange[];
  outdatedCount: number;
  replacedCount: number;
  /** Selectors detected as outdated but with no confident replacement. */
  unresolved: Array<{ locator: string; elementDescription?: string; reason: string }>;
  /** Rewritten file blob (delimiter format), only when changes were applied. */
  newScriptContent?: string;
  summary: string;
}

/* -------------------------------------------------------------------------- */
/*  Selector extraction                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Pull the concrete, comparable selectors out of a Playwright locator string.
 * Mirrors the heuristic in script-maintenance so sync & health agree on what a
 * "selector" is.
 */
export function concreteSelectorsFromLocator(locator: string): string[] {
  if (!locator) return [];
  const out: string[] = [];
  const idM = /#([\w-]+)/.exec(locator);
  if (idM) out.push(`#${idM[1]}`);
  const testIdM =
    /getByTestId\(['"]([^'"]+)['"]\)/.exec(locator) ||
    /data-testid=['"]([^'"]+)['"]/.exec(locator);
  if (testIdM) out.push(`[data-testid="${testIdM[1]}"]`);
  const nameM = /\[name=['"]([^'"]+)['"]\]/.exec(locator);
  if (nameM) out.push(`[name="${nameM[1]}"]`);
  return out;
}

/** A locator literal discovered directly in a file body. */
export interface ExtractedLocator {
  file: string;
  /** The full locator expression, e.g. `page.locator('#login')`. */
  raw: string;
  concreteSelectors: string[];
}

const LOCATOR_RE =
  /page\s*\.\s*(?:locator|getByTestId|getByRole|getByText|getByLabel|getByPlaceholder)\s*\([^)]*\)/g;

/**
 * Scan parsed script files for locator expressions. Used as a fallback when the
 * stored locator report is empty.
 */
export function extractLocatorsFromFiles(files: ParsedScriptFile[]): ExtractedLocator[] {
  const out: ExtractedLocator[] = [];
  for (const f of files) {
    const body = f.content || '';
    const matches = body.match(LOCATOR_RE) || [];
    for (const raw of matches) {
      const concrete = concreteSelectorsFromLocator(raw);
      if (concrete.length) out.push({ file: f.path, raw, concreteSelectors: concrete });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Replacement                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Apply a map of `oldLocator → newLocator` literal replacements across a file
 * blob. Returns the rewritten blob and how many times each key matched.
 */
export function applyReplacements(
  content: string,
  map: Record<string, string>,
): { newContent: string; counts: Record<string, number> } {
  let newContent = content;
  const counts: Record<string, number> = {};
  for (const [oldStr, newStr] of Object.entries(map)) {
    if (!oldStr || oldStr === newStr) continue;
    let n = 0;
    // Literal (non-regex) global replacement.
    let idx = newContent.indexOf(oldStr);
    if (idx === -1) { counts[oldStr] = 0; continue; }
    const parts: string[] = [];
    let last = 0;
    while (idx !== -1) {
      parts.push(newContent.slice(last, idx), newStr);
      last = idx + oldStr.length;
      n++;
      idx = newContent.indexOf(oldStr, last);
    }
    parts.push(newContent.slice(last));
    newContent = parts.join('');
    counts[oldStr] = n;
  }
  return { newContent, counts };
}

/**
 * Re-serialise parsed files back into the `// === path ===` delimited blob.
 */
export function serializeFiles(files: ParsedScriptFile[]): string {
  return files.map((f) => `// === ${f.path} ===\n${f.content}`).join('\n\n');
}

/* -------------------------------------------------------------------------- */
/*  Core sync                                                                 */
/* -------------------------------------------------------------------------- */

/** Whether a concrete selector is still present in the new crawl signature. */
function selectorStillPresent(sig: CrawlSignature, selector: string): boolean {
  if (sig.allSelectors.includes(selector)) return true;
  // Compare on the raw value so getByTestId('x') matches [data-testid="x"] etc.
  const valM = selector.match(/["']([^"']+)["']|#([\w-]+)/);
  const val = valM ? valM[1] || valM[2] : '';
  return !!val && sig.allSelectors.some((s) => s.includes(val));
}

/**
 * Compute (and optionally apply) selector replacements for a script against a
 * fresh crawl.
 *
 * @param scriptContent   The stored script blob.
 * @param filesGenerated  Optional `files_generated` metadata (for typing).
 * @param locatorReport   The script's stored locator report (preferred source
 *                        of element descriptions). May be `{}`/null.
 * @param newCrawlData    Current crawl of the target app.
 * @param apply           When true, returns rewritten `newScriptContent`.
 */
export function syncScript(params: {
  scriptContent: string | null | undefined;
  filesGenerated?: unknown;
  locatorReport?: { locators?: Array<{ elementDescription: string; locator: string }> } | null;
  newCrawlData: CrawlDataLike;
  apply?: boolean;
}): SyncResult {
  const { scriptContent, filesGenerated, locatorReport, newCrawlData, apply } = params;
  const files = parseScriptContent(scriptContent, filesGenerated);
  const sig = computeCrawlSignature(newCrawlData as any);
  const resolver = new LocatorResolver({ crawlData: newCrawlData });

  const map: Record<string, string> = {};
  const changes: SyncChange[] = [];
  const unresolved: SyncResult['unresolved'] = [];
  let outdatedCount = 0;

  // Build the list of (locator, elementDescription) candidates. Prefer the
  // stored locator report; fall back to scanning the files directly.
  const reportLocators = (locatorReport?.locators || []).filter((l) => l && l.locator);
  const candidates: Array<{ locator: string; elementDescription?: string }> =
    reportLocators.length > 0
      ? reportLocators.map((l) => ({ locator: l.locator, elementDescription: l.elementDescription }))
      : extractLocatorsFromFiles(files).map((e) => ({ locator: e.raw }));

  const seen = new Set<string>();
  for (const cand of candidates) {
    if (seen.has(cand.locator)) continue;
    seen.add(cand.locator);

    const concrete = concreteSelectorsFromLocator(cand.locator);
    if (!concrete.length) continue; // role/text locators — resilient, skip

    const stale = concrete.filter((s) => !selectorStillPresent(sig, s));
    if (!stale.length) continue; // still valid against the new crawl

    outdatedCount++;
    const reason = `Selector(s) ${stale.join(', ')} no longer present in the latest crawl`;

    // Attempt to re-resolve a replacement using the element description.
    let replacement = '';
    let confidence = 0;
    if (cand.elementDescription) {
      const resolved = resolver.resolve(cand.elementDescription);
      if (resolved && resolved.locator && resolved.locator !== cand.locator && resolved.confidence >= 50) {
        replacement = resolved.locator;
        confidence = resolved.confidence;
      }
    }

    if (replacement) {
      map[cand.locator] = replacement;
      changes.push({
        file: '(multiple)',
        oldLocator: cand.locator,
        newLocator: replacement,
        reason,
        elementDescription: cand.elementDescription,
        confidence,
        occurrences: 0,
      });
    } else {
      unresolved.push({ locator: cand.locator, elementDescription: cand.elementDescription, reason });
    }
  }

  let newScriptContent: string | undefined;
  let replacedCount = 0;

  if (changes.length) {
    // Apply across each file so we can attribute file + occurrence counts.
    const rewritten: ParsedScriptFile[] = files.map((f) => {
      const { newContent, counts } = applyReplacements(f.content, map);
      for (const ch of changes) {
        const c = counts[ch.oldLocator] || 0;
        if (c > 0) {
          ch.occurrences += c;
          if (ch.file === '(multiple)') ch.file = f.path;
        }
      }
      return { ...f, content: newContent };
    });
    replacedCount = changes.reduce((sum, c) => sum + c.occurrences, 0);
    if (apply) newScriptContent = serializeFiles(rewritten);
  }

  const summary =
    outdatedCount === 0
      ? 'All locators are still valid against the latest crawl — no changes needed.'
      : `${outdatedCount} outdated locator(s); ${changes.length} auto-repaired, ${unresolved.length} need manual review.`;

  return { changes, outdatedCount, replacedCount, unresolved, newScriptContent, summary };
}
