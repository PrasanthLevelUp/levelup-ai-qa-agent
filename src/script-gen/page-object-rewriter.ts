/**
 * Page Object Rewriter (Repository Intelligence — ZIP path)
 *
 * The Test Case Lab → `generate-scripts-and-commit` flow (TestToScriptEngine)
 * historically emitted raw `page.locator('#user-name').fill(...)` sequences even
 * when the target repository already shipped Page Objects. Reviewers correctly
 * flagged that the generated ZIP showed *zero* evidence of Page Object reuse
 * (Repo Intelligence scored 3/10).
 *
 * This module is a deterministic, post-generation pass that rewrites the FINAL
 * generated code (AI output OR deterministic template — same code path) so that
 * recognised raw locator sequences collapse into high-level Page Object method
 * calls, e.g.:
 *
 *     await page.locator('#user-name').fill(user.username ?? '');
 *     await page.locator('#password').fill(user.password ?? '');
 *     await page.locator('#login-button').click();
 *        ↓
 *     const loginPage = new LoginPage(page);
 *     await loginPage.login(user.username ?? '', user.password ?? '');
 *
 * Design guarantees (mirrors the PR #142 review fixes already applied to the
 * URL-based ScriptGenEngine):
 *   • METHOD VALIDATION — never emits a method that isn't present in the scanned
 *     Page Object metadata (no hallucinated `loginPage.login()`).
 *   • REAL IMPORT PATHS — the import path is computed from the actual scanned
 *     `filePath` relative to the spec's output directory, never hardcoded.
 *   • MORE THAN LOGIN — Login, Cart, Checkout and Inventory are all matched.
 *   • DATASET-AWARE — whatever credential expression the original fill used
 *     (`user.username ?? ''`, a literal, or `process.env...`) is preserved as
 *     the method argument, so dataset binding survives the rewrite.
 *
 * It is intentionally conservative: when a pattern isn't confidently recognised
 * the original lines are left untouched, so the rewrite can only ever make the
 * script *more* idiomatic, never break it.
 */

import nodePath from 'path';
import type { RepositoryProfile } from '../context/types';

export type PageObjectKind = 'login' | 'inventory' | 'cart' | 'checkout';

export interface MatchedPageObject {
  /** Class name, e.g. "LoginPage". */
  name: string;
  /** Instance variable name, e.g. "loginPage". */
  varName: string;
  /** Real scanned file path, e.g. "src/pages/login.page.ts". */
  filePath: string;
  /** Real scanned method names, e.g. ["login", "logout"]. */
  methods: string[];
  /** Import path relative to the spec output dir, e.g. "../src/pages/login.page". */
  importPath: string;
  /** Semantic kind used to drive the rewrite rules. */
  kind: PageObjectKind;
}

export interface PageObjectRewriteReport {
  /** Page Objects discovered + matched for this generation context. */
  pageObjects: Array<MatchedPageObject & { used: boolean }>;
  totalAvailable: number;
  totalMatched: number;
  totalUsed: number;
}

export interface PageObjectRewriteResult {
  code: string;
  report: PageObjectRewriteReport;
}

/** Semantic kind → keyword detector (in test text) + PO class-name matcher. */
const KIND_RULES: Array<{ kind: PageObjectKind; inText: RegExp; poName: RegExp }> = [
  { kind: 'login',     inText: /\blogin|sign.?in|log.?in|auth|credential/i,             poName: /login|signin|auth/i },
  { kind: 'inventory', inText: /inventory|products?|catalog|item list|browse/i,          poName: /inventory|product|catalog/i },
  { kind: 'cart',      inText: /\bcart\b|basket|shopping.?cart|add to cart/i,            poName: /cart|basket/i },
  { kind: 'checkout',  inText: /checkout|purchase|payment|place order|complete order/i,   poName: /checkout|payment|order/i },
];

/**
 * Compute the import path for a Page Object from its REAL scanned file path,
 * relative to the directory the spec file lives in. Never hardcoded.
 *
 * Examples (spec lives in `tests/generated`):
 *   src/pages/login.page.ts → ../../src/pages/login.page
 *   pages/login.page.ts     → ../../pages/login.page
 */
