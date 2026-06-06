/**
 * Script Maintenance Service — Proactive Change Detection & Script Health
 * ----------------------------------------------------------------------------
 * Self-healing fixes scripts *reactively* (after a test fails). This service
 * powers the *proactive* side of maintenance:
 *
 *   1. computeCrawlSignature  — distil a crawl into a compact, comparable shape.
 *   2. diffCrawlSignatures    — detect added / removed / changed selectors and
 *                               structural changes between two crawls.
 *   3. scoreScriptHealth      — grade a generated script (locator validity +
 *                               staleness) so teams see decay before it breaks.
 *   4. analyzeImpact          — map a crawl diff to the scripts it endangers.
 *
 * Everything here is pure / side-effect free (no DB, no network) so it is
 * trivially unit-testable and safe to call from request handlers. It degrades
 * gracefully: missing crawl data or locator reports simply yields lower-fidelity
 * (but still useful) results rather than throwing.
 */

import type { CrawlResult, PageElement } from '../script-gen/page-crawler';
import { validateLocator } from './locator-resolver';
import { logger } from '../utils/logger';

const MOD = 'ScriptMaintenance';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

/** A compact, comparable fingerprint of a single crawled page. */
export interface PageSignature {
  url: string;
  pageType: string;
  /** Stable selectors discovered on the page (id / data-testid / name / recommended). */
  selectors: string[];
  elementCount: number;
  formCount: number;
}

/** A compact, comparable fingerprint of an entire crawl (single or multi-page). */
export interface CrawlSignature {
  pages: PageSignature[];
  /** Union of every stable selector across all pages. */
  allSelectors: string[];
  totalElements: number;
  totalForms: number;
  totalSelectors: number;
  pageCount: number;
}

/** The result of diffing two crawl signatures. */
export interface CrawlDiff {
  addedSelectors: string[];
  removedSelectors: string[];
  addedPages: string[];
  removedPages: string[];
  /** Net change in element count (curr − prev). */
  elementDelta: number;
  formDelta: number;
  /** True when nothing meaningful changed. */
  unchanged: boolean;
  /** Human-readable one-line summary. */
  summary: string;
  /** Severity heuristic for prioritising review. */
  severity: 'none' | 'low' | 'medium' | 'high';
}

/** An individual locator flagged as potentially broken/outdated. */
export interface OutdatedLocator {
  elementDescription: string;
  locator: string;
  reason: string;
  validationMethod: 'dom_match' | 'pattern_check' | 'syntax_only';
}

/** A health grade for one generated script. */
export interface ScriptHealth {
  scriptId: number;
  url: string;
  pageType: string | null;
  score: number;             // 0..100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  ageDays: number;
  stalenessPenalty: number;  // 0..0.3
  locatorHealth: number;     // 0..1 (fraction of valid locators)
  totalLocators: number;
  validLocators: number;
  outdatedLocators: OutdatedLocator[];
  /** True when no crawl data was available, so validity is heuristic only. */
  heuristicOnly: boolean;
  warnings: string[];
}

/** Which scripts a crawl diff is likely to impact. */
export interface ImpactedScript {
  scriptId: number;
  url: string;
  /** Locators in the script that reference a removed/changed selector. */
  impactedLocators: Array<{ elementDescription: string; locator: string; selector: string }>;
  riskLevel: 'low' | 'medium' | 'high';
}

/* -------------------------------------------------------------------------- */
/*  Crawl-data normalisation                                                  */
/* -------------------------------------------------------------------------- */

/** Loosely-typed crawl data — either a single CrawlResult or a multi-page envelope. */
type AnyCrawlData =
  | (Partial<CrawlResult> & Record<string, any>)
  | { multiPage?: boolean; pages?: any[]; [key: string]: any }
  | null
  | undefined;

/** Normalise any crawl-data shape into an array of page-like objects. */
function asPages(crawlData: AnyCrawlData): any[] {
  if (!crawlData || typeof crawlData !== 'object') return [];
  const cd = crawlData as any;
  if (Array.isArray(cd.pages) && cd.pages.length > 0) return cd.pages;
  // Single-page crawl result — treat as one page.
  if (Array.isArray(cd.elements) || Array.isArray(cd.forms) || cd.url) return [cd];
  return [];
}

