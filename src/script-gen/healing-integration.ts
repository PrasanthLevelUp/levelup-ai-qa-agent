/**
 * Healing Integration Engine
 * Ensures generated tests are compatible with the LevelUp healing platform.
 * 
 * Responsibilities:
 * - Add healing metadata to generated tests
 * - Track selector confidence scores
 * - Generate healing-compatible locator patterns
 * - Ensure patch compatibility with the healing engine
 * - Add healing ID comments for tracking
 */

import { v4 as uuidv4 } from 'uuid';
import type { GeneratedFile, TestPlan, TestPlanStep } from './script-gen-engine';
import type { ScoredSelector } from './selector-quality-engine';
import { logger } from '../utils/logger';

const MOD = 'healing-integration';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface HealingMetadata {
  healingId: string;           // unique ID for healing tracking
  testName: string;
  selectors: SelectorMetadata[];
  generatedAt: string;
  selectorQuality: number;     // avg score
  healingCompatible: boolean;
}

export interface SelectorMetadata {
  healingId: string;
  selector: string;
  strategy: string;
  confidence: number;
  fallbacks: string[];         // alternative selectors
  elementDescription: string;
}

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

export class HealingIntegrationEngine {
  /**
   * Enhance generated files with healing metadata.
   */
  addHealingMetadata(files: GeneratedFile[], testPlan: TestPlan): {
    files: GeneratedFile[];
    metadata: HealingMetadata[];
  } {
    const metadata: HealingMetadata[] = [];

    const enhancedFiles = files.map(file => {
      if (file.type !== 'test') return file;

      const healingId = `heal_${uuidv4().slice(0, 8)}`;
      const selectorMeta: SelectorMetadata[] = [];

      // Add healing ID header comment
      let content = file.content;
      const headerComment = `// @healing-id: ${healingId}\n// @generated-by: LevelUp AI QA Engine\n// @healing-compatible: true\n// @selector-quality: ${(testPlan.metadata.selectorQuality * 100).toFixed(0)}%\n\n`;
      content = headerComment + content;

      // Find and annotate selectors with healing comments
      content = content.replace(
        /(page\.(?:locator|getByRole|getByTestId|getByLabel|getByPlaceholder|getByText)\([^)]+\))/g,
        (match) => {
          const sId = `sel_${uuidv4().slice(0, 6)}`;
          selectorMeta.push({
            healingId: sId,
            selector: match,
            strategy: inferStrategy(match),
            confidence: inferConfidence(match),
            fallbacks: [],
            elementDescription: match,
          });
          return `${match} /* @heal:${sId} */`;
        },
      );

      metadata.push({
        healingId,
        testName: extractTestName(file.path),
        selectors: selectorMeta,
        generatedAt: new Date().toISOString(),
        selectorQuality: testPlan.metadata.selectorQuality,
        healingCompatible: true,
      });

      return { ...file, content };
    });

    logger.info(MOD, 'Healing metadata added', {
      files: enhancedFiles.length,
      totalSelectors: metadata.reduce((sum, m) => sum + m.selectors.length, 0),
    });

    return { files: enhancedFiles, metadata };
  }

  /**
   * Generate a healing configuration file for the project.
   */
  generateHealingConfig(metadata: HealingMetadata[]): GeneratedFile {
    const config = {
      version: '1.0',
      platform: 'levelup-ai-qa',
      healingEnabled: true,
      selectors: metadata.flatMap(m => m.selectors.map(s => ({
        id: s.healingId,
        testName: m.testName,
        selector: s.selector,
        strategy: s.strategy,
        confidence: s.confidence,
      }))),
      generatedAt: new Date().toISOString(),
    };

    return {
      path: 'healing.config.json',
      content: JSON.stringify(config, null, 2),
      type: 'config',
    };
  }
}

/* -------------------------------------------------------------------------- */
/*  Helpers                                                                   */
/* -------------------------------------------------------------------------- */

function inferStrategy(selector: string): string {
  if (selector.includes('getByTestId')) return 'data-testid';
  if (selector.includes('getByRole')) return 'role';
  if (selector.includes('getByLabel')) return 'label';
  if (selector.includes('getByPlaceholder')) return 'placeholder';
  if (selector.includes('getByText')) return 'text';
  if (selector.includes('locator')) return 'css';
  return 'unknown';
}

function inferConfidence(selector: string): number {
  if (selector.includes('getByTestId')) return 1.0;
  if (selector.includes('getByRole')) return 0.9;
  if (selector.includes('getByLabel')) return 0.85;
  if (selector.includes('getByPlaceholder')) return 0.7;
  if (selector.includes('getByText')) return 0.5;
  return 0.4;
}

function extractTestName(filePath: string): string {
  return filePath
    .replace(/^tests\//, '')
    .replace(/\.spec\.ts$/, '')
    .replace(/-/g, ' ');
}
