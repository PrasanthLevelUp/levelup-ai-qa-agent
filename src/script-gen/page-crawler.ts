/**
 * Page Crawler Engine
 * Playwright-based crawler that visits URLs and extracts structured DOM intelligence.
 * 
 * Capabilities:
 * - Visit URLs with browser isolation & security
 * - Extract forms, buttons, inputs, links, navigation
 * - Capture DOM snapshots & screenshots
 * - Detect page types (login, dashboard, listing, form, etc.)
 * - Extract labels, placeholders, ARIA roles
 * - Build element hierarchy with parent context
 * 
 * Security:
 * - URL validation (no internal IPs, no file:// protocol)
 * - Timeout limits
 * - Memory limits via browser context
 * - Request throttling
 */

import { logger } from '../utils/logger';
import { AuthEngine, type AuthConfig, type AuthResult } from './auth-engine';

const MOD = 'page-crawler';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface CrawlConfig {
  url: string;
  maxDepth?: number;         // max pages to follow (default 1 = single page)
  timeout?: number;          // navigation timeout ms (default 15000)
  waitAfterLoad?: number;    // ms to wait after load (default 2000)
  captureScreenshot?: boolean;
  followLinks?: boolean;     // follow same-origin links
  maxPages?: number;         // max pages to crawl (default 5)
  viewport?: { width: number; height: number };

  /** Optional authentication config — enables authenticated crawling. */
  authConfig?: AuthConfig;
  /**
   * Additional URLs to crawl post-authentication (e.g. admin pages).
   * These are crawled in the SAME browser context (session preserved).
   */
  additionalUrls?: string[];

  /**
   * Optional progress callback invoked with human-readable status lines during
   * the crawl (e.g. "Visiting page: …", "Extracted 23 elements from …").
   * Used to surface live diagnostics via the crawl-logs endpoint. Errors thrown
   * by the callback are swallowed so logging can never break a crawl.
   */
  onLog?: (message: string) => void;

  /**
   * Loop 2 (Test Failures → Crawl Intelligence): when set, this crawl is using
   * a LEARNED adaptation for a page that has proven flaky in production. It
   * raises the depth cap from 3 → 5 so deep/dynamic flows get captured, and
   * allows a longer post-load wait. Set automatically by the generation engine
   * when CrawlAdaptationService recommends it; defaults off (behaviour unchanged).
   */
  adaptive?: boolean;
  /**
   * When `adaptive` is set, capture loading states (the crawler already waits
   * for networkidle; this also applies the longer `waitAfterLoad`) so dynamic
   * content has settled before extraction.
   */
  captureLoadingStates?: boolean;
  /** When `adaptive` is set, give animations extra time to finish before extracting. */
  waitForAnimations?: boolean;
}

/**
 * Multiple selector strategies for a single element, ordered by robustness.
 * Test scripts can pick the most stable available locator (id/testid first,
 * falling back to CSS/XPath). `recommended` is the single best pick.
 */
export interface ElementSelectors {
  /** `#id` selector when the element has a stable id. */
  id?: string;
  /** `[data-testid="..."]` selector — most stable for test automation. */
  dataTestId?: string;
  /** `[name="..."]` selector (form fields). */
  name?: string;
  /** ARIA-role + accessible-name based selector hint (Playwright getByRole). */
  role?: string;
  /** Visible-text based selector hint (Playwright getByText / :has-text). */
  text?: string;
  /** Unique CSS path computed from the DOM tree. */
  css?: string;
  /** Absolute/indexed XPath computed from the DOM tree. */
  xpath?: string;
  /** The single most robust selector to use first. */
  recommended?: string;
  /** Strategy name of the recommended selector (id|data-testid|name|role|text|css|xpath). */
  recommendedStrategy?: string;
}

export interface PageElement {
  tag: string;
  type?: string;             // input type
  id?: string;
  name?: string;
  className?: string;
  placeholder?: string;
  ariaLabel?: string;
  ariaRole?: string;
  role?: string;
  dataTestId?: string;
  textContent: string;
  href?: string;
  value?: string;
  required?: boolean;
  disabled?: boolean;
  visible: boolean;
  boundingBox?: { x: number; y: number; width: number; height: number };
  parentTag?: string;
  parentId?: string;
  nearbyLabel?: string;
  formIndex?: number;        // which form this belongs to (-1 if none)
  attributes: Record<string, string>;
  /** Multiple selector strategies (id, data-testid, css, xpath, …) per element. */
  selectors?: ElementSelectors;
}

export interface FormInfo {
  index: number;
  action?: string;
  method?: string;
  id?: string;
  name?: string;
  fields: PageElement[];
  submitButton?: PageElement;
}

export interface NavigationLink {
  text: string;
  href: string;
  isInternal: boolean;
  ariaLabel?: string;
  role?: string;
}

export type PageType = 
  | 'login' | 'signup' | 'dashboard' | 'listing' | 'detail'
  | 'form' | 'search' | 'landing' | 'settings' | 'profile'
  | 'checkout' | 'cart' | 'error' | 'unknown';

export interface CrawlResult {
  url: string;
  finalUrl: string;            // after redirects
  title: string;
  metaDescription?: string;
  pageType: PageType;
  pageTypeConfidence: number;
  elements: PageElement[];
  forms: FormInfo[];
  navigationLinks: NavigationLink[];
  buttons: PageElement[];
  inputs: PageElement[];
  headings: { level: number; text: string }[];
  htmlSnapshot: string;        // trimmed DOM
  screenshot?: Buffer;
  screenshotBase64?: string;
  totalElements: number;
  interactiveElements: number;
  crawlTimeMs: number;
  errors: string[];
  /** Present when authentication was attempted. */
  authResult?: AuthResult;
}

