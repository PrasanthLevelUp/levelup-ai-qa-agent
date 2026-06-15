/**
 * Profile Diff (Change) Engine — App Profile Versioning & Change Intelligence
 * ----------------------------------------------------------------------------
 * The App Profile is the platform's System of Record for "what the app looks
 * like". This module turns two crawl snapshots into a *structured, human- and
 * machine-readable change set* so the rest of the platform can answer:
 *
 *   • What pages / elements / forms were added or removed?
 *   • Which locators *changed* (same logical element, new selector)?
 *   • Did navigation change?
 *   • How much of the app have we actually covered?
 *
 * Design goals (mirrors script-maintenance.ts):
 *   - PURE / side-effect free (no DB, no network) → trivially unit-testable.
 *   - Graceful degradation: malformed / partial crawl data yields lower-fidelity
 *     results rather than throwing.
 *   - BACKWARD COMPATIBLE: `computeProfileSignature` returns a *superset* of the
 *     legacy `CrawlSignature` (script-maintenance.ts), so anything that already
 *     reads a stored snapshot signature keeps working.
 *
 * The enriched signature additionally carries a stable, selector-independent
 * *identity key* per element. That identity is what lets us detect a
 * LOCATOR_CHANGED (e.g. `#loginBtn` → `[data-testid="login"]`) — the same
 * logical control whose selector moved — which is the single most valuable
 * signal for self-healing.
 */

import { computeCrawlSignature, type CrawlSignature } from './script-maintenance';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/** A single element captured for change tracking, keyed by a stable identity. */
export interface ElementSignature {
  /** Stable, selector-independent identity (tag + semantic label + type/role). */
  key: string;
  /** The recommended/best selector for this element at crawl time. */
  selector: string;
  /** Short visible text / label (for human-readable change rows). */
  text: string;
  tag: string;
  role?: string;
}

/** Per-page enriched signature (superset of script-maintenance PageSignature). */
export interface ProfilePageSignature {
  url: string;
  pageType: string;
  selectors: string[];
  elementCount: number;
  formCount: number;
  /** Identity-keyed elements for change detection. */
  elements: ElementSignature[];
  /** Same-origin navigation targets discovered on this page. */
  navHrefs: string[];
  /** Stable keys for the forms on this page. */
  formKeys: string[];
}

/** Coverage estimate: crawled vs. discovered surface. */
export interface CoverageEstimate {
  crawledPages: number;
  discoveredPages: number;
  coveragePct: number;
  /** Discovered-but-not-crawled URLs (capped). */
  uncrawled: string[];
}

/**
 * Enriched profile signature. A SUPERSET of the legacy `CrawlSignature` so
 * existing consumers (diffCrawlSignatures, script-sync) keep working when this
 * is what's persisted in `crawl_snapshots.signature`.
 */
export interface ProfileSignature extends CrawlSignature {
  /** Enriched per-page data (legacy `pages` retains the compact shape). */
  profilePages: ProfilePageSignature[];
  coverage: CoverageEstimate;
}

/** Structured change types the user explicitly asked for. */
export type ProfileChangeType =
  | 'PAGE_ADDED'
  | 'PAGE_REMOVED'
  | 'ELEMENT_ADDED'
  | 'ELEMENT_REMOVED'
  | 'LOCATOR_CHANGED'
  | 'TEXT_CHANGED'
  | 'FORM_ADDED'
  | 'FORM_REMOVED'
  | 'NAVIGATION_CHANGED';

/** One structured change between two profile versions. */
export interface ProfileChange {
  type: ProfileChangeType;
  /** Page URL the change occurred on (or the page itself for PAGE_*). */
  page: string;
  /** Previous value (e.g. old selector / old text). */
  old?: string;
  /** New value (e.g. new selector / new text). */
  new?: string;
  /** Short human-readable description. */
  detail: string;
  severity: 'low' | 'medium' | 'high';
}

/** Aggregate result of diffing two profile versions. */
export interface ProfileDiff {
  changes: ProfileChange[];
  counts: Record<ProfileChangeType, number>;
  /** True when nothing meaningful changed. */
  unchanged: boolean;
  summary: string;
  severity: 'none' | 'low' | 'medium' | 'high';
}

