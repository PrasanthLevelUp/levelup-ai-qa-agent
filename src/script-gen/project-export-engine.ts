/**
 * Project Export Engine
 * Generates downloadable ZIP files containing complete Playwright projects.
 * 
 * Output structure:
 * project/
 * ├── playwright.config.ts
 * ├── package.json
 * ├── tsconfig.json
 * ├── .env.example
 * ├── .gitignore
 * ├── README.md
 * ├── tests/
 * ├── pages/
 * ├── fixtures/
 * ├── utils/
 * └── .github/workflows/playwright.yml
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';
import type { GeneratedFile, TestPlan, GenerationResult } from './script-gen-engine';

const MOD = 'project-export';

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface ExportResult {
  projectDir: string;          // path to generated project directory
  fileCount: number;
  totalSize: number;           // bytes
  structure: string[];         // list of files
}

/* -------------------------------------------------------------------------- */
/*  Engine                                                                    */
/* -------------------------------------------------------------------------- */

export class ProjectExportEngine {
  /**
   * Export generated files as a complete project directory.
   */
  exportProject(result: GenerationResult, outputDir: string): ExportResult {
    const projectDir = outputDir;
    fs.mkdirSync(projectDir, { recursive: true });

    const structure: string[] = [];
    let totalSize = 0;

    // Write all generated files
    for (const file of result.generatedFiles) {
      const filePath = path.join(projectDir, file.path);
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, file.content, 'utf-8');
      structure.push(file.path);
      totalSize += Buffer.byteLength(file.content, 'utf-8');
    }

    // Add package.json
    const packageJson = this.generatePackageJson(result.testPlan);
    const pkgPath = path.join(projectDir, 'package.json');
    fs.writeFileSync(pkgPath, packageJson, 'utf-8');
    structure.push('package.json');
    totalSize += Buffer.byteLength(packageJson, 'utf-8');

    // Add tsconfig.json
    const tsconfig = this.generateTsConfig();
    const tscPath = path.join(projectDir, 'tsconfig.json');
    fs.writeFileSync(tscPath, tsconfig, 'utf-8');
    structure.push('tsconfig.json');
    totalSize += Buffer.byteLength(tsconfig, 'utf-8');

    // Add .gitignore
    const gitignore = this.generateGitignore();
    const giPath = path.join(projectDir, '.gitignore');
    fs.writeFileSync(giPath, gitignore, 'utf-8');
    structure.push('.gitignore');
    totalSize += Buffer.byteLength(gitignore, 'utf-8');

    // Add test plan JSON
    const planJson = JSON.stringify(result.testPlan, null, 2);
    const planPath = path.join(projectDir, 'test-plan.json');
    fs.writeFileSync(planPath, planJson, 'utf-8');
    structure.push('test-plan.json');
    totalSize += Buffer.byteLength(planJson, 'utf-8');

    logger.info(MOD, 'Project exported', {
      projectDir,
      files: structure.length,
      totalSize,
    });

    return {
      projectDir,
      fileCount: structure.length,
      totalSize,
      structure,
    };
  }

  private generatePackageJson(plan: TestPlan): string {
    return JSON.stringify({
      name: `levelup-tests-${toSlug(plan.name)}`,
      version: '1.0.0',
      description: plan.description,
      scripts: {
        test: 'npx playwright test',
        'test:ui': 'npx playwright test --ui',
        'test:headed': 'npx playwright test --headed',
        'test:debug': 'npx playwright test --debug',
        report: 'npx playwright show-report',
        install: 'npx playwright install --with-deps chromium',
      },
      devDependencies: {
        '@playwright/test': '^1.59.0',
        'dotenv': '^16.4.0',
      },
      engines: { node: '>=18' },
      author: 'LevelUp AI QA Engine',
      license: 'MIT',
    }, null, 2);
  }

  private generateTsConfig(): string {
    return JSON.stringify({
      compilerOptions: {
        target: 'ES2020',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        declaration: false,
        outDir: './dist',
        baseUrl: '.',
        paths: {
          '@pages/*': ['pages/*'],
          '@fixtures/*': ['fixtures/*'],
          '@utils/*': ['utils/*'],
        },
      },
      include: ['tests/**/*.ts', 'pages/**/*.ts', 'fixtures/**/*.ts', 'utils/**/*.ts'],
      exclude: ['node_modules', 'dist'],
    }, null, 2);
  }

  private generateGitignore(): string {
    return `node_modules/
test-results/
playwright-report/
screenshots/
.env
dist/
*.log
.DS_Store
`;
  }
}

function toSlug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 40);
}
