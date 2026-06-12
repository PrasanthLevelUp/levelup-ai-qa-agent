/**
 * Method Intelligence Service (Repo Intelligence — Phase 3)
 *
 * Builds a searchable index of every method / helper / page-object method /
 * utility function in a repository, plus a caller→callee dependency graph.
 *
 * Uses ts-morph (already a project dependency) to extract not just the method
 * signature but also the *source code* and the list of methods each one calls —
 * neither of which the lightweight `FileAnalysis` model carries. The extracted
 * data is persisted via the `repository_methods` / `method_dependencies` tables
 * (see postgres.ts), which power the True Reuse Engine.
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 * Everything here is gated behind the METHOD_INTELLIGENCE feature flag AND the
 * runtime availability of the method-intelligence schema. When either is off
 * the public methods are cheap no-ops that return empty results — default
 * product behaviour is therefore completely unchanged.
 *
 * NOTE: The original design spec referenced a `PostgresService` class that does
 * not exist in this codebase. This implementation is adapted to the real
 * functional persistence layer in `src/db/postgres.ts`.
 */

import { Project, SourceFile, Node } from 'ts-morph';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { logger } from '../utils/logger';
import { FEATURE_FLAGS } from '../config/features';
import {
  isMethodIntelAvailable,
  replaceRepositoryMethods,
  upsertMethodDependency,
  getMethodIntelStats,
  searchMethods,
  type MethodRecord,
  type MethodSearchHit,
} from '../db/postgres';

const MOD = 'method-intelligence';

/** Method classification used both for storage and for reuse search filters. */
export type MethodType = 'helper' | 'page_object_method' | 'test' | 'utility';

/** An extracted method/function before persistence (includes call targets). */
export interface ExtractedMethod {
  methodName: string;
  filePath: string;
  className: string | null;
  parameters: Array<{ name: string; type: string }>;
  returnType: string | null;
  isAsync: boolean;
  methodType: MethodType;
  sourceCode: string;
  codeHash: string;
  lineStart: number;
  lineEnd: number;
  description: string | null;
  /** Bare callee names referenced in the body (last `.`-segment of each call). */
  calledMethods: string[];
}

export interface MethodAnalysisResult {
  analyzed: boolean;
  reason?: string;
  filesScanned: number;
  methodsExtracted: number;
  methodsStored: number;
  dependenciesStored: number;
  durationMs: number;
}

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
  '.cache', '.yarn', '__pycache__', '.tox', 'venv', '.venv',
  'test-results', 'playwright-report', 'allure-results',
]);
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 500_000;

export class MethodIntelligenceService {
  private project: Project;

  constructor() {
    this.project = new Project({
      compilerOptions: {
        allowJs: true,
        target: 99, // ESNext
        module: 99, // ESNext
        moduleResolution: 2, // Node
        strict: false,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
      },
      skipAddingFilesFromTsConfig: true,
    });
  }

  /** Whether method intelligence will actually do anything right now. */
  static isEnabled(): boolean {
    return FEATURE_FLAGS.REPO_INTELLIGENCE.METHOD_INTELLIGENCE && isMethodIntelAvailable();
  }