/* -------------------------------------------------------------------------- */
/*  Crawl-data normalisation (kept local & defensive)                         */
/* -------------------------------------------------------------------------- */

type AnyCrawlData = Record<string, any> | null | undefined;

/** Normalise any crawl-data shape into an array of page-like objects. */
function asPages(crawlData: AnyCrawlData): any[] {
  if (!crawlData || typeof crawlData !== 'object') return [];
  const cd = crawlData as any;
  if (Array.isArray(cd.pages) && cd.pages.length > 0) return cd.pages;
  if (Array.isArray(cd.elements) || Array.isArray(cd.forms) || cd.url) return [cd];
  return [];
}

function pageUrl(page: any): string {
  return String(page?.finalUrl || page?.url || 'unknown');
}

function norm(s: any): string {
  return String(s ?? '').trim().replace(/\s+/g, ' ');
}

/** Strip protocol/host noise so URLs compare by path (origin-agnostic). */
function urlPath(u: string): string {
  try {
    const parsed = new URL(u);
    return (parsed.pathname || '/').replace(/\/+$/, '') || '/';
  } catch {
    // Relative or malformed — normalise trailing slash only.
    return String(u || '').replace(/[#?].*$/, '').replace(/\/+$/, '') || '/';
  }
}

/**
 * Build a STABLE, selector-independent identity for an element. This must
 * survive a selector change (that's the whole point of LOCATOR_CHANGED), so it
 * is composed only of semantic signals: tag + the best human label + type/role.
 */
export function elementIdentity(el: any): string {
  const tag = norm(el?.tag || el?.tagName).toLowerCase();
  const label = norm(
    el?.nearbyLabel || el?.ariaLabel || el?.placeholder || el?.name ||
    (el?.textContent ? String(el.textContent).slice(0, 40) : ''),
  ).toLowerCase();
  const type = norm(el?.type).toLowerCase();
  const role = norm(el?.role || el?.ariaRole).toLowerCase();
  return [tag, type, role, label].filter(Boolean).join('|');
}

/** The recommended selector string for an element (best available). */
function bestSelector(el: any): string {
  const sel = el?.selectors || {};
  return (
    sel.recommended || sel.dataTestId || sel.id || sel.name || sel.role ||
    sel.css || sel.xpath ||
    (el?.id ? `#${el.id}` : '') ||
    (el?.dataTestId ? `[data-testid="${el.dataTestId}"]` : '') ||
    (el?.name ? `[name="${el.name}"]` : '') ||
    ''
  );
}

function elementsOf(page: any): any[] {
  const out: any[] = [];
  if (Array.isArray(page?.elements)) out.push(...page.elements);
  if (Array.isArray(page?.buttons)) out.push(...page.buttons);
  if (Array.isArray(page?.inputs)) out.push(...page.inputs);
  if (Array.isArray(page?.forms)) {
    for (const f of page.forms) if (Array.isArray(f?.fields)) out.push(...f.fields);
  }
  return out;
}

function navHrefsOf(page: any): string[] {
  const links: any[] = Array.isArray(page?.navigationLinks) ? page.navigationLinks : [];
  const hrefs = links
    .map((l) => (typeof l === 'string' ? l : l?.href))
    .filter(Boolean)
    .map((h: string) => urlPath(h));
  return Array.from(new Set(hrefs)).sort();
}

function formKeysOf(page: any): string[] {
  const forms: any[] = Array.isArray(page?.forms) ? page.forms : [];
  return forms
    .map((f, i) => norm(f?.id || f?.name || f?.action || `form#${i}`).toLowerCase())
    .sort();
}

/* -------------------------------------------------------------------------- */
/*  1. Coverage                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Estimate coverage as crawled pages vs. the union of crawled pages and pages
 * *discovered* through navigation links / siteMap. This is the audit's #1
 * quick win — it lets users (and healing) distinguish "no alternative exists"
 * from "we never crawled that page".
 */
export function computeCoverage(crawlData: AnyCrawlData): CoverageEstimate {
  const pages = asPages(crawlData);
  const crawledPaths = new Set<string>();
  for (const p of pages) crawledPaths.add(urlPath(pageUrl(p)));

  const discovered = new Set<string>(crawledPaths);

  // Navigation links found on each crawled page.
  for (const p of pages) for (const h of navHrefsOf(p)) discovered.add(h);

  // siteMap entries (deep crawl envelope), if present.
  const cd = (crawlData || {}) as any;
  const siteMap: any[] = Array.isArray(cd.siteMap) ? cd.siteMap : [];
  for (const entry of siteMap) {
    const u = typeof entry === 'string' ? entry : entry?.url || entry?.href;
    if (u) discovered.add(urlPath(u));
  }

  const crawledPages = crawledPaths.size;
  const discoveredPages = Math.max(discovered.size, crawledPages);
  const coveragePct = discoveredPages > 0
    ? Math.round((crawledPages / discoveredPages) * 100)
    : 0;

  const uncrawled = Array.from(discovered)
    .filter((u) => !crawledPaths.has(u))
    .sort()
    .slice(0, 50);

  return { crawledPages, discoveredPages, coveragePct, uncrawled };
}

/* -------------------------------------------------------------------------- */
/*  2. Enriched signature (superset of CrawlSignature)                        */
/* -------------------------------------------------------------------------- */

/**
 * Distil a crawl into an enriched, comparable signature. Returns a SUPERSET of
 * the legacy `CrawlSignature` (so existing consumers keep working) plus
 * identity-keyed per-element data, navigation, form keys, and coverage.
 */
export function computeProfileSignature(crawlData: AnyCrawlData): ProfileSignature {
  const base = computeCrawlSignature(crawlData as any);
  const pages = asPages(crawlData);

  const profilePages: ProfilePageSignature[] = pages.map((page) => {
    const url = urlPath(pageUrl(page));
    const rawEls = elementsOf(page);
    const seen = new Map<string, ElementSignature>();
    for (const el of rawEls) {
      const key = elementIdentity(el);
      if (!key || key.length < 2) continue; // skip unidentifiable elements
      const selector = bestSelector(el);
      // First occurrence wins (stable); later dupes are positional noise.
      if (!seen.has(key)) {
        seen.set(key, {
          key,
          selector,
          text: norm(el?.nearbyLabel || el?.textContent || el?.ariaLabel || el?.placeholder).slice(0, 60),
          tag: norm(el?.tag || el?.tagName).toLowerCase(),
          role: norm(el?.role || el?.ariaRole).toLowerCase() || undefined,
        });
      }
    }
    const baseMatch = base.pages.find((bp) => urlPath(bp.url) === url);
    return {
      url,
      pageType: page?.pageType || baseMatch?.pageType || 'unknown',
      selectors: baseMatch?.selectors ?? [],
      elementCount: baseMatch?.elementCount ?? rawEls.length,
      formCount: baseMatch?.formCount ?? (Array.isArray(page?.forms) ? page.forms.length : 0),
      elements: Array.from(seen.values()),
      navHrefs: navHrefsOf(page),
      formKeys: formKeysOf(page),
    };
  });

  return {
    ...base,
    profilePages,
    coverage: computeCoverage(crawlData),
  };
}

/* -------------------------------------------------------------------------- */
/*  3. Profile diff (the Change Engine)                                       */
/* -------------------------------------------------------------------------- */

function emptyCounts(): Record<ProfileChangeType, number> {
  return {
    PAGE_ADDED: 0, PAGE_REMOVED: 0, ELEMENT_ADDED: 0, ELEMENT_REMOVED: 0,
    LOCATOR_CHANGED: 0, TEXT_CHANGED: 0, FORM_ADDED: 0, FORM_REMOVED: 0,
    NAVIGATION_CHANGED: 0,
  };
}

/** Restore a ProfileSignature shape from a stored (possibly legacy) signature. */
export function coerceProfileSignature(sig: any): ProfileSignature {
  if (sig && Array.isArray(sig.profilePages)) return sig as ProfileSignature;
  // Legacy CrawlSignature (no enriched data) — degrade gracefully.
  const base: CrawlSignature = {
    pages: Array.isArray(sig?.pages) ? sig.pages : [],
    allSelectors: Array.isArray(sig?.allSelectors) ? sig.allSelectors : [],
    totalElements: sig?.totalElements ?? 0,
    totalForms: sig?.totalForms ?? 0,
    totalSelectors: sig?.totalSelectors ?? 0,
    pageCount: sig?.pageCount ?? 0,
  };
  return {
    ...base,
    profilePages: base.pages.map((p) => ({
      url: urlPath(p.url), pageType: p.pageType, selectors: p.selectors,
      elementCount: p.elementCount, formCount: p.formCount,
      elements: [], navHrefs: [], formKeys: [],
    })),
    coverage: { crawledPages: base.pageCount, discoveredPages: base.pageCount, coveragePct: 0, uncrawled: [] },
  };
}

/**
 * Diff two enriched profile signatures (prev = older, curr = newer) into a
 * structured change set. Severity favours *removals* and *locator changes* —
 * those are what break existing scripts.
 */
export function computeProfileDiff(
  prevRaw: any,
  currRaw: any,
): ProfileDiff {
  const prev = coerceProfileSignature(prevRaw);
  const curr = coerceProfileSignature(currRaw);
  const counts = emptyCounts();
  const changes: ProfileChange[] = [];

  const prevPages = new Map(prev.profilePages.map((p) => [p.url, p]));
  const currPages = new Map(curr.profilePages.map((p) => [p.url, p]));

  // ── Page-level add/remove ────────────────────────────────────────────────
  for (const url of currPages.keys()) {
    if (!prevPages.has(url)) {
      changes.push({ type: 'PAGE_ADDED', page: url, new: url, detail: `Page added: ${url}`, severity: 'low' });
      counts.PAGE_ADDED++;
    }
  }
  for (const url of prevPages.keys()) {
    if (!currPages.has(url)) {
      changes.push({ type: 'PAGE_REMOVED', page: url, old: url, detail: `Page removed: ${url}`, severity: 'high' });
      counts.PAGE_REMOVED++;
    }
  }

  // ── Per-page element / locator / text / form / navigation diffs ───────────
  for (const [url, currPage] of currPages) {
    const prevPage = prevPages.get(url);
    if (!prevPage) continue; // brand-new page already reported

    const prevEls = new Map(prevPage.elements.map((e) => [e.key, e]));
    const currEls = new Map(currPage.elements.map((e) => [e.key, e]));

    for (const [key, ce] of currEls) {
      const pe = prevEls.get(key);
      if (!pe) {
        changes.push({
          type: 'ELEMENT_ADDED', page: url, new: ce.selector,
          detail: `Element added on ${url}: ${ce.text || ce.key}`, severity: 'low',
        });
        counts.ELEMENT_ADDED++;
        continue;
      }
      // Same logical element present in both — check selector & text drift.
      if (pe.selector && ce.selector && pe.selector !== ce.selector) {
        changes.push({
          type: 'LOCATOR_CHANGED', page: url, old: pe.selector, new: ce.selector,
          detail: `Locator changed on ${url} for "${ce.text || ce.key}": ${pe.selector} → ${ce.selector}`,
          severity: 'high',
        });
        counts.LOCATOR_CHANGED++;
      }
      if (pe.text && ce.text && pe.text !== ce.text) {
        changes.push({
          type: 'TEXT_CHANGED', page: url, old: pe.text, new: ce.text,
          detail: `Text changed on ${url}: "${pe.text}" → "${ce.text}"`, severity: 'low',
        });
        counts.TEXT_CHANGED++;
      }
    }
    for (const [key, pe] of prevEls) {
      if (!currEls.has(key)) {
        changes.push({
          type: 'ELEMENT_REMOVED', page: url, old: pe.selector,
          detail: `Element removed from ${url}: ${pe.text || pe.key}`, severity: 'medium',
        });
        counts.ELEMENT_REMOVED++;
      }
    }

    // Forms
    const prevForms = new Set(prevPage.formKeys);
    const currForms = new Set(currPage.formKeys);
    for (const f of currForms) if (!prevForms.has(f)) {
      changes.push({ type: 'FORM_ADDED', page: url, new: f, detail: `Form added on ${url}: ${f}`, severity: 'low' });
      counts.FORM_ADDED++;
    }
    for (const f of prevForms) if (!currForms.has(f)) {
      changes.push({ type: 'FORM_REMOVED', page: url, old: f, detail: `Form removed from ${url}: ${f}`, severity: 'high' });
      counts.FORM_REMOVED++;
    }

    // Navigation
    const prevNav = new Set(prevPage.navHrefs);
    const currNav = new Set(currPage.navHrefs);
    const navAdded = [...currNav].filter((n) => !prevNav.has(n));
    const navRemoved = [...prevNav].filter((n) => !currNav.has(n));
    if (navAdded.length || navRemoved.length) {
      const bits: string[] = [];
      if (navAdded.length) bits.push(`+${navAdded.length}`);
      if (navRemoved.length) bits.push(`-${navRemoved.length}`);
      changes.push({
        type: 'NAVIGATION_CHANGED', page: url,
        old: navRemoved.join(', ') || undefined,
        new: navAdded.join(', ') || undefined,
        detail: `Navigation changed on ${url} (${bits.join(' ')} links)`,
        severity: navRemoved.length ? 'medium' : 'low',
      });
      counts.NAVIGATION_CHANGED++;
    }
  }

  const total = changes.length;
  const unchanged = total === 0;

  // Severity heuristic — removals & locator changes dominate.
  const high = changes.filter((c) => c.severity === 'high').length;
  const medium = changes.filter((c) => c.severity === 'medium').length;
  let severity: ProfileDiff['severity'] = 'none';
  if (high >= 1) severity = 'high';
  else if (medium >= 1) severity = 'medium';
  else if (total >= 1) severity = 'low';

  const parts: string[] = [];
  const order: ProfileChangeType[] = [
    'PAGE_ADDED', 'PAGE_REMOVED', 'ELEMENT_ADDED', 'ELEMENT_REMOVED',
    'LOCATOR_CHANGED', 'TEXT_CHANGED', 'FORM_ADDED', 'FORM_REMOVED', 'NAVIGATION_CHANGED',
  ];
  const label: Record<ProfileChangeType, string> = {
    PAGE_ADDED: 'page(s) added', PAGE_REMOVED: 'page(s) removed',
    ELEMENT_ADDED: 'element(s) added', ELEMENT_REMOVED: 'element(s) removed',
    LOCATOR_CHANGED: 'locator(s) changed', TEXT_CHANGED: 'text change(s)',
    FORM_ADDED: 'form(s) added', FORM_REMOVED: 'form(s) removed',
    NAVIGATION_CHANGED: 'navigation change(s)',
  };
  for (const t of order) if (counts[t]) parts.push(`${counts[t]} ${label[t]}`);
  const summary = unchanged ? 'No changes detected' : parts.join(', ');

  return { changes, counts, unchanged, summary, severity };
}

/**
 * Convenience for self-healing: find a persisted/just-computed LOCATOR_CHANGED
 * whose OLD selector matches the broken locator. Returns the NEW selector when
 * a confident match exists, else null. Matching is tolerant of common locator
 * wrappers (getByTestId, #id, [name=...]).
 */
export function findLocatorReplacement(
  changes: Array<Pick<ProfileChange, 'type' | 'old' | 'new'>>,
  brokenLocator: string,
): string | null {
  if (!brokenLocator) return null;
  const needle = canonicalizeLocator(brokenLocator);
  for (const c of changes) {
    if (c.type !== 'LOCATOR_CHANGED' || !c.old || !c.new) continue;
    if (canonicalizeLocator(c.old) === needle) return c.new;
  }
  return null;
}

/** Reduce a locator to a comparable canonical token (id / testid / name / raw). */
export function canonicalizeLocator(locator: string): string {
  const l = String(locator || '').trim();
  const id = /#([\w-]+)/.exec(l) || /getById\(['"]([^'"]+)['"]\)/.exec(l);
  if (id) return `#${id[1]}`;
  const testId =
    /getByTestId\(['"]([^'"]+)['"]\)/.exec(l) || /data-testid=['"]([^'"]+)['"]/.exec(l);
  if (testId) return `[data-testid="${testId[1]}"]`;
  const name = /\[name=['"]([^'"]+)['"]\]/.exec(l);
  if (name) return `[name="${name[1]}"]`;
  return l.toLowerCase();
}
