/**
 * Page Object Resolver
 * --------------------
 * Diagnosis-first prerequisite: resolve a Page-Object **field reference** on the
 * failing line back to the concrete Playwright locator string it points at.
 *
 * Why this exists
 * ---------------
 * Production tests use the Page Object Model, so the line that fails looks like:
 *
 *     await this.loginBtn.click();          // inside LoginPage.ts
 *     await loginPage.loginBtn.click();     // inside a spec
 *
 * There is **no inline selector** on that line, so `locator-extractor` (which only
 * matches inline `locator('...')` / `getByRole(...)` calls) returns nothing. The
 * healer is then starved of a `failedLocator`, every grounded advisor goes quiet,
 * and the AI layer hallucinates a wrong selector — which is exactly the
 * "false broken-locator" bug this stage fixes.
 *
 * This module is a small, pure, regex-based resolver. Given the failing line plus
 * the source of the page-object class (the file where the failure occurred is
 * usually enough, because it contains both the field declaration and the method
 * that uses it), it returns the concrete locator the field was assigned.
 *
 * It is intentionally dependency-free and never throws — on anything it cannot
 * confidently resolve it returns `null` and the caller falls back to the existing
 * behaviour.
 */

export interface PageObjectResolution {
  /** The field name referenced on the failing line, e.g. `loginBtn`. */
  fieldName: string;
  /** The receiver the field was accessed on, e.g. `this` or `loginPage`. */
  receiver: string;
  /** The action invoked on the field, if any, e.g. `click`, `fill`, `isVisible`. */
  action: string | null;
  /** The raw locator argument the field was assigned, e.g. `#login-button`. */
  resolvedLocator: string;
  /** The full locator expression, e.g. `page.locator('#login-button')`. */
  locatorExpression: string;
  /** Which Playwright builder produced the locator: `locator`, `getByRole`, etc. */
  builder: string;
}

/** Playwright locator builder method names we understand. */
const BUILDER_NAMES = [
  'locator',
  'getByRole',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
  'getByTestId',
];

/**
 * Parse the failing line and pull out the receiver, field, and action.
 *
 * Handles shapes like:
 *   await this.loginBtn.click();
 *   await loginPage.userName.fill('x');
 *   this.submit.click()
 *   await this.errorMsg.isVisible();
 *
 * Returns null when the line is not a `<receiver>.<field>.<action>(...)` access
 * (e.g. it already contains an inline `locator(...)` — which the existing
 * extractor handles — or it is some other statement).
 */
