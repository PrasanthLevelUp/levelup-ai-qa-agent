/**
 * Projects a raw application profile (application_profiles row + crawl_data) into
 * the compact, token-budgeted ApplicationProfileContext consumed by the test
 * generation engine. Isolated here so the crawl-data parsing (multi-page envelope
 * vs single page, selector picking, credential sanitization) is testable and the
 * route layer stays lean.
 *
 * Issue #2 fix: real selectors / forms / flows are surfaced to the LLM so that
 * test cases are grounded in the actual application instead of generic guesses.
 */
import type { ApplicationProfileContext } from '../engines/test-coverage-engine';

interface AnyObj { [k: string]: any }

/** Pick the single most robust selector for an element. */
function pickSelector(el: AnyObj | undefined | null): string | undefined {
  if (!el) return undefined;
  const sels = el.selectors || {};
  if (sels.recommended) return sels.recommended;
  if (sels.dataTestId) return sels.dataTestId;
  if (sels.id) return sels.id;
  if (sels.name) return sels.name;
  if (sels.role) return sels.role;
  if (sels.css) return sels.css;
  if (sels.xpath) return sels.xpath;
  // Fallback from raw attributes
  if (el.dataTestId) return `[data-testid="${el.dataTestId}"]`;
  if (el.id) return `#${el.id}`;
  if (el.name) return `[name="${el.name}"]`;
  return undefined;
}

function fieldLabel(el: AnyObj): string | undefined {
  return el.nearbyLabel || el.ariaLabel || el.placeholder || el.name || el.id || undefined;
}

function projectForm(form: AnyObj, pageUrl?: string): NonNullable<ApplicationProfileContext['forms']>[number] {
  return {
    page: pageUrl,
    action: form.action,
    method: form.method,
    fields: (form.fields || []).slice(0, 12).map((fd: AnyObj) => ({
      name: fd.name || fd.id,
      type: fd.type || fd.tag,
      required: !!fd.required,
      selector: pickSelector(fd),
      label: fieldLabel(fd),
    })),
    submitSelector: pickSelector(form.submitButton),
  };
}

function projectPageElements(page: AnyObj): NonNullable<ApplicationProfileContext['keyElements']> {
  const buttons: AnyObj[] = page.buttons || [];
  const inputs: AnyObj[] = page.inputs || [];
  const combined = [...buttons, ...inputs];
  return combined.slice(0, 25).map((el) => ({
    label: el.textContent?.trim()?.slice(0, 60) || fieldLabel(el),
    tag: el.tag,
    role: el.role || el.ariaRole,
    selector: pickSelector(el),
  })).filter((e) => e.selector || e.label);
}

/**
 * Build the compact projection. `profile` is an ApplicationProfile row; its
 * `crawl_data` may be a single CrawlResult or a multi-page envelope. `auth_config`
 * is already sanitized on read (no password). Returns undefined when there is no
 * usable structure (so generation falls back to generic behaviour gracefully).
 */
export function buildApplicationProfileContext(profile: AnyObj | null | undefined): ApplicationProfileContext | undefined {
  if (!profile) return undefined;
  const crawl = profile.crawl_data;
  if (!crawl || typeof crawl !== 'object') return undefined;

  const authConfig = profile.auth_config || {};
  const ctx: ApplicationProfileContext = {
    baseUrl: profile.base_url,
    name: profile.name || undefined,
    pageCount: profile.page_count ?? undefined,
    totalElements: profile.total_elements ?? undefined,
    totalForms: profile.total_forms ?? undefined,
    loginUrl: authConfig.loginUrl || undefined,
    username: authConfig.username || undefined,
    pages: [],
    forms: [],
    keyElements: [],
  };

  const pages: AnyObj[] = crawl.multiPage && Array.isArray(crawl.pages)
    ? crawl.pages
    : [crawl];

  // Site map (prefer the explicit siteMap if present on the envelope)
  if (crawl.multiPage && Array.isArray(crawl.siteMap) && crawl.siteMap.length) {
    ctx.pages = crawl.siteMap.slice(0, 15).map((n: AnyObj) => ({
      url: n.url,
      title: n.title,
      pageType: n.pageType,
      elementCount: n.elementCount,
      formCount: n.formCount,
    }));
  } else {
    ctx.pages = pages.slice(0, 15).map((p: AnyObj) => ({
      url: p.url,
      title: p.title,
      pageType: p.pageType,
      elementCount: p.totalElements ?? (p.elements?.length || 0),
      formCount: p.forms?.length || 0,
    }));
  }

  // Forms across pages (cap to keep token budget reasonable)
  const forms: NonNullable<ApplicationProfileContext['forms']> = [];
  for (const p of pages) {
    for (const f of (p.forms || [])) {
      if (forms.length >= 10) break;
      forms.push(projectForm(f, p.url || p.finalUrl));
    }
    if (forms.length >= 10) break;
  }
  ctx.forms = forms;

  // Key interactive elements from the first few pages
  const keyElements: NonNullable<ApplicationProfileContext['keyElements']> = [];
  for (const p of pages.slice(0, 4)) {
    for (const el of projectPageElements(p)) {
      if (keyElements.length >= 30) break;
      keyElements.push(el);
    }
    if (keyElements.length >= 30) break;
  }
  ctx.keyElements = keyElements;

  // If nothing useful was extracted, signal absence so we fall back gracefully.
  const hasContent = (ctx.pages?.length || 0) > 0 || (ctx.forms?.length || 0) > 0 ||
    (ctx.keyElements?.length || 0) > 0 || !!ctx.loginUrl;
  return hasContent ? ctx : undefined;
}