/** A single node in the discovered application sitemap. */
export interface SiteMapNode {
  url: string;
  title: string;
  pageType: PageType;
  depth: number;
  /** URL this page was discovered from (null for the entry/landing page). */
  discoveredFrom: string | null;
  elementCount: number;
  formCount: number;
  interactiveCount: number;
}

export interface MultiPageCrawlResult {
  pages: CrawlResult[];
  navigationGraph: { from: string; to: string; linkText: string }[];
  /** Structured map of the application discovered during the crawl. */
  siteMap?: SiteMapNode[];
  /** True when an authenticated session was established for the crawl. */
  authenticated?: boolean;
  authResult?: AuthResult;
  totalCrawlTimeMs: number;
}

/* -------------------------------------------------------------------------- */
/*  Security: URL Validation                                                  */
/* -------------------------------------------------------------------------- */

const BLOCKED_HOSTS = [
  'localhost', '127.0.0.1', '0.0.0.0', '::1',
  '169.254.169.254',  // AWS metadata
  'metadata.google.internal',
];

const BLOCKED_CIDRS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^fc00:/i,
  /^fd/i,
  /^fe80:/i,
];

export function validateUrl(url: string): { valid: boolean; reason?: string } {
  try {
    const parsed = new URL(url);

    // Protocol check
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, reason: `Blocked protocol: ${parsed.protocol}` };
    }

    // Host check
    const hostname = parsed.hostname.toLowerCase();
    if (BLOCKED_HOSTS.includes(hostname)) {
      return { valid: false, reason: `Blocked host: ${hostname}` };
    }

    // Private IP check
    for (const cidr of BLOCKED_CIDRS) {
      if (cidr.test(hostname)) {
        return { valid: false, reason: `Blocked private IP range: ${hostname}` };
      }
    }

    // No IP-only hosts (additional safety)
    if (/^\d+\.\d+\.\d+\.\d+$/.test(hostname) && !hostname.startsWith('1')) {
      // Allow common public ranges but block most raw IPs
      return { valid: false, reason: `Raw IP addresses not allowed: ${hostname}` };
    }

    return { valid: true };
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
}

/* -------------------------------------------------------------------------- */
/*  Page Type Detection                                                       */
/* -------------------------------------------------------------------------- */

interface PageTypeSignal {
  type: PageType;
  weight: number;
}

function detectPageType(result: Partial<CrawlResult>): { type: PageType; confidence: number } {
  const signals: PageTypeSignal[] = [];
  const url = (result.finalUrl || result.url || '').toLowerCase();
  const title = (result.title || '').toLowerCase();
  const allText = [
    title,
    ...((result.headings || []).map(h => h.text.toLowerCase())),
    ...((result.elements || []).map(e => e.textContent.toLowerCase())),
  ].join(' ');

  const forms = result.forms || [];
  const inputs = result.inputs || [];
  const buttons = result.buttons || [];

  // Login signals
  const hasPasswordField = inputs.some(i => i.type === 'password');
  const hasUsernameField = inputs.some(i => 
    ['username', 'user', 'email', 'login'].some(k => 
      (i.name || '').toLowerCase().includes(k) ||
      (i.placeholder || '').toLowerCase().includes(k) ||
      (i.id || '').toLowerCase().includes(k)
    )
  );
  const loginKeywords = ['login', 'sign in', 'signin', 'log in'];
  const hasLoginText = loginKeywords.some(k => allText.includes(k));

  if (hasPasswordField && hasUsernameField && forms.length <= 2) {
    signals.push({ type: 'login', weight: 0.9 });
  } else if (hasPasswordField && hasLoginText) {
    signals.push({ type: 'login', weight: 0.7 });
  }

  // Signup signals
  const signupKeywords = ['sign up', 'signup', 'register', 'create account'];
  const hasSignupText = signupKeywords.some(k => allText.includes(k));
  if (hasPasswordField && hasSignupText && inputs.length >= 3) {
    signals.push({ type: 'signup', weight: 0.8 });
  }
  if (url.includes('register') || url.includes('signup')) {
    signals.push({ type: 'signup', weight: 0.6 });
  }

  // Dashboard signals
  const dashboardKeywords = ['dashboard', 'overview', 'analytics', 'reports', 'admin'];
  if (dashboardKeywords.some(k => url.includes(k) || title.includes(k))) {
    signals.push({ type: 'dashboard', weight: 0.7 });
  }
  if ((result.navigationLinks || []).length > 5 && forms.length === 0) {
    signals.push({ type: 'dashboard', weight: 0.3 });
  }

  // Listing/table signals
  const hasTable = (result.htmlSnapshot || '').includes('<table');
  const listingKeywords = ['list', 'results', 'search', 'items', 'records'];
  if (hasTable && listingKeywords.some(k => allText.includes(k))) {
    signals.push({ type: 'listing', weight: 0.6 });
  }

  // Search signals
  const hasSearchInput = inputs.some(i => 
    i.type === 'search' || 
    (i.placeholder || '').toLowerCase().includes('search') ||
    (i.name || '').toLowerCase().includes('search')
  );
  if (hasSearchInput) {
    signals.push({ type: 'search', weight: 0.5 });
  }

  // Form signals (generic)
  if (forms.length > 0 && inputs.length >= 4 && !hasPasswordField) {
    signals.push({ type: 'form', weight: 0.5 });
  }

  // Settings signals
  if (url.includes('settings') || url.includes('preferences') || url.includes('config')) {
    signals.push({ type: 'settings', weight: 0.7 });
  }

  // Profile signals
  if (url.includes('profile') || url.includes('account') || url.includes('my-')) {
    signals.push({ type: 'profile', weight: 0.6 });
  }

  // Checkout / cart
  if (url.includes('checkout') || url.includes('payment')) {
    signals.push({ type: 'checkout', weight: 0.8 });
  }
  if (url.includes('cart') || url.includes('basket')) {
    signals.push({ type: 'cart', weight: 0.8 });
  }

  // Landing page
  if (url.endsWith('/') && forms.length <= 1 && (result.navigationLinks || []).length > 3) {
    signals.push({ type: 'landing', weight: 0.3 });
  }

  // Error page
  const errorKeywords = ['404', 'not found', '500', 'error', 'forbidden'];
  if (errorKeywords.some(k => title.includes(k))) {
    signals.push({ type: 'error', weight: 0.8 });
  }

  // Pick highest weighted signal
  if (signals.length === 0) return { type: 'unknown', confidence: 0.3 };
  signals.sort((a, b) => b.weight - a.weight);
  return { type: signals[0]!.type, confidence: signals[0]!.weight };
}