/** Pull the most stable selector strings off a single element. */
function stableSelectorsFromElement(el: PageElement | any): string[] {
  if (!el || typeof el !== 'object') return [];
  const out: string[] = [];
  const sel = el.selectors || {};
  if (el.id) out.push(`#${el.id}`);
  if (el.dataTestId) out.push(`[data-testid="${el.dataTestId}"]`);
  if (el.name) out.push(`[name="${el.name}"]`);
  if (sel.id) out.push(sel.id);
  if (sel.dataTestId) out.push(sel.dataTestId);
  if (sel.name) out.push(sel.name);
  if (sel.recommended) out.push(sel.recommended);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  1. Crawl signature                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Distil a crawl into a compact, comparable signature. Only *stable* selectors
 * (id / data-testid / name / recommended) are retained — these are the ones
 * generated scripts actually rely on, so changes to them are what matter.
 */
export function computeCrawlSignature(crawlData: AnyCrawlData): CrawlSignature {
  const pages = asPages(crawlData);
  const pageSigs: PageSignature[] = [];
  const allSelectors = new Set<string>();
  let totalElements = 0;
  let totalForms = 0;

  for (const page of pages) {
    const elements: any[] = [
      ...(Array.isArray(page.elements) ? page.elements : []),
      ...(Array.isArray(page.buttons) ? page.buttons : []),
      ...(Array.isArray(page.inputs) ? page.inputs : []),
    ];
    // Form fields can be nested under forms[].fields
    if (Array.isArray(page.forms)) {
      for (const f of page.forms) {
        if (Array.isArray(f.fields)) elements.push(...f.fields);
      }
    }

    const pageSelectors = new Set<string>();
    for (const el of elements) {
      for (const s of stableSelectorsFromElement(el)) {
        pageSelectors.add(s);
        allSelectors.add(s);
      }
    }

    const formCount = Array.isArray(page.forms) ? page.forms.length : 0;
    const elementCount = Array.isArray(page.elements) ? page.elements.length : elements.length;
    totalElements += elementCount;
    totalForms += formCount;

    pageSigs.push({
      url: page.finalUrl || page.url || 'unknown',
      pageType: page.pageType || 'unknown',
      selectors: Array.from(pageSelectors).sort(),
      elementCount,
      formCount,
    });
  }

  return {
    pages: pageSigs,
    allSelectors: Array.from(allSelectors).sort(),
    totalElements,
    totalForms,
    totalSelectors: allSelectors.size,
    pageCount: pageSigs.length,
  };
}

/* -------------------------------------------------------------------------- */
/*  2. Crawl diff                                                             */
/* -------------------------------------------------------------------------- */

function setDiff(a: string[], b: string[]): string[] {
  const setB = new Set(b);
  return a.filter((x) => !setB.has(x));
}

/**
 * Diff two crawl signatures (prev = older, curr = newer). Returns the selectors
 * and pages that appeared/disappeared plus a severity heuristic so the UI can
 * prioritise review.
 */
export function diffCrawlSignatures(prev: CrawlSignature | null, curr: CrawlSignature | null): CrawlDiff {
  const prevSel = prev?.allSelectors ?? [];
  const currSel = curr?.allSelectors ?? [];
  const prevPages = (prev?.pages ?? []).map((p) => p.url);
  const currPages = (curr?.pages ?? []).map((p) => p.url);

  const removedSelectors = setDiff(prevSel, currSel);
  const addedSelectors = setDiff(currSel, prevSel);
  const removedPages = setDiff(prevPages, currPages);
  const addedPages = setDiff(currPages, prevPages);

  const elementDelta = (curr?.totalElements ?? 0) - (prev?.totalElements ?? 0);
  const formDelta = (curr?.totalForms ?? 0) - (prev?.totalForms ?? 0);

  const unchanged =
    removedSelectors.length === 0 &&
    addedSelectors.length === 0 &&
    removedPages.length === 0 &&
    addedPages.length === 0;

  // Severity is driven mostly by *removed* selectors / pages — those are what
  // break existing scripts. Additions are informational.
  let severity: CrawlDiff['severity'] = 'none';
  const removedSignal = removedSelectors.length + removedPages.length * 3;
  if (removedSignal >= 8 || removedPages.length >= 2) severity = 'high';
  else if (removedSignal >= 3) severity = 'medium';
  else if (removedSignal >= 1 || addedSelectors.length + addedPages.length >= 1) severity = 'low';

  const parts: string[] = [];
  if (removedSelectors.length) parts.push(`${removedSelectors.length} selector(s) removed`);
  if (addedSelectors.length) parts.push(`${addedSelectors.length} selector(s) added`);
  if (removedPages.length) parts.push(`${removedPages.length} page(s) removed`);
  if (addedPages.length) parts.push(`${addedPages.length} page(s) added`);
  const summary = unchanged ? 'No structural changes detected' : parts.join(', ');

  return {
    addedSelectors,
    removedSelectors,
    addedPages,
    removedPages,
    elementDelta,
    formDelta,
    unchanged,
    summary,
    severity,
  };
}

/* -------------------------------------------------------------------------- */
/*  3. Script health                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Extract the *concrete* stable selector(s) a locator references — i.e. an
 * explicit id (`#x`), `[data-testid="x"]` / `getByTestId('x')`, or `[name="x"]`.
 * These can be cross-checked directly against the crawl signature (something
 * the generic LocatorResolver.validateLocator does NOT do for raw CSS ids).
 * Returns the canonical selector strings as they appear in a CrawlSignature.
 */
function concreteSelectorsFromLocator(locator: string): string[] {
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

function gradeFromScore(score: number): ScriptHealth['grade'] {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

/**
 * Staleness penalty ramps from 0 (fresh, < 30 days) up to 0.3 (> 90 days).
 * Linear between 30 and 90 days.
 */
export function stalenessPenaltyForAge(ageDays: number): number {
  if (ageDays <= 30) return 0;
  if (ageDays >= 90) return 0.3;
  return ((ageDays - 30) / 60) * 0.3;
}

/**
 * Compute a 0–100 health score + letter grade for one generated script.
 *
 * score = round(100 * locatorHealth * (1 − stalenessPenalty))
 *
 * @param script        Row with locator_report, created_at, url, page_type.
 * @param crawlData     Latest crawl for the app (optional). When present we
 *                      validate each locator against the live DOM; otherwise we
 *                      fall back to the locator report's own confidence flags.
 * @param now           Injectable clock for deterministic tests.
 */
export function scoreScriptHealth(
  script: {
    id: number;
    url: string;
    page_type?: string | null;
    locator_report?: any;
    created_at?: string | Date;
  },
  crawlData?: AnyCrawlData,
  now: Date = new Date(),
): ScriptHealth {
  const report = script.locator_report || {};
  const locators: any[] = Array.isArray(report.locators) ? report.locators : [];
  const warnings: string[] = [];

  const ageMs = script.created_at ? now.getTime() - new Date(script.created_at).getTime() : 0;
  const ageDays = Math.max(0, Math.floor(ageMs / 86_400_000));
  const stalenessPenalty = stalenessPenaltyForAge(ageDays);

  const hasCrawl = asPages(crawlData).length > 0;
  // Pre-compute the live selector set so we can directly detect concrete
  // id/data-testid/name selectors that no longer exist in the latest crawl.
  const liveSelectors = hasCrawl ? new Set(computeCrawlSignature(crawlData).allSelectors) : null;
  const outdatedLocators: OutdatedLocator[] = [];
  let validCount = 0;

  if (locators.length > 0) {
    for (const loc of locators) {
      const locatorStr: string = loc.locator || '';
      if (!locatorStr) continue;
      if (hasCrawl) {
        // 1) Direct cross-check: if the locator references a concrete stable
        //    selector that is absent from the latest crawl, it is outdated.
        const concrete = concreteSelectorsFromLocator(locatorStr);
        const missingConcrete = concrete.length > 0 && liveSelectors
          ? concrete.filter((s) => !liveSelectors.has(s))
          : [];
        if (missingConcrete.length > 0) {
          outdatedLocators.push({
            elementDescription: loc.elementDescription || 'element',
            locator: locatorStr,
            reason: `Selector ${missingConcrete.join(', ')} no longer present in latest crawl`,
            validationMethod: 'dom_match',
          });
          continue;
        }
        // 2) Fall back to the generic Playwright DOM validator for everything
        //    else (getByRole/getByText/getByLabel/getByTestId, etc.).
        const v = validateLocator(locatorStr, crawlData as any);
        if (v.isValid) {
          validCount++;
        } else {
          outdatedLocators.push({
            elementDescription: loc.elementDescription || 'element',
            locator: locatorStr,
            reason: v.warnings[0] || 'Locator not found in latest crawl',
            validationMethod: v.validationMethod,
          });
        }
      } else {
        // No crawl to validate against — trust the report's own validated flag
        // / confidence as a heuristic signal.
        const ok = loc.validated === true || (typeof loc.confidence === 'number' && loc.confidence >= 60);
        if (ok) {
          validCount++;
        } else {
          outdatedLocators.push({
            elementDescription: loc.elementDescription || 'element',
            locator: locatorStr,
            reason: 'Low-confidence locator (no recent crawl to verify)',
            validationMethod: 'syntax_only',
          });
        }
      }
    }
  }

  const totalLocators = locators.length;
  // When there are no locators at all, fall back to the script's avgConfidence
  // (if present) or a neutral 0.7 so brand-new scripts aren't graded F.
  let locatorHealth: number;
  if (totalLocators > 0) {
    locatorHealth = validCount / totalLocators;
  } else if (typeof report.avgConfidence === 'number' && report.avgConfidence > 0) {
    locatorHealth = Math.min(1, report.avgConfidence / 100);
    warnings.push('No per-locator detail — score derived from average confidence');
  } else {
    locatorHealth = 0.7;
    warnings.push('No locator report available — score is an estimate');
  }

  if (!hasCrawl) warnings.push('No recent crawl available — locator validity is heuristic');
  if (ageDays > 90) warnings.push(`Script is ${ageDays} days old and may be stale`);
  if (outdatedLocators.length > 0) warnings.push(`${outdatedLocators.length} locator(s) may be outdated`);

  const score = Math.round(100 * locatorHealth * (1 - stalenessPenalty));

  return {
    scriptId: script.id,
    url: script.url,
    pageType: script.page_type ?? null,
    score,
    grade: gradeFromScore(score),
    ageDays,
    stalenessPenalty: Math.round(stalenessPenalty * 100) / 100,
    locatorHealth: Math.round(locatorHealth * 100) / 100,
    totalLocators,
    validLocators: validCount,
    outdatedLocators,
    heuristicOnly: !hasCrawl,
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/*  4. Impact analysis                                                        */
/* -------------------------------------------------------------------------- */

/** Does a locator string reference the given selector? (loose containment match) */
function locatorReferencesSelector(locator: string, selector: string): boolean {
  if (!locator || !selector) return false;
  if (locator.includes(selector)) return true;
  // Compare on the raw value inside brackets / after '#' so e.g. a script
  // locator `getByTestId('submit')` matches a `[data-testid="submit"]` selector.
  const valMatch = selector.match(/["']([^"']+)["']|#([\w-]+)/);
  const val = valMatch ? valMatch[1] || valMatch[2] : '';
  return !!val && locator.includes(val);
}

/**
 * Given a set of scripts and a crawl diff, determine which scripts reference a
 * removed selector and are therefore at risk of breaking.
 */
export function analyzeImpact(
  scripts: Array<{ id: number; url: string; locator_report?: any }>,
  diff: CrawlDiff,
): ImpactedScript[] {
  const removed = diff.removedSelectors;
  if (removed.length === 0) return [];

  const impacted: ImpactedScript[] = [];
  for (const script of scripts) {
    const report = script.locator_report || {};
    const locators: any[] = Array.isArray(report.locators) ? report.locators : [];
    const hits: ImpactedScript['impactedLocators'] = [];

    for (const loc of locators) {
      const locatorStr: string = loc.locator || '';
      for (const sel of removed) {
        if (locatorReferencesSelector(locatorStr, sel)) {
          hits.push({
            elementDescription: loc.elementDescription || 'element',
            locator: locatorStr,
            selector: sel,
          });
          break;
        }
      }
    }

    if (hits.length > 0) {
      const riskLevel: ImpactedScript['riskLevel'] =
        hits.length >= 4 ? 'high' : hits.length >= 2 ? 'medium' : 'low';
      impacted.push({ scriptId: script.id, url: script.url, impactedLocators: hits, riskLevel });
    }
  }

  logger.info(MOD, `Impact analysis: ${impacted.length} script(s) affected by ${removed.length} removed selector(s)`);
  return impacted;
}

/** Convenience: build the snapshot row fields from a signature. */
export function signatureToSnapshotFields(sig: CrawlSignature) {
  return {
    elementCount: sig.totalElements,
    formCount: sig.totalForms,
    selectorCount: sig.totalSelectors,
    pageCount: sig.pageCount,
  };
}
