/**
 * Multi-Language Analyzer (Repo Intelligence — Phase 3)
 *
 * Extends repository intelligence beyond TypeScript/JavaScript to Java, Python
 * and C# using tree-sitter grammars. For each supported language it extracts
 * classes, methods/functions, imports and detects the test framework in use
 * (JUnit/TestNG/Selenium, pytest/unittest/Playwright, NUnit/xUnit/MSTest, …).
 *
 * ── Design: zero hard dependency on tree-sitter at build time ──────────────
 * The tree-sitter native parsers are loaded *lazily* via `require()` inside a
 * try/catch and typed as `any`. This means:
 *   • The project compiles cleanly with `tsc` whether or not the optional
 *     tree-sitter packages are installed.
 *   • If the grammars are missing (or fail to build natively), the analyzer
 *     degrades gracefully — `isAvailable()` returns false and `analyzeFile()`
 *     returns an `available: false` result instead of throwing.
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 * All analysis is additionally gated behind the MULTI_LANGUAGE feature flag.
 * When the flag is off, the analyzer reports unavailable and does no work, so
 * default behaviour is unchanged.
 */

import * as path from 'path';
import * as fs from 'fs';
import { logger } from '../utils/logger';
import { FEATURE_FLAGS } from '../config/features';

const MOD = 'multi-language-analyzer';

export type SupportedLanguage = 'java' | 'python' | 'csharp';

export interface ExtractedParameter {
  name: string;
  type: string | null;
}

export interface ExtractedLangMethod {
  name: string;
  className: string | null;
  parameters: ExtractedParameter[];
  returnType: string | null;
  isStatic: boolean;
  lineStart: number;
  lineEnd: number;
}

export interface ExtractedLangClass {
  name: string;
  baseClass: string | null;
  lineStart: number;
  lineEnd: number;
}

export interface MultiLangFileAnalysis {
  available: boolean;
  reason?: string;
  filePath: string;
  language: SupportedLanguage;
  classes: ExtractedLangClass[];
  methods: ExtractedLangMethod[];
  imports: string[];
  framework: string | null;
  frameworks: string[];
}

/** File extension → language. */
const EXT_TO_LANG: Record<string, SupportedLanguage> = {
  '.java': 'java',
  '.py': 'python',
  '.cs': 'csharp',
};

/** Lazily-required tree-sitter module names per language. */
const GRAMMAR_MODULES: Record<SupportedLanguage, string> = {
  java: 'tree-sitter-java',
  python: 'tree-sitter-python',
  csharp: 'tree-sitter-c-sharp',
};

/** tree-sitter node-type names used to find declarations, per language. */
const NODE_TYPES: Record<SupportedLanguage, {
  class: string[];
  method: string[];
  import: string[];
}> = {
  java: {
    class: ['class_declaration', 'interface_declaration', 'enum_declaration'],
    method: ['method_declaration', 'constructor_declaration'],
    import: ['import_declaration'],
  },
  python: {
    class: ['class_definition'],
    method: ['function_definition'],
    import: ['import_statement', 'import_from_statement'],
  },
  csharp: {
    class: ['class_declaration', 'interface_declaration', 'struct_declaration'],
    method: ['method_declaration', 'constructor_declaration'],
    import: ['using_directive'],
  },
};

/** Framework detection signatures (substring match against import/source text). */
const FRAMEWORK_SIGNATURES: Record<SupportedLanguage, Array<{ name: string; needles: string[] }>> = {
  java: [
    { name: 'JUnit5', needles: ['org.junit.jupiter'] },
    { name: 'JUnit4', needles: ['org.junit.Test', 'org.junit.Assert', 'org.junit.Before', 'org.junit.runner'] },
    { name: 'TestNG', needles: ['org.testng'] },
    { name: 'Selenium', needles: ['org.openqa.selenium'] },
    { name: 'RestAssured', needles: ['io.restassured'] },
    { name: 'Cucumber', needles: ['io.cucumber'] },
  ],
  python: [
    { name: 'pytest', needles: ['import pytest', 'from pytest'] },
    { name: 'unittest', needles: ['import unittest', 'from unittest'] },
    { name: 'Playwright', needles: ['playwright'] },
    { name: 'Selenium', needles: ['selenium'] },
    { name: 'Robot', needles: ['robot.api', 'robotframework'] },
    { name: 'behave', needles: ['from behave', 'import behave'] },
  ],
  csharp: [
    { name: 'NUnit', needles: ['NUnit.Framework', 'using NUnit'] },
    { name: 'xUnit', needles: ['using Xunit', 'Xunit'] },
    { name: 'MSTest', needles: ['Microsoft.VisualStudio.TestTools'] },
    { name: 'Selenium', needles: ['OpenQA.Selenium'] },
    { name: 'SpecFlow', needles: ['TechTalk.SpecFlow', 'Reqnroll'] },
  ],
};

export class MultiLanguageAnalyzer {
  /** Cache: language → loaded grammar (or null if load failed). */
  private grammarCache = new Map<SupportedLanguage, any>();
  private parserCtor: any = undefined; // undefined = not probed, null = unavailable

