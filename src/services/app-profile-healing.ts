/**
 * Application-Profile Healing Bridge
 * ==================================
 *
 * THE GAP THIS CLOSES
 * -------------------
 * LevelUp crawls every target application into an **Application Profile**
 * (`application_profiles.crawl_data.elements[]`) — DOM, attributes, roles,
 * labels, `data-test*` ids, the lot. Until now that intelligence was read only
 * by *script generation*; the **healer never asked it anything**. So when a
 * locator broke, the pipeline fell straight through to an ungrounded AI guess
 * even though the correct, stable selector was already sitting in the crawl.
 *
 * WHAT THIS DOES
 * --------------
 * Given a failure, this bridge:
 *   1. Loads the Application Profile for the failing page (tenant-scoped).
 *   2. Derives a human element description from the failed locator / code line.
 *   3. Runs the existing {@link LocatorResolver} against the crawl — which
 *      prioritises real `data-testid` / `data-test` / `data-cy` ids and
 *      role/label/text locators grounded in the actual DOM.
 *   4. Returns grounded candidate locators for the orchestrator to validate and
 *      prefer **before** spending an AI token.
 *
 * It is intentionally:
 *  • Resilient — works even when `failedLocator` is empty (falls back to the
 *    failing source line), so it helps regardless of error-format parsing.
 *  • Defensive — never throws; on any miss it returns an empty result and the
 *    healer proceeds exactly as before.
 *  • Tenant-safe — every profile read is scoped by companyId / projectId.
 */

import { getProfileByUrl, listProfiles, getLatestActiveApplicationProfileForHealing, type ApplicationProfile } from '../db/postgres';
import { normalizeBaseUrl } from '../utils/url-normalize';
import { logger } from '../utils/logger';
import type { FailureDetails } from '../core/failure-analyzer';

const MOD = 'app-profile-healing';

/** A grounded locator candidate sourced from the Application Profile crawl. */
export interface AppProfileCandidate {
  /** Playwright locator string, e.g. `page.locator('[data-test="login-button"]')`. */
  locator: string;
  /** Confidence on a 0–1 scale. */
  confidence: number;
  /** Always `app_profile` — kept explicit for trail/observability. */
  source: 'app_profile';
  /** Human-readable explanation of why this candidate was chosen. */
  reasoning: string;
  /** True when the locator was matched against real crawled DOM. */
  validated: boolean;
}

/** Result of consulting the Application Profile for a single failure. */
export interface AppProfileHealingInput {
  /** Ranked grounded candidates (best first). Empty when nothing was found. */
  candidates: AppProfileCandidate[];
  /** Whether a profile existed for the failing page. */
  profileFound: boolean;
  /** Number of crawled elements scanned. */
  elementsScanned: number;
  /** The element description derived from the failure (for logging/trail). */
  description: string;
}

const EMPTY: AppProfileHealingInput = {
  candidates: [],
  profileFound: false,
  elementsScanned: 0,
  description: '',
};

/* -------------------------------------------------------------------------- */
/*  Element-description derivation (pure / unit-tested)                       */
/* -------------------------------------------------------------------------- */