export function parseFieldReference(
  failingLine: string,
): { receiver: string; fieldName: string; action: string | null } | null {
  if (!failingLine) return null;
  const line = failingLine.trim();

  // If the line already carries an inline locator builder, this is not a bare
  // page-object field reference — let the inline extractor own it.
  const inlineBuilder = new RegExp(`\\.(?:${BUILDER_NAMES.join('|')})\\s*\\(`);
  if (inlineBuilder.test(line)) return null;

  // <receiver>.<field>.<action>(...)   — action present
  // Identifiers only (no extra dots between receiver and field) to avoid
  // misreading deep chains. `receiver` may be `this`.
  const withAction =
    /(?:await\s+)?((?:this|[A-Za-z_$][\w$]*))\s*\.\s*([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(
      line,
    );
  if (withAction) {
    return { receiver: withAction[1], fieldName: withAction[2], action: withAction[3] };
  }

  // <receiver>.<field> with no trailing action call (e.g. passed to expect()).
  //   await expect(this.errorMsg).toBeVisible();
  const noAction =
    /((?:this|[A-Za-z_$][\w$]*))\s*\.\s*([A-Za-z_$][\w$]*)\s*\)/.exec(line);
  if (noAction) {
    return { receiver: noAction[1], fieldName: noAction[2], action: null };
  }

  return null;
}

/**
 * Find where `fieldName` is assigned a Playwright locator within the given source
 * and return the concrete locator string + expression.
 *
 * Recognises the common page-object assignment forms:
 *   this.loginBtn = page.locator('#login-button');
 *   this.loginBtn = this.page.locator('#login-button');
 *   readonly loginBtn = this.page.getByRole('button', { name: 'Login' });
 *   this.loginBtn = page.getByTestId('login');
 *   loginBtn: Locator = page.locator('#login-button');
 *
 * Also resolves getter/property initialisations inside the class body.
 */
export function resolveFieldLocator(
  fieldName: string,
  pageObjectSource: string,
): { resolvedLocator: string; locatorExpression: string; builder: string } | null {
  if (!fieldName || !pageObjectSource) return null;

  const builderAlt = BUILDER_NAMES.join('|');

  // Match: <fieldName> [ : Type ] = <recv>.<builder>( <args> )
  // - left side may be `this.loginBtn`, `loginBtn`, or `loginBtn: Locator`
  // - receiver of the builder may be `page`, `this.page`, `this.<frame>` etc.
  // We capture the builder name and the FULL argument list (balanced-ish, up to
  // the first close paren at depth 0 is good enough for typical single-call
  // assignments).
  const assignRe = new RegExp(
    String.raw`(?:this\s*\.\s*)?` +            // optional `this.`
      escapeForRegex(fieldName) +              // the field name
      String.raw`(?:\s*:\s*[A-Za-z_$][\w$<>\[\]\. ]*)?` + // optional `: Locator`
      String.raw`\s*=\s*` +                    // =
      String.raw`(?:[A-Za-z_$][\w$]*\s*\.\s*)*` + // optional receiver chain (page. / this.page.)
      String.raw`(` + builderAlt + String.raw`)\s*\(`, // builder name + (
    'm',
  );

  const m = assignRe.exec(pageObjectSource);
  if (!m || m.index < 0) return null;

  const builder = m[1];
  // Extract the argument list starting at the '(' that follows the match.
  const openParenIdx = pageObjectSource.indexOf('(', m.index + m[0].length - 1);
  if (openParenIdx < 0) return null;
  const args = extractBalancedArgs(pageObjectSource, openParenIdx);
  if (args == null) return null;

  const locatorExpression = `${builder}(${args})`;
  const resolvedLocator = deriveLocatorString(builder, args);
  if (!resolvedLocator) return null;

  return { resolvedLocator, locatorExpression, builder };
}

/**
 * Top-level convenience: given the failing line and the page-object source,
 * return a complete resolution or null.
 */
export function resolvePageObjectLocator(
  failingLine: string,
  pageObjectSource: string,
): PageObjectResolution | null {
  const ref = parseFieldReference(failingLine);
  if (!ref) return null;

  const resolved = resolveFieldLocator(ref.fieldName, pageObjectSource);
  if (!resolved) return null;

  return {
    fieldName: ref.fieldName,
    receiver: ref.receiver,
    action: ref.action,
    resolvedLocator: resolved.resolvedLocator,
    locatorExpression: resolved.locatorExpression,
    builder: resolved.builder,
  };
}

/**
 * Turn a builder + raw args into the most useful "locator string" for healing.
 * - locator('#x')                  → `#x`
 * - getByTestId('login')           → `login`  (kept raw; caller knows builder)
 * - getByRole('button', {name})    → the whole arg list, since role locators are
 *                                     not a single selector string.
 */
function deriveLocatorString(builder: string, args: string): string {
  const firstString = extractFirstStringLiteral(args);
  if (builder === 'locator') {
    return firstString ?? args.trim();
  }
  // For getBy* builders the most faithful representation is the full expression
  // argument list; but when there's a leading string literal we surface it so
  // downstream similarity scoring has something concrete to compare.
  return firstString ?? args.trim();
}

/** Extract the first single/double/back-quoted string literal from an arg list. */
function extractFirstStringLiteral(args: string): string | null {
  const m = /(['"`])((?:\\.|(?!\1).)*)\1/.exec(args);
  return m ? m[2] : null;
}

/**
 * Given an index pointing at an opening paren, return the substring between it
 * and its matching close paren (handles nested parens and quoted strings).
 */
function extractBalancedArgs(source: string, openParenIdx: number): string | null {
  if (source[openParenIdx] !== '(') return null;
  let depth = 0;
  let inString: string | null = null;
  for (let i = openParenIdx; i < source.length; i++) {
    const ch = source[i];
    const prev = source[i - 1];
    if (inString) {
      if (ch === inString && prev !== '\\') inString = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      inString = ch;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        return source.slice(openParenIdx + 1, i);
      }
    }
  }
  return null;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