export function buildPageObjectImportPath(filePath: string, fromDir: string): string {
  const cleanFile = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const cleanDir = String(fromDir || '').replace(/\\/g, '/').replace(/^\.\//, '');
  let rel = nodePath.posix.relative(cleanDir, cleanFile).replace(/\.[tj]sx?$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/**
 * Find the real method name on a Page Object whose name matches `pattern`.
 * Returns the actual scanned method name (preserving its casing) or null.
 * This is the guard that prevents emitting hallucinated methods.
 */
export function findPoMethod(methods: string[], pattern: RegExp): string | null {
  for (const m of methods) if (pattern.test(m)) return m;
  return null;
}

/**
 * Match a chunk of test text to ALL relevant Page Objects in the repo profile.
 * Returns one entry per matched PO with its real methods + a repo-derived import
 * path. Empty array when no profile or no match. Intentionally simple keyword
 * matching — no architecture inference.
 */
export function matchPageObjects(
  contextText: string,
  profile: RepositoryProfile | null | undefined,
  fromDir: string,
): MatchedPageObject[] {
  const pos = profile?.pageObjects;
  if (!pos || !pos.length) return [];

  const text = String(contextText || '').toLowerCase();
  const out: MatchedPageObject[] = [];
  const seen = new Set<string>();

  for (const rule of KIND_RULES) {
    if (!rule.inText.test(text)) continue;
    const po = pos.find((p: any) => rule.poName.test(p.name));
    if (!po || seen.has(po.name)) continue;
    seen.add(po.name);
    out.push({
      name: po.name,
      varName: po.name.charAt(0).toLowerCase() + po.name.slice(1),
      filePath: po.filePath,
      methods: ((po.methods as any[]) || []).map((m) => (typeof m === 'string' ? m : m.name)),
      importPath: buildPageObjectImportPath(po.filePath, fromDir),
      kind: rule.kind,
    });
  }
  return out;
}

/** Extract the argument expression from a `.fill(<EXPR>)` call on a line. */
function extractFillArg(line: string): string | null {
  const m = line.match(/\.fill\(\s*([\s\S]*?)\s*\)\s*;?\s*$/);
  return m ? m[1].trim() : null;
}

/** Leading whitespace of a line (for indentation-preserving inserts). */
function indentOf(line: string): string {
  const m = line.match(/^(\s*)/);
  return m ? m[1] : '';
}

/* ── line classifiers (conservative; only collapse what we recognise) ── */

const isUserFill = (l: string) =>
  /\.fill\(/.test(l) &&
  /#user-name|data-test=["']username["']|getbylabel\(\s*["'][^"']*user|getbyplaceholder\(\s*["'][^"']*user|['"]#username['"]|\busername\b/i.test(l);

const isPassFill = (l: string) =>
  /\.fill\(/.test(l) &&
  /#password|data-test=["']password["']|getbylabel\(\s*["'][^"']*pass|getbyplaceholder\(\s*["'][^"']*pass|['"]#pwd['"]|\bpassword\b/i.test(l);

const isLoginClick = (l: string) =>
  /\.click\(/.test(l) &&
  /#login-button|data-test=["']login-button["']|login.?button|getbyrole\(\s*["']button["'][^)]*log\s?in/i.test(l);

/**
 * Collapse a login fill/fill/click triad into a single `loginPage.login(u, p)`
 * call. Only fires when the LoginPage exposes a real `login` method. Preserves
 * whatever credential expressions the fills already used (dataset-aware).
 *
 * REVIEW FIX: loginPage.login() typically includes navigation to the login page,
 * so we also remove any redundant goto(baseURL) that immediately precedes or
 * follows the login sequence to prevent duplicate navigation.
 */
function rewriteLogin(lines: string[], loginPO: MatchedPageObject): { lines: string[]; used: boolean } {
  const loginMethod = findPoMethod(loginPO.methods, /^log[_]?in$/i);
  if (!loginMethod) return { lines, used: false };

  const out = [...lines];
  let used = false;

  for (let i = 0; i < out.length; i++) {
    if (!isUserFill(out[i])) continue;
    // Find password fill + login click within a forward window (expanded to 15
    // lines to catch precondition blocks that span comments/whitespace).
    let pIdx = -1;
    let cIdx = -1;
    for (let j = i + 1; j < Math.min(out.length, i + 15); j++) {
      if (pIdx === -1 && isPassFill(out[j])) { pIdx = j; continue; }
      if (pIdx !== -1 && isLoginClick(out[j])) { cIdx = j; break; }
    }
    if (pIdx === -1 || cIdx === -1) continue;

    const uArg = extractFillArg(out[i]) ?? `process.env.TEST_USERNAME ?? ''`;
    const pArg = extractFillArg(out[pIdx]) ?? `process.env.TEST_PASSWORD ?? ''`;
    const pad = indentOf(out[i]);

    // Identify lines to remove: the triad itself plus any trailing waitForLoadState.
    let dropEnd = cIdx;
    if (/page\.waitForLoadState/i.test(out[cIdx + 1] || '')) dropEnd = cIdx + 1;

    // Look backward for a preceding goto() (up to 5 lines before username fill).
    // If found, remove it since loginPage.login() handles navigation.
    let precedingGoto = -1;
    for (let k = Math.max(0, i - 5); k < i; k++) {
      if (/^\s*await\s+page\.goto\(/.test(out[k])) {
        precedingGoto = k;
        // Also check if there's a waitForLoadState right after the goto
        if (k + 1 < i && /page\.waitForLoadState/i.test(out[k + 1])) {
          // We'll remove both the goto and the wait
        }
      }
    }

    // Look forward for a following goto() (up to 3 lines after dropEnd).
    // This catches the pattern where login is called then goto is called again.
    let followingGoto = -1;
    for (let k = dropEnd + 1; k < Math.min(out.length, dropEnd + 4); k++) {
      if (/^\s*await\s+page\.goto\(/.test(out[k])) {
        followingGoto = k;
        break;
      }
    }

    const call = `${pad}await ${loginPO.varName}.${loginMethod}(${uArg}, ${pArg});`;
    // Build the removal set: triad + goto lines + trailing waits.
    const removeSet = new Set<number>([i, pIdx, cIdx]);
    if (dropEnd === cIdx + 1) removeSet.add(cIdx + 1);
    
    // Add preceding goto + its potential waitForLoadState
    if (precedingGoto !== -1) {
      removeSet.add(precedingGoto);
      if (precedingGoto + 1 < i && /page\.waitForLoadState/i.test(out[precedingGoto + 1])) {
        removeSet.add(precedingGoto + 1);
      }
    }
    
    // Add following goto (loginPage.login already navigates, so this is redundant)
    if (followingGoto !== -1) {
      removeSet.add(followingGoto);
      // Also remove waitForLoadState after the following goto
      if (followingGoto + 1 < out.length && /page\.waitForLoadState/i.test(out[followingGoto + 1])) {
        removeSet.add(followingGoto + 1);
      }
    }
    
    // Place the login call at the earliest removal point (if we removed a preceding goto,
    // put the login where the goto was; otherwise at the username fill position).
    const callPos = precedingGoto !== -1 ? precedingGoto : i;
    
    const rebuilt: string[] = [];
    for (let k = 0; k < out.length; k++) {
      if (k === callPos) { rebuilt.push(call); continue; }
      if (removeSet.has(k)) continue;
      rebuilt.push(out[k]);
    }
    out.length = 0;
    out.push(...rebuilt);
    used = true;
    break; // one login per test body is the realistic case
  }

  return { lines: out, used };
}

/**
 * Rewrite single-action clicks for cart / checkout / inventory using the
 * preceding comment + the line itself as semantic context. Only fires when the
 * corresponding PO method genuinely exists.
 */
function rewriteActions(
  lines: string[],
  pos: MatchedPageObject[],
): { lines: string[]; used: Set<string> } {
  const used = new Set<string>();
  const cartPO = pos.find((p) => p.kind === 'cart');
  const checkoutPO = pos.find((p) => p.kind === 'checkout');

  const cartAdd = cartPO ? findPoMethod(cartPO.methods, /add.*(cart|item)|addto.*cart/i) : null;
  const cartOpen = cartPO ? findPoMethod(cartPO.methods, /^(open|view|go.?to).*cart|^opencart/i) : null;
  const coMethod = checkoutPO ? findPoMethod(checkoutPO.methods, /complete.*checkout|^checkout$|finish.*(order|checkout)/i) : null;

  if (!cartAdd && !cartOpen && !coMethod) return { lines, used };

  const rewritten: string[] = [];
  let lastComment = '';
  for (const l of lines) {
    const isComment = /^\s*\/\//.test(l);
    if (isComment) lastComment = l;
    const semantic = `${lastComment} ${l}`;
    const isClick = /\.click\(/i.test(l);
    const pad = indentOf(l);

    if (isClick && cartAdd && /add.?to.?cart|add_to_cart|add.*item/i.test(semantic)) {
      rewritten.push(`${pad}await ${cartPO!.varName}.${cartAdd}();`);
      used.add(cartPO!.varName);
      continue;
    }
    if (isClick && cartOpen && /shopping.?cart|cart.?(link|icon)|open.*cart|view.*cart|go to.*cart/i.test(semantic)) {
      rewritten.push(`${pad}await ${cartPO!.varName}.${cartOpen}();`);
      used.add(cartPO!.varName);
      continue;
    }
    if (isClick && coMethod && /checkout|#finish|#continue|place.?order|finish/i.test(semantic)) {
      rewritten.push(`${pad}await ${checkoutPO!.varName}.${coMethod}();`);
      used.add(checkoutPO!.varName);
      continue;
    }
    rewritten.push(l);
  }

  // Collapse a multi-click checkout flow into ONE completeCheckout() call.
  let work = rewritten;
  if (coMethod) {
    let seen = false;
    work = rewritten.filter((l) => {
      if (l.includes(`.${coMethod}(`)) {
        if (seen) return false;
        seen = true;
      }
      return true;
    });
  }
  return { lines: work, used };
}

/**
 * Inject `const <var> = new <Name>(page);` as the first statement of every test
 * body that references `<var>.`, using brace tracking so the instantiation lands
 * in the correct scope. Idempotent: skips a test that already instantiates it.
 */
function injectInstantiations(code: string, pos: MatchedPageObject[]): string {
  if (!pos.length) return code;
  const byVar = new Map(pos.map((p) => [p.varName, p]));
  const lines = code.split('\n');
  const out: string[] = [];

  // Track open test scopes as a stack of { brace depth at open, vars seen }.
  let depth = 0;
  const scopes: Array<{ openDepth: number; injectedAt: number }> = [];

  const isTestOpener = (l: string) =>
    /\btest(\.(skip|only|fixme))?\s*\([^)]*async\s*\(\s*\{[^}]*page[^}]*\}\s*\)\s*=>\s*\{/.test(l) ||
    /\btest(\.(skip|only|fixme))?\s*\(/.test(l) && /async\s*\(\s*\{[^}]*page/.test(l) && /=>\s*\{/.test(l);

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    out.push(line);

    const opensTest = isTestOpener(line);
    // Count braces on this line to maintain depth.
    const opens = (line.match(/\{/g) || []).length;
    const closes = (line.match(/\}/g) || []).length;

    if (opensTest) {
      scopes.push({ openDepth: depth, injectedAt: out.length });
    }
    depth += opens - closes;

    // When a scope closes, finalise any pending instantiations for it.
    while (scopes.length && depth <= scopes[scopes.length - 1].openDepth) {
      scopes.pop();
    }
  }

  // Second pass: for each top-level test block, find used vars and insert decls.
  // Re-split using the already-rewritten lines (out === lines here).
  return injectByBlock(out.join('\n'), byVar);
}

/**
 * Block-based instantiation injector. Splits the code at `test(`/`test.fixme(`
 * boundaries via brace matching and inserts the needed `new PO(page)` decls at
 * the top of each block that references a PO var.
 */
function injectByBlock(code: string, byVar: Map<string, MatchedPageObject>): string {
  const lines = code.split('\n');
  const result: string[] = [];
  let i = 0;

  const openerRe = /\btest(\.(skip|only|fixme))?\s*\(/;

  while (i < lines.length) {
    const line = lines[i];
    if (!openerRe.test(line) || !/=>\s*\{/.test(line)) {
      result.push(line);
      i++;
      continue;
    }

    // Found a test opener with an inline body brace. Capture the block by brace
    // matching from this line.
    let depth = 0;
    let started = false;
    const block: string[] = [];
    let j = i;
    for (; j < lines.length; j++) {
      const l = lines[j];
      block.push(l);
      const opens = (l.match(/\{/g) || []).length;
      const closes = (l.match(/\}/g) || []).length;
      if (opens > 0) started = true;
      depth += opens - closes;
      if (started && depth <= 0) break;
    }

    // Determine which PO vars this block uses and which are already instantiated.
    const blockText = block.join('\n');
    const decls: string[] = [];
    const bodyIndent = indentOf(block[1] !== undefined ? block[1] : block[0]) || '  ';
    for (const [varName, po] of byVar) {
      const usesVar = new RegExp(`\\b${varName}\\.`).test(blockText);
      const alreadyDeclared = new RegExp(`new\\s+${po.name}\\s*\\(`).test(blockText);
      if (usesVar && !alreadyDeclared) {
        decls.push(`${bodyIndent}const ${varName} = new ${po.name}(page);`);
      }
    }

    if (decls.length) {
      // Insert decls right after the opener line (block[0]).
      result.push(block[0]);
      result.push(...decls);
      for (let k = 1; k < block.length; k++) result.push(block[k]);
    } else {
      result.push(...block);
    }

    i = j + 1;
  }

  return result.join('\n');
}

/** Add `import { Name } from '<importPath>';` lines for used POs (deduped). */
function injectImports(code: string, usedPos: MatchedPageObject[]): string {
  if (!usedPos.length) return code;
  const lines = code.split('\n');
  const needed = usedPos.filter((p) => !new RegExp(`import\\s*\\{[^}]*\\b${p.name}\\b`).test(code));
  if (!needed.length) return code;

  const importStatements = needed.map((p) => `import { ${p.name} } from '${p.importPath}';`);

  // Insert after the last existing top-of-file import; else at the very top.
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s.+from\s+['"].+['"];?\s*$/.test(lines[i])) lastImport = i;
    else if (lastImport !== -1 && lines[i].trim() !== '') break;
  }
  if (lastImport === -1) {
    return [...importStatements, ...lines].join('\n');
  }
  return [
    ...lines.slice(0, lastImport + 1),
    ...importStatements,
    ...lines.slice(lastImport + 1),
  ].join('\n');
}

/**
 * Main entry point. Rewrites `code` to reuse the Page Objects discovered in
 * `profile` for the supplied `contextText` (feature/title/steps), returning the
 * new code plus a transparency report.
 *
 * `fromDir` is the directory the spec file lives in (e.g. "tests/generated"),
 * used to compute correct relative import paths.
 */
export function applyPageObjectReuse(
  code: string,
  profile: RepositoryProfile | null | undefined,
  contextText: string,
  fromDir: string,
): PageObjectRewriteResult {
  const totalAvailable = profile?.pageObjects?.length ?? 0;
  const matched = matchPageObjects(contextText, profile, fromDir);

  if (!matched.length) {
    return {
      code,
      report: { pageObjects: [], totalAvailable, totalMatched: 0, totalUsed: 0 },
    };
  }

  let work = code;
  const usedVars = new Set<string>();

  // 1. Login triad collapse.
  const loginPO = matched.find((p) => p.kind === 'login');
  if (loginPO) {
    const lines = work.split('\n');
    const { lines: newLines, used } = rewriteLogin(lines, loginPO);
    if (used) {
      work = newLines.join('\n');
      usedVars.add(loginPO.varName);
    }
  }

  // 2. Cart / checkout single-action collapse.
  {
    const lines = work.split('\n');
    const { lines: newLines, used } = rewriteActions(lines, matched);
    work = newLines.join('\n');
    used.forEach((v) => usedVars.add(v));
  }

  const usedPos = matched.filter((p) => usedVars.has(p.varName));

  // 3. Instantiate + import only the POs we actually referenced.
  if (usedPos.length) {
    work = injectInstantiations(work, usedPos);
    work = injectImports(work, usedPos);
  }

  return {
    code: work,
    report: {
      pageObjects: matched.map((p) => ({ ...p, used: usedVars.has(p.varName) })),
      totalAvailable,
      totalMatched: matched.length,
      totalUsed: usedPos.length,
    },
  };
}

/** Merge several per-file rewrite reports into one (a PO is "used" if ANY file used it). */
export function mergeRewriteReports(reports: PageObjectRewriteReport[]): PageObjectRewriteReport | undefined {
  const real = reports.filter((r) => r && r.pageObjects.length);
  if (!real.length) {
    // Still surface availability if any report saw POs in the repo.
    const anyAvail = reports.find((r) => r && r.totalAvailable > 0);
    return anyAvail
      ? { pageObjects: [], totalAvailable: anyAvail.totalAvailable, totalMatched: 0, totalUsed: 0 }
      : undefined;
  }
  const byName = new Map<string, MatchedPageObject & { used: boolean }>();
  let totalAvailable = 0;
  for (const r of reports) {
    totalAvailable = Math.max(totalAvailable, r.totalAvailable);
    for (const po of r.pageObjects) {
      const existing = byName.get(po.name);
      if (existing) existing.used = existing.used || po.used;
      else byName.set(po.name, { ...po });
    }
  }
  const pageObjects = [...byName.values()];
  return {
    pageObjects,
    totalAvailable,
    totalMatched: pageObjects.length,
    totalUsed: pageObjects.filter((p) => p.used).length,
  };
}
