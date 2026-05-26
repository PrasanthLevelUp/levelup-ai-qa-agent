/**
 * Adaptive Code Generator
 *
 * Produces `GeneratedFile[]` that respect the target repository's
 * existing structure, naming conventions, and style choices.
 *
 * When the repo uses flat-scripts (no page objects), the output is a
 * set of numbered spec files with inline test logic — matching what
 * the developer already has.
 *
 * When the repo uses POM, the generator falls through to the default
 * engine behaviour (returns `null` so the caller keeps the originals).
 */

import type {
  GeneratedFile,
  GenerationConfig,
  TestPlan,
  TestPlanFlow,
  TestPlanStep,
} from './script-gen-engine';
import type { RepoStructureAnalysis, NamingConvention } from './repo-analyzer';

/* ------------------------------------------------------------------ */
/*  Public API                                                          */
/* ------------------------------------------------------------------ */

/**
 * Generate files that match the repo's detected structure.
 *
 * Returns `null` when the mode is 'pom' — the caller should use the
 * existing POM generation path instead.
 */
export function adaptiveGenerateFiles(
  testPlan: TestPlan,
  config: GenerationConfig,
  analysis: RepoStructureAnalysis,
): GeneratedFile[] | null {
  if (analysis.mode === 'pom') {
    // Let the existing engine handle POM repos
    return null;
  }

  // Flat or hybrid → generate flat spec files
  return generateFlatFiles(testPlan, config, analysis);
}

/* ------------------------------------------------------------------ */
/*  Flat-Scripts Generator                                              */
/* ------------------------------------------------------------------ */

function generateFlatFiles(
  plan: TestPlan,
  config: GenerationConfig,
  analysis: RepoStructureAnalysis,
): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  let nextNum = analysis.nextFileNumber;

  for (const flow of plan.flows) {
    const fileName = buildFileName(flow, nextNum, analysis.naming);
    const filePath = `${analysis.testDir}/${fileName}`;

    files.push({
      path: filePath,
      content: generateFlatSpec(flow, plan, config, analysis),
      type: 'test',
    });

    if (analysis.naming.usesNumberPrefix) nextNum++;
  }

  // Only generate config/utils/CI if the repo doesn't already have them
  if (!analysis.hasPlaywrightConfig) {
    files.push({
      path: 'playwright.config.ts',
      content: generateMinimalConfig(config, analysis),
      type: 'config',
    });
  }

  // Skip utils, fixtures, CI, README if they already exist
  // The user's flat repo typically doesn't want these scaffolded
  if (!analysis.hasUtils && analysis.mode === 'hybrid') {
    files.push({
      path: 'utils/test-helpers.ts',
      content: generateMinimalHelpers(),
      type: 'util',
    });
  }

  return files;
}

/* ------------------------------------------------------------------ */
/*  File Naming                                                         */
/* ------------------------------------------------------------------ */

function buildFileName(
  flow: TestPlanFlow,
  num: number,
  naming: NamingConvention,
): string {
  const desc = flowToDescriptiveName(flow.name, naming);

  if (naming.usesNumberPrefix) {
    const prefix = String(num).padStart(2, '0');
    return `${prefix}${naming.separator}${desc}${naming.extension}`;
  }

  return `${desc}${naming.extension}`;
}

/**
 * Turn a flow name like "Login - Positive Flow" into a file-safe
 * descriptive string using the repo's naming convention.
 */
function flowToDescriptiveName(name: string, naming: NamingConvention): string {
  // Normalise: strip non-alpha, collapse spaces
  const words = name
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.toLowerCase());

  switch (naming.casing) {
    case 'snake_case':
      return words.join('_');
    case 'kebab-case':
      return words.join('-');
    case 'camelCase':
      return words.map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1))).join('');
    case 'PascalCase':
      return words.map(w => w[0].toUpperCase() + w.slice(1)).join('');
    default:
      return words.join('_');
  }
}

/* ------------------------------------------------------------------ */
/*  Flat Spec Content                                                   */
/* ------------------------------------------------------------------ */