  /**
   * Analyze a repository and (re)build its method index + dependency graph.
   *
   * Safe to call unconditionally: returns `{ analyzed: false }` immediately when
   * the feature flag is off or the schema is unavailable.
   */
  async analyzeRepository(repoRoot: string, repoContextId: number): Promise<MethodAnalysisResult> {
    const start = Date.now();
    const empty: MethodAnalysisResult = {
      analyzed: false,
      filesScanned: 0,
      methodsExtracted: 0,
      methodsStored: 0,
      dependenciesStored: 0,
      durationMs: 0,
    };

    if (!FEATURE_FLAGS.REPO_INTELLIGENCE.METHOD_INTELLIGENCE) {
      return { ...empty, reason: 'METHOD_INTELLIGENCE flag disabled', durationMs: Date.now() - start };
    }
    if (!isMethodIntelAvailable()) {
      return { ...empty, reason: 'method intelligence schema unavailable', durationMs: Date.now() - start };
    }
    if (!repoContextId || repoContextId <= 0) {
      return { ...empty, reason: 'invalid repoContextId', durationMs: Date.now() - start };
    }

    const files = this.discoverFiles(repoRoot);
    const extracted: ExtractedMethod[] = [];
    for (const file of files) {
      try {
        extracted.push(...this.extractFromFile(file, repoRoot));
      } catch (err) {
        logger.warn(MOD, 'Failed to extract methods from file', {
          file,
          error: (err as Error).message,
        });
      }
    }

    // Persist methods (replace = fresh snapshot for this repo context).
    const records: MethodRecord[] = extracted.map(m => ({
      repositoryContextId: repoContextId,
      methodName: m.methodName,
      filePath: m.filePath,
      className: m.className,
      parameters: m.parameters,
      returnType: m.returnType,
      isAsync: m.isAsync,
      methodType: m.methodType,
      sourceCode: m.sourceCode,
      codeHash: m.codeHash,
      lineStart: m.lineStart,
      lineEnd: m.lineEnd,
      description: m.description,
      tags: [],
    }));

    const { stored, idByName } = await replaceRepositoryMethods(repoContextId, records);

    // Build the dependency graph using the name→id map. Only edges whose callee
    // we actually indexed are recorded (external/library calls are ignored).
    let dependenciesStored = 0;
    for (const m of extracted) {
      const callerId = idByName.get(m.methodName);
      if (callerId == null) continue;
      const seen = new Set<string>();
      for (const callee of m.calledMethods) {
        if (seen.has(callee)) continue;
        seen.add(callee);
        const calleeId = idByName.get(callee);
        if (calleeId == null || calleeId === callerId) continue;
        try {
          await upsertMethodDependency(callerId, calleeId);
          dependenciesStored++;
        } catch (err) {
          logger.warn(MOD, 'Failed to store method dependency', {
            caller: m.methodName,
            callee,
            error: (err as Error).message,
          });
        }
      }
    }

    const result: MethodAnalysisResult = {
      analyzed: true,
      filesScanned: files.length,
      methodsExtracted: extracted.length,
      methodsStored: stored,
      dependenciesStored,
      durationMs: Date.now() - start,
    };
    logger.info(MOD, 'Method intelligence analysis complete', result as any);
    return result;
  }

  /** Convenience passthrough to the fuzzy method search (respects gating). */
  async search(
    repoContextId: number,
    term: string,
    opts: { methodType?: MethodType; limit?: number; minSimilarity?: number } = {},
  ): Promise<MethodSearchHit[]> {
    if (!MethodIntelligenceService.isEnabled()) return [];
    return searchMethods(repoContextId, term, opts);
  }

  /** Aggregate stats for a repo context's method index. */
  async getStats(repoContextId: number) {
    if (!MethodIntelligenceService.isEnabled()) {
      return { totalMethods: 0, byType: {}, dependencies: 0 };
    }
    return getMethodIntelStats(repoContextId);
  }

  /* ---------------------------------------------------------------- */
  /*  Extraction                                                       */
  /* ---------------------------------------------------------------- */

  /** Extract every standalone function and class method from one source file. */
  extractFromFile(filePath: string, repoRoot: string): ExtractedMethod[] {
    if (!fs.existsSync(filePath)) return [];
    const content = fs.readFileSync(filePath, 'utf-8');
    if (content.length > MAX_FILE_BYTES) return [];

    const relPath = path.relative(repoRoot, filePath);
    let sf: SourceFile;
    try {
      sf = this.project.createSourceFile(`virtual/${relPath}`, content, { overwrite: true });
    } catch {
      return [];
    }

    const out: ExtractedMethod[] = [];
    try {
      // 1) Standalone function declarations.
      for (const fn of sf.getFunctions()) {
        const name = fn.getName();
        if (!name) continue;
        out.push(this.buildExtracted({
          name,
          className: null,
          relPath,
          parameters: fn.getParameters().map(p => ({ name: p.getName(), type: safeType(p) })),
          returnType: safeReturnType(fn),
          isAsync: fn.isAsync(),
          node: fn,
          jsdoc: jsdocText(fn),
        }));
      }

      // 2) Exported / const arrow + function expressions.
      for (const varStmt of sf.getVariableStatements()) {
        for (const decl of varStmt.getDeclarations()) {
          const init = decl.getInitializer();
          if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
            const name = decl.getName();
            out.push(this.buildExtracted({
              name,
              className: null,
              relPath,
              parameters: init.getParameters().map(p => ({ name: p.getName(), type: safeType(p) })),
              returnType: safeReturnTypeAny(init),
              isAsync: (init as any).isAsync?.() ?? false,
              node: init,
              jsdoc: jsdocText(varStmt),
            }));
          }
        }
      }

      // 3) Class methods (page objects, helper classes, etc).
      for (const cls of sf.getClasses()) {
        const className = cls.getName() || null;
        for (const m of cls.getMethods()) {
          const name = m.getName();
          out.push(this.buildExtracted({
            name,
            className,
            relPath,
            parameters: m.getParameters().map(p => ({ name: p.getName(), type: safeType(p) })),
            returnType: safeReturnTypeAny(m),
            isAsync: m.isAsync(),
            node: m,
            jsdoc: jsdocText(m),
          }));
        }
      }
    } finally {
      this.project.removeSourceFile(sf);
    }

