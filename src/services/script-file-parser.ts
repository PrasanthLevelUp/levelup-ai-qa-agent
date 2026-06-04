/**
 * Script File Parser (Sprint 4B — History Page Redesign, spec §8.3.1)
 * ================================================================================
 *
 * PURPOSE
 * -------
 * `logGeneratedScript` persists every generated file into a single
 * `script_content` column, delimited by `// === <path> ===` headers. The
 * redesigned history view wants a per-file breakdown so it can render file
 * cards (with type, language, size, line count) instead of one giant <pre>.
 *
 * This module reconstructs that structured `ParsedFile[]` view from the stored
 * blob, enriching `type` from the separately-stored `files_generated` metadata
 * when available.
 *
 * SAFETY GUARANTEES
 * -----------------
 * • Pure / synchronous — no I/O, never throws.
 * • Backward compatible — malformed or legacy blobs with no delimiters collapse
 *   to a single synthetic file; empty input returns [].
 */

export interface ParsedScriptFile {
  /** Repo-relative path, e.g. `tests/login.spec.ts`. */
  path: string;
  /** Convenience alias of the basename, e.g. `login.spec.ts`. */
  filename: string;
  /** File body (delimiter header stripped). */
  content: string;
  /** 'test' | 'page-object' | 'config' | 'helper' | 'fixture'. */
  type: string;
  /** 'typescript' | 'javascript'. */
  language: string;
  /** Test framework inferred from the content (e.g. 'playwright'). */
  framework: string;
  /** Number of lines in the file body. */
  lineCount: number;
  /** Byte size of the file body. */
  sizeBytes: number;
}

interface FileMeta {
  path?: string;
  type?: string;
  [k: string]: unknown;
}

/** Infer a coarse file category from its path (spec §8.3.1). */
export function inferFileType(path: string): string {
  const p = path.toLowerCase();
  if (p.includes('.spec.') || p.includes('.test.')) return 'test';
  if (p.includes('page') || /page(object)?/i.test(path)) return 'page-object';
  if (p.includes('config') || p.includes('.config')) return 'config';
  if (p.includes('helper') || p.includes('util')) return 'helper';
  if (p.includes('fixture')) return 'fixture';
  return 'test';
}

/** Infer the test framework from a file's content (best-effort). */
export function inferFramework(content: string): string {
  if (/@playwright\/test|playwright/i.test(content)) return 'playwright';
  if (/from\s+['"]cypress['"]|cy\.[a-z]/i.test(content)) return 'cypress';
  if (/selenium-webdriver|webdriver/i.test(content)) return 'selenium';
  if (/from\s+['"]@jest|describe\(|it\(/.test(content)) return 'jest';
  return 'playwright';
}

function normalizeMeta(filesGenerated: unknown): FileMeta[] {
  try {
    const raw = typeof filesGenerated === 'string' ? JSON.parse(filesGenerated) : filesGenerated;
    return Array.isArray(raw) ? (raw as FileMeta[]) : [];
  } catch {
    return [];
  }
}

const basename = (p: string): string => p.split('/').pop() || p;

/**
 * Parse a stored script blob into structured files.
 *
 * @param scriptContent  Concatenated file blob (`// === path ===` delimited).
 * @param filesGenerated Optional `files_generated` metadata (array or JSON string).
 */
export function parseScriptContent(
  scriptContent: string | null | undefined,
  filesGenerated?: unknown,
): ParsedScriptFile[] {
  const content = typeof scriptContent === 'string' ? scriptContent : '';
  const meta = normalizeMeta(filesGenerated);

  // path -> type lookup from metadata.
  const typeByPath = new Map<string, string>();
  for (const f of meta) {
    if (f && typeof f.path === 'string' && typeof f.type === 'string') {
      typeByPath.set(f.path, f.type);
    }
  }

  const build = (path: string, body: string): ParsedScriptFile => {
    const cleanPath = path.trim();
    const lineCount = body.length ? body.split('\n').length : 0;
    return {
      path: cleanPath,
      filename: basename(cleanPath),
      content: body,
      type: typeByPath.get(cleanPath) || inferFileType(cleanPath),
      language: cleanPath.endsWith('.ts') || cleanPath.endsWith('.tsx') ? 'typescript' : 'javascript',
      framework: inferFramework(body),
      lineCount,
      sizeBytes: Buffer.byteLength(body, 'utf8'),
    };
  };

  if (content.trim()) {
    // Split on the `// === <path> ===` header lines (handle the first header
    // possibly being at the very start of the blob, with or without a leading
    // newline). We use a regex that captures the path on each header.
    const headerRe = /(?:^|\n)\/\/ === (.+?) ===\n?/g;
    const matches: Array<{ path: string; bodyStart: number; headerStart: number }> = [];
    let m: RegExpExecArray | null;
    while ((m = headerRe.exec(content)) !== null) {
      matches.push({ path: m[1].trim(), bodyStart: headerRe.lastIndex, headerStart: m.index });
    }

    if (matches.length > 0) {
      const files: ParsedScriptFile[] = [];
      for (let i = 0; i < matches.length; i++) {
        const next = matches[i + 1];
        const body = content
          .slice(matches[i].bodyStart, next ? next.headerStart : content.length)
          .replace(/\n+$/, '');
        files.push(build(matches[i].path, body));
      }
      return files;
    }

    // No delimiters — surface as a single file using metadata path if present.
    return [build(meta[0]?.path && typeof meta[0].path === 'string' ? meta[0].path : 'script.spec.ts', content.replace(/\n+$/, ''))];
  }

  // No content but we have metadata — expose path/type stubs for the UI.
  if (meta.length > 0) {
    return meta
      .filter((f) => f && typeof f.path === 'string')
      .map((f) => build(f.path as string, ''));
  }

  return [];
}