  /** Whether the MULTI_LANGUAGE feature flag is enabled. */
  static isFlagEnabled(): boolean {
    return FEATURE_FLAGS.REPO_INTELLIGENCE.MULTI_LANGUAGE;
  }

  /** Detect a supported language from a file path (null if unsupported). */
  detectLanguage(filePath: string): SupportedLanguage | null {
    return EXT_TO_LANG[path.extname(filePath).toLowerCase()] ?? null;
  }

  /** Lazily resolve the tree-sitter Parser constructor (null if unavailable). */
  private getParserCtor(): any {
    if (this.parserCtor !== undefined) return this.parserCtor;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      this.parserCtor = require('tree-sitter');
    } catch (err) {
      logger.warn(MOD, 'tree-sitter core not installed — multi-language analysis unavailable', {
        error: (err as Error).message,
      });
      this.parserCtor = null;
    }
    return this.parserCtor;
  }

  /** Lazily resolve a language grammar (null if it cannot be loaded). */
  private getGrammar(language: SupportedLanguage): any {
    if (this.grammarCache.has(language)) return this.grammarCache.get(language);
    let grammar: any = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      grammar = require(GRAMMAR_MODULES[language]);
    } catch (err) {
      logger.warn(MOD, `grammar ${GRAMMAR_MODULES[language]} unavailable`, {
        error: (err as Error).message,
      });
      grammar = null;
    }
    this.grammarCache.set(language, grammar);
    return grammar;
  }

  /**
   * Whether analysis can run for a given language right now: the feature flag
   * must be on AND the tree-sitter core + grammar must load. With no language
   * argument, reports whether the core parser is available at all.
   */
  isAvailable(language?: SupportedLanguage): boolean {
    if (!MultiLanguageAnalyzer.isFlagEnabled()) return false;
    if (!this.getParserCtor()) return false;
    if (!language) return true;
    return !!this.getGrammar(language);
  }

  /** Build a parser bound to the given language, or null if unavailable. */
  private buildParser(language: SupportedLanguage): any {
    const Parser = this.getParserCtor();
    const grammar = this.getGrammar(language);
    if (!Parser || !grammar) return null;
    try {
      const parser = new Parser();
      parser.setLanguage(grammar);
      return parser;
    } catch (err) {
      logger.warn(MOD, 'failed to build parser', { language, error: (err as Error).message });
      return null;
    }
  }

  /**
   * Analyze a single source file. Always returns a result object — when the
   * feature is off or parsers are missing, `available` is false and the lists
   * are empty (never throws).
   */
  analyzeFile(filePath: string, language?: SupportedLanguage): MultiLangFileAnalysis {
    const lang = language ?? this.detectLanguage(filePath);
    const base: MultiLangFileAnalysis = {
      available: false,
      filePath,
      language: (lang ?? 'java'),
      classes: [],
      methods: [],
      imports: [],
      framework: null,
      frameworks: [],
    };

    if (!lang) return { ...base, reason: 'unsupported file extension' };
    base.language = lang;

    if (!MultiLanguageAnalyzer.isFlagEnabled()) {
      return { ...base, reason: 'MULTI_LANGUAGE flag disabled' };
    }
    if (!fs.existsSync(filePath)) {
      return { ...base, reason: 'file not found' };
    }

    const source = (() => {
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch {
        return null;
      }
    })();
    if (source == null) return { ...base, reason: 'unreadable file' };

    return this.analyzeSource(source, lang, filePath);
  }

  /**
   * Analyze raw source text for a language. Useful for tests (no file I/O).
   */
  analyzeSource(source: string, language: SupportedLanguage, filePath = `inline.${language}`): MultiLangFileAnalysis {
    const base: MultiLangFileAnalysis = {
      available: false,
      filePath,
      language,
      classes: [],
      methods: [],
      imports: [],
      framework: null,
      frameworks: [],
    };

    if (!MultiLanguageAnalyzer.isFlagEnabled()) {
      return { ...base, reason: 'MULTI_LANGUAGE flag disabled' };
    }

    const parser = this.buildParser(language);
    if (!parser) return { ...base, reason: 'tree-sitter parser unavailable' };

    let tree: any;
    try {
      tree = parser.parse(source);
    } catch (err) {
      return { ...base, reason: `parse error: ${(err as Error).message}` };
    }

    const root = tree.rootNode;
    const types = NODE_TYPES[language];

    const classes = this.findNodes(root, types.class).map(node => this.toClass(node, source));
    const methods = this.findNodes(root, types.method).map(node => this.toMethod(node, source, language));
    const importNodes = this.findNodes(root, types.import);
    const imports = importNodes.map(n => getNodeText(n, source).trim()).filter(Boolean);

    const frameworks = this.detectFrameworks(source, language);

    return {
      available: true,
      filePath,
      language,
      classes,
      methods,
      imports,
      framework: frameworks[0] ?? null,
      frameworks,
    };
  }

  /** Detect every test/automation framework whose signature appears in source. */
  detectFrameworks(source: string, language: SupportedLanguage): string[] {
    const found: string[] = [];
    for (const { name, needles } of FRAMEWORK_SIGNATURES[language]) {
      if (needles.some(n => source.includes(n)) && !found.includes(name)) found.push(name);
    }
    return found;
  }

  /* ---------------------------------------------------------------- */
  /*  tree-sitter traversal helpers                                    */
  /* ---------------------------------------------------------------- */

  /** Depth-first collect all nodes whose type is in `wanted`. */
  private findNodes(root: any, wanted: string[]): any[] {
    const want = new Set(wanted);
    const out: any[] = [];
    const stack: any[] = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (want.has(node.type)) out.push(node);
      const count = node.childCount ?? 0;
      for (let i = 0; i < count; i++) {
        const child = node.child(i);
        if (child) stack.push(child);
      }
    }
    return out;
  }

  private toClass(node: any, source: string): ExtractedLangClass {
    return {
      name: this.nodeName(node, source) || 'Anonymous',
      baseClass: this.superclassName(node, source),
      lineStart: (node.startPosition?.row ?? 0) + 1,
      lineEnd: (node.endPosition?.row ?? 0) + 1,
    };
  }

  private toMethod(node: any, source: string, language: SupportedLanguage): ExtractedLangMethod {
    return {
      name: this.nodeName(node, source) || 'anonymous',
      className: this.enclosingClassName(node, source),
      parameters: this.extractParameters(node, source, language),
      returnType: this.returnType(node, source, language),
      isStatic: getNodeText(node, source).slice(0, 200).includes('static'),
      lineStart: (node.startPosition?.row ?? 0) + 1,
      lineEnd: (node.endPosition?.row ?? 0) + 1,
    };
  }

  /** Best-effort name extraction: prefer the `name` field, else first identifier. */
  private nodeName(node: any, source: string): string | null {
    const named = node.childForFieldName?.('name');
    if (named) return getNodeText(named, source);
    const count = node.childCount ?? 0;
    for (let i = 0; i < count; i++) {
      const c = node.child(i);
      if (c && (c.type === 'identifier' || c.type === 'type_identifier')) {
        return getNodeText(c, source);
      }
    }
    return null;
  }

  private superclassName(node: any, source: string): string | null {
    // Java: superclass field; Python: argument_list; C#: base_list
    const sc = node.childForFieldName?.('superclass');
    if (sc) return getNodeText(sc, source).replace(/^extends\s+/, '').trim() || null;
    const count = node.childCount ?? 0;
    for (let i = 0; i < count; i++) {
      const c = node.child(i);
      if (!c) continue;
      if (c.type === 'superclass' || c.type === 'base_list' || c.type === 'argument_list') {
        const text = getNodeText(c, source).replace(/^[:(]\s*/, '').replace(/[)\s]+$/, '').replace(/^extends\s+/, '').trim();
        if (text) return text.split(',')[0].trim();
      }
    }
    return null;
  }

  private enclosingClassName(node: any, source: string): string | null {
    let cur = node.parent;
    const classTypes = new Set([
      'class_declaration', 'class_definition', 'interface_declaration',
      'struct_declaration', 'enum_declaration',
    ]);
    while (cur) {
      if (classTypes.has(cur.type)) return this.nodeName(cur, source);
      cur = cur.parent;
    }
    return null;
  }

  private extractParameters(node: any, source: string, language: SupportedLanguage): ExtractedParameter[] {
    const params = node.childForFieldName?.('parameters');
    if (!params) return [];
    const out: ExtractedParameter[] = [];
    const count = params.childCount ?? 0;
    for (let i = 0; i < count; i++) {
      const p = params.child(i);
      if (!p) continue;
      const t = p.type;
      // Skip punctuation nodes.
      if (t === '(' || t === ')' || t === ',' || t === ':') continue;
      const nameNode = p.childForFieldName?.('name') ?? p.childForFieldName?.('declarator');
      const name = nameNode ? getNodeText(nameNode, source) : getNodeText(p, source).trim();
      if (!name || name === 'self' || name === 'this') continue;
      const typeNode = p.childForFieldName?.('type');
      out.push({
        name: name.replace(/[:=].*$/, '').trim(),
        type: typeNode ? getNodeText(typeNode, source).trim() : null,
      });
    }
    return out;
  }

  private returnType(node: any, source: string, language: SupportedLanguage): string | null {
    const typeNode = node.childForFieldName?.('type')
      ?? node.childForFieldName?.('return_type');
    if (typeNode) return getNodeText(typeNode, source).trim() || null;
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Pure helpers (exported for testing)                               */
/* ------------------------------------------------------------------ */

/** Slice the original source using a tree-sitter node's byte offsets. */
export function getNodeText(node: any, source: string): string {
  if (!node) return '';
  if (typeof node.text === 'string') return node.text;
  const start = node.startIndex ?? 0;
  const end = node.endIndex ?? 0;
  return source.slice(start, end);
}

/** Standalone extension→language map (mirrors instance method, for tests). */
export function languageForExtension(filePath: string): SupportedLanguage | null {
  return EXT_TO_LANG[path.extname(filePath).toLowerCase()] ?? null;
}