/* -------------------------------------------------------------------------- */
/*  DOM Extraction (runs in browser context)                                   */
/* -------------------------------------------------------------------------- */

const EXTRACT_ELEMENTS_SCRIPT = `
() => {
  const results = [];
  const interactive = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[onclick],[data-testid]';
  const elements = document.querySelectorAll(interactive);

  // ── Selector-strategy helpers (run in browser context) ──────────────
  const cssEscape = (v) => {
    if (window.CSS && CSS.escape) return CSS.escape(v);
    return String(v).replace(/([^a-zA-Z0-9_-])/g, '\\\\$1');
  };

  // Build a unique-ish CSS path by walking up to <body>, using nth-of-type.
  const cssPath = (el) => {
    if (!(el instanceof Element)) return '';
    const parts = [];
    let node = el;
    let depth = 0;
    while (node && node.nodeType === 1 && node.tagName.toLowerCase() !== 'html' && depth < 6) {
      let selector = node.tagName.toLowerCase();
      if (node.id) {
        // an id makes the path unique — prepend and stop.
        parts.unshift('#' + cssEscape(node.id));
        return parts.join(' > ');
      }
      const parent = node.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(c => c.tagName === node.tagName);
        if (sameTag.length > 1) {
          const index = sameTag.indexOf(node) + 1;
          selector += ':nth-of-type(' + index + ')';
        }
      }
      parts.unshift(selector);
      node = parent;
      depth++;
    }
    return parts.join(' > ');
  };

  // Build an indexed XPath up to a stable ancestor (id) or document root.
  const xPath = (el) => {
    if (!(el instanceof Element)) return '';
    const segs = [];
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.id) {
        segs.unshift('//*[@id="' + node.id + '"]');
        return segs.join('/');
      }
      let ix = 1;
      let sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) ix++; sib = sib.previousElementSibling; }
      segs.unshift(node.tagName.toLowerCase() + '[' + ix + ']');
      node = node.parentElement;
    }
    return '/' + segs.join('/');
  };

  // Pick the most robust selector & build the strategies object.
  const buildSelectors = (el) => {
    const sel = {};
    const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
    const nameAttr = el.getAttribute('name');
    const roleAttr = el.getAttribute('role');
    const ariaLabel = el.getAttribute('aria-label');
    const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').substring(0, 60);

    if (el.id) sel.id = '#' + cssEscape(el.id);
    if (testId) sel.dataTestId = '[data-testid="' + testId + '"]';
    if (nameAttr) sel.name = el.tagName.toLowerCase() + '[name="' + nameAttr + '"]';
    if (roleAttr && (ariaLabel || text)) sel.role = 'role=' + roleAttr + '[name="' + (ariaLabel || text) + '"]';
    if (text && ['BUTTON','A'].includes(el.tagName)) sel.text = 'text=' + text;
    sel.css = cssPath(el);
    sel.xpath = xPath(el);

    // Recommendation order: data-testid > id > name > role > text > css > xpath
    if (sel.dataTestId) { sel.recommended = sel.dataTestId; sel.recommendedStrategy = 'data-testid'; }
    else if (sel.id) { sel.recommended = sel.id; sel.recommendedStrategy = 'id'; }
    else if (sel.name) { sel.recommended = sel.name; sel.recommendedStrategy = 'name'; }
    else if (sel.role) { sel.recommended = sel.role; sel.recommendedStrategy = 'role'; }
    else if (sel.text) { sel.recommended = sel.text; sel.recommendedStrategy = 'text'; }
    else if (sel.css) { sel.recommended = sel.css; sel.recommendedStrategy = 'css'; }
    else { sel.recommended = sel.xpath; sel.recommendedStrategy = 'xpath'; }
    return sel;
  };

  elements.forEach((el, idx) => {
    if (idx > 500) return; // cap at 500 elements
    const rect = el.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0 && 
                    window.getComputedStyle(el).display !== 'none' &&
                    window.getComputedStyle(el).visibility !== 'hidden';
    
    // Find nearby label
    let nearbyLabel = '';
    if (el.id) {
      const label = document.querySelector('label[for="' + el.id + '"]');
      if (label) nearbyLabel = label.textContent?.trim() || '';
    }
    if (!nearbyLabel && el.closest('label')) {
      nearbyLabel = el.closest('label').textContent?.trim() || '';
    }
    if (!nearbyLabel) {
      const prev = el.previousElementSibling;
      if (prev && prev.tagName === 'LABEL') nearbyLabel = prev.textContent?.trim() || '';
    }
    
    // Collect all attributes
    const attrs = {};
    for (const attr of el.attributes) {
      attrs[attr.name] = attr.value;
    }
    
    // Find which form this belongs to
    const form = el.closest('form');
    const formIndex = form ? Array.from(document.querySelectorAll('form')).indexOf(form) : -1;
    
    results.push({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || undefined,
      id: el.id || undefined,
      name: el.getAttribute('name') || undefined,
      className: el.className || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      ariaRole: el.getAttribute('aria-role') || undefined,
      role: el.getAttribute('role') || undefined,
      dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || undefined,
      textContent: (el.textContent || '').trim().substring(0, 100),
      href: el.getAttribute('href') || undefined,
      value: el.value || undefined,
      required: el.hasAttribute('required'),
      disabled: el.hasAttribute('disabled') || el.disabled,
      visible,
      boundingBox: visible ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined,
      parentTag: el.parentElement?.tagName.toLowerCase(),
      parentId: el.parentElement?.id || undefined,
      nearbyLabel,
      formIndex,
      attributes: attrs,
      selectors: buildSelectors(el),
    });
  });
  
  return results;
}
`;

