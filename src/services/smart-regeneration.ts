/**
 * Smart Regeneration (Feature E — regenerate page objects while preserving
 * hand-written test logic)
 * --------------------------------------------------------------------------
 * Re-generating a script from a fresh crawl normally throws away everything a
 * human added: bespoke test data, extra assertions, custom helper logic. Smart
 * Regeneration parses the existing script with the TypeScript compiler API,
 * extracts the parts worth keeping (test/describe titles, `expect(...)`
 * assertions, top-level test data, and explicitly marked custom regions), and
 * merges them back over freshly-regenerated page objects / locators.
 *
 * The TypeScript parse is pure (no type-checking, no program). The route layer
 * owns crawling, regeneration via ScriptGenEngine, DB persistence, and backups.
 */

import ts from 'typescript';

/** Markers a user (or a previous regeneration) can use to fence custom code. */
export const PRESERVE_START = '// @preserve-start';
export const PRESERVE_END = '// @preserve-end';

/** A single test/describe block discovered in the source. */
export interface ExtractedTest {
  kind: 'test' | 'it' | 'describe';
  title: string;
  /** Raw body text of the callback (for reference / re-injection). */
  body: string;
  /** `expect(...)` assertion expressions found inside. */
  assertions: string[];
}

/** Everything Smart Regeneration wants to carry across a regeneration. */
export interface PreservedContent {
  imports: string[];
  /** Top-level `const`/`let` declarations = test data, fixtures, configs. */
  testData: Array<{ name: string; code: string }>;
  tests: ExtractedTest[];
  assertions: string[];
  /** Code fenced between @preserve-start / @preserve-end markers. */
  customRegions: string[];
  /** True when the source failed to parse (we degrade to text heuristics). */
  parseError?: string;
}

/* -------------------------------------------------------------------------- */
/*  Extraction (TypeScript AST)                                               */
/* -------------------------------------------------------------------------- */

function getCallName(expr: ts.CallExpression): string {
  const e = expr.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    // e.g. test.only(...) / describe.skip(...)
    if (ts.isIdentifier(e.expression)) return e.expression.text;
  }
  return '';
}

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.getText();
  return null;
}

/**
 * Parse a single TypeScript/JavaScript source file and extract preserved
 * content. Resilient: on parse failure, returns marker-based regions only.
 */
export function extractPreservedContent(source: string): PreservedContent {
  const result: PreservedContent = {
    imports: [],
    testData: [],
    tests: [],
    assertions: [],
    customRegions: extractMarkedRegions(source),
  };

  let sf: ts.SourceFile;
  try {
    sf = ts.createSourceFile('script.ts', source, ts.ScriptTarget.ES2022, /*setParentNodes*/ true, ts.ScriptKind.TS);
  } catch (err) {
    result.parseError = (err as Error).message;
    return result;
  }

  const visit = (node: ts.Node): void => {
    // Imports
    if (ts.isImportDeclaration(node)) {
      result.imports.push(node.getText(sf).trim());
    }

    // Top-level test data: const/let at the module level.
    if (ts.isVariableStatement(node) && node.parent === sf) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          result.testData.push({ name: decl.name.text, code: node.getText(sf).trim() });
        }
      }
    }

    // test(...) / it(...) / describe(...) calls
    if (ts.isCallExpression(node)) {
      const name = getCallName(node);
      if ((name === 'test' || name === 'it' || name === 'describe') && node.arguments.length >= 1) {
        const title = literalText(node.arguments[0]);
        if (title != null) {
          const cb = node.arguments[1];
          const body = cb ? cb.getText(sf) : '';
          result.tests.push({
            kind: name as ExtractedTest['kind'],
            title,
            body,
            assertions: extractAssertionsFromText(body),
          });
        }
      }
      // Collect every expect(...) chain as an assertion.
      if (getCallName(node) === 'expect') {
        // Walk up to the full statement expression for the complete chain.
        let top: ts.Node = node;
        while (top.parent && (ts.isPropertyAccessExpression(top.parent) || ts.isCallExpression(top.parent))) {
          top = top.parent;
        }
        result.assertions.push(top.getText(sf).trim());
      }
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  // De-dup assertions.
  result.assertions = Array.from(new Set(result.assertions));
  return result;
}

/** Lightweight regex assertion extraction (used on callback body text). */
function extractAssertionsFromText(text: string): string[] {
  const out: string[] = [];
  const re = /expect\s*\([^;]*?\)\s*\.\s*[\w.]+\([^;]*?\)/g;
  const matches = text.match(re) || [];
  for (const m of matches) out.push(m.trim());
  return Array.from(new Set(out));
}

