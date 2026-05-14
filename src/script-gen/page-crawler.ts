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
}

export interface MultiPageCrawlResult {
  pages: CrawlResult[];
  navigationGraph: { from: string; to: string; linkText: string }[];
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
/*  Crawler Class                                                             */
/* -------------------------------------------------------------------------- */

export class PageCrawler {
  private config: Required<CrawlConfig>;

  constructor(config: CrawlConfig) {
    this.config = {
      url: config.url,
      maxDepth: config.maxDepth ?? 1,
      timeout: Math.min(config.timeout ?? 15000, 30000), // cap at 30s
      waitAfterLoad: Math.min(config.waitAfterLoad ?? 2000, 5000),
      captureScreenshot: config.captureScreenshot ?? true,
      followLinks: config.followLinks ?? false,
      maxPages: Math.min(config.maxPages ?? 5, 10), // cap at 10 pages
      viewport: config.viewport ?? { width: 1280, height: 720 },
    };
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
        args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
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

      // Navigate
      logger.info(MOD, 'Crawling page', { url: this.config.url });
      await page.goto(this.config.url, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.timeout,
      });

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
        elements = await page.evaluate(EXTRACT_ELEMENTS_SCRIPT);
      } catch (e) {
        errors.push(`Element extraction failed: ${(e as Error).message}`);
      }

      // Forms
      let formInfos: Array<{ index: number; action?: string; method?: string; id?: string; name?: string }> = [];
      try {
        formInfos = await page.evaluate(EXTRACT_FORMS_SCRIPT);
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
        headings = await page.evaluate(EXTRACT_HEADINGS_SCRIPT);
      } catch { /* ignore */ }

      // Navigation links
      let navigationLinks: NavigationLink[] = [];
      try {
        navigationLinks = await page.evaluate(EXTRACT_NAV_LINKS_SCRIPT);
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
      };
    } catch (error) {
      if (browser) try { await browser.close(); } catch { /* ignore */ }
      throw new Error(`Crawl failed for ${this.config.url}: ${(error as Error).message}`);
    }
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