const EXTRACT_FORMS_SCRIPT = `
() => {
  const forms = document.querySelectorAll('form');
  return Array.from(forms).map((form, idx) => ({
    index: idx,
    action: form.getAttribute('action') || undefined,
    method: (form.getAttribute('method') || 'GET').toUpperCase(),
    id: form.id || undefined,
    name: form.getAttribute('name') || undefined,
  }));
}
`;

const EXTRACT_HEADINGS_SCRIPT = `
() => {
  return Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6')).map(h => ({
    level: parseInt(h.tagName[1]),
    text: (h.textContent || '').trim().substring(0, 200),
  })).slice(0, 30);
}
`;

const EXTRACT_NAV_LINKS_SCRIPT = `
() => {
  const origin = window.location.origin;
  const links = document.querySelectorAll('a[href], nav a, [role="navigation"] a, header a');
  const seen = new Set();
  const result = [];
  
  links.forEach(a => {
    const href = a.getAttribute('href');
    if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:')) return;
    const key = href + '|' + (a.textContent || '').trim();
    if (seen.has(key)) return;
    seen.add(key);
    
    let fullHref = href;
    try { fullHref = new URL(href, origin).href; } catch {}
    
    result.push({
      text: (a.textContent || '').trim().substring(0, 100),
      href: fullHref,
      isInternal: fullHref.startsWith(origin),
      ariaLabel: a.getAttribute('aria-label') || undefined,
      role: a.getAttribute('role') || undefined,
    });
  });
  
  return result.slice(0, 100);
}
`;

/* -------------------------------------------------------------------------- */
/*  In-page script runner                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Run one of the EXTRACT_* scripts inside the page and return its result.
 *
 * CRITICAL: Playwright's `page.evaluate(arg)` treats a STRING argument as a
 * JavaScript *expression to evaluate*, NOT a function to invoke. Our EXTRACT_*
 * constants are arrow-function *sources* (e.g. "() => { ... }"), so passing
 * them directly causes Playwright to evaluate the expression to a function
 * object — which is non-serializable and comes back as `undefined`. That made
 * every page report 0 elements / 0 forms.
 *
 * Wrapping the source as an invoked IIFE — `(() => { ... })()` — turns it into
 * an expression that actually *calls* the function and returns its
 * (serializable) result, which is what we want.
 */
async function runPageScript<T = any>(page: any, scriptSource: string): Promise<T> {
  return page.evaluate(`(${scriptSource})()`);
}

/* -------------------------------------------------------------------------- */
/*  Browser launch hardening                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Chromium launch flags shared by every crawl path.
 *
 * Besides the usual sandbox/gpu flags, these disable Chrome's password
 * manager, the "save password?" bubble, the password-leak ("found in a data
 * breach") warning, and the AutomationControlled fingerprint — all of which
 * can pop modal dialogs that steal focus and break automated login/crawl runs.
 */
const BROWSER_LAUNCH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  // Don't advertise navigator.webdriver / automation infobar.
  '--disable-blink-features=AutomationControlled',
  // Kill password manager, save-password prompt, leak detection & autofill sync.
  '--disable-features=PasswordManager,PasswordManagerOnboarding,PasswordLeakDetection,AutofillServerCommunication,SavePasswordBubble',
  '--disable-password-manager-reauthentication',
  '--disable-save-password-bubble',
  '--no-first-run',
  '--no-default-browser-check',
  '--password-store=basic',
];

/* -------------------------------------------------------------------------- */
/*  Crawler Class                                                             */
/* -------------------------------------------------------------------------- */

export class PageCrawler {
  private config: CrawlConfig & {
    maxDepth: number;
    timeout: number;
    waitAfterLoad: number;
    captureScreenshot: boolean;
    followLinks: boolean;
    maxPages: number;
    viewport: { width: number; height: number };
  };

  constructor(config: CrawlConfig) {
    // Loop 2: flaky pages get an adaptive crawl — a deeper depth cap (5 instead
    // of 3) and a longer post-load wait cap so dynamic content / animations have
    // time to settle. Non-adaptive crawls keep the original, conservative caps.
    const depthCap = config.adaptive ? 5 : 3;
    const waitCap = config.adaptive ? 8000 : 5000;
    this.config = {
      ...config,
      maxDepth: Math.min(config.maxDepth ?? 1, depthCap),
      timeout: Math.min(config.timeout ?? 15000, 30000), // cap at 30s
      waitAfterLoad: Math.min(config.waitAfterLoad ?? 2000, waitCap),
      captureScreenshot: config.captureScreenshot ?? true,
      followLinks: config.followLinks ?? false,
      maxPages: Math.min(config.maxPages ?? 5, 15), // cap at 15 pages
      viewport: config.viewport ?? { width: 1280, height: 720 },
    };
  }

