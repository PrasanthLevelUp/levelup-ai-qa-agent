/**
 * Patch Engine v2 — AST-based code transformation using ts-morph.
 * Surgical locator replacements that preserve formatting and comments.
 * Falls back to string-based replacement when AST approach fails.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';
import { Project, SyntaxKind, type SourceFile, type Node } from 'ts-morph';
import { logger } from '../utils/logger';

const MOD = 'patch-engine';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface PatchMetadata {
  filePath: string;
  lineNumber: number;
  description: string;
  strategy: string;
  timestamp: string;
  method: 'ast' | 'string' | 'line';
}

export interface PatchResult {
  patchContent: string;
  patchPath: string;
  metadata: PatchMetadata;
  success: boolean;
  modifiedCode?: string;
  preservedFormatting: boolean;
}

/* -------------------------------------------------------------------------- */
/*  Patch Engine                                                              */
/* -------------------------------------------------------------------------- */

export class PatchEngine {
  private readonly outputDir: string;
  private readonly project: Project;

  constructor(outputDir = '/home/ubuntu/healing_reports/patches') {
    this.outputDir = outputDir;
    fs.mkdirSync(this.outputDir, { recursive: true });
    this.project = new Project({
      compilerOptions: {
        target: 2 /* ES2015 */,
        module: 1 /* CommonJS */,
        strict: false,
        noEmit: true,
      },
      skipFileDependencyResolution: true,
      skipLoadingLibFiles: true,
    });
  }

  /* ------------------------------------------------------------------ */
  /*  AST-based locator replacement                                      */
  /* ------------------------------------------------------------------ */

  /**
   * Replace a locator in a file using AST analysis.
   * Falls back to string replacement if AST approach fails.
   */
  async applyLocatorChange(
    filePath: string,
    lineNumber: number,
    oldLocator: string,
    newLocator: string,
    description = 'Self-healing fix',
    strategy = 'rule_engine',
  ): Promise<PatchResult> {
    const originalCode = fs.readFileSync(filePath, 'utf-8');
    let modifiedCode: string;
    let method: 'ast' | 'string' | 'line' = 'ast';

    try {
      modifiedCode = this.applyViaAST(filePath, originalCode, lineNumber, oldLocator, newLocator);
      logger.info(MOD, 'AST-based replacement succeeded', { filePath, lineNumber });
    } catch (astError: any) {
      logger.warn(MOD, 'AST replacement failed, falling back to string replacement', {
        error: astError.message,
      });
      try {
        modifiedCode = this.applyViaString(originalCode, lineNumber, oldLocator, newLocator);
        method = 'string';
      } catch (strError: any) {
        logger.warn(MOD, 'String replacement failed, falling back to line replacement', {
          error: strError.message,
        });
        modifiedCode = this.applyViaLine(originalCode, lineNumber, oldLocator, newLocator);
        method = 'line';
      }
    }

    // Generate diff
    const patchContent = this.generateUnifiedDiff(originalCode, modifiedCode, filePath, description, strategy);
    const patchPath = this.savePatchToFile(patchContent, filePath, lineNumber);

    const metadata: PatchMetadata = {
      filePath,
      lineNumber,
      description,
      strategy,
      timestamp: new Date().toISOString(),
      method,
    };

    return {
      patchContent,
      patchPath,
      metadata,
      success: true,
      modifiedCode,
      preservedFormatting: method === 'ast',
    };
  }

  /* ---- AST approach ---- */

  private applyViaAST(
    filePath: string,
    originalCode: string,
    lineNumber: number,
    oldLocator: string,
    newLocator: string,
  ): string {
    // Create a temporary source file for AST analysis
    const tempFileName = `temp_${Date.now()}.ts`;
    const sourceFile = this.project.createSourceFile(tempFileName, originalCode, { overwrite: true });

    try {
      // Find the locator node at the specified line
      const targetNode = this.findLocatorNode(sourceFile, lineNumber, oldLocator);

      if (!targetNode) {
        throw new Error(`Could not locate target node at line ${lineNumber} containing "${oldLocator}"`);
      }

      // Replace the node text
      const nodeText = targetNode.getText();
      const newNodeText = nodeText.replace(oldLocator, newLocator);
      targetNode.replaceWithText(newNodeText);

      const result = sourceFile.getFullText();
      return result;
    } finally {
      this.project.removeSourceFile(sourceFile);
    }
  }

  private findLocatorNode(sourceFile: SourceFile, lineNumber: number, locator: string): Node | null {
    // Get all call expressions in the file
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

    for (const call of callExpressions) {
      const startLine = call.getStartLineNumber();
      const endLine = call.getEndLineNumber();

      // Check if this call is on or spans the target line
      if (startLine <= lineNumber && endLine >= lineNumber) {
        const text = call.getText();
        if (text.includes(locator)) {
          // Try to return the most specific argument containing the locator
          const args = call.getArguments();
          for (const arg of args) {
            if (arg.getText().includes(locator)) {
              return arg;
            }
          }
          return call;
        }
      }
    }

    // Fallback: check string literals
    const stringLiterals = sourceFile.getDescendantsOfKind(SyntaxKind.StringLiteral);
    for (const str of stringLiterals) {
      const line = str.getStartLineNumber();
      if (line === lineNumber && str.getText().includes(locator)) {
        return str;
      }
    }

    // Fallback: check template literals
    const templates = sourceFile.getDescendantsOfKind(SyntaxKind.NoSubstitutionTemplateLiteral);
    for (const tmpl of templates) {
      const line = tmpl.getStartLineNumber();
      if (line === lineNumber && tmpl.getText().includes(locator)) {
        return tmpl;
      }
    }

    return null;
  }

