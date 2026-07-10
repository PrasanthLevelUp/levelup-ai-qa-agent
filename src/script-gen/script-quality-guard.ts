/**
 * SCRIPT QUALITY GUARD — "ESLint for generated Playwright specs"
 * ==============================================================
 * Sprint 3 (emitter refinement). The DETERMINISTIC quality bar for generated
 * scripts. NOT an AI, NOT a linter plugin, NOT a new pipeline — a pure function
 * over a generated spec string that returns the classes of "code a Senior SDET
 * would rewrite." Same spirit as `tools/measure-graph-coverage.ts`: turn a
 * quality judgment into a number.
 *
 * Two lifecycles for one rule set:
 *   • MEASUREMENT (Sprint 3 now) — `tools/measure-script-quality.ts` runs this
 *     over the real generated corpus and prints a baseline. Nothing is blocked.
 *   • ENFORCEMENT (PR 3.9) — the SAME `auditScriptQuality` is wired into the
 *     generation pipeline to REJECT a script that trips an `error`-severity rule.
 *
 * Design rules for this module:
 *   • Deterministic and dependency-free (line + light-regex scanning only).
 *   • No false-positive tolerance that would erode trust: variable rules are
 *     scoped PER `test(...)` block, so legitimate name reuse across tests is fine.
 *   • Every rule maps to exactly one Sprint 3 PR, so "PR done" == "rule green."
 */

/** One rule id. Kept in lock-step with the Sprint 3 PR list. */
export type QualityRuleId =
  | 'no-wait-for-timeout'      // 3.6 — arbitrary sleeps are flaky
  | 'no-networkidle'          // 3.6 — networkidle is discouraged by Playwright
  | 'no-manual-text-content'  // 3.6 — .textContent()/.innerText() vs toHaveText
  | 'no-todo-marker'          // 3.5 — TODO/FIXME/"Unsupported step" never ship
  | 'no-weak-assertion'       // 3.4 — toBeTruthy/toBeDefined are not real checks
  | 'no-weak-locator'         // 3.4/3.6 — xpath / nth-child / deep CSS are fragile
  | 'no-unused-variable'      // 3.5 — declared-but-never-used noise
  | 'no-duplicate-variable'   // 3.5 — same const declared twice in one test
  | 'no-dead-import';         // 3.5 — imported-but-never-used symbols

export type QualitySeverity = 'error' | 'warn';

export interface QualityViolation {
  rule: QualityRuleId;
  severity: QualitySeverity;
  /** 1-based line number in the spec (0 when file-level). */
  line: number;
  message: string;
  /** The offending source line, trimmed. */
  snippet: string;
}

export interface QualityReport {
  violations: QualityViolation[];
  /** Count per rule (only rules that fired appear). */
  byRule: Partial<Record<QualityRuleId, number>>;
  errorCount: number;
  warnCount: number;
  /** True when zero `error`-severity violations (the PR 3.9 gate condition). */
  clean: boolean;
}

const SEVERITY: Record<QualityRuleId, QualitySeverity> = {
  'no-wait-for-timeout': 'error',
  'no-networkidle': 'warn',
  'no-manual-text-content': 'warn',
  'no-todo-marker': 'error',
  'no-weak-assertion': 'error',
  'no-weak-locator': 'warn',
  'no-unused-variable': 'warn',
  'no-duplicate-variable': 'error',
  'no-dead-import': 'warn',
};

/**
 * STRING-AWARE comment stripper: blanks out `//` and block comments but NEVER
 * treats a `//` inside a string literal (e.g. an xpath `'//div'` or a URL) as a
 * comment. Preserves newlines and column positions so line numbers stay exact.
 */
function stripComments(content: string): string {
  let out = '';
  let i = 0;
  let str: string | null = null; // active quote char
  let block = false;             // inside /* */
  let lineComment = false;       // inside //
  while (i < content.length) {
    const c = content[i];
    const next = content[i + 1];
    if (block) {
      if (c === '*' && next === '/') { out += '  '; i += 2; block = false; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    if (lineComment) {
      if (c === '\n') { out += '\n'; lineComment = false; } else out += ' ';
      i++; continue;
    }
    if (str) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === str) str = null;
      i++; continue;
    }
    if (c === '/' && next === '*') { out += '  '; i += 2; block = true; continue; }
    if (c === '/' && next === '/') { out += '  '; i += 2; lineComment = true; continue; }
    if (c === "'" || c === '"' || c === '`') { str = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

/** Extract each `test(...)`/`test.only`/`test.fixme` block body with its start line. */
function testBlocks(lines: string[]): Array<{ start: number; end: number }> {
  const blocks: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/\btest(\.(only|skip|fixme))?\s*\(/.test(lines[i])) continue;
    let depth = 0;
    let seen = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') { depth++; seen = true; }
        else if (ch === '}') depth--;
      }
      if (seen && depth <= 0) { blocks.push({ start: i, end: j }); i = j; break; }
    }
  }
  return blocks;
}