  /**
   * Emit a progress/diagnostic line. Goes to the structured logger, to stdout
   * (so it shows in server logs / `docker logs`), and to the optional onLog
   * callback (so the crawl-logs endpoint can surface it). Never throws.
   */
  private progress(message: string, data?: Record<string, any>): void {
    try { logger.info(MOD, message, data); } catch { /* ignore */ }
    try { console.log(`🕷️  [crawl] ${message}${data ? ' ' + JSON.stringify(data) : ''}`); } catch { /* ignore */ }
    try { this.config.onLog?.(message); } catch { /* ignore */ }
  }

  async crawl(): Promise<CrawlResult> {
    // Validate URL
    const validation = validateUrl(this.config.url);
    if (!validation.valid) {
      throw new Error(`URL validation failed: ${validation.reason}`);
    }

    const startTime = Date.now();
    let browser: any = null;
    const errors: string[] = [];

    try {
      const pw = await import('playwright');
      browser = await pw.chromium.launch({
        headless: true,
        args: BROWSER_LAUNCH_ARGS,
      });

      const context = await browser.newContext({
        viewport: this.config.viewport,
        userAgent: 'LevelUpAI-Crawler/1.0 (Test Automation)',
        javaScriptEnabled: true,
        ignoreHTTPSErrors: true,
      });

      // Set resource limits
      context.setDefaultTimeout(this.config.timeout);
      context.setDefaultNavigationTimeout(this.config.timeout);

      const page = await context.newPage();

      // Block heavy resources for faster crawling
      await page.route('**/*.{mp4,webm,ogg,mp3,wav,flac}', (route: any) => route.abort());
      await page.route('**/*.{woff,woff2,ttf,eot}', (route: any) => route.abort());

      // ─── Authenticated crawling ──────────────────────────────────
      let authResult: AuthResult | undefined;
      if (this.config.authConfig) {
        const authEngine = new AuthEngine();
        authResult = await authEngine.authenticate(
          page, context, this.config.authConfig, this.config.url,
        );
        logger.info(MOD, 'Auth attempt completed', {
          success: authResult.success,
          strategy: authResult.strategy,
          durationMs: authResult.durationMs,
          captcha: authResult.captchaDetected,
        });

        if (authResult.success) {
          // Navigate to the actual target URL (may differ from login URL)
          const currentUrl = page.url();
          if (currentUrl !== this.config.url) {
            logger.info(MOD, 'Navigating to target URL after auth', { url: this.config.url });
            await page.goto(this.config.url, {
              waitUntil: 'domcontentloaded',
              timeout: this.config.timeout,
            });
          }
        } else {
          // Auth failed — crawl what we can (best-effort)
          errors.push(`Authentication failed: ${authResult.message}`);
          logger.warn(MOD, 'Auth failed, continuing with public crawl', { error: authResult.message });
        }
      } else {
        // ─── Standard public crawl (existing behaviour) ──────────────
        logger.info(MOD, 'Crawling page', { url: this.config.url });
        await page.goto(this.config.url, {
          waitUntil: 'domcontentloaded',
          timeout: this.config.timeout,
        });
      }

      // Wait for SPA frameworks to render — first try networkidle, fall back to fixed delay
      try {
        await page.waitForLoadState('networkidle', { timeout: Math.min(this.config.timeout, 10000) });
      } catch {
        // networkidle timeout is non-fatal; SPA may keep polling
      }

      // Wait for dynamic content
      await page.waitForTimeout(this.config.waitAfterLoad);

      // Extract data
      const title = await page.title();
      const finalUrl = page.url();

      // Meta description
      let metaDescription: string | undefined;
      try {
        metaDescription = await page.$eval(
          'meta[name="description"]',
          (el: any) => el.getAttribute('content'),
        ).catch(() => undefined);
      } catch { /* ignore */ }

      // Elements
      let elements: PageElement[] = [];
      try {
        const rawElements = await runPageScript(page, EXTRACT_ELEMENTS_SCRIPT);
        elements = Array.isArray(rawElements) ? rawElements : [];
      } catch (e) {
        errors.push(`Element extraction failed: ${(e as Error).message}`);
      }

      // Forms
      let formInfos: Array<{ index: number; action?: string; method?: string; id?: string; name?: string }> = [];
      try {
        const rawForms = await runPageScript(page, EXTRACT_FORMS_SCRIPT);
        formInfos = Array.isArray(rawForms) ? rawForms : [];
      } catch (e) {
        errors.push(`Form extraction failed: ${(e as Error).message}`);
      }

      // Build forms with their fields
      const forms: FormInfo[] = formInfos.map((fi) => {
        const fields = elements.filter((el) => el.formIndex === fi.index);
        const submitButton = fields.find(
          (el) => el.tag === 'button' || (el.tag === 'input' && el.type === 'submit'),
        ) || elements.find(
          (el) => el.formIndex === fi.index && el.type === 'submit',
        );
        return { ...fi, fields, submitButton };
      });

      // Headings
      let headings: { level: number; text: string }[] = [];
      try {
        const rawHeadings = await runPageScript(page, EXTRACT_HEADINGS_SCRIPT);
        headings = Array.isArray(rawHeadings) ? rawHeadings : [];
      } catch { /* ignore */ }

      // Navigation links
      let navigationLinks: NavigationLink[] = [];
      try {
        const rawNavLinks = await runPageScript(page, EXTRACT_NAV_LINKS_SCRIPT);
        navigationLinks = Array.isArray(rawNavLinks) ? rawNavLinks : [];
      } catch { /* ignore */ }

      // Filter element categories
      const buttons = elements.filter(
        (el) => el.tag === 'button' || el.role === 'button' || (el.tag === 'input' && el.type === 'submit'),
      );
      const inputs = elements.filter(
        (el) => el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select',
      );

      // HTML snapshot (trimmed)
      let htmlSnapshot = '';
      try {
        const fullHtml = await page.content();
        // Keep first 50KB for analysis
        htmlSnapshot = fullHtml.substring(0, 50000);
      } catch { /* ignore */ }

      // Screenshot
      let screenshot: Buffer | undefined;
      let screenshotBase64: string | undefined;
      if (this.config.captureScreenshot) {
        try {
          screenshot = await page.screenshot({ type: 'png', fullPage: false });
          screenshotBase64 = screenshot!.toString('base64');
        } catch { /* ignore */ }
      }

      const interactiveElements = elements.filter((el) => el.visible).length;

      const partialResult: Partial<CrawlResult> = {
        url: this.config.url,
        finalUrl,
        title,
        metaDescription,
        elements,
        forms,
        navigationLinks,
        buttons,
        inputs,
        headings,
        htmlSnapshot,
        totalElements: elements.length,
        interactiveElements,
      };

      // Detect page type
      const { type: pageType, confidence: pageTypeConfidence } = detectPageType(partialResult);

      await context.close();
      await browser.close();
      browser = null;

      const crawlTimeMs = Date.now() - startTime;
      logger.info(MOD, 'Crawl complete', {
        url: this.config.url,
        pageType,
        elements: elements.length,
        forms: forms.length,
        links: navigationLinks.length,
        crawlTimeMs,
      });

      return {
        ...partialResult as CrawlResult,
        pageType,
        pageTypeConfidence,
        screenshot,
        screenshotBase64,
        crawlTimeMs,
        errors,
        authResult,
      };
    } catch (error) {
      if (browser) try { await browser.close(); } catch { /* ignore */ }
      throw new Error(`Crawl failed for ${this.config.url}: ${(error as Error).message}`);
    }
  }