    return out;
  }

  private buildExtracted(args: {
    name: string;
    className: string | null;
    relPath: string;
    parameters: Array<{ name: string; type: string }>;
    returnType: string | null;
    isAsync: boolean;
    node: Node;
    jsdoc: string;
  }): ExtractedMethod {
    const sourceCode = args.node.getText().slice(0, 20_000);
    const calledMethods = this.extractCalledMethods(args.node);
    const methodType = classifyMethod(args.name, args.relPath, args.className);
    return {
      methodName: args.name,
      filePath: args.relPath,
      className: args.className,
      parameters: args.parameters,
      returnType: args.returnType,
      isAsync: args.isAsync,
      methodType,
      sourceCode,
      codeHash: hashCode(sourceCode),
      lineStart: args.node.getStartLineNumber(),
      lineEnd: args.node.getEndLineNumber(),
      description: args.jsdoc ? args.jsdoc.slice(0, 500) : null,
      calledMethods,
    };
  }

  /** Walk the body and collect the bare name of every call expression target. */
  private extractCalledMethods(node: Node): string[] {
    const names = new Set<string>();
    node.forEachDescendant(child => {
      if (Node.isCallExpression(child)) {
        const expr = child.getExpression();
        let bare: string | null = null;
        if (Node.isPropertyAccessExpression(expr)) {
          // foo.bar.baz() → "baz"
          bare = expr.getName();
        } else if (Node.isIdentifier(expr)) {
          bare = expr.getText();
        }
        if (bare && /^[A-Za-z_$][\w$]*$/.test(bare)) names.add(bare);
      }
    });
    return Array.from(names);
  }

  /* ---------------------------------------------------------------- */

  private discoverFiles(repoRoot: string): string[] {
    const files: string[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 10 || files.length >= MAX_FILES) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
            walk(path.join(dir, entry.name), depth + 1);
          }
        } else if (entry.isFile()) {
          if (EXTENSIONS.has(path.extname(entry.name))) {
            files.push(path.join(dir, entry.name));
          }
        }
      }
    };
    walk(repoRoot, 0);
    return files;
  }
}

/* ------------------------------------------------------------------ */
/*  Pure helpers (exported for unit testing)                          */
/* ------------------------------------------------------------------ */

/**
 * Heuristic method classification. A method is a page-object method when it
 * lives in a `*Page`-ish class or a `pages/` path; a test when it sits in a
 * spec/test file; a utility when it lives under utils/helpers/lib; otherwise a
 * generic helper.
 */
export function classifyMethod(
  name: string,
  filePath: string,
  className: string | null,
): MethodType {
  const lowerPath = filePath.toLowerCase();
  const lowerName = name.toLowerCase();

  if (/\.(spec|test)\.[tj]sx?$/.test(lowerPath) || /(^|[._-])(test|spec)/.test(lowerName)) {
    return 'test';
  }
  if ((className && /page|screen|view|component/i.test(className)) || /(^|\/)pages?\//.test(lowerPath)) {
    return 'page_object_method';
  }
  if (/(^|\/)(utils?|helpers?|lib|common|support|fixtures?)\//.test(lowerPath)) {
    return 'utility';
  }
  return 'helper';
}

/** Whether a method looks like a reusable helper (helper or utility bucket). */
export function isHelper(name: string, filePath: string, className: string | null): boolean {
  const t = classifyMethod(name, filePath, className);
  return t === 'helper' || t === 'utility' || t === 'page_object_method';
}

/** SHA-256 of normalized source (whitespace-collapsed) for duplicate detection. */
export function hashCode(source: string): string {
  const normalized = source.replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/* -- ts-morph type-text helpers (defensive: ts-morph can throw on types) -- */

function safeType(p: any): string {
  try {
    return p.getType().getText(p) || 'any';
  } catch {
    return 'any';
  }
}

function safeReturnType(fn: any): string | null {
  try {
    return fn.getReturnType?.()?.getText() || null;
  } catch {
    return null;
  }
}

function safeReturnTypeAny(node: any): string | null {
  try {
    return node.getReturnType?.()?.getText() || null;
  } catch {
    return null;
  }
}

function jsdocText(node: any): string {
  try {
    return node.getJsDocs?.()?.map((d: any) => d.getDescription()).join('\n').trim() || '';
  } catch {
    return '';
  }
}