/** Pull out every region fenced by @preserve-start / @preserve-end. */
export function extractMarkedRegions(source: string): string[] {
  const regions: string[] = [];
  const lines = source.split('\n');
  let buf: string[] | null = null;
  for (const line of lines) {
    if (line.includes('@preserve-start')) { buf = []; continue; }
    if (line.includes('@preserve-end')) {
      if (buf) regions.push(buf.join('\n'));
      buf = null;
      continue;
    }
    if (buf) buf.push(line);
  }
  return regions;
}

/* -------------------------------------------------------------------------- */
/*  Merge                                                                     */
/* -------------------------------------------------------------------------- */

export interface MergeOptions {
  preserveTestData?: boolean;
  preserveAssertions?: boolean;
  preserveCustomRegions?: boolean;
}

export interface MergeResult {
  content: string;
  report: {
    testDataInjected: number;
    assertionsInjected: number;
    customRegionsInjected: number;
    notes: string[];
  };
}

/**
 * Merge preserved content from the old script over a freshly-regenerated file.
 *
 * Strategy (deterministic, additive):
 *   - Marked custom regions present in the OLD file but missing from the NEW
 *     file are appended in a clearly-labelled `@preserve` block.
 *   - Top-level test data not already declared in the new file is re-injected
 *     after the import block.
 *   - Assertions not already present are surfaced as TODO comments so a human
 *     can re-attach them (we never silently drop hand-written checks).
 */
export function mergeRegenerated(
  preserved: PreservedContent,
  newImpl: string,
  options: MergeOptions = {},
): MergeResult {
  const opts: Required<MergeOptions> = {
    preserveTestData: options.preserveTestData ?? true,
    preserveAssertions: options.preserveAssertions ?? true,
    preserveCustomRegions: options.preserveCustomRegions ?? true,
  };
  const notes: string[] = [];
  let content = newImpl;
  let testDataInjected = 0;
  let assertionsInjected = 0;
  let customRegionsInjected = 0;

  // 1. Re-inject top-level test data not already present.
  if (opts.preserveTestData && preserved.testData.length) {
    const missing = preserved.testData.filter((d) => !new RegExp(`\\b(const|let|var)\\s+${d.name}\\b`).test(content));
    if (missing.length) {
      const block = ['', '// ── Preserved test data (carried over from previous version) ──',
        ...missing.map((d) => d.code), ''].join('\n');
      content = injectAfterImports(content, block);
      testDataInjected = missing.length;
      notes.push(`Re-injected ${missing.length} preserved test-data declaration(s).`);
    }
  }

  // 2. Re-attach marked custom regions missing from the new impl.
  if (opts.preserveCustomRegions && preserved.customRegions.length) {
    const missing = preserved.customRegions.filter((r) => r.trim() && !content.includes(r.trim()));
    if (missing.length) {
      const block = ['', PRESERVE_START,
        '// Custom logic carried over from the previous version — review placement.',
        ...missing, PRESERVE_END, ''].join('\n');
      content = `${content.replace(/\n+$/, '')}\n${block}`;
      customRegionsInjected = missing.length;
      notes.push(`Carried over ${missing.length} custom region(s).`);
    }
  }

  // 3. Surface assertions that the regeneration dropped, as TODOs.
  if (opts.preserveAssertions && preserved.assertions.length) {
    const missing = preserved.assertions.filter((a) => !content.includes(a));
    if (missing.length) {
      const block = ['', '// ── Preserved assertions — re-attach to the appropriate test ──',
        ...missing.map((a) => `// TODO(preserve): ${a}`), ''].join('\n');
      content = `${content.replace(/\n+$/, '')}\n${block}`;
      assertionsInjected = missing.length;
      notes.push(`Flagged ${missing.length} previously hand-written assertion(s) for re-attachment.`);
    }
  }

  return {
    content,
    report: { testDataInjected, assertionsInjected, customRegionsInjected, notes },
  };
}

/** Insert a block right after the last import statement (or at the top). */
function injectAfterImports(content: string, block: string): string {
  const lines = content.split('\n');
  let lastImport = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*import\s/.test(lines[i])) lastImport = i;
  }
  if (lastImport === -1) return `${block}\n${content}`;
  lines.splice(lastImport + 1, 0, block);
  return lines.join('\n');
}