function generateFlatSpec(
  flow: TestPlanFlow,
  plan: TestPlan,
  config: GenerationConfig,
  analysis: RepoStructureAnalysis,
): string {
  const q = analysis.quoteStyle === 'double' ? '"' : "'";
  const semi = analysis.semicolons ? ';' : '';

  // Build tags
  const tags = buildTagAnnotation(flow, analysis, q, semi);

  // Build steps
  const stepLines = flow.steps.map((step, i) => {
    const code = stepToCode(step, config, q);
    const wait = step.waitAfter ? `\n    ${step.waitAfter}${semi}` : '';
    const assertions = (step.assertions || []).map(a => `\n    ${a}`).join('');
    return `    // Step ${i + 1}: ${step.description}\n    ${code}${semi ? '' : ''}${wait}${assertions}`;
  }).join('\n\n');

  const describeName = escStr(flow.name, q);
  const testName = escStr(flow.description, q);

  return `import { test, expect } from ${q}@playwright/test${q}${semi}

/**
 * ${flow.name}
 * ${flow.description}
 *
 * Flow Type: ${flow.flowType}
 * Priority: ${flow.priority}
 *
 * Generated by LevelUp AI QA Engine
 * Base URL: ${plan.baseUrl}
 */

test.describe(${q}${describeName}${q}, ${tags}() => {
  test(${q}${testName}${q}, async ({ page }) => {
${stepLines}
  })${semi}
${generateNegativeTests(flow, config, analysis, q, semi)}})${semi}
`;
}

function buildTagAnnotation(
  flow: TestPlanFlow,
  analysis: RepoStructureAnalysis,
  q: string,
  semi: string,
): string {
  if (!flow.tags || flow.tags.length === 0) return '';

  // Match the repo's tag style
  const tagPrefix = analysis.tagPattern?.startsWith('@') ? '@' : '@';
  const tagList = flow.tags.map(t => {
    const cleaned = t.startsWith('@') ? t : `${tagPrefix}${t}`;
    return `${q}${cleaned}${q}`;
  });

  return `{ tag: [${tagList.join(', ')}] }, `;
}

function generateNegativeTests(
  flow: TestPlanFlow,
  config: GenerationConfig,
  analysis: RepoStructureAnalysis,
  q: string,
  semi: string,
): string {
  if (!config.includeNegativeTests) return '';
  if (flow.flowType !== 'authentication') return '';

  const url = config.url;

  return `
  test(${q}should show error with invalid credentials${q}, async ({ page }) => {
    await page.goto(${q}${url}${q})${semi}
    await page.waitForLoadState(${q}domcontentloaded${q})${semi}

    // Fill with invalid credentials
    const usernameField = page.locator(${q}input[type="text"], input[type="email"], input[name*="user" i], input[name*="email" i]${q}).first()${semi}
    const passwordField = page.locator(${q}input[type="password"]${q}).first()${semi}
    const submitBtn = page.locator(${q}button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Sign")${q}).first()${semi}

    await usernameField.fill(${q}invalid_user${q})${semi}
    await passwordField.fill(${q}wrong_password${q})${semi}
    await submitBtn.click()${semi}

    // Should show error and stay on login page
    await expect(page.locator(${q}.error, .alert-danger, [role="alert"], .oxd-alert, .invalid-feedback${q}).first()).toBeVisible({ timeout: 5000 })${semi}
  })${semi}

`;
}

/* ------------------------------------------------------------------ */
/*  Step → Code  (standalone, matches engine's private stepToCode)      */
/* ------------------------------------------------------------------ */

