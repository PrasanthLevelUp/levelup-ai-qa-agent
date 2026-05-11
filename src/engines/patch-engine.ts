/**
 * Patch Engine — generates proper diff patches for healing fixes.
 */

import * as fs from 'fs';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';
import { logger } from '../utils/logger';

const MOD = 'patch-engine';

export interface PatchMetadata {
  filePath: string;
  lineNumber: number;
  description: string;
  strategy: string;
  timestamp: string;
}

export interface PatchResult {
  patchContent: string;
  patchPath: string;
  metadata: PatchMetadata;
}

export class PatchEngine {
  private readonly outputDir: string;

  constructor(outputDir = '/home/ubuntu/healing_reports/patches') {
    this.outputDir = outputDir;
    fs.mkdirSync(this.outputDir, { recursive: true });
  }

  /**
   * Generate a unified diff patch from original and fixed code.
   */
  generatePatch(
    filePath: string,
    lineNumber: number,
    originalCode: string,
    fixedCode: string,
    description = 'Self-healing fix',
    strategy = 'rule_engine',
  ): PatchResult {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const baseName = path.basename(filePath, path.extname(filePath));
    const patchFileName = `${baseName}.line${lineNumber}.${ts}.patch`;
    const patchPath = path.join(this.outputDir, patchFileName);

    const patchContent = createTwoFilesPatch(
      filePath,
      filePath,
      originalCode,
      fixedCode,
      'before-heal',
      'after-heal',
    );

    // Add metadata header
    const metadata: PatchMetadata = {
      filePath,
      lineNumber,
      description,
      strategy,
      timestamp: new Date().toISOString(),
    };

    const fullPatch = [
      `# Self-Healing Patch`,
      `# File: ${filePath}`,
      `# Line: ${lineNumber}`,
      `# Strategy: ${strategy}`,
      `# Description: ${description}`,
      `# Generated: ${metadata.timestamp}`,
      `#`,
      patchContent,
    ].join('\n');

    fs.writeFileSync(patchPath, fullPatch, 'utf-8');

    logger.info(MOD, 'Patch generated', {
      patchPath,
      filePath,
      lineNumber,
      strategy,
    });

    return { patchContent: fullPatch, patchPath, metadata };
  }

  /**
   * Apply a patch file to the filesystem (by writing the fixed content).
   */
  applyPatch(filePath: string, fixedContent: string): void {
    fs.writeFileSync(filePath, fixedContent, 'utf-8');
    logger.info(MOD, 'Patch applied', { filePath });
  }

  /**
   * Save a patch to a specific output path.
   */
  savePatch(patchContent: string, outputPath: string): void {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, patchContent, 'utf-8');
    logger.info(MOD, 'Patch saved', { outputPath });
  }

  /**
   * List all generated patches.
   */
  listPatches(): string[] {
    if (!fs.existsSync(this.outputDir)) return [];
    return fs.readdirSync(this.outputDir)
      .filter((f) => f.endsWith('.patch'))
      .map((f) => path.join(this.outputDir, f));
  }
}
