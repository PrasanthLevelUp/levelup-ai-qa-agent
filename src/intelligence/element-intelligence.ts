/**
 * Element Intelligence — the single source of truth for locators.
 * ============================================================================
 *
 * WHY THIS EXISTS
 * ---------------
 * Historically LevelUp had TWO independent locator brains:
 *
 *   • Script Generation  (script-gen-engine.resolveGroundedSelectorTracked)
 *       → picked ONE selector, id-first, no ranked alternatives.
 *   • Healing            (app-profile-healing.buildGroundedCandidates)
 *       → produced RANKED, confidence-scored candidates, data-test-first.
 *
 * The same element therefore resolved DIFFERENTLY depending on who asked —
 * exactly the "everyone guesses their own way" problem. This module makes the
 * App Profile the authoritative locator service: it ranks every element's
 * candidate locators ONCE, with an explicit confidence + reasoning, and BOTH
 * Script Generation and Healing consume the identical ranking.
 *
 *     Crawler → DOM Memory → App Profile → Element Intelligence
 *                                              ├── Test Case Lab
 *                                              ├── Script Generation
 *                                              ├── Healing
 *                                              └── RCA
 *
 * The generation engine never invents a locator: it asks Element Intelligence
 * for "username" and gets back `[data-test="username"]` @ 99% (plus ranked
 * fallbacks). Healing consults the exact same catalogue.
 *
 * DESIGN PRINCIPLES
 * -----------------
 * 1. GROUNDED ONLY — every candidate is derived from a real crawled attribute
 *    or value. Nothing is hallucinated.
 * 2. RANKED — most-stable strategy first (data-test → ARIA role → id → …),
 *    each with a 0–1 confidence and a human-readable reason.
 * 3. PURE — deterministic and side-effect free, so it is trivially unit-tested
 *    and can run in the browser, the API, the CLI or a worker unchanged.
 */

/* -------------------------------------------------------------------------- */
/*  Public types                                                              */
/* -------------------------------------------------------------------------- */

/** The locator strategy a candidate is built from, strongest → weakest. */
export type LocatorStrategy =
  | 'data-test'
  | 'data-testid'
  | 'data-cy'
  | 'data-qa'
  | 'role'
  | 'id'
  | 'name'
  | 'placeholder'
  | 'label'
  | 'text'
  | 'css'
  | 'xpath';

/** A single ranked, grounded candidate locator for an element. */
export interface LocatorCandidate {
  /** Ready-to-use Playwright locator, e.g. `page.locator('[data-test="username"]')`. */
  locator: string;
  /** Raw CSS/attribute selector, e.g. `[data-test="username"]` (handy for display/copy). */
  css: string;
  /** Which strategy produced this candidate. */
  strategy: LocatorStrategy;
  /** Confidence on a 0–1 scale (1 = most trustworthy). */
  confidence: number;
  /** Human-readable explanation, e.g. `data-test hook — dedicated automation contract`. */
  reasoning: string;
  /** Whether this strategy is considered resilient to UI change. */
  stable: boolean;
}

/** The full intelligence record LevelUp stores for one element. */
export interface ElementIntelligence {
  /** Friendly semantic name, e.g. "Username", "Login Button". */
  semanticName: string;
  /** Inferred ARIA role / element kind, e.g. "textbox", "button", "link". */
  role: string;
  /** Coarse interactive category, e.g. "input", "button", "link", "select". */
  category: string;
  /** The default locator generation & healing should use (candidates[0]). */
  primary: LocatorCandidate | null;
  /** All ranked candidates, best first (includes `primary`). */
  candidates: LocatorCandidate[];
  /** Confidence of the primary candidate (0–1), surfaced for convenience. */
  confidence: number;
  /* ---- roadmap metadata (populated by callers over time) ---------------- */
  /** ISO timestamp this element was last observed/validated in a crawl. */
  lastValidated?: string;
  /** How many generated scripts reference this element (future analytics). */
  usedByScripts?: number;
  /** How many times healing successfully recovered this element (future). */
  healedCount?: number;
}