  /**
   * Session-aware authenticated multi-page crawl.
   *
   * Authenticates once, then crawls the target URL plus all additionalUrls
   * in the SAME browser context (preserving session cookies).
   */
  async crawlAuthenticatedMultiPage(): Promise<MultiPageCrawlResult> {
    if (!this.config.authConfig) {
      return this.crawlMultiPage();
    }

    const startTime = Date.now();
    const pages: CrawlResult[] = [];
    let browser: any = null;

    try {
      const pw = await import('playwright');
      browser = await pw.chromium.launch({
        headless: true,
        args: BROWSER_LAUNCH_ARGS,
      });
      const context = await browser.newContext({
        viewport: this.config.viewport,
        userAgent: 'LevelUpAI-Crawler/1.0 (Test Automation)',
        javaScriptEnabled: true,
        ignoreHTTPSErrors: true,
      });
      context.setDefaultTimeout(this.config.timeout);
      context.setDefaultNavigationTimeout(this.config.timeout);

      const page = await context.newPage();
      await page.route('**/*.{mp4,webm,ogg,mp3,wav,flac}', (route: any) => route.abort());
      await page.route('**/*.{woff,woff2,ttf,eot}', (route: any) => route.abort());

      // Authenticate once
      const authEngine = new AuthEngine();
      const authResult = await authEngine.authenticate(
        page, context, this.config.authConfig, this.config.url,
      );

      if (!authResult.success) {
        logger.warn(MOD, 'Auth failed for multi-page crawl', { error: authResult.message });
      }

      // Crawl target URL + additional URLs in the same session
      const urlsToVisit = [this.config.url, ...(this.config.additionalUrls || [])];
      for (const crawlUrl of urlsToVisit) {
        if (pages.length >= this.config.maxPages) break;
        const urlVal = validateUrl(crawlUrl);
        if (!urlVal.valid) continue;
        try {
          const pageResult = await this.crawlPageInContext(page, crawlUrl, pages.length === 0);
          pageResult.authResult = authResult;
          pages.push(pageResult);
        } catch (e) {
          logger.warn(MOD, 'Session crawl page failed', { url: crawlUrl, error: (e as Error).message });
        }
      }

      await context.close();
      await browser.close();
      browser = null;

      return {
        pages,
        navigationGraph: pages.slice(1).map((p, i) => ({
          from: pages[0]?.url || '', to: p.url, linkText: `Page ${i + 2}`,
        })),
        totalCrawlTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      if (browser) try { await browser.close(); } catch { /* ignore */ }
      throw new Error(`Authenticated multi-page crawl failed: ${(error as Error).message}`);
    }
  }

  /**
   * Deep authenticated crawl with AUTONOMOUS link discovery.
   *
   * This is the method that powers "Crawl Now" from the Application Profiles UI.
   * It needs no pre-written scripts or hand-supplied locators — Playwright drives
   * a real browser and the crawler discovers the app structure itself:
   *
   *   1. Launch a headless browser + single shared context.
   *   2. If authConfig is present, log in ONCE (session cookies persist for all
   *      subsequent navigations in the same context).
   *   3. Crawl the landing/target page, capturing interactive elements
   *      (forms, inputs, buttons, selects) with multiple selector strategies.
   *   4. BFS-discover internal navigation links from each crawled page and keep
   *      visiting new same-origin routes — in the SAME authenticated session —
   *      until maxPages or maxDepth is reached.
   *   5. Build a sitemap describing the discovered application structure.
   *
   * The session is preserved across every page, so authenticated areas
   * (dashboards, settings, inventory, etc.) are reachable — unlike
   * `crawlMultiPage`, which spins up a fresh unauthenticated browser per URL.
   */
  async crawlDeepAuthenticated(): Promise<MultiPageCrawlResult> {
    const validation = validateUrl(this.config.url);
    if (!validation.valid) {
      throw new Error(`URL validation failed: ${validation.reason}`);
    }

    const startTime = Date.now();
    const pages: CrawlResult[] = [];
    const navigationGraph: { from: string; to: string; linkText: string }[] = [];
    const siteMap: SiteMapNode[] = [];
    let browser: any = null;
    let authResult: AuthResult | undefined;

    const origin = (() => { try { return new URL(this.config.url).origin; } catch { return ''; } })();
    const normalize = (u: string) => u.replace(/#.*$/, '').replace(/\/$/, '');

    this.progress(`Starting authenticated crawl of ${this.config.url}`, {
      maxPages: this.config.maxPages,
      maxDepth: this.config.maxDepth,
      hasAuth: !!this.config.authConfig,
    });

    try {
      const pw = await import('playwright');
      browser = await pw.chromium.launch({
        headless: true,
        args: BROWSER_LAUNCH_ARGS,
      });
      const context = await browser.newContext({
        viewport: this.config.viewport,
        userAgent: 'LevelUpAI-Crawler/1.0 (Test Automation)',
        javaScriptEnabled: true,
        ignoreHTTPSErrors: true,
      });
      context.setDefaultTimeout(this.config.timeout);
      context.setDefaultNavigationTimeout(this.config.timeout);

      const page = await context.newPage();
      await page.route('**/*.{mp4,webm,ogg,mp3,wav,flac}', (route: any) => route.abort());
      await page.route('**/*.{woff,woff2,ttf,eot}', (route: any) => route.abort());

      // ── 1. Authenticate once (if configured) ─────────────────────────
      if (this.config.authConfig) {
        this.progress('Authenticating before crawl…');
        const authEngine = new AuthEngine();
        authResult = await authEngine.authenticate(page, context, this.config.authConfig, this.config.url);
        if (authResult.success) {
          this.progress(`Login successful (strategy=${authResult.strategy}, ${authResult.durationMs}ms)`);
        } else {
          this.progress(`Login FAILED — continuing best-effort with public pages only: ${authResult.message}`);
          logger.warn(MOD, 'Deep crawl auth failed — continuing best-effort (public pages only)', {
            error: authResult.message,
          });
        }
      } else {
        this.progress('No auth configured — crawling as anonymous visitor');
      }

      // ── 2. BFS over discovered same-origin links in the SAME session ──
      const visited = new Set<string>();
      const queue: { url: string; depth: number; from: string | null; linkText: string }[] = [
        { url: this.config.url, depth: 0, from: null, linkText: 'entry' },
      ];

      // If login redirected us to a different landing page (e.g. /inventory.html
      // on SauceDemo), seed that authenticated URL FIRST. Otherwise the crawl
      // would only ever re-visit the public login page and miss everything
      // behind the auth wall.
      if (authResult?.success && authResult.finalUrl) {
        const landingKey = normalize(authResult.finalUrl);
        const entryKey = normalize(this.config.url);
        if (landingKey !== entryKey && validateUrl(authResult.finalUrl).valid) {
          queue.unshift({ url: authResult.finalUrl, depth: 0, from: this.config.url, linkText: 'post-login landing' });
          this.progress(`Seeding authenticated landing page: ${authResult.finalUrl}`);
        }
      }

      // Seed any caller-provided URLs too.
      for (const extra of this.config.additionalUrls || []) {
        queue.push({ url: extra, depth: 0, from: this.config.url, linkText: 'seed' });
      }

      while (queue.length > 0 && pages.length < this.config.maxPages) {
        const item = queue.shift()!;
        const key = normalize(item.url);
        if (visited.has(key)) continue;
        visited.add(key);

        const urlVal = validateUrl(item.url);
        if (!urlVal.valid) {
          logger.warn(MOD, 'Skipping invalid/blocked URL during deep crawl', { url: item.url, reason: urlVal.reason });
          continue;
        }

        try {
          this.progress(`Visiting page (depth ${item.depth}): ${item.url}`);
          const result = await this.crawlPageInContext(page, item.url, pages.length === 0);
          if (authResult) result.authResult = authResult;
          pages.push(result);

          const beforeQueue = queue.length;
          if (item.from) {
            navigationGraph.push({ from: item.from, to: item.url, linkText: item.linkText });
          }
          siteMap.push({
            url: result.finalUrl || item.url,
            title: result.title,
            pageType: result.pageType,
            depth: item.depth,
            discoveredFrom: item.from,
            elementCount: result.elements.length,
            formCount: result.forms.length,
            interactiveCount: result.interactiveElements,
          });

          // Discover next-level internal links (same-origin, not yet visited).
          if (item.depth < this.config.maxDepth) {
            for (const link of result.navigationLinks) {
              const linkKey = normalize(link.href);
              const sameOrigin = origin ? link.href.startsWith(origin) : link.isInternal;
              if (sameOrigin && !visited.has(linkKey) && !queue.some(q => normalize(q.url) === linkKey)) {
                queue.push({ url: link.href, depth: item.depth + 1, from: item.url, linkText: link.text });
              }
            }
          }
          const newlyQueued = queue.length - beforeQueue;
          this.progress(
            `Extracted ${result.elements.length} elements, ${result.forms.length} forms from ${result.finalUrl || item.url}` +
            ` (title="${result.title}", type=${result.pageType}, +${newlyQueued} links queued)` +
            (result.errors && result.errors.length ? ` ⚠️ ${result.errors.join('; ')}` : ''),
          );
        } catch (e) {
          this.progress(`Page FAILED, skipping ${item.url}: ${(e as Error).message}`);
          logger.warn(MOD, 'Deep crawl page failed, skipping', { url: item.url, error: (e as Error).message });
        }
      }

      await context.close();
      await browser.close();
      browser = null;

      const totalElements = pages.reduce((s, p) => s + p.elements.length, 0);
      const totalForms = pages.reduce((s, p) => s + p.forms.length, 0);
      this.progress(
        `Crawl complete: ${pages.length} page(s), ${totalElements} elements, ${totalForms} forms, ` +
        `authenticated=${!!authResult?.success}, ${Date.now() - startTime}ms`,
        { pagesCrawled: pages.length, totalElements, totalForms },
      );

      return {
        pages,
        navigationGraph,
        siteMap,
        authenticated: !!authResult?.success,
        authResult,
        totalCrawlTimeMs: Date.now() - startTime,
      };
    } catch (error) {
      if (browser) try { await browser.close(); } catch { /* ignore */ }
      throw new Error(`Deep authenticated crawl failed for ${this.config.url}: ${(error as Error).message}`);
    }
  }

  /** Extract DOM from a page using an existing (session-aware) page instance. */
  private async crawlPageInContext(page: any, url: string, captureScreenshot: boolean): Promise<CrawlResult> {
    const startTime = Date.now();
    const errors: string[] = [];

    logger.info(MOD, 'Crawling page in session', { url });
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: this.config.timeout });
    try { await page.waitForLoadState('networkidle', { timeout: Math.min(this.config.timeout, 10000) }); } catch { /* SPA */ }
    await page.waitForTimeout(this.config.waitAfterLoad);

    const title = await page.title();
    const finalUrl = page.url();
    let metaDescription: string | undefined;
    try { metaDescription = await page.$eval('meta[name="description"]', (el: any) => el.getAttribute('content')).catch(() => undefined); } catch { /* */ }

    let elements: PageElement[] = [];
    try { const raw = await runPageScript(page, EXTRACT_ELEMENTS_SCRIPT); elements = Array.isArray(raw) ? raw : []; } catch (e) { errors.push(`Element extraction: ${(e as Error).message}`); }

    let formInfos: any[] = [];
    try { const raw = await runPageScript(page, EXTRACT_FORMS_SCRIPT); formInfos = Array.isArray(raw) ? raw : []; } catch (e) { errors.push(`Form extraction: ${(e as Error).message}`); }
    const forms: FormInfo[] = formInfos.map(fi => {
      const fields = elements.filter(el => el.formIndex === fi.index);
      const submitButton = fields.find(el => el.tag === 'button' || (el.tag === 'input' && el.type === 'submit'));
      return { ...fi, fields, submitButton };
    });

    let headings: { level: number; text: string }[] = [];
    try { const raw = await runPageScript(page, EXTRACT_HEADINGS_SCRIPT); headings = Array.isArray(raw) ? raw : []; } catch { /* */ }
    let navigationLinks: NavigationLink[] = [];
    try { const raw = await runPageScript(page, EXTRACT_NAV_LINKS_SCRIPT); navigationLinks = Array.isArray(raw) ? raw : []; } catch { /* */ }

    const buttons = elements.filter(el => el.tag === 'button' || el.role === 'button' || (el.tag === 'input' && el.type === 'submit'));
    const inputs = elements.filter(el => el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select');
    let htmlSnapshot = '';
    try { const full = await page.content(); htmlSnapshot = full.substring(0, 50000); } catch { /* */ }

    let screenshot: Buffer | undefined;
    let screenshotBase64: string | undefined;
    if (captureScreenshot) {
      try { screenshot = await page.screenshot({ type: 'png', fullPage: false }); screenshotBase64 = screenshot!.toString('base64'); } catch { /* */ }
    }

    const interactiveElements = elements.filter(el => el.visible).length;
    const partial: Partial<CrawlResult> = {
      url, finalUrl, title, metaDescription, elements, forms, navigationLinks, buttons, inputs, headings, htmlSnapshot, totalElements: elements.length, interactiveElements,
    };
    const { type: pageType, confidence: pageTypeConfidence } = detectPageType(partial);
    return { ...partial as CrawlResult, pageType, pageTypeConfidence, screenshot, screenshotBase64, crawlTimeMs: Date.now() - startTime, errors };
  }

  /**
   * Crawl multiple pages following internal links.
   */
  async crawlMultiPage(): Promise<MultiPageCrawlResult> {
    const startTime = Date.now();
    const pages: CrawlResult[] = [];
    const navigationGraph: { from: string; to: string; linkText: string }[] = [];
    const visited = new Set<string>();
    const queue: { url: string; depth: number; fromUrl?: string; linkText?: string }[] = [
      { url: this.config.url, depth: 0 },
    ];

    while (queue.length > 0 && pages.length < this.config.maxPages) {
      const item = queue.shift()!;
      const normalizedUrl = item.url.replace(/\/$/, '');
      if (visited.has(normalizedUrl)) continue;
      visited.add(normalizedUrl);

      try {
        const crawler = new PageCrawler({
          ...this.config,
          url: item.url,
          followLinks: false,
          captureScreenshot: pages.length === 0, // screenshot only first page
        });
        const result = await crawler.crawl();
        pages.push(result);

        if (item.fromUrl) {
          navigationGraph.push({
            from: item.fromUrl,
            to: item.url,
            linkText: item.linkText || '',
          });
        }

        // Queue internal links for next depth
        if (item.depth < this.config.maxDepth && this.config.followLinks) {
          for (const link of result.navigationLinks) {
            if (link.isInternal && !visited.has(link.href.replace(/\/$/, ''))) {
              queue.push({
                url: link.href,
                depth: item.depth + 1,
                fromUrl: item.url,
                linkText: link.text,
              });
            }
          }
        }
      } catch (e) {
        logger.warn(MOD, 'Page crawl failed, skipping', { url: item.url, error: (e as Error).message });
      }
    }

    return {
      pages,
      navigationGraph,
      totalCrawlTimeMs: Date.now() - startTime,
    };
  }
}
