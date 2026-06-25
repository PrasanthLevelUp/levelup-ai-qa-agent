/**
 * DOM Memory Seeder (Phase 2 — "DOM Snapshot Persistence")
 *
 * THE PROBLEM
 * -----------
 * DOM Memory is LevelUp's moat: during healing we query historical selector
 * data (stability + alternatives) BEFORE spending an AI token. But that history
 * lived in `selector_history`, and the ONLY thing that ever wrote to it was a
 * *heal* event. So on a brand-new project — before anything had ever broken —
 * DOM Memory was stone cold and always answered "No DOM Memory history… building
 * baseline data." The moat had no water.
 *
 * THE FIX
 * -------
 * We already crawl the application and build a rich Application Profile. This
 * module turns that crawl into DOM Memory: every interactive element the crawler
 * saw contributes its *grounded* selector variants (data-test, role+name, id,
 * name, placeholder, label, text — produced by the exact same, unit-tested
 * `buildGroundedCandidates` the App Profile healer uses). All variants for one
 * element share a single `elementIdentifier`, which is precisely what
 * `getAlternativeSelectors` joins on — so when any one of those selectors later
 * fails, DOM Memory can instantly offer the others as 0-token alternatives.
 *
 * It is deliberately best-effort and tenant-scoped, and it is idempotent per
 * page (a re-crawl clears its own previous crawl-sourced rows first).
 */

import { logger } from '../utils/logger';
import {
  collectElements,
  buildGroundedCandidates,
} from './app-profile-healing';
import {
  recordSelectorObservations,
  clearCrawlSelectorHistory,
} from '../db/postgres';

const MOD = 'dom-memory-seeder';

/** Cap how many elements/selectors we persist per page to bound DB volume. */
const MAX_ELEMENTS_PER_PAGE = 200;
const MAX_SELECTORS_PER_ELEMENT = 4;

export interface SeedInput {
  /** Raw crawl data for a single page (or a whole profile — both are flattened). */
  crawlData: any;
  pageUrl: string;
  projectId?: number;
  companyId?: number;
}

export interface SeedResult {
  elementsScanned: number;
  elementsKept: number;
  selectorsSeeded: number;
}

export interface SeedRow {
  projectId?: number;
  companyId?: number;
  pageUrl?: string;
  selector: string;
  elementType?: string;
  elementIdentifier?: string;
  changeType?: string;
  source?: string;
  metadata?: Record<string, any>;
}

/** A crawled element as returned by `collectElements`. */
type Element = ReturnType<typeof collectElements>[number];

/** Looks like a framework-generated / unstable id we should not key on. */
function isDynamicId(id: string): boolean {
  if (!id) return true;
  return (
    /\d{4,}/.test(id) ||
    /[a-f0-9]{8,}/i.test(id) ||
    /^:r[0-9a-z]+:?$/i.test(id) ||
    /(ember|react|ng-|mui-|css-)/i.test(id)
  );
}

/**
 * Derive a stable, human-meaningful key that uniquely identifies the element
 * across selector representations. Most-stable signals first. Returns null when
 * the element offers nothing we can reliably key on (we skip those).
 */
export function deriveElementIdentifier(el: Element): string | null {
  const a = el.attributes || {};
  if (a['data-test']) return `data-test:${a['data-test']}`;
  if (a['data-testid']) return `data-testid:${a['data-testid']}`;
  if (a['data-cy']) return `data-cy:${a['data-cy']}`;
  if (a['data-qa']) return `data-qa:${a['data-qa']}`;
  if (el.id && !isDynamicId(el.id)) return `id:${el.id}`;
  if (el.name) return `name:${el.name}`;

  const role = (el.role || el.tag || '').toLowerCase();
  const text = (el.textContent || el.ariaLabel || el.nearbyLabel || el.placeholder || '').trim().toLowerCase();
  if (role && text) return `${role}:${text}`;
  if (text) return `text:${text}`;
  return null;
}

/** A short description used to drive `buildGroundedCandidates`. */
function describe(el: Element): string {
  return (
    el.textContent ||
    el.ariaLabel ||
    el.nearbyLabel ||
    el.placeholder ||
    el.name ||
    el.id ||
    el.attributes?.['data-test'] ||
    el.attributes?.['data-testid'] ||
    ''
  ).trim();
}

/**
 * Pure (no-DB) transform: turn a page's crawl data into the exact rows we would
 * persist to `selector_history`. Exposed for unit testing and reuse.
 */
export function buildSeedRows(input: SeedInput): { rows: SeedRow[]; elementsScanned: number; elementsKept: number } {
  const elements = collectElements(input.crawlData);
  if (!elements.length) return { rows: [], elementsScanned: 0, elementsKept: 0 };

  const rows: SeedRow[] = [];
  // De-dupe (elementIdentifier + selector) so one element listed twice in the
  // crawl does not double-insert the same row.
  const seen = new Set<string>();
  let kept = 0;

  for (const el of elements.slice(0, MAX_ELEMENTS_PER_PAGE)) {
    const identifier = deriveElementIdentifier(el);
    if (!identifier) continue;

    const description = describe(el);
    const candidates = buildGroundedCandidates(el, description).slice(0, MAX_SELECTORS_PER_ELEMENT);
    if (!candidates.length) continue;

    let addedForEl = 0;
    for (const c of candidates) {
      const dedupeKey = `${identifier}|${c.locator}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      rows.push({
        projectId: input.projectId,
        companyId: input.companyId,
        pageUrl: input.pageUrl,
        selector: c.locator,
        elementType: el.role || el.tag || undefined,
        elementIdentifier: identifier,
        changeType: 'observed',
        source: 'crawl',
        metadata: { confidence: c.confidence, reasoning: c.reasoning },
      });
      addedForEl++;
    }
    if (addedForEl > 0) kept++;
  }

  return { rows, elementsScanned: elements.length, elementsKept: kept };
}

/**
 * Seed DOM Memory (`selector_history`) from one page's crawl data. Best-effort:
 * never throws — a seeding failure must not break profile saving or crawling.
 */
export async function seedSelectorHistoryFromCrawl(input: SeedInput): Promise<SeedResult> {
  const empty: SeedResult = { elementsScanned: 0, elementsKept: 0, selectorsSeeded: 0 };
  try {
    const { rows, elementsScanned, elementsKept } = buildSeedRows(input);

    if (!rows.length) {
      return { elementsScanned, elementsKept: 0, selectorsSeeded: 0 };
    }

    // Idempotent per page: drop our own previous crawl-sourced rows first.
    await clearCrawlSelectorHistory({
      projectId: input.projectId,
      companyId: input.companyId,
      pageUrl: input.pageUrl,
    });

    const seeded = await recordSelectorObservations(rows);

    logger.info(MOD, 'Seeded DOM Memory from crawl', {
      pageUrl: input.pageUrl.slice(0, 80),
      elementsScanned,
      elementsKept,
      selectorsSeeded: seeded,
      projectId: input.projectId,
    });

    return { elementsScanned, elementsKept, selectorsSeeded: seeded };
  } catch (err: any) {
    // Non-fatal — DOM Memory seeding is an optimisation, never a hard dependency.
    logger.warn(MOD, 'DOM Memory seeding failed (non-fatal)', {
      pageUrl: input.pageUrl?.slice(0, 80),
      error: err?.message,
    });
    return empty;
  }
}
