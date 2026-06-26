/**
 * Locator State Analyzer (Evidence, not inference)
 * ------------------------------------------------
 * Diagnosis must be based on *evidence*, not on parsing an error string. This
 * module turns a captured DOM snapshot into hard, observable facts about the
 * element a failing locator points at:
 *
 *     exists ✔   visible ✔   enabled ✔   clickable ✖   (covered by overlay)
 *
 * That fact set is exactly what lets the classifier say "this is a TIMING /
 * overlay problem, recommend wait_for_overlay" instead of guessing "broken
 * locator". It is the canonical example the product owner asked for.
 *
 * Design notes
 * ------------
 * - Pure, deterministic, dependency-free. We deliberately avoid pulling in a DOM
 *   library; we do targeted, well-scoped string/attribute analysis on the HTML
 *   snapshot. This is a heuristic but *observable* signal — far stronger than
 *   regex over an error message — and it is fully unit-testable with fixtures.
 * - When a live Playwright page is available, the Evidence Collector can instead
 *   fill the same `LocatorState` shape from real `boundingBox()` /
 *   `isVisible()` / `evaluate(elementFromPoint)` probes (see the
 *   `LocatorStateProbe` interface in evidence-collector.ts). This analyzer is the
 *   offline fallback that works from the DOM snapshot we already persist.
 */

export interface LocatorState {
  /** Was an element matching the selector present in the DOM snapshot at all? */
  exists: boolean;
  /** Is the element rendered (not display:none / hidden / aria-hidden)? */
  visible: boolean;
  /** Is the element interactable (not disabled / aria-disabled)? */
  enabled: boolean;
  /**
   * Does the element receive pointer events, or is something on top of it /
   * pointer-events:none? Null when it cannot be determined from the snapshot.
   */
  receivesPointerEvents: boolean | null;
  /** exists && visible && enabled && receivesPointerEvents !== false */
  clickable: boolean;
  /** Short description of what is intercepting the click, when detected. */
  interceptedBy: string | null;
  /** How these facts were derived: 'dom_snapshot' | 'live_probe' | 'unknown'. */
  source: 'dom_snapshot' | 'live_probe' | 'unknown';
  /** Human-readable observations backing the booleans above. */
  notes: string[];
}

/** Class/id fragments that strongly indicate a click-blocking overlay. */
const OVERLAY_HINTS = [
  'overlay',
  'backdrop',
  'modal',
  'spinner',
  'loading',
  'loader',
  'busy',
  'mask',
  'progress',
  'scrim',
  'dimmer',
];

/**
 * Reduce a CSS/Playwright selector to the concrete attribute/text signature we
 * can search for in raw HTML. Supports the forms that show up in real tests:
 *   #login-button                      → id="login-button"
 *   .submit-btn                        → class~="submit-btn"
 *   [data-test="login"] / [data-test=login]
 *   [disabled]                         → bare attribute
 *   button / input                     → tag
 *   getByTestId('login')               → data-testid/data-test/data-test-id="login"
 */
interface SelectorSignature {
  kind: 'id' | 'class' | 'attr' | 'tag' | 'testid' | 'text' | 'unknown';
  name?: string;
  value?: string;
}

