/**
 * Repo Intelligence — Healing (Phase 4, PR #160: "Patch the Page Object")
 * ========================================================================
 *
 * THE IDEA
 * --------
 * When a selector breaks, LevelUp already grounds a *new* selector (App Profile,
 * DOM Memory, …). Repo Intelligence answers a different, higher-leverage
 * question: WHERE should the fix go?
 *
 * If the failure originates inside a shared Page Object / helper, patching that
 * ONE file repairs every spec that uses it. So instead of healing N specs, we
 * heal one abstraction.
 *
 * KEY INSIGHT (why this is deterministic, no call graph needed)
 * -------------------------------------------------------------
 * When `page.locator('#login-button')` lives inside `LoginPage.login()` and
 * breaks, Playwright's error stack points at `LoginPage.ts` — so the failure's
 * own `filePath`/`lineNumber` ALREADY identify the Page Object. We just have to
 * recognise that the failing file is a Page Object and route the patch there.
 *
 * This module is a pure *classifier + router*. It does NOT invent selectors —
 * it consumes whatever grounded selector the pipeline produced. That keeps it
 * cleanly after App Profile in the waterfall, exactly as the Phase 4 plan asks.
 *
 * Detection sources, strongest first:
 *   1. Method index (authoritative): a `repository_methods` row of type
 *      `page_object_method`/`helper` whose file matches the failing file. Gives
 *      the class name AND `usage_count` ("fixes N tests").
 *   2. Source AST (ts-morph): the failing file declares a class containing
 *      locator calls and no test/describe blocks.
 *   3. Path heuristic (0-dependency fallback): conventional PO locations/names.
 *
 * Everything degrades safely: any failure or missing data ⇒ "not a page object"
 * ⇒ the normal (spec) healing path is used.
 */

import * as fs from 'fs';
import { Project, SyntaxKind, type SourceFile } from 'ts-morph';
import { logger } from '../utils/logger';
import { findPageObjectMethodsByFile, type MethodSearchHit } from '../db/postgres';

const MOD = 'repo-intelligence-healing';

export type PageObjectSource = 'method_index' | 'source_ast' | 'path_heuristic';

export interface PageObjectClassification {
  /** True when the failing file is a shared Page Object / helper. */
  isPageObject: boolean;
  /** How we decided (strongest evidence that fired). */
  source: PageObjectSource | null;
  /** Owning class, when known (e.g. "LoginPage"). */
  className: string | null;
  /** Best-matching method, when known (e.g. "login"). */
  methodName: string | null;
  /** How many tests depend on this abstraction (0 when unknown). */
  impactedTests: number;
  /** Human-readable explanation for the decision trail / PR body. */
  reasoning: string;
}

const NOT_PAGE_OBJECT: PageObjectClassification = {
  isPageObject: false,
  source: null,
  className: null,
  methodName: null,
  impactedTests: 0,
  reasoning: 'Failure file is not a shared Page Object',
};

/* -------------------------------------------------------------------------- */
/*  Pure heuristics (unit-tested, no DB / no fs)                              */
/* -------------------------------------------------------------------------- */

/**
 * A file path that is clearly a test/spec, never a Page Object. Filename-based
 * only — directory (`tests/`, `e2e/`) is intentionally NOT used, because Page
 * Objects and helpers frequently live under those roots. The source-AST check
 * is the authoritative guard against mis-classifying an actual spec.
 */
export function isSpecPath(filePath: string): boolean {
  const f = (filePath || '').replace(/\\/g, '/').toLowerCase();
  const base = f.split('/').pop() || '';
  return /\.(spec|test|e2e|cy)\.[cm]?[jt]sx?$/.test(base);
}

/**
 * Conventional Page Object / helper locations & names. Deliberately
 * conservative — only fires on strong naming/location signals.
 */
export function looksLikePageObjectPath(filePath: string): boolean {
  if (!filePath || isSpecPath(filePath)) return false;
  const f = filePath.replace(/\\/g, '/').toLowerCase();
  const base = f.split('/').pop() || '';
  const dirSignal = /(^|\/)(pages?|page-?objects?|pageobjects?|po|fixtures?|helpers?|support|components?)\//.test(f);
  const nameSignal =
    /\.page\.[cm]?[jt]sx?$/.test(base) ||
    /\.po\.[cm]?[jt]sx?$/.test(base) ||
    /(page|fixture|helper)\.[cm]?[jt]sx?$/.test(base) ||
    /^[a-z0-9_-]*page[a-z0-9_-]*\.[cm]?[jt]sx?$/.test(base) ||
    /^[a-z0-9_-]*(fixture|helper)[a-z0-9_-]*\.[cm]?[jt]sx?$/.test(base);
  return dirSignal || nameSignal;
}

/* -------------------------------------------------------------------------- */
/*  AST detection (ts-morph)                                                  */
/* -------------------------------------------------------------------------- */