function stepToCode(step: TestPlanStep, config: GenerationConfig, q: string): string {
  const selector = step.selector || (step.target ? targetToPlaywright(step.target) : '');

  switch (step.action) {
    case 'navigate': {
      const url = step.target || config.url || '';
      return `await page.goto(${q}${url}${q});\n    await page.waitForLoadState(${q}domcontentloaded${q})`;
    }
    case 'fill': {
      const val = step.value || '';
      // For flat repos with inline cred style, use hardcoded values from config
      if (val.includes('{{USERNAME}}') && config.credentials?.username) {
        return `await ${selector}.fill(${q}${escStr(config.credentials.username, q)}${q})`;
      }
      if (val.includes('{{PASSWORD}}') && config.credentials?.password) {
        return `await ${selector}.fill(${q}${escStr(config.credentials.password, q)}${q})`;
      }
      // Replace remaining templates with literal values
      const resolved = val
        .replace('{{USERNAME}}', config.credentials?.username || 'Admin')
        .replace('{{PASSWORD}}', config.credentials?.password || 'admin123')
        .replace(/\{\{(\w+)\}\}/g, (_, key) => key);
      return `await ${selector}.fill(${q}${escStr(resolved, q)}${q})`;
    }
    case 'click':
      return `await ${selector}.click()`;
    case 'select':
      return `await ${selector}.selectOption(${q}${escStr(step.value || '', q)}${q})`;
    case 'hover':
      return `await ${selector}.hover()`;
    case 'press':
      return `await page.keyboard.press(${q}${step.value || 'Enter'}${q})`;
    case 'assert':
      return `// Assert: ${step.description}`;
    case 'wait':
      return `await page.waitForLoadState(${q}networkidle${q}).catch(() => {})`;
    case 'screenshot':
      return `await page.screenshot({ path: ${q}screenshots/${toKebab(step.description || 'step')}.png${q} })`;
    default:
      return `// ${step.action}: ${step.description}`;
  }
}

/**
 * Convert a human-readable target description into a Playwright locator.
 * Mirrors the engine's `targetToPlaywright`.
 */
function targetToPlaywright(target: string): string {
  const t = target.toLowerCase();

  if (t.includes('button')) {
    const label = target.replace(/button/i, '').trim();
    return label
      ? `page.getByRole('button', { name: '${label}' })`
      : `page.locator('button').first()`;
  }
  if (t.includes('link')) {
    const label = target.replace(/link/i, '').trim();
    return label
      ? `page.getByRole('link', { name: '${label}' })`
      : `page.locator('a').first()`;
  }
  if (t.includes('input') || t.includes('field') || t.includes('text')) {
    const label = target.replace(/input|field|text/gi, '').trim();
    return label
      ? `page.getByLabel('${label}')`
      : `page.locator('input').first()`;
  }
  if (t.includes('checkbox')) return `page.getByRole('checkbox')`;
  if (t.includes('radio')) return `page.getByRole('radio')`;
  if (t.includes('select') || t.includes('dropdown')) return `page.locator('select').first()`;
  if (t.includes('heading') || t.includes('title')) {
    return `page.getByRole('heading', { name: '${target}' })`;
  }

  return `page.locator('${target}')`;
}

/* ------------------------------------------------------------------ */
/*  Minimal Config (respects repo that already has one)                 */
/* ------------------------------------------------------------------ */

function generateMinimalConfig(config: GenerationConfig, analysis: RepoStructureAnalysis): string {
  const q = analysis.quoteStyle === 'double' ? '"' : "'";
  const semi = analysis.semicolons ? ';' : '';

  return `import { defineConfig, devices } from ${q}@playwright/test${q}${semi}

export default defineConfig({
  testDir: ${q}./${analysis.testDir}${q},
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: ${q}html${q},
  use: {
    baseURL: ${q}${config.url}${q},
    trace: ${q}on-first-retry${q},
  },
  projects: [
    {
      name: ${q}chromium${q},
      use: { ...devices[${q}Desktop Chrome${q}] },
    },
  ],
})${semi}
`;
}

function generateMinimalHelpers(): string {
  return `import { type Page, expect } from '@playwright/test';

/**
 * Wait for page to finish loading
 */
export async function waitForPageLoad(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
}

/**
 * Take a named screenshot
 */
export async function takeScreenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: \`screenshots/\${name}.png\` });
}
`;
}

/* ------------------------------------------------------------------ */
/*  Utilities                                                           */
/* ------------------------------------------------------------------ */

function toKebab(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .toLowerCase()
    .replace(/^-|-$/g, '');
}

function escStr(s: string, q: string): string {
  const esc = q === '"' ? '"' : "'";
  return s.replace(new RegExp(esc, 'g'), `\\${esc}`).replace(/\n/g, '\\n');
}