/** Split kebab / snake / camel identifiers into space-separated words. */
function humanizeIdentifier(raw: string): string {
  return (raw || '')
    .replace(/[#.\[\]'"`()]/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Turn a Playwright locator (or the raw failing source line) into a plain
 * element description the {@link LocatorResolver} can fuzzy-match against the
 * crawl. Pure and exported so the mapping is unit-testable.
 *
 * Examples:
 *   getByRole('button', { name: 'Log in' })  → "log in button"
 *   getByLabel('Username')                   → "username"
 *   getByPlaceholder('Password')             → "password"
 *   getByTestId('login-button')              → "login button"
 *   locator('#user-name')                    → "user name"
 */
export function deriveElementDescription(failure: Partial<FailureDetails>): string {
  const sources = [failure.failedLocator, failure.failedLineCode]
    .map((s) => (s || '').trim())
    .filter(Boolean);

  for (const src of sources) {
    // getByRole('role', { name: 'NAME' | /NAME/ })
    const role = src.match(/getByRole\(\s*['"`]([^'"`]+)['"`]\s*(?:,\s*\{[^}]*name\s*:\s*['"`/]([^'"`/]+)['"`/])?/i);
    if (role) {
      const roleName = role[1]?.trim();
      const accName = role[2]?.trim();
      if (accName) return `${accName} ${roleName}`.toLowerCase();
      if (roleName) return roleName.toLowerCase();
    }

    // getByTestId('x') — humanise the id (often the most descriptive signal)
    const testId = src.match(/getByTestId\(\s*['"`]([^'"`]+)['"`]/i);
    if (testId) return humanizeIdentifier(testId[1]);

    // getByLabel / getByPlaceholder / getByText / getByAltText / getByTitle
    const named = src.match(/getBy(?:Label|Placeholder|Text|AltText|Title)\(\s*['"`/]([^'"`/]+)['"`/]/i);
    if (named) return named[1].trim().toLowerCase();

    // locator('[data-test="x"]') / locator('[data-testid="x"]') / [data-cy=...]
    const dataAttr = src.match(/\[data-(?:test|testid|test-id|cy|qa)\s*=\s*['"`]?([^'"`\]]+)/i);
    if (dataAttr) return humanizeIdentifier(dataAttr[1]);

    // locator('#id') / locator('.class')
    const cssId = src.match(/locator\(\s*['"`]([#.][^'"`]+)['"`]/i);
    if (cssId) return humanizeIdentifier(cssId[1]);

    // input[name="x"] / [name="x"]
    const nameAttr = src.match(/name\s*=\s*['"`]([^'"`]+)['"`]/i);
    if (nameAttr) return humanizeIdentifier(nameAttr[1]);
  }

  // Last resort: humanise whatever raw text we have.
  return humanizeIdentifier(sources[0] || '');
}

/* -------------------------------------------------------------------------- */
/*  Profile lookup (tenant-scoped, origin-tolerant)                           */
/* -------------------------------------------------------------------------- */

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

/**
 * Find the Application Profile for a failing page URL. The crawl stores a
 * normalised `base_url` (the app origin), while a failure URL is usually a deep
 * page URL — so we try the normalised base, the raw origin, then fall back to a
 * tenant-scoped origin match across the company's profiles.
 */
async function findProfileForUrl(
  url: string,
  companyId?: number,
  projectId?: number,
): Promise<ApplicationProfile | null> {
  const candidates = Array.from(
    new Set([normalizeBaseUrl(url), originOf(url), url].filter(Boolean)),
  );

  for (const base of candidates) {
    const profile = await getProfileByUrl(base, companyId, projectId);
    if (profile) return profile;
  }

  // Fallback: scan this tenant's profiles and match by origin.
  const failureOrigin = originOf(url);
  if (!failureOrigin) return null;
  try {
    const { profiles } = await listProfiles(companyId, { projectId, limit: 100 });
    return (
      profiles.find((p) => originOf(p.base_url) === failureOrigin) || null
    );
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Healing-specific profile resolver (URL cascade → latest active fallback)  */
/* -------------------------------------------------------------------------- */

/** Extra, healing-only URL signals that help locate the right crawl. */
export interface HealingProfileResolverInput {
  companyId?: number;
  projectId?: number;
  /**
   * URL from the failure artifact (most specific).
   * Now populated with the REAL page.url() from the auto-fixture on test failure,
   * no longer regex-guessed from error text.
   */
  failureUrl?: string | null;
  /**
   * DEPRECATED: browserUrl tier is no longer used; the auto-fixture writes the
   * real page.url() directly into failure.url via the artifact collector.
   * Kept for signature stability; always pass null.
   */
  browserUrl?: string | null;
  /** The suite's configured base URL (playwright.config baseURL / BASE_URL). */
  executionBaseUrl?: string | null;
}

/** How a healing profile was resolved — surfaced for the decision trail. */
export type HealingProfileSource =
  | 'failure_url'
  | 'browser_url'
  | 'execution_base_url'
  | 'latest_active_project'
  | 'none';

export interface HealingProfileResolution {
  profile: ApplicationProfile | null;
  source: HealingProfileSource;
}

/**
 * Resolve the Application Profile to ground healing on, using a deterministic
 * cascade — NOT the Script-Generation helper (healing is its own domain and
 * must heal the page that actually failed):
 *
 *   1. Failure URL (failureUrl)
 *        Now populated with the REAL page.url() captured by an auto-fixture at
 *        test failure — no regex-guessing. This is the most specific signal.
 *   2. Execution Base URL (executionBaseUrl)
 *        The suite's baseURL config (playwright.config / BASE_URL env). Right app,
 *        but maybe not the exact page. Used when the fixture didn't run or the
 *        browser was already closed.
 *   3. Latest Active Project Profile
 *        Last resort. Avoids the multi-app pitfall: a project with QA / Prod /
 *        Admin / Customer portals crawled together would otherwise heal against
 *        the wrong "newest crawl."
 *
 * Always resolves (never throws); returns `{ profile: null, source: 'none' }`
 * when nothing matches.
 */
export async function getApplicationProfileForHealing(
  input: HealingProfileResolverInput,
): Promise<HealingProfileResolution> {
  const { companyId, projectId } = input;

  // Ordered URL signals, most-specific first. Filtered + de-duped so we never
  // do a redundant DB lookup for the same URL.
  const urlSignals: Array<{ url: string; source: HealingProfileSource }> = [];
  const pushUrl = (url: string | null | undefined, source: HealingProfileSource) => {
    const u = (url || '').trim();
    if (u && !urlSignals.some((s) => s.url === u)) urlSignals.push({ url: u, source });
  };
  pushUrl(input.failureUrl, 'failure_url');
  pushUrl(input.browserUrl, 'browser_url');
  pushUrl(input.executionBaseUrl, 'execution_base_url');

  for (const signal of urlSignals) {
    try {
      const profile = await findProfileForUrl(signal.url, companyId, projectId);
      if (profile) {
        logger.info(MOD, 'Healing profile resolved by URL', {
          source: signal.source,
          url: signal.url,
          profileBaseUrl: profile.base_url,
          companyId,
          projectId,
        });
        return { profile, source: signal.source };
      }
    } catch (err: any) {
      logger.warn(MOD, 'Healing profile URL lookup failed (continuing cascade)', {
        source: signal.source,
        url: signal.url,
        error: err?.message,
      });
    }
  }

  // Last resort: latest ACTIVE profile for this project. Logged loudly because
  // in a multi-app project this may not be the page that failed — it's a
  // best-effort fallback, not a guarantee.
  try {
    const profile = await getLatestActiveApplicationProfileForHealing(companyId, projectId);
    if (profile) {
      logger.warn(MOD, 'Healing profile resolved via latest-active fallback (no URL matched)', {
        profileBaseUrl: profile.base_url,
        triedUrlSignals: urlSignals.map((s) => s.source),
        companyId,
        projectId,
        note: 'In multi-app projects this may not be the failing page; provide a failure/browser URL for precision.',
      });
      return { profile, source: 'latest_active_project' };
    }
  } catch (err: any) {
    logger.warn(MOD, 'Healing latest-active profile fallback failed', { error: err?.message });
  }

  return { profile: null, source: 'none' };
}

/* -------------------------------------------------------------------------- */
/*  Main entry point                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Consult the Application Profile crawl for grounded healing candidates.
 * Always resolves (never throws); returns {@link EMPTY} on any miss.
 *
 * `urls` carries the extra healing-only URL signals (current browser URL,
 * execution base URL) that make profile resolution deterministic even when the
 * failure error itself carries no URL (the common locator-timeout case).
 */
export async function buildAppProfileHealingInput(
  failure: Partial<FailureDetails>,
  companyId?: number,
  projectId?: number,
  urls?: { browserUrl?: string | null; executionBaseUrl?: string | null },
): Promise<AppProfileHealingInput> {
  let profile: ApplicationProfile | null = null;
  try {
    const resolution = await getApplicationProfileForHealing({
      companyId,
      projectId,
      failureUrl: failure?.url ?? null,
      browserUrl: urls?.browserUrl ?? null,
      executionBaseUrl: urls?.executionBaseUrl ?? null,
    });
    profile = resolution.profile;
  } catch (err: any) {
    logger.warn(MOD, 'Application Profile lookup failed (non-critical)', { error: err?.message });
    return EMPTY;
  }
  if (!profile || !profile.crawl_data) return EMPTY;

  const description = deriveElementDescription(failure);
  if (!description) {
    return { ...EMPTY, profileFound: true };
  }

  // Match the failing element against the crawled DOM and build grounded
  // candidate locators with CORRECT attribute semantics (e.g. a `data-test`
  // attribute becomes `[data-test="..."]`, not a default-mismatched
  // getByTestId which only targets `data-testid`). Never invents values.
  const elements = collectElements(profile.crawl_data);
  const elementsScanned = elements.length;
  if (!elementsScanned) {
    return { ...EMPTY, profileFound: true, description };
  }

  const match = bestElementMatch(elements, description);
  if (!match) {
    return { ...EMPTY, profileFound: true, description, elementsScanned };
  }

  const candidates = buildGroundedCandidates(match.el, description);
  if (!candidates.length) {
    return { ...EMPTY, profileFound: true, description, elementsScanned };
  }

  logger.info(MOD, 'Application Profile produced grounded healing candidates', {
    url: failure.url,
    description,
    elementsScanned,
    matchScore: Number(match.score.toFixed(2)),
    topLocator: candidates[0]?.locator,
    topConfidence: candidates[0]?.confidence,
    candidateCount: candidates.length,
  });

  return { candidates, profileFound: true, elementsScanned, description };
}

/* -------------------------------------------------------------------------- */
/*  Crawl-element matching + grounded selector construction                   */
/* -------------------------------------------------------------------------- */

/** Normalised view of a crawled DOM element (mirrors the crawl/profile shape). */
interface CrawledElement {
  tag: string;
  type?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  role?: string;
  textContent: string;
  nearbyLabel?: string;
  href?: string;
  attributes: Record<string, string>;
}

/** Flatten the various crawl-data shapes into a single element list. */
export function collectElements(crawlData: any): CrawledElement[] {
  if (!crawlData || typeof crawlData !== 'object') return [];
  const raw: any[] = [];
  const pushArr = (v: any) => { if (Array.isArray(v)) raw.push(...v); };

  pushArr(crawlData.interactiveElements);
  pushArr(crawlData.elements);
  pushArr(crawlData.buttons);
  pushArr(crawlData.inputs);
  pushArr(crawlData.links);
  pushArr(crawlData.navigationLinks);
  if (Array.isArray(crawlData.forms)) {
    for (const f of crawlData.forms) {
      pushArr(f?.fields);
      if (f?.submitButton) raw.push(f.submitButton);
    }
  }
  // Some profiles nest elements under pages[].
  if (Array.isArray(crawlData.pages)) {
    for (const p of crawlData.pages) {
      pushArr(p?.elements);
      pushArr(p?.interactiveElements);
      pushArr(p?.buttons);
      pushArr(p?.inputs);
    }
  }

  const seen = new Set<string>();
  const out: CrawledElement[] = [];
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue;
    const attributes = (r.attributes && typeof r.attributes === 'object') ? r.attributes : {};
    const el: CrawledElement = {
      tag: String(r.tag || r.tagName || '').toLowerCase(),
      type: r.type || attributes.type,
      id: r.id || attributes.id,
      name: r.name || attributes.name,
      placeholder: r.placeholder || attributes.placeholder,
      ariaLabel: r.ariaLabel || attributes['aria-label'],
      role: r.role || r.ariaRole || attributes.role,
      textContent: String(r.textContent || r.text || r.value || attributes.value || '').trim(),
      nearbyLabel: r.nearbyLabel || r.label,
      href: r.href || attributes.href,
      attributes,
    };
    const key = `${el.tag}|${el.textContent}|${el.id}|${el.name}|${el.attributes['data-test'] || el.attributes['data-testid'] || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(el);
  }
  return out;
}

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'on', 'in', 'with', 'click', 'press', 'tap', 'enter', 'type', 'fill', 'select', 'submit', 'button', 'link', 'field', 'input', 'box']);

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Find the crawled element that best matches the derived description. */
export function bestElementMatch(
  elements: CrawledElement[],
  description: string,
): { el: CrawledElement; score: number } | null {
  const tokens = tokenize(description);
  if (!tokens.length) return null;
  const wantRole = /\b(button|submit|link|checkbox|radio|tab|menu)\b/.exec(description)?.[1];

  let best: { el: CrawledElement; score: number } | null = null;
  for (const el of elements) {
    const hay = [
      el.textContent, el.ariaLabel, el.nearbyLabel, el.placeholder, el.name, el.id,
      el.attributes['data-test'], el.attributes['data-testid'], el.attributes['data-cy'],
      el.attributes['value'], el.role, el.type,
    ].filter(Boolean).join(' ').toLowerCase();
    if (!hay) continue;

    const hayTokens = tokenize(hay);
    let hits = 0;
    for (const t of tokens) {
      // Exact, prefix, or containment match so "log in" matches "login",
      // "user" matches "username", etc. (handles accessible-name vs id drift).
      if (hayTokens.some((h) => h === t || h.startsWith(t) || t.startsWith(h) || h.includes(t))) hits++;
    }
    let score = hits / tokens.length;
    if (score <= 0) continue; // never manufacture a match without real overlap

    // Role corroboration boost.
    const haveRole = inferRole(el);
    if (wantRole && haveRole && (wantRole === haveRole || (wantRole === 'submit' && haveRole === 'button'))) {
      score += 0.25;
    }
    if (!best || score > best.score) best = { el, score: Math.min(1, score) };
  }
  return best;
}

function inferRole(el: CrawledElement): string {
  if (el.role) return el.role.toLowerCase();
  const tag = el.tag;
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input') {
    const t = (el.type || '').toLowerCase();
    if (t === 'submit' || t === 'button') return 'button';
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    return 'textbox';
  }
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  return '';
}

/** Looks like a framework-generated / unstable id we should not target. */
function isDynamicId(id: string): boolean {
  if (!id) return true;
  return (
    /\d{4,}/.test(id) ||
    /[a-f0-9]{8,}/i.test(id) ||
    /^:r[0-9a-z]+:?$/i.test(id) ||
    /(ember|react|ng-|mui-|css-)/i.test(id)
  );
}

function esc(v: string): string {
  return v.replace(/'/g, "\\'");
}

/**
 * Build ordered, grounded candidate locators for a concrete matched element,
 * strongest/most-stable first. Every candidate is sourced from a real crawled
 * attribute/value — nothing is invented.
 */
export function buildGroundedCandidates(el: CrawledElement, description: string): AppProfileCandidate[] {
  const out: AppProfileCandidate[] = [];
  const seen = new Set<string>();
  const add = (locator: string, confidence: number, why: string) => {
    const norm = locator.trim();
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push({ locator: norm, confidence: Math.max(0, Math.min(1, confidence)), source: 'app_profile', reasoning: why, validated: true });
  };

  const a = el.attributes || {};
  const text = (el.textContent || el.ariaLabel || el.nearbyLabel || '').trim();
  const role = inferRole(el);

  // 1. data-test (SauceDemo & many apps) — exact attribute selector.
  if (a['data-test']) add(`page.locator('[data-test="${esc(a['data-test'])}"]')`, 0.96, `Grounded: data-test="${a['data-test']}" from crawl (matched "${description}")`);
  // 2. data-testid — getByTestId targets data-testid by default; also give the explicit attr alt.
  if (a['data-testid']) {
    const v = a['data-testid'];
    add(`page.getByTestId('${esc(v)}')`, 0.95, `Grounded: data-testid="${v}" from crawl`);
    add(`page.locator('[data-testid="${esc(v)}"]')`, 0.9, `Grounded: data-testid attribute from crawl`);
  }
  // 3. data-cy / data-qa.
  if (a['data-cy']) add(`page.locator('[data-cy="${esc(a['data-cy'])}"]')`, 0.93, `Grounded: data-cy="${a['data-cy']}" from crawl`);
  if (a['data-qa']) add(`page.locator('[data-qa="${esc(a['data-qa'])}"]')`, 0.92, `Grounded: data-qa="${a['data-qa']}" from crawl`);

  // 4. Accessible role + name (resilient, semantic).
  if (role && text) add(`page.getByRole('${role}', { name: '${esc(text)}' })`, 0.9, `Grounded: ${role} with accessible name "${text}" from crawl`);

  // 5. Stable id.
  if (el.id && !isDynamicId(el.id)) add(`page.locator('#${esc(el.id)}')`, 0.85, `Grounded: stable id #${el.id} from crawl`);

  // 6. name attribute (forms).
  if (el.name) add(`page.locator('[name="${esc(el.name)}"]')`, 0.83, `Grounded: name="${el.name}" from crawl`);

  // 7. Placeholder / label / text fallbacks.
  if (el.placeholder) add(`page.getByPlaceholder('${esc(el.placeholder)}')`, 0.8, `Grounded: placeholder "${el.placeholder}" from crawl`);
  if (el.nearbyLabel || el.ariaLabel) add(`page.getByLabel('${esc((el.nearbyLabel || el.ariaLabel)!)}')`, 0.8, `Grounded: label "${el.nearbyLabel || el.ariaLabel}" from crawl`);
  if (text && !role) add(`page.getByText('${esc(text)}')`, 0.75, `Grounded: text "${text}" from crawl`);

  // Keep the top few for resilience without flooding the retry loop.
  return out.slice(0, 4);
}