/**
 * Audit a single generated spec. Pure and deterministic — same input always
 * yields the same report.
 */
export function auditScriptQuality(content: string): QualityReport {
  const violations: QualityViolation[] = [];
  const rawLines = content.split('\n');
  const codeLines = stripComments(content).split('\n');

  const push = (rule: QualityRuleId, line: number, message: string) =>
    violations.push({
      rule,
      severity: SEVERITY[rule],
      line: line + 1,
      message,
      snippet: (rawLines[line] ?? '').trim(),
    });

  // ── Line-scan rules (comment-stripped so JSDoc examples never trip them) ──
  codeLines.forEach((line, i) => {
    if (/\.waitForTimeout\s*\(/.test(line))
      push('no-wait-for-timeout', i, 'Arbitrary sleep — replace with a web-first expect() or auto-wait.');

    if (/networkidle/.test(line))
      push('no-networkidle', i, "waitForLoadState('networkidle') is discouraged — prefer 'domcontentloaded' or a state assertion.");

    if (/\.(textContent|innerText)\s*\(\s*\)/.test(line))
      push('no-manual-text-content', i, 'Manual text read — assert with toHaveText()/toContainText() instead.');

    // TODO markers live in COMMENTS, so scan the RAW line (not comment-stripped).
    if (/\b(TODO|FIXME)\b/.test(rawLines[i] ?? '') || /Unsupported step/i.test(rawLines[i] ?? ''))
      push('no-todo-marker', i, 'Placeholder/TODO/unsupported-step marker must never be emitted.');

    if (/\.(toBeTruthy|toBeDefined|toBeNull|toBeUndefined)\s*\(\s*\)/.test(line))
      push('no-weak-assertion', i, 'Weak assertion — assert a business outcome (text/state/value/count), not truthiness.');

    // Weak locators: xpath, positional nth-child, or deep (>2) descendant CSS chains.
    if (/\.locator\(\s*['"`](\/\/|xpath=)/.test(line))
      push('no-weak-locator', i, 'XPath locator is fragile — use a role/label/test-id locator.');
    else if (/\.locator\(\s*['"`][^'"`]*:nth-(child|of-type)/.test(line))
      push('no-weak-locator', i, 'Positional :nth locator is fragile — use a role/label/test-id locator.');
  });

  // ── Dead imports (file-level) ──
  const bodyTokens = stripComments(content);
  const importRe = /import\s+(?:type\s+)?\{([^}]*)\}\s+from/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(content)) !== null) {
    const importLine = content.slice(0, m.index).split('\n').length - 1;
    const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean);
    for (const name of names) {
      const uses = (bodyTokens.match(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')) || []).length;
      if (uses <= 1) push('no-dead-import', importLine, `Imported '${name}' is never used.`);
    }
  }

  // ── Variable rules, scoped PER test block (avoids cross-test false positives) ──
  const blocks = testBlocks(codeLines);
  for (const block of blocks) {
    const seen = new Set<string>();
    for (let i = block.start; i <= block.end; i++) {
      // catch MULTIPLE declarations on the same line (matchAll, not single match)
      const decls = [...codeLines[i].matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/g)];
      for (const decl of decls) {
        const name = decl[1];
        if (seen.has(name)) {
          push('no-duplicate-variable', i, `Variable '${name}' is declared more than once in this test.`);
          continue;
        }
        seen.add(name);
        // usage count within the block (declaration + references)
        let uses = 0;
        const re = new RegExp(`\\b${name}\\b`, 'g');
        for (let j = block.start; j <= block.end; j++) uses += (codeLines[j].match(re) || []).length;
        if (uses <= 1) push('no-unused-variable', i, `Variable '${name}' is declared but never used.`);
      }
    }
  }

  const byRule: Partial<Record<QualityRuleId, number>> = {};
  let errorCount = 0;
  let warnCount = 0;
  for (const v of violations) {
    byRule[v.rule] = (byRule[v.rule] ?? 0) + 1;
    if (v.severity === 'error') errorCount++;
    else warnCount++;
  }

  return { violations, byRule, errorCount, warnCount, clean: errorCount === 0 };
}

/** Human-readable one-line summary for logs/CI. */
export function formatQualitySummary(report: QualityReport): string {
  if (!report.violations.length) return 'clean (0 violations)';
  const parts = Object.entries(report.byRule).map(([r, n]) => `${r}:${n}`);
  return `${report.errorCount} error / ${report.warnCount} warn — ${parts.join(', ')}`;
}