/** Structural element shape — compatible with both the crawler & healing models. */
export interface ElementLike {
  tag?: string;
  type?: string;
  id?: string;
  name?: string;
  placeholder?: string;
  ariaLabel?: string;
  ariaRole?: string;
  role?: string;
  textContent?: string;
  text?: string;
  value?: string;
  nearbyLabel?: string;
  label?: string;
  href?: string;
  className?: string;
  dataTestId?: string;
  attributes?: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

/** Case-insensitive attribute lookup that also mirrors promoted fields. */
function attr(el: ElementLike, key: string): string | undefined {
  const attrs = el.attributes || {};
  if (attrs[key] != null && attrs[key] !== '') return attrs[key];
  const lowerKey = key.toLowerCase();
  for (const k of Object.keys(attrs)) {
    if (k.toLowerCase() === lowerKey && attrs[k]) return attrs[k];
  }
  return undefined;
}

function esc(v: string): string {
  return String(v).replace(/'/g, "\\'");
}

function escAttr(v: string): string {
  return String(v).replace(/"/g, '\\"');
}

/** Looks like a framework-generated / unstable id we should not target. */
export function isDynamicId(id: string | undefined): boolean {
  if (!id) return true;
  return (
    /\d{4,}/.test(id) ||
    /[a-f0-9]{8,}/i.test(id) ||
    /^:r[0-9a-z]+:?$/i.test(id) ||
    /(ember|react|ng-|mui-|css-)/i.test(id)
  );
}

/** Infer a stable ARIA-ish role for an element. */
export function inferRole(el: ElementLike): string {
  if (el.role) return String(el.role).toLowerCase();
  if (el.ariaRole) return String(el.ariaRole).toLowerCase();
  const tag = String(el.tag || '').toLowerCase();
  if (tag === 'a') return 'link';
  if (tag === 'button') return 'button';
  if (tag === 'input') {
    const t = (el.type || attr(el, 'type') || '').toLowerCase();
    if (t === 'submit' || t === 'button') return 'button';
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    return 'textbox';
  }
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  return '';
}

/** Coarse interactive category (mirrors the dashboard's classifyElement). */
export function classifyCategory(el: ElementLike): string {
  const tag = String(el.tag || '').toLowerCase();
  const type = String(el.type || attr(el, 'type') || '').toLowerCase();
  const role = String(el.role || el.ariaRole || '').toLowerCase();
  if (tag === 'a' || role === 'link') return 'link';
  if (tag === 'button' || role === 'button' || type === 'submit' || type === 'button') return 'button';
  if (tag === 'select' || role === 'combobox' || role === 'listbox') return 'select';
  if (tag === 'textarea') return 'input';
  if (type === 'checkbox' || role === 'checkbox') return 'checkbox';
  if (type === 'radio' || role === 'radio') return 'radio';
  if (tag === 'input') return 'input';
  return 'other';
}

const STABLE_STRATEGIES = new Set<LocatorStrategy>([
  'data-test', 'data-testid', 'data-cy', 'data-qa', 'role', 'id', 'name',
]);

/* -------------------------------------------------------------------------- */
/*  The canonical ranking — the ONE place locator priority is decided         */
/* -------------------------------------------------------------------------- */

/**
 * Rank an element's candidate locators, strongest/most-stable first.
 *
 * Priority (data-test-first, per the Element Intelligence architecture):
 *   1. data-test        — dedicated automation contract              0.96
 *   2. data-testid       — dedicated automation contract              0.95
 *   3. data-cy / data-qa — dedicated automation contract         0.93 / 0.92
 *   4. ARIA role + name  — accessible + resilient to markup change   0.90
 *   5. stable id         — unique, non-dynamic identifier            0.85
 *   6. name              — stable for form fields                    0.83
 *   7. placeholder/label — readable, moderately stable               0.80
 *   8. visible text      — breaks on copy changes                    0.75
 *   9. css / xpath       — brittle fallbacks                    0.55 / 0.40
 *
 * Every candidate is grounded in a REAL crawled attribute/value.
 * `description` (optional) is only woven into the reasoning text.
 */
export function rankLocatorCandidates(el: ElementLike, description?: string): LocatorCandidate[] {
  const out: LocatorCandidate[] = [];
  const seen = new Set<string>();
  const ctx = description ? ` (matched "${description}")` : '';

  const add = (
    locator: string, css: string, strategy: LocatorStrategy, confidence: number, reasoning: string,
  ) => {
    const norm = locator.trim();
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push({
      locator: norm,
      css,
      strategy,
      confidence: Math.max(0, Math.min(1, confidence)),
      reasoning,
      stable: STABLE_STRATEGIES.has(strategy),
    });
  };

  const dataTest = attr(el, 'data-test');
  const dataTestId = attr(el, 'data-testid') || attr(el, 'data-test-id') || el.dataTestId;
  const dataCy = attr(el, 'data-cy');
  const dataQa = attr(el, 'data-qa');
  const role = inferRole(el);
  const text = (el.textContent || el.text || el.ariaLabel || el.nearbyLabel || el.label || attr(el, 'value') || '').trim();
  const name = el.name || attr(el, 'name');
  const id = el.id || attr(el, 'id');
  const placeholder = el.placeholder || attr(el, 'placeholder');
  const labelText = el.nearbyLabel || el.ariaLabel || el.label || attr(el, 'aria-label');

  // 1. data-test — dedicated automation hook (SauceDemo & many apps).
  if (dataTest) {
    add(`page.locator('[data-test="${escAttr(dataTest)}"]')`, `[data-test="${dataTest}"]`, 'data-test', 0.96,
      `data-test="${dataTest}" — dedicated automation contract${ctx}`);
  }
  // 2. data-testid — getByTestId targets data-testid by default; give the attr alt too.
  if (dataTestId) {
    add(`page.getByTestId('${esc(dataTestId)}')`, `[data-testid="${dataTestId}"]`, 'data-testid', 0.95,
      `data-testid="${dataTestId}" — dedicated automation contract`);
  }
  // 3. data-cy / data-qa.
  if (dataCy) add(`page.locator('[data-cy="${escAttr(dataCy)}"]')`, `[data-cy="${dataCy}"]`, 'data-cy', 0.93, `data-cy="${dataCy}" — dedicated automation hook`);
  if (dataQa) add(`page.locator('[data-qa="${escAttr(dataQa)}"]')`, `[data-qa="${dataQa}"]`, 'data-qa', 0.92, `data-qa="${dataQa}" — dedicated automation hook`);

  // 4. Accessible role + name — resilient & semantic.
  if (role && text) {
    add(`page.getByRole('${role}', { name: '${esc(text)}' })`, `role=${role}[name="${text}"]`, 'role', 0.9,
      `${role} with accessible name "${text}" — resilient to markup changes`);
  }

  // 5. Stable id.
  if (id && !isDynamicId(id)) add(`page.locator('#${esc(id)}')`, `#${id}`, 'id', 0.85, `stable id #${id}`);

  // 6. name attribute (forms).
  if (name) add(`page.locator('[name="${escAttr(name)}"]')`, `[name="${name}"]`, 'name', 0.83, `name="${name}" — stable for form fields`);

  // 7. Placeholder / label.
  if (placeholder) add(`page.getByPlaceholder('${esc(placeholder)}')`, `[placeholder="${placeholder}"]`, 'placeholder', 0.8, `placeholder "${placeholder}"`);
  if (labelText) add(`page.getByLabel('${esc(labelText)}')`, `label="${labelText}"`, 'label', 0.8, `associated label "${labelText}"`);

  // 8. Visible text (last semantic resort).
  if (text && !role) add(`page.getByText('${esc(text)}')`, `text=${text}`, 'text', 0.75, `visible text "${text}" — breaks on copy changes`);

  // Candidates are added in descending priority; keep that order.
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Semantic naming + catalogue building                                     */
/* -------------------------------------------------------------------------- */

/** Derive a friendly semantic name for an element (e.g. "Login Button"). */
export function deriveSemanticName(el: ElementLike): string {
  const raw =
    attr(el, 'data-test') || attr(el, 'data-testid') || el.dataTestId ||
    el.ariaLabel || attr(el, 'aria-label') ||
    el.nearbyLabel || el.label ||
    (el.textContent || el.text || '').trim() ||
    el.placeholder || attr(el, 'placeholder') ||
    el.name || attr(el, 'name') ||
    el.id || attr(el, 'id') ||
    '';

  const humanized = String(raw)
    .replace(/[#.\[\]'"`()]/g, ' ')
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();

  const base = humanized
    ? humanized.split(' ').map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w)).join(' ')
    : (String(el.tag || 'Element')[0].toUpperCase() + String(el.tag || 'lement').slice(1));

  // Append a role hint for buttons/links so names read naturally.
  const cat = classifyCategory(el);
  const suffix = cat === 'button' ? ' Button' : cat === 'link' ? ' Link' : '';
  const already = new RegExp(`\\b(button|link)\\b`, 'i').test(base);
  return (already ? base : `${base}${suffix}`).slice(0, 60);
}

/** Flatten the various crawl-data shapes into a single element list. */
export function collectElements(crawlData: any): ElementLike[] {
  if (!crawlData || typeof crawlData !== 'object') return [];
  const raw: any[] = [];
  const push = (v: any) => { if (Array.isArray(v)) raw.push(...v); };

  push(crawlData.interactiveElements);
  push(crawlData.elements);
  push(crawlData.buttons);
  push(crawlData.inputs);
  push(crawlData.links);
  push(crawlData.navigationLinks);
  if (Array.isArray(crawlData.forms)) {
    for (const f of crawlData.forms) {
      push(f?.fields);
      if (f?.submitButton) raw.push(f.submitButton);
    }
  }
  if (Array.isArray(crawlData.pages)) {
    for (const p of crawlData.pages) {
      push(p?.elements);
      push(p?.interactiveElements);
      push(p?.buttons);
      push(p?.inputs);
    }
  }
  return raw.filter((r) => r && typeof r === 'object');
}

/**
 * Build the Element Intelligence catalogue for a crawl / App Profile: one
 * ranked, confidence-scored record per addressable element. This is what the
 * App Profile exposes as the single source of truth for locators.
 *
 * `opts.max` caps the catalogue (default 500) to keep payloads sane.
 */
export function buildElementIntelligence(
  crawlData: any,
  opts?: { max?: number; lastValidated?: string },
): ElementIntelligence[] {
  const els = collectElements(crawlData);
  const max = opts?.max ?? 500;
  const out: ElementIntelligence[] = [];
  const seen = new Set<string>();

  for (const el of els) {
    const candidates = rankLocatorCandidates(el);
    if (!candidates.length) continue; // no grounded locator → not addressable
    const primary = candidates[0];

    // De-dup on the primary locator so the same element isn't listed twice.
    if (seen.has(primary.locator)) continue;
    seen.add(primary.locator);

    out.push({
      semanticName: deriveSemanticName(el),
      role: inferRole(el),
      category: classifyCategory(el),
      primary,
      candidates,
      confidence: primary.confidence,
      lastValidated: opts?.lastValidated,
    });
    if (out.length >= max) break;
  }

  // Most-trustworthy elements first.
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Intent resolution — "give me the best locator for X"                      */
/* -------------------------------------------------------------------------- */

const STOP = new Set([
  'the', 'a', 'an', 'to', 'of', 'for', 'and', 'or', 'on', 'in', 'with', 'click',
  'press', 'tap', 'enter', 'type', 'fill', 'select', 'submit', 'button', 'link',
  'field', 'input', 'box',
]);

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Resolve a semantic intent ("username", "login button") against an element
 * list and return its ranked candidates — the query API both Script Generation
 * and Healing use. Never manufactures a match without real token overlap.
 */
export function resolveByIntent(
  els: ElementLike[],
  intent: string,
): { element: ElementLike; candidates: LocatorCandidate[]; score: number } | null {
  const tokens = tokenize(intent);
  if (!tokens.length) return null;
  const wantRole = /\b(button|submit|link|checkbox|radio|tab|menu)\b/.exec(intent)?.[1];

  let best: { element: ElementLike; score: number } | null = null;
  for (const el of els) {
    const hay = [
      el.textContent, el.text, el.ariaLabel, el.nearbyLabel, el.label, el.placeholder,
      el.name, el.id, attr(el, 'data-test'), attr(el, 'data-testid'), attr(el, 'data-cy'),
      attr(el, 'value'), el.role, el.type,
    ].filter(Boolean).join(' ').toLowerCase();
    if (!hay) continue;

    const hayTokens = tokenize(hay);
    let hits = 0;
    for (const t of tokens) {
      if (hayTokens.some((h) => h === t || h.startsWith(t) || t.startsWith(h) || h.includes(t))) hits++;
    }
    let score = hits / tokens.length;
    if (score <= 0) continue;

    const haveRole = inferRole(el);
    if (wantRole && haveRole && (wantRole === haveRole || (wantRole === 'submit' && haveRole === 'button'))) {
      score += 0.25;
    }
    if (!best || score > best.score) best = { element: el, score: Math.min(1, score) };
  }

  if (!best) return null;
  return { element: best.element, candidates: rankLocatorCandidates(best.element, intent), score: best.score };
}
