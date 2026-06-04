/**
 * Locator Resolution Service (Sprint 4 — Enterprise Script Generation Enhancement)
 * ================================================================================
 *
 * THE PROBLEM
 * -----------
 * AI-generated Playwright scripts frequently contain *invented* or *sample*
 * locators that don't exist in the real application DOM — e.g.
 *   page.locator('#submit-button')          (a guessed CSS id)
 *   page.getByTestId('login-form')          (a hallucinated test id)
 *   page.locator('input[name="email"]')     (an attribute that may not exist)
 * These cause scripts to fail on the very first run, eroding user trust.
 *
 * THE SOLUTION
 * ------------
 * This service resolves every element a test step needs to interact with by
 * walking a strict PRIORITY CASCADE, preferring evidence that is grounded in
 * real data over anything the model "guesses":
 *
 *   LEVEL 1  Application Profile DOM   — cached crawl data (highest confidence)
 *   LEVEL 2  App Knowledge             — human-documented selectors
 *   LEVEL 3  Repository Patterns       — locators used by existing repo tests
 *   LEVEL 4  Smart Fallbacks           — AI-inferred, role/text-based ONLY
 *
 * It then VALIDATES each resolved locator against the cached DOM and a set of
 * anti-patterns, builds a per-element report, and annotates low-confidence
 * locators with a `// TODO: Verify ...` marker so a human can review them.
 *
 * DESIGN NOTES
 * ------------
 * • Pure / CPU-only — never touches the network, filesystem, or a live browser.
 * • Defensive — tolerates missing/partial inputs (graceful degradation). All
 *   sources are optional; with zero context it still emits safe role/text
 *   fallbacks rather than throwing.
 * • Loosely-typed crawl data — accepts both the `ApplicationProfile.crawl_data`
 *   JSONB shape and the live `CrawlResult` shape (they share `elements[]`).
 */

import type { KnowledgeItem } from '../ai/knowledge-optimizer';
import type { RepositoryProfile } from '../context/types';

/* -------------------------------------------------------------------------- */
/*  Public Types                                                              */
/* -------------------------------------------------------------------------- */

/** Which cascade level produced a locator. */
export type LocatorSource =
  | 'app_profile'
  | 'app_knowledge'
  | 'repo_patterns'
  | 'smart_fallback';

/** A single resolved locator with full provenance. */
export interface ResolvedLocator {
  /** The Playwright locator string (e.g. `page.getByRole('button', { name: /submit/i })`). */
  locator: string;
  /** Confidence this locator is valid, 0–100. */
  confidence: number;
  /** Which resolution level provided this locator. */
  source: LocatorSource;
  /** The original element description from the test step. */
  elementDescription: string;
  /** Whether this locator was validated against real (cached) DOM. */
  validated: boolean;
  /** Alternative locators for resilience (1–2, may include inline comments). */
  alternatives: string[];
  /**
   * Optional code comment to emit immediately above the locator usage. Present
   * for low-confidence / AI-inferred locators (e.g. `// TODO: Verify ...`).
   */
  todoComment?: string;
}

/** Result of validating a single locator string. */
export interface LocatorValidation {
  locator: string;
  isValid: boolean;
  validationMethod: 'dom_match' | 'pattern_check' | 'syntax_only';
  warnings: string[];
}

/**
 * Loosely-typed view of crawl data. Compatible with both
 * `ApplicationProfile.crawl_data` JSONB and the live `CrawlResult`.
 */
export interface CrawlDataLike {
  elements?: any[];
  interactiveElements?: any[];
  buttons?: any[];
  inputs?: any[];
  forms?: any[];
  navigationLinks?: any[];
  [key: string]: any;
}