  /* ---- String replacement approach ---- */

  private applyViaString(
    originalCode: string,
    lineNumber: number,
    oldLocator: string,
    newLocator: string,
  ): string {
    const lines = originalCode.split('\n');
    const targetLine = lines[lineNumber - 1];

    if (!targetLine) {
      throw new Error(`Line ${lineNumber} does not exist in file`);
    }

    if (!targetLine.includes(oldLocator)) {
      throw new Error(`Old locator "${oldLocator}" not found on line ${lineNumber}`);
    }

    lines[lineNumber - 1] = targetLine.replace(oldLocator, newLocator);
    return lines.join('\n');
  }

  /* ---- Line replacement approach (most conservative) ---- */

  private applyViaLine(
    originalCode: string,
    lineNumber: number,
    oldLocator: string,
    newLocator: string,
  ): string {
    const lines = originalCode.split('\n');
    const idx = lineNumber - 1;

    if (idx < 0 || idx >= lines.length) {
      throw new Error(`Line ${lineNumber} out of range (file has ${lines.length} lines)`);
    }

    // Try exact replacement on the target line
    if (lines[idx].includes(oldLocator)) {
      lines[idx] = lines[idx].replace(oldLocator, newLocator);
    } else {
      // Search nearby lines (±3)
      let found = false;
      for (let offset = -3; offset <= 3; offset++) {
        const i = idx + offset;
        if (i >= 0 && i < lines.length && lines[i].includes(oldLocator)) {
          lines[i] = lines[i].replace(oldLocator, newLocator);
          found = true;
          break;
        }
      }
      if (!found) {
        // Last resort: replace the entire line with new locator in same context
        logger.warn(MOD, 'Could not find old locator; replacing line content', { lineNumber, oldLocator });
        lines[idx] = lines[idx].replace(/(?:page\.\w+\([^)]*\)|['"][^'"]+['"])/g, newLocator);
      }
    }

    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /*  Diff generation                                                    */
  /* ------------------------------------------------------------------ */

  generateUnifiedDiff(
    original: string,
    modified: string,
    fileName: string,
    description = 'Self-healing fix',
    strategy = 'unknown',
  ): string {
    const patch = createTwoFilesPatch(
      fileName,
      fileName,
      original,
      modified,
      'original',
      'fixed',
    );

    return [
      `# Self-Healing Patch`,
      `# File: ${fileName}`,
      `# Strategy: ${strategy}`,
      `# Description: ${description}`,
      `# Generated: ${new Date().toISOString()}`,
      `#`,
      patch,
    ].join('\n');
  }

  /* ------------------------------------------------------------------ */
  /*  Legacy generatePatch (backward compat)                            */
  /* ------------------------------------------------------------------ */

  generatePatch(
    filePath: string,
    lineNumber: number,
    originalCode: string,
    fixedCode: string,
    description = 'Self-healing fix',
    strategy = 'rule_engine',
  ): PatchResult {
    const patchContent = this.generateUnifiedDiff(originalCode, fixedCode, filePath, description, strategy);
    const patchPath = this.savePatchToFile(patchContent, filePath, lineNumber);

    const metadata: PatchMetadata = {
      filePath,
      lineNumber,
      description,
      strategy,
      timestamp: new Date().toISOString(),
      method: 'string',
    };

    logger.info(MOD, 'Patch generated', { patchPath, filePath, lineNumber, strategy });

    return { patchContent, patchPath, metadata, success: true, preservedFormatting: false };
  }

  /* ------------------------------------------------------------------ */
  /*  File operations                                                    */
  /* ------------------------------------------------------------------ */

  applyPatch(filePath: string, fixedContent: string): void {
    fs.writeFileSync(filePath, fixedContent, 'utf-8');
    logger.info(MOD, 'Patch applied', { filePath });
  }

  savePatch(patchContent: string, outputPath: string): void {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, patchContent, 'utf-8');
    logger.info(MOD, 'Patch saved', { outputPath });
  }

  listPatches(): string[] {
    if (!fs.existsSync(this.outputDir)) return [];
    return fs.readdirSync(this.outputDir)
      .filter((f) => f.endsWith('.patch'))
      .map((f) => path.join(this.outputDir, f));
  }

  private savePatchToFile(patchContent: string, filePath: string, lineNumber: number): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = path.basename(filePath, path.extname(filePath));
    const patchFileName = `${baseName}.line${lineNumber}.${ts}.patch`;
    const patchPath = path.join(this.outputDir, patchFileName);
    fs.writeFileSync(patchPath, patchContent, 'utf-8');
    return patchPath;
  }
}