const LOCATOR_CALL = /\b(page|this\.page|this\.\w+)\s*\.\s*(locator|getBy[A-Z]\w*|\$\$?|\$x)\b/;
const TEST_BLOCK = /\b(test|describe|it)\s*(\.\w+)?\s*\(/;

/**
 * Decide whether SOURCE looks like a Page Object: declares a class that holds
 * locator calls, and is not itself a test file. Returns the class + a likely
 * method name (the method containing the broken selector, when we can find it).
 */
export function classifySource(
  source: string,
  filePath: string,
  brokenLocator?: string,
): { isPageObject: boolean; className: string | null; methodName: string | null } {
  const miss = { isPageObject: false, className: null, methodName: null };
  if (!source) return miss;
  // A file that defines test blocks is a spec, not a Page Object.
  if (TEST_BLOCK.test(source) && !/class\s+\w/.test(source)) return miss;

  try {
    const project = new Project({ useInMemoryFileSystem: true, skipFileDependencyResolution: true });
    const sf: SourceFile = project.createSourceFile('probe.ts', source, { overwrite: true });

    const classes = sf.getClasses();
    if (classes.length === 0) {
      // No class — fall back to a "module of helper functions with locators".
      const hasLocators = LOCATOR_CALL.test(source);
      const hasTests = TEST_BLOCK.test(source);
      return hasLocators && !hasTests ? { isPageObject: true, className: null, methodName: null } : miss;
    }

    for (const cls of classes) {
      const text = cls.getText();
      if (!LOCATOR_CALL.test(text)) continue;
      const className = cls.getName() ?? null;

      // Try to pinpoint the method that owns the broken locator.
      let methodName: string | null = null;
      const methods = cls.getMethods();
      if (brokenLocator) {
        const needle = brokenLocator.trim();
        const owner = methods.find((m) => m.getText().includes(needle));
        if (owner) methodName = owner.getName();
      }
      if (!methodName) {
        const firstWithLocator = methods.find((m) => LOCATOR_CALL.test(m.getText()));
        methodName = firstWithLocator?.getName() ?? null;
      }
      return { isPageObject: true, className, methodName };
    }
    // Class(es) present but none hold locators — not a Page Object we can heal.
    void SyntaxKind; // keep import meaningful across refactors
    return miss;
  } catch (err: any) {
    logger.debug(MOD, 'AST classification failed (non-fatal)', { filePath, error: err?.message });
    // Fall back to a cheap regex when the AST cannot parse.
    return LOCATOR_CALL.test(source) && !TEST_BLOCK.test(source)
      ? { isPageObject: true, className: null, methodName: null }
      : miss;
  }
}

/* -------------------------------------------------------------------------- */
/*  Orchestrating classifier                                                  */
/* -------------------------------------------------------------------------- */

export interface ClassifyInput {
  /** Failing file path from the stack (may be repo-relative or absolute). */
  filePath: string;
  /** The broken locator/source line, used to pinpoint the owning method. */
  brokenLocator?: string;
  /** Resolved repository_contexts.id, to scope the method-index lookup. */
  repoContextId?: number | null;
  /**
   * Optional already-loaded source for AST detection. When omitted and
   * `absolutePath` is provided, the file is read from disk.
   */
  source?: string;
  /** Absolute on-disk path (e.g. inside a cloned repo) for AST detection. */
  absolutePath?: string;
}

/**
 * Classify whether a failure originates inside a shared Page Object / helper.
 * Best-effort and never throws.
 */
export async function classifyFailureFile(input: ClassifyInput): Promise<PageObjectClassification> {
  const { filePath } = input;
  if (!filePath || isSpecPath(filePath)) return { ...NOT_PAGE_OBJECT };

  // 1) Method index — authoritative, gives class + impact count.
  try {
    const methods: MethodSearchHit[] = await findPageObjectMethodsByFile(filePath, {
      repoContextId: input.repoContextId ?? undefined,
    });
    if (methods.length > 0) {
      const owner = pickOwningMethod(methods, input.brokenLocator);
      const impactedTests = methods.reduce((sum, m) => sum + (m.usageCount || 0), 0);
      return {
        isPageObject: true,
        source: 'method_index',
        className: owner.className ?? null,
        methodName: owner.methodName,
        impactedTests,
        reasoning:
          `Failure occurs inside indexed Page Object` +
          `${owner.className ? ` ${owner.className}` : ''}` +
          `${owner.methodName ? `.${owner.methodName}()` : ''}` +
          `${impactedTests > 0 ? ` — patching it fixes ${impactedTests} dependent test(s)` : ''}`,
      };
    }
  } catch (err: any) {
    logger.debug(MOD, 'method-index classification failed (non-fatal)', { filePath, error: err?.message });
  }

  // 2) Source AST — read source if needed.
  let source = input.source;
  if (!source && input.absolutePath) {
    try { source = fs.readFileSync(input.absolutePath, 'utf-8'); } catch { /* ignore */ }
  }
  if (source) {
    const ast = classifySource(source, filePath, input.brokenLocator);
    if (ast.isPageObject) {
      return {
        isPageObject: true,
        source: 'source_ast',
        className: ast.className,
        methodName: ast.methodName,
        impactedTests: 0,
        reasoning:
          `Failure file declares a Page Object class` +
          `${ast.className ? ` (${ast.className})` : ''} containing locator definitions — ` +
          `patching it fixes every test that uses it`,
      };
    }
    // AST is a POSITIVE-only signal: `source` is often just the failing line's
    // surrounding snippet (not the whole file), so an AST "no" is inconclusive.
    // Fall through to the path heuristic rather than returning early.
  }

  // 3) Path heuristic — last-resort, conventions only.
  if (looksLikePageObjectPath(filePath)) {
    return {
      isPageObject: true,
      source: 'path_heuristic',
      className: null,
      methodName: null,
      impactedTests: 0,
      reasoning: 'Failure file is in a conventional Page Object / helper location — patching the shared file fixes all callers',
    };
  }

  return { ...NOT_PAGE_OBJECT };
}

/** Choose the method (from index hits) most likely to own the broken locator. */
function pickOwningMethod(
  methods: MethodSearchHit[],
  brokenLocator?: string,
): { className: string | null; methodName: string | null } {
  if (brokenLocator) {
    const needle = brokenLocator.trim();
    const direct = methods.find((m) => (m.sourceCode || '').includes(needle));
    if (direct) return { className: direct.className, methodName: direct.methodName };
  }
  // Otherwise the most-used method is the best representative.
  const top = methods[0];
  return { className: top?.className ?? null, methodName: top?.methodName ?? null };
}