/** Inputs that steer locator resolution. */
export interface LocatorResolverConfig {
  /** Cached DOM data from the Application Profile (preferred source). */
  crawlData?: CrawlDataLike | null;
  /** Knowledge items that may carry documented selectors. */
  knowledgeItems?: KnowledgeItem[];
  /** Repository profile with preferred locator patterns. */
  repoProfile?: RepositoryProfile | null;
  /** Minimum confidence to accept a locator before falling through. Default 50. */
  minConfidence?: number;
}

/** Aggregated locator-quality summary stored in `generated_scripts.locator_report`. */
export interface LocatorReport {
  totalLocators: number;
  validatedCount: number;
  /** Count of locators flagged low-confidence (carry a // TODO marker). */
  todoCount: number;
  /** Average confidence across all resolved locators (0–100). */
  avgConfidence: number;
  /** Breakdown of how many locators came from each cascade level. */
  sources: Record<LocatorSource, number>;
  /** Per-element detail (kept compact for JSONB storage). */
  locators: Array<{
    elementDescription: string;
    locator: string;
    source: LocatorSource;
    confidence: number;
    validated: boolean;
  }>;
  /** Human-readable warnings collected during validation. */
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/*  Internal Types                                                            */
/* -------------------------------------------------------------------------- */

/** A candidate locator before source/validation metadata is attached. */
interface LocatorCandidate {
  locator: string;
  confidence: number;
  alternatives: string[];
}

/** Normalised view of a single crawled DOM element. */
interface DomElement {
  tag: string;
  type?: string;
  id?: string;
  name?: string;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  role?: string;
  dataTestId?: string;
  textContent: string;
  nearbyLabel?: string;
  href?: string;
  attributes: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/*  Anti-patterns (reject these — they fail or are brittle on first run)      */
/* -------------------------------------------------------------------------- */

const ANTI_PATTERNS: RegExp[] = [
  /page\.locator\(['"]#[a-z]+-[a-z]+['"]\)/i,        // guessed CSS ids: #submit-button
  /data-testid=['"](?:test|example|sample|foo|bar)/i, // sample/placeholder test ids
  /page\.locator\(['"]div\s*>\s*div\s*>\s*div/i,      // deep structural selectors
  /page\.locator\(['"]\.css-[a-z0-9]+['"]\)/i,        // CSS-module hashes
  /page\.locator\(['"]\[class\*=/i,                   // partial class matching
  /:nth-child\(/i,                                    // positional structural selectors
];

/** Locators built from accessible roles/text/labels are resilient by design. */
const ROLE_BASED_RE = /getByRole|getByText|getByLabel|getByPlaceholder|getByAltText|getByTitle/;

/* -------------------------------------------------------------------------- */
/*  LocatorResolver                                                           */
/* -------------------------------------------------------------------------- */

export class LocatorResolver {
  private readonly minConfidence: number;

  constructor(private readonly config: LocatorResolverConfig = {}) {
    this.minConfidence = config.minConfidence ?? 50;
  }

  /* ----------------------------- Resolution ----------------------------- */

  /**
   * Resolve the best locator for an element description by walking the
   * priority cascade. Always returns a locator (never throws) — at worst a
   * role/text-based smart fallback flagged with a // TODO.
   */
  resolve(elementDescription: string, overrides?: Partial<LocatorResolverConfig>): ResolvedLocator {
    const cfg: LocatorResolverConfig = { ...this.config, ...overrides };
    const desc = (elementDescription || '').trim();

    // LEVEL 1 — Application Profile DOM (highest confidence: 80–100)
    if (cfg.crawlData) {
      const domMatch = this.matchFromDom(desc, cfg.crawlData);
      if (domMatch && domMatch.confidence >= 80) {
        return this.finalize(domMatch, 'app_profile', desc, true);
      }
    }

    // LEVEL 2 — App Knowledge (documented selectors: 70–95)
    if (cfg.knowledgeItems?.length) {
      const kMatch = this.matchFromKnowledge(desc, cfg.knowledgeItems);
      if (kMatch && kMatch.confidence >= 70) {
        return this.finalize(kMatch, 'app_knowledge', desc, false);
      }
    }

    // LEVEL 3 — Repository patterns (existing test code: 60–85)
    if (cfg.repoProfile) {
      const rMatch = this.matchFromRepoPatterns(desc, cfg.repoProfile);
      if (rMatch && rMatch.confidence >= 60) {
        return this.finalize(rMatch, 'repo_patterns', desc, false);
      }
    }

    // LEVEL 4 — Smart fallback (role/text-based ONLY: ≤ 70)
    return this.generateSmartFallback(desc);
  }

  /** Resolve a batch of element descriptions and build the aggregate report. */
  resolveAll(elementDescriptions: string[], overrides?: Partial<LocatorResolverConfig>): {
    resolved: ResolvedLocator[];
    report: LocatorReport;
  } {
    const resolved = (elementDescriptions || [])
      .filter((d) => d && d.trim().length > 0)
      .map((d) => this.resolve(d, overrides));
    return { resolved, report: this.buildReport(resolved, overrides?.crawlData ?? this.config.crawlData) };
  }

  /* --------------------------- Level 1: DOM ----------------------------- */

  /**
   * Find the best matching element in the cached crawl data and emit the
   * strongest available locator for it. Preference order within the DOM:
   *   1. data-testid / data-cy / data-test
   *   2. getByRole() with accessible name
   *   3. getByLabel() for form fields
   *   4. getByText() for buttons/links with unique text
   *   5. getByPlaceholder() for inputs
   */
  private matchFromDom(description: string, crawlData: CrawlDataLike): LocatorCandidate | null {
    const elements = this.collectElements(crawlData);
    if (!elements.length) return null;

    const tokens = this.tokenize(description);
    if (!tokens.length) return null;

    let best: { el: DomElement; score: number } | null = null;
    for (const el of elements) {
      const score = this.scoreElement(el, tokens, description);
      if (score > 0 && (!best || score > best.score)) best = { el, score };
    }
    if (!best) return null;

    const { el } = best;
    // Map the fuzzy match score (0..1) into a 80..100 confidence band — these
    // are grounded in real DOM, so they start high.
    const confidence = Math.min(100, Math.round(80 + best.score * 20));
    const candidate = this.bestLocatorForElement(el);
    if (!candidate) return null;
    return { ...candidate, confidence: Math.max(candidate.confidence, confidence) };
  }

  /** Produce the strongest locator string for a concrete DOM element. */
  private bestLocatorForElement(el: DomElement): LocatorCandidate | null {
    const alternatives: string[] = [];
    const text = this.cleanText(el.textContent) || this.cleanText(el.ariaLabel) || this.cleanText(el.nearbyLabel);
    const role = this.inferRole(el);

    // 1. data-testid / data-cy / data-test (only REAL ones from the DOM)
    const testId = el.dataTestId
      || el.attributes?.['data-testid']
      || el.attributes?.['data-cy']
      || el.attributes?.['data-test'];
    if (testId) {
      const primary = el.attributes?.['data-cy']
        ? `page.locator('[data-cy="${testId}"]')`
        : `page.getByTestId('${testId}')`;
      if (role && text) alternatives.push(`page.getByRole('${role}', { name: ${this.rx(text)} })`);
      return { locator: primary, confidence: 98, alternatives };
    }

    // 2. getByRole() with accessible name
    if (role && text) {
      const primary = `page.getByRole('${role}', { name: ${this.rx(text)} })`;
      if (text) alternatives.push(`page.getByText(${this.rx(text)})`);
      return { locator: primary, confidence: 92, alternatives };
    }

    // 3. getByLabel() for form fields
    const label = this.cleanText(el.nearbyLabel) || this.cleanText(el.ariaLabel);
    if (this.isFormField(el) && label) {
      const primary = `page.getByLabel(${this.rx(label)})`;
      if (el.placeholder) alternatives.push(`page.getByPlaceholder('${this.cleanText(el.placeholder)}')`);
      return { locator: primary, confidence: 88, alternatives };
    }

    // 4. getByText() for elements with unique text
    if (text) {
      return { locator: `page.getByText(${this.rx(text)})`, confidence: 84, alternatives };
    }

    // 5. getByPlaceholder() for inputs
    if (el.placeholder) {
      return { locator: `page.getByPlaceholder('${this.cleanText(el.placeholder)}')`, confidence: 82, alternatives };
    }

    return null;
  }

  /* ------------------------ Level 2: Knowledge -------------------------- */

  /**
   * Look for a documented selector in App Knowledge items. We scan the item's
   * description/metadata for either an explicit selector string or a labelled
   * selector (e.g. "Login button: [data-cy='submit-login']").
   */
  private matchFromKnowledge(description: string, items: KnowledgeItem[]): LocatorCandidate | null {
    const tokens = this.tokenize(description);
    if (!tokens.length) return null;

    let best: { selector: string; score: number } | null = null;

    for (const item of items) {
      // Structured selectors first (metadata.selectors: { label: selector }).
      const metaSelectors = (item.metadata?.selectors || item.metadata?.locators) as Record<string, string> | undefined;
      if (metaSelectors && typeof metaSelectors === 'object') {
        for (const [label, selector] of Object.entries(metaSelectors)) {
          if (typeof selector !== 'string') continue;
          const score = this.overlap(tokens, this.tokenize(label));
          if (score > 0 && (!best || score > best.score)) best = { selector, score };
        }
      }

      // Free-text selectors embedded in the description.
      const haystack = `${item.title} ${item.description}`;
      const docScore = this.overlap(tokens, this.tokenize(haystack));
      if (docScore > 0.3) {
        const sel = this.extractSelectorFromText(item.description);
        if (sel && (!best || docScore > best.score)) best = { selector: sel, score: docScore };
      }
    }

    if (!best) return null;
    const confidence = Math.min(95, Math.round(70 + best.score * 25));
    return {
      locator: this.selectorToLocator(best.selector),
      confidence,
      alternatives: [],
    };
  }

  /* ------------------------- Level 3: Repo ------------------------------ */

  /**
   * Reuse the repository's *preferred* locator patterns. We don't have the
   * concrete element here, so we adopt the repo's dominant strategy (e.g. the
   * team consistently uses getByRole) and apply it to the inferred role/text.
   */
  private matchFromRepoPatterns(description: string, repo: RepositoryProfile): LocatorCandidate | null {
    const preferred = (repo.preferredLocators || []).slice().sort((a, b) => b.count - a.count);
    if (!preferred.length) return null;

    const role = this.inferRoleFromText(description);
    const text = this.inferTextFromDescription(description);
    if (!text) return null;

    const top = preferred[0].pattern.toLowerCase();
    let locator: string;
    if (top.includes('getbyrole') || top.includes('role')) {
      locator = `page.getByRole('${role}', { name: ${this.rx(text)} })`;
    } else if (top.includes('getbylabel') || top.includes('label')) {
      locator = `page.getByLabel(${this.rx(text)})`;
    } else if (top.includes('getbytext') || top.includes('text')) {
      locator = `page.getByText(${this.rx(text)})`;
    } else if (top.includes('testid') || top.includes('data-test')) {
      // The repo favours test ids, but we have none verified — fall back to role
      // (we must never invent a data-testid value).
      locator = `page.getByRole('${role}', { name: ${this.rx(text)} })`;
    } else {
      locator = `page.getByRole('${role}', { name: ${this.rx(text)} })`;
    }

    // Confidence scales with how dominant the top pattern is.
    const totalCount = preferred.reduce((s, p) => s + p.count, 0) || 1;
    const dominance = preferred[0].count / totalCount;
    const confidence = Math.min(85, Math.round(60 + dominance * 25));
    return { locator, confidence, alternatives: [`page.getByText(${this.rx(text)})`] };
  }

  /* ----------------------- Level 4: Fallback ---------------------------- */

  /**
   * Generate a SAFE, role/text-based fallback. STRICT rules:
   *   • PREFER getByRole() — survives DOM changes
   *   • PREFER getByText() / getByLabel() — resilient to structure changes
   *   • NEVER invent data-testid values not seen in the DOM
   *   • NEVER emit CSS ids
   *   • confidence ≤ 70 and ALWAYS carry a // TODO marker for human review
   */
  private generateSmartFallback(description: string): ResolvedLocator {
    const role = this.inferRoleFromText(description);
    const text = this.inferTextFromDescription(description) || description;

    const primary = `page.getByRole('${role}', { name: ${this.rx(text)} })`;
    const alternatives = [`page.getByText(${this.rx(text)})`];
    if (this.looksLikeField(description)) {
      alternatives.push(`page.getByLabel(${this.rx(text)})`);
    }

    return {
      locator: primary,
      confidence: 55,
      source: 'smart_fallback',
      elementDescription: description,
      validated: false,
      alternatives,
      todoComment: '// TODO: AI-inferred locator — verify against the real DOM',
    };
  }

  /* --------------------------- Validation ------------------------------- */

  /**
   * Validate a locator string. Order:
   *   1. Syntax check
   *   2. Anti-pattern rejection
   *   3. DOM match (when crawl data available)
   *   4. Pattern heuristics (role-based locators pass)
   */
  validateLocator(locator: string, crawlData?: CrawlDataLike | null): LocatorValidation {
    const warnings: string[] = [];

    if (!this.isValidPlaywrightLocator(locator)) {
      return { locator, isValid: false, validationMethod: 'syntax_only', warnings: ['Invalid Playwright locator syntax'] };
    }

    for (const pattern of ANTI_PATTERNS) {
      if (pattern.test(locator)) warnings.push(`Locator matches anti-pattern: ${pattern.source}`);
    }
    const matchesAntiPattern = warnings.length > 0;

    const data = crawlData ?? this.config.crawlData;
    if (data) {
      const found = this.findElementInDom(locator, data);
      if (!found) {
        warnings.push('Locator not found in cached DOM — may be invalid');
        return { locator, isValid: false, validationMethod: 'dom_match', warnings };
      }
      return { locator, isValid: !matchesAntiPattern, validationMethod: 'dom_match', warnings };
    }

    const isRoleBased = ROLE_BASED_RE.test(locator);
    return {
      locator,
      isValid: isRoleBased && !matchesAntiPattern,
      validationMethod: 'pattern_check',
      warnings: isRoleBased
        ? warnings
        : [...warnings, 'No DOM data to validate against — using pattern heuristics'],
    };
  }

  /* ----------------------------- Report --------------------------------- */

  /** Build the aggregate locator-quality report for `generated_scripts.locator_report`. */
  buildReport(resolved: ResolvedLocator[], crawlData?: CrawlDataLike | null): LocatorReport {
    const sources: Record<LocatorSource, number> = {
      app_profile: 0,
      app_knowledge: 0,
      repo_patterns: 0,
      smart_fallback: 0,
    };
    const warnings: string[] = [];
    let validatedCount = 0;
    let todoCount = 0;
    let confidenceSum = 0;

    const locators = resolved.map((r) => {
      sources[r.source] = (sources[r.source] ?? 0) + 1;
      if (r.validated) validatedCount++;
      if (r.todoComment) todoCount++;
      confidenceSum += r.confidence;

      // Re-validate each primary locator for the report's warning surface.
      const v = this.validateLocator(r.locator, crawlData);
      if (!v.isValid) {
        warnings.push(`"${r.elementDescription}": ${v.warnings.join('; ') || 'invalid locator'}`);
      }
      return {
        elementDescription: r.elementDescription,
        locator: r.locator,
        source: r.source,
        confidence: r.confidence,
        validated: r.validated,
      };
    });

    return {
      totalLocators: resolved.length,
      validatedCount,
      todoCount,
      avgConfidence: resolved.length ? Math.round(confidenceSum / resolved.length) : 0,
      sources,
      locators,
      warnings,
    };
  }

  /* --------------------------- DOM helpers ------------------------------ */

  /** Normalise the various crawl-data shapes into a flat DomElement[]. */
  private collectElements(crawlData: CrawlDataLike): DomElement[] {
    const raw: any[] = [];
    // `interactiveElements` may be a number (CrawlResult) OR an array (some
    // profile shapes). Only spread when it's an array.
    if (Array.isArray(crawlData.interactiveElements)) raw.push(...crawlData.interactiveElements);
    if (Array.isArray(crawlData.elements)) raw.push(...crawlData.elements);
    if (Array.isArray(crawlData.buttons)) raw.push(...crawlData.buttons);
    if (Array.isArray(crawlData.inputs)) raw.push(...crawlData.inputs);
    if (Array.isArray(crawlData.navigationLinks)) raw.push(...crawlData.navigationLinks);
    if (Array.isArray(crawlData.forms)) {
      for (const f of crawlData.forms) {
        if (Array.isArray(f?.fields)) raw.push(...f.fields);
        if (f?.submitButton) raw.push(f.submitButton);
      }
    }

    const seen = new Set<string>();
    const out: DomElement[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      const el: DomElement = {
        tag: String(r.tag || r.tagName || '').toLowerCase(),
        type: r.type,
        id: r.id,
        name: r.name,
        className: r.className,
        placeholder: r.placeholder,
        ariaLabel: r.ariaLabel,
        role: r.role || r.ariaRole,
        dataTestId: r.dataTestId,
        textContent: r.textContent || r.text || '',
        nearbyLabel: r.nearbyLabel,
        href: r.href,
        attributes: (r.attributes && typeof r.attributes === 'object') ? r.attributes : {},
      };
      const key = `${el.tag}|${el.textContent}|${el.id}|${el.dataTestId}|${el.name}|${el.href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(el);
    }
    return out;
  }

  /**
   * Best-effort DOM presence check for a locator. We extract the salient value
   * (test id, accessible name, label, text, placeholder) from the locator
   * string and confirm a matching element exists in the crawl data.
   */
  private findElementInDom(locator: string, crawlData: CrawlDataLike): boolean {
    const elements = this.collectElements(crawlData);
    if (!elements.length) return false;

    const testId = /getByTestId\(['"]([^'"]+)['"]\)/.exec(locator)?.[1]
      || /data-(?:testid|cy|test)=['"]([^'"]+)['"]/.exec(locator)?.[1];
    if (testId) {
      return elements.some((e) =>
        e.dataTestId === testId
        || e.attributes?.['data-testid'] === testId
        || e.attributes?.['data-cy'] === testId
        || e.attributes?.['data-test'] === testId);
    }

    // Extract a text/name fragment from getByRole/getByText/getByLabel/getByPlaceholder.
    const nameMatch = /name:\s*\/([^/]+)\//i.exec(locator)
      || /getByText\((?:\/([^/]+)\/|['"]([^'"]+)['"])/i.exec(locator)
      || /getByLabel\((?:\/([^/]+)\/|['"]([^'"]+)['"])/i.exec(locator)
      || /getByPlaceholder\(['"]([^'"]+)['"]\)/i.exec(locator);
    const needle = nameMatch ? (nameMatch[1] || nameMatch[2] || '').toLowerCase() : '';
    if (needle) {
      const nTokens = this.tokenize(needle);
      return elements.some((e) => {
        const hay = `${e.textContent} ${e.ariaLabel || ''} ${e.nearbyLabel || ''} ${e.placeholder || ''}`.toLowerCase();
        return this.overlap(nTokens, this.tokenize(hay)) >= 0.5;
      });
    }

    // Could not extract a comparable token — treat as "unknown but not absent".
    return true;
  }

  /* --------------------------- Scoring ---------------------------------- */

  /** Fuzzy score (0..1) of how well an element matches the description tokens. */
  private scoreElement(el: DomElement, tokens: string[], description: string): number {
    const haystack = [
      el.textContent, el.ariaLabel, el.nearbyLabel, el.placeholder,
      el.name, el.id, el.role, el.type, el.attributes?.['data-testid'],
    ].filter(Boolean).join(' ').toLowerCase();
    if (!haystack) return 0;

    const base = this.overlap(tokens, this.tokenize(haystack));

    // CRITICAL: role/interaction boosts must NEVER manufacture a match on their
    // own. `inferRoleFromText` defaults to 'button' for almost any description,
    // so without a textual-overlap gate every unmatched step would spuriously
    // bind to the first button on the page. Require real token overlap first.
    if (base <= 0) return 0;

    let score = base;

    // Boost when the described UI role matches the element's actual role/tag.
    const wantRole = this.inferRoleFromText(description);
    const haveRole = this.inferRole(el);
    if (wantRole && haveRole && wantRole === haveRole) score += 0.25;

    // Boost interactive elements when the step implies interaction.
    if (/click|press|tap|select|enter|type|fill|submit/i.test(description) && this.isInteractive(el)) {
      score += 0.1;
    }
    return Math.min(1, score);
  }

  /** Token overlap ratio relative to the needle token set. */
  private overlap(needle: string[], haystack: string[]): number {
    if (!needle.length || !haystack.length) return 0;
    const hset = new Set(haystack);
    let hits = 0;
    for (const t of needle) if (hset.has(t)) hits++;
    return hits / needle.length;
  }

  /* ----------------------- Inference helpers ---------------------------- */

  private inferRole(el: DomElement): string {
    if (el.role) return el.role;
    switch (el.tag) {
      case 'button': return 'button';
      case 'a': return 'link';
      case 'input':
        if (el.type === 'checkbox') return 'checkbox';
        if (el.type === 'radio') return 'radio';
        if (el.type === 'submit' || el.type === 'button') return 'button';
        return 'textbox';
      case 'select': return 'combobox';
      case 'textarea': return 'textbox';
      case 'img': return 'img';
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6': return 'heading';
      default: return 'button';
    }
  }

  private inferRoleFromText(description: string): string {
    const d = description.toLowerCase();
    if (/\blink\b|navigate to|go to/.test(d)) return 'link';
    if (/\bcheckbox\b|check the|toggle/.test(d)) return 'checkbox';
    if (/\bradio\b/.test(d)) return 'radio';
    if (/\bdropdown\b|\bselect\b|combobox/.test(d)) return 'combobox';
    if (/\bfield\b|\binput\b|\btext box\b|textbox|enter |type |fill /.test(d)) return 'textbox';
    if (/\bheading\b|\btitle\b/.test(d)) return 'heading';
    if (/\btab\b/.test(d)) return 'tab';
    return 'button';
  }

  /** Pull the most likely visible-text fragment out of a free-text description. */
  private inferTextFromDescription(description: string): string {
    // Prefer quoted text: Click the "Sign In" button → Sign In
    const quoted = /["'“”‘’]([^"'“”‘’]{2,40})["'“”‘’]/.exec(description);
    if (quoted) return quoted[1].trim();

    // Strip common action/role words to leave the label.
    const cleaned = description
      .replace(/\b(click|press|tap|select|enter|type|fill|submit|the|a|an|on|in|into|button|link|field|input|checkbox|dropdown|icon)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || description.trim();
  }

  private looksLikeField(description: string): boolean {
    return /\bfield\b|\binput\b|enter |type |fill |email|password|username|search/i.test(description);
  }

  private isFormField(el: DomElement): boolean {
    return el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select';
  }

  private isInteractive(el: DomElement): boolean {
    return ['button', 'a', 'input', 'select', 'textarea'].includes(el.tag)
      || ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem'].includes(el.role || '');
  }

  /* --------------------------- Text utils ------------------------------- */

  private tokenize(s: string): string[] {
    return (s || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .filter((t) => t.length > 1 && !STOPWORDS.has(t));
  }

  private cleanText(s?: string): string {
    return (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  }

  /** Build a case-insensitive regex literal for a Playwright name option. */
  private rx(text: string): string {
    const escaped = this.cleanText(text).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    return `/${escaped}/i`;
  }

  /** Convert a raw CSS/attribute selector string into an idiomatic locator. */
  private selectorToLocator(selector: string): string {
    const s = selector.trim();
    const testId = /\[data-(?:testid|test-id)=['"]?([^'"\]]+)['"]?\]/.exec(s)?.[1];
    if (testId) return `page.getByTestId('${testId}')`;
    const cy = /\[data-cy=['"]?([^'"\]]+)['"]?\]/.exec(s)?.[1];
    if (cy) return `page.locator('[data-cy="${cy}"]')`;
    // Already a page.* call? keep as-is.
    if (/^page\./.test(s)) return s;
    return `page.locator('${s.replace(/'/g, "\\'")}')`;
  }

  /** Extract the first plausible selector token out of free text. */
  private extractSelectorFromText(text: string): string | null {
    const m = /(\[data-[a-z-]+=['"][^'"]+['"]\]|#[\w-]+|\.[\w-]+|page\.[a-zA-Z]+\([^)]*\))/.exec(text || '');
    return m ? m[1] : null;
  }

  /** Lightweight syntax sanity check for a Playwright locator expression. */
  private isValidPlaywrightLocator(locator: string): boolean {
    if (!locator || typeof locator !== 'string') return false;
    if (!/^page\.(locator|getBy[A-Za-z]+|frameLocator)\s*\(/.test(locator.trim())) return false;
    // Balanced parentheses.
    let depth = 0;
    for (const ch of locator) {
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth < 0) return false;
    }
    return depth === 0;
  }

  /** Attach source/validation metadata + low-confidence TODO marker. */
  private finalize(
    candidate: LocatorCandidate,
    source: LocatorSource,
    description: string,
    validated: boolean,
  ): ResolvedLocator {
    const resolved: ResolvedLocator = {
      locator: candidate.locator,
      confidence: candidate.confidence,
      source,
      elementDescription: description,
      validated,
      alternatives: candidate.alternatives || [],
    };
    if (candidate.confidence < this.minConfidence + 10 && source !== 'app_profile') {
      resolved.todoComment = '// TODO: Verify this locator against the real DOM';
    }
    return resolved;
  }
}

/* -------------------------------------------------------------------------- */
/*  Module-level convenience helpers                                          */
/* -------------------------------------------------------------------------- */

const STOPWORDS = new Set([
  'the', 'a', 'an', 'to', 'of', 'on', 'in', 'into', 'and', 'or', 'for', 'with',
  'is', 'are', 'be', 'this', 'that', 'it', 'click', 'press', 'enter', 'type',
  'fill', 'select', 'should', 'when', 'then', 'given', 'user', 'page',
]);

/** Functional shorthand: resolve a single element with ad-hoc config. */
export function resolveLocator(elementDescription: string, config: LocatorResolverConfig): ResolvedLocator {
  return new LocatorResolver(config).resolve(elementDescription);
}

/** Functional shorthand: validate a single locator against crawl data. */
export function validateLocator(locator: string, crawlData?: CrawlDataLike | null): LocatorValidation {
  return new LocatorResolver({ crawlData: crawlData ?? null }).validateLocator(locator, crawlData);
}
