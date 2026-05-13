/**
 * Validation Layer
 * Safety gate before applying AI/rule/pattern suggestions.
 */

import * as fs from 'fs';
import * as path from 'path';
import ts from 'typescript';
import { createTwoFilesPatch } from 'diff';
import { logger } from '../utils/logger';
import type { HealingSuggestion } from '../core/healing-orchestrator';
import type { FailureDetails } from '../core/failure-analyzer';

const MOD = 'validation-layer';

export interface ValidationResult {
  approved: boolean;
  reason?: string;
  patchPath?: string;
  updatedContent?: string;
}

export class ValidationLayer {
  constructor(private readonly patchDir: string = '/home/ubuntu/healing_reports/patches') {}

  validate(suggestion: HealingSuggestion, failure: FailureDetails): ValidationResult {
    if (suggestion.confidence <= 0.5) {
      return { approved: false, reason: `Confidence too low (${suggestion.confidence.toFixed(2)} <= 0.50)` };
    }

    if (!this.isSemanticLocator(suggestion.newLocator)) {
      return { approved: false, reason: 'Non-semantic locator rejected.' };
    }

    if (!this.isSafeCode(suggestion.newLocator)) {
      return { approved: false, reason: 'Security check failed due to dangerous code pattern.' };
    }

    if (!failure.failedLocator) {
      return { approved: false, reason: 'Failed locator missing; cannot produce deterministic patch.' };
    }

    if (!fs.existsSync(failure.filePath)) {
      return { approved: false, reason: `Test file does not exist: ${failure.filePath}` };
    }

    const originalContent = fs.readFileSync(failure.filePath, 'utf-8');
    if (!originalContent.includes(failure.failedLocator)) {
      return { approved: false, reason: 'Original locator not found in file.' };
    }

    let updatedContent = this.applyLocatorReplacement(originalContent, failure.failedLocator, suggestion.newLocator);
    if (suggestion.addExplicitWait) {
      updatedContent = this.insertExplicitWait(updatedContent);
    }

    const syntaxCheck = this.isValidTypeScript(updatedContent, failure.filePath);
    if (!syntaxCheck.valid) {
      return { approved: false, reason: `TypeScript syntax validation failed: ${syntaxCheck.reason}` };
    }

    const patchPath = this.generatePatch(failure.filePath, originalContent, updatedContent);

    logger.info(MOD, 'Validation approved', {
      testName: failure.testName,
      strategy: suggestion.strategy,
      patchPath,
    });

    return {
      approved: true,
      patchPath,
      updatedContent,
    };
  }

  applyValidatedFix(filePath: string, updatedContent: string): void {
    fs.writeFileSync(filePath, updatedContent, 'utf-8');
  }

  private isSemanticLocator(locatorExpression: string): boolean {
    // Accept Playwright semantic locators
    if (/(getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|getByAltText|getByTitle)/.test(locatorExpression)) {
      return true;
    }
    // Accept stable CSS attribute selectors like input[name="username"], #id, [data-testid="x"]
    if (/^[a-z]+\[[a-z_-]+="[^"]+"\]$/i.test(locatorExpression)) {
      return true;
    }
    if (/^#[\w-]+$/.test(locatorExpression)) {
      return true;
    }
    if (/^\[data-testid="[^"]+"\]$/.test(locatorExpression)) {
      return true;
    }
    return false;
  }

  private isSafeCode(locatorExpression: string): boolean {
    const blocked = [
      /eval\(/,
      /new Function\(/,
      /child_process/,
      /process\.exit/,
      /`\$\{/,
      /require\(/,
    ];
    return !blocked.some((rule) => rule.test(locatorExpression));
  }

  private isValidTypeScript(content: string, fileName: string): { valid: boolean; reason?: string } {
    const result = ts.transpileModule(content, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
        strict: true,
      },
      fileName,
      reportDiagnostics: true,
    });

    const diagnostics = result.diagnostics ?? [];
    if (diagnostics.length === 0) return { valid: true };

    const message = diagnostics
      .slice(0, 3)
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n'))
      .join(' | ');

    return { valid: false, reason: message };
  }

  private escapeRegex(input: string): string {
    return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private applyLocatorReplacement(content: string, failedLocator: string, newLocatorExpr: string): string {
    const escapedLocator = this.escapeRegex(failedLocator);

    const clickPattern = new RegExp(`page\\.click\\((['\"])${escapedLocator}\\1\\)`, 'g');
    if (clickPattern.test(content)) {
      return content.replace(clickPattern, `${newLocatorExpr}.click()`);
    }

    const fillPattern = new RegExp(`page\\.fill\\((['\"])${escapedLocator}\\1\\s*,`, 'g');
    if (fillPattern.test(content)) {
      return content.replace(fillPattern, `${newLocatorExpr}.fill(`);
    }

    const locatorPattern = new RegExp(`page\\.locator\\((['\"])${escapedLocator}\\1\\)`, 'g');
    if (locatorPattern.test(content)) {
      return content.replace(locatorPattern, `${newLocatorExpr}`);
    }

    const expectPattern = new RegExp(`expect\\(page\\.locator\\((['\"])${escapedLocator}\\1\\)\\)`, 'g');
    if (expectPattern.test(content)) {
      return content.replace(expectPattern, `expect(${newLocatorExpr})`);
    }

    return content.replace(failedLocator, newLocatorExpr);
  }

  private insertExplicitWait(content: string): string {
    if (content.includes("waitForLoadState('networkidle')")) return content;
    return content.replace(/(await page\.goto\([^;]+;)/, "$1\n  await page.waitForLoadState('networkidle');");
  }

  private generatePatch(filePath: string, originalContent: string, updatedContent: string): string {
    fs.mkdirSync(this.patchDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const patchFile = path.join(this.patchDir, `${path.basename(filePath)}.${ts}.patch`);
    const patch = createTwoFilesPatch(
      filePath,
      filePath,
      originalContent,
      updatedContent,
      'before-heal',
      'after-heal',
    );

    fs.writeFileSync(patchFile, patch, 'utf-8');
    return patchFile;
  }
}