export function parseSelectorSignature(selector: string): SelectorSignature {
  const s = (selector || '').trim();
  if (!s) return { kind: 'unknown' };

  // getByTestId('x') or page.getByTestId("x")
  const testId = /getByTestId\(\s*['"]([^'"]+)['"]\s*\)/.exec(s);
  if (testId) return { kind: 'testid', value: testId[1] };

  // getByText / getByRole(..., { name: 'x' }) → text signature
  const named = /\{\s*name\s*:\s*['"]([^'"]+)['"]/.exec(s);
  if (named) return { kind: 'text', value: named[1] };
  const byText = /getByText\(\s*['"]([^'"]+)['"]/.exec(s);
  if (byText) return { kind: 'text', value: byText[1] };

  // [attr="value"] / [attr=value] / [attr]
  const attrEq = /\[\s*([\w-]+)\s*=\s*['"]?([^'"\]]+)['"]?\s*\]/.exec(s);
  if (attrEq) return { kind: 'attr', name: attrEq[1], value: attrEq[2] };
  const attrBare = /^\[\s*([\w-]+)\s*\]$/.exec(s);
  if (attrBare) return { kind: 'attr', name: attrBare[1] };

  // #id (take the leading id token)
  const id = /#([\w-]+)/.exec(s);
  if (id && s.trim().startsWith('#')) return { kind: 'id', value: id[1] };

  // .class
  const cls = /\.([\w-]+)/.exec(s);
  if (cls && s.trim().startsWith('.')) return { kind: 'class', value: cls[1] };

  // bare tag (button, input, a, ...)
  if (/^[a-zA-Z][\w-]*$/.test(s)) return { kind: 'tag', name: s.toLowerCase() };

  // id embedded mid-selector (e.g. "form #login-button")
  if (id) return { kind: 'id', value: id[1] };
  if (cls) return { kind: 'class', value: cls[1] };

  return { kind: 'unknown' };
}

/** Find the index where an element matching the signature begins in the HTML. */
function findMatchIndex(sig: SelectorSignature, html: string): number {
  switch (sig.kind) {
    case 'id':
      return matchAttr(html, 'id', sig.value!);
    case 'testid': {
      for (const attr of ['data-testid', 'data-test', 'data-test-id']) {
        const idx = matchAttr(html, attr, sig.value!);
        if (idx >= 0) return idx;
      }
      return -1;
    }
    case 'attr':
      return sig.value != null
        ? matchAttr(html, sig.name!, sig.value)
        : matchAttrBare(html, sig.name!);
    case 'class':
      return matchClass(html, sig.value!);
    case 'tag': {
      const m = new RegExp(`<${escapeRe(sig.name!)}[\\s/>]`, 'i').exec(html);
      return m ? m.index : -1;
    }
    case 'text': {
      const idx = html.toLowerCase().indexOf(sig.value!.toLowerCase());
      return idx;
    }
    default:
      return -1;
  }
}

function matchAttr(html: string, attr: string, value: string): number {
  const re = new RegExp(`${escapeRe(attr)}\\s*=\\s*["']${escapeRe(value)}["']`, 'i');
  const m = re.exec(html);
  return m ? m.index : -1;
}

function matchAttrBare(html: string, attr: string): number {
  const re = new RegExp(`[\\s<]${escapeRe(attr)}(\\s|=|>|/)`, 'i');
  const m = re.exec(html);
  return m ? m.index : -1;
}

function matchClass(html: string, cls: string): number {
  // class="... cls ..." with word boundaries inside the class list
  const re = new RegExp(`class\\s*=\\s*["'][^"']*\\b${escapeRe(cls)}\\b[^"']*["']`, 'i');
  const m = re.exec(html);
  return m ? m.index : -1;
}

/** Expand from an attribute match index outward to the enclosing element tag. */
function enclosingTag(html: string, matchIdx: number): string {
  const open = html.lastIndexOf('<', matchIdx);
  if (open < 0) return '';
  const close = html.indexOf('>', matchIdx);
  if (close < 0) return html.slice(open);
  return html.slice(open, close + 1);
}

function tagIsHidden(tag: string): { hidden: boolean; reason?: string } {
  const t = tag.toLowerCase();
  if (/\shidden(\s|=|>|\/)/.test(t)) return { hidden: true, reason: 'hidden attribute' };
  if (/type\s*=\s*["']hidden["']/.test(t)) return { hidden: true, reason: 'type="hidden"' };
  if (/aria-hidden\s*=\s*["']true["']/.test(t)) return { hidden: true, reason: 'aria-hidden="true"' };
  if (/display\s*:\s*none/.test(t)) return { hidden: true, reason: 'display:none' };
  if (/visibility\s*:\s*hidden/.test(t)) return { hidden: true, reason: 'visibility:hidden' };
  if (/opacity\s*:\s*0(\D|$)/.test(t)) return { hidden: true, reason: 'opacity:0' };
  return { hidden: false };
}

function tagIsDisabled(tag: string): { disabled: boolean; reason?: string } {
  const t = tag.toLowerCase();
  if (/\sdisabled(\s|=|>|\/)/.test(t)) return { disabled: true, reason: 'disabled attribute' };
  if (/aria-disabled\s*=\s*["']true["']/.test(t)) return { disabled: true, reason: 'aria-disabled="true"' };
  return { disabled: false };
}

function tagHasPointerEventsNone(tag: string): boolean {
  return /pointer-events\s*:\s*none/i.test(tag);
}

/**
 * Detect a visible, click-blocking overlay anywhere in the snapshot. Returns a
 * short description of the overlay if one is present and not display:none.
 */
export function detectActiveOverlay(html: string): string | null {
  if (!html) return null;
  const lower = html.toLowerCase();
  for (const hint of OVERLAY_HINTS) {
    // Find a class/id token containing the hint.
    const re = new RegExp(`(?:class|id)\\s*=\\s*["'][^"']*\\b([\\w-]*${escapeRe(hint)}[\\w-]*)\\b[^"']*["']`, 'i');
    const m = re.exec(lower);
    if (!m) continue;
    // Confirm the enclosing element is not explicitly hidden.
    const tag = enclosingTag(html, m.index);
    if (tag && tagIsHidden(tag).hidden) continue;
    return m[1];
  }
  return null;
}

/**
 * Analyze the state of `selector` within a DOM snapshot. Pure & deterministic.
 */
export function analyzeLocatorState(selector: string, domHtml: string | null | undefined): LocatorState {
  const notes: string[] = [];
  if (!domHtml) {
    return {
      exists: false,
      visible: false,
      enabled: false,
      receivesPointerEvents: null,
      clickable: false,
      interceptedBy: null,
      source: 'unknown',
      notes: ['No DOM snapshot available — locator state could not be observed.'],
    };
  }

  const sig = parseSelectorSignature(selector);
  const matchIdx = findMatchIndex(sig, domHtml);
  const exists = matchIdx >= 0;

  if (!exists) {
    return {
      exists: false,
      visible: false,
      enabled: false,
      receivesPointerEvents: null,
      clickable: false,
      interceptedBy: null,
      source: 'dom_snapshot',
      notes: [`No element matching "${selector}" found in the DOM snapshot.`],
    };
  }

  const tag = enclosingTag(domHtml, matchIdx);
  const hidden = tagIsHidden(tag);
  const disabled = tagIsDisabled(tag);
  const visible = !hidden.hidden;
  const enabled = !disabled.disabled;

  notes.push(`Element matching "${selector}" found in the DOM snapshot.`);
  if (!visible && hidden.reason) notes.push(`Not visible: ${hidden.reason}.`);
  if (!enabled && disabled.reason) notes.push(`Not enabled: ${disabled.reason}.`);

  // Pointer-event interception: explicit pointer-events:none on the element, or
  // a visible overlay sitting on top of the page.
  let receivesPointerEvents: boolean | null = true;
  let interceptedBy: string | null = null;

  if (tagHasPointerEventsNone(tag)) {
    receivesPointerEvents = false;
    interceptedBy = 'pointer-events:none on the element';
    notes.push('Element has pointer-events:none — clicks are ignored.');
  } else {
    const overlay = detectActiveOverlay(domHtml);
    if (overlay) {
      receivesPointerEvents = false;
      interceptedBy = overlay;
      notes.push(`A visible overlay ("${overlay}") is present and likely intercepts the click.`);
    }
  }

  const clickable = exists && visible && enabled && receivesPointerEvents !== false;

  return {
    exists,
    visible,
    enabled,
    receivesPointerEvents,
    clickable,
    interceptedBy,
    source: 'dom_snapshot',
    notes,
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
