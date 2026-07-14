/**
 * Repository Reuse Verifier — deterministic, LLM-free post-generation audit.
 *
 * This module answers the Sprint-A "gate" question with EVIDENCE, not
 * assumptions: *given* a scanned {@link RepositoryProfile}, did the generated
 * scripts actually honour the repository's own conventions and reusable assets,
 * or did Script Gen silently fall back to generic, hardcoded code?
 *
 * It implements four observable steps:
 *   Step 1  summarizeProfileForDebug()  → structured "Repository Profile Loaded"
 *           snapshot (also powers the developer Repository Intelligence panel).
 *   Step 2  the same summary is what a caller dumps as "Profile → Prompt Builder"
 *           so a human can confirm LoginPage.login(), getUser(), logger, env,
 *           waits and fixtures are present BEFORE prompt creation.
 *   Step 3  verifyRepoReuse()           → deterministic audit of the generated
 *           files, listing every concrete reuse violation.
 *   Step 4  the returned { score, passed } lets the pipeline FAIL a low-reuse
 *           generation instead of shipping poor scripts.
 *
 * Design constraints (explicit, from the product owner):
 *   • Do NOT build a new scanner or parallel engine. This module CONSUMES the
 *     existing RepositoryProfile produced by RepositoryContextEngine.
 *   • Be conservative: only flag a violation when the repo demonstrably offers a
 *     native alternative. Prefer WARNING over a false FAIL. Never invent
 *     intelligence — every violation cites the concrete evidence that triggered
 *     it.
 */

import type { RepositoryProfile } from '../context/types';

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/** One generated file to audit. Matches script-gen's GeneratedFile shape. */
export interface GeneratedFileInput {
  path: string;
  content: string;
}

export type ReuseSeverity = 'critical' | 'high' | 'medium' | 'warning';

/** Stable identifiers for each reuse rule, so callers can filter/aggregate. */
export type ReuseRuleId =
  | 'half-generated-throw'
  | 'hardcoded-url'
  | 'parallel-test-data-module'
  | 'test-data-helper-bypassed'
  | 'logger-bypassed'
  | 'hard-sleep'
  | 'raw-wait-vs-repo-util'
  | 'page-object-bypassed';

export interface ReuseViolation {
  ruleId: ReuseRuleId;
  severity: ReuseSeverity;
  /** Human-readable, evidence-first description. */
  message: string;
  /** File the violation was found in (relative path as generated). */
  file?: string;
  /** What the repository profile said the code SHOULD use. */
  expected?: string;
  /** What the generated code actually did. */
  actual?: string;
  /** Number of occurrences across the audited files (deduped per file+line). */
  occurrences: number;
}

/** Per-category roll-up so the debug panel can show pass/fail at a glance. */
export interface ReuseCheckResult {
  ruleId: ReuseRuleId;
  /** True when the check was applicable (repo offered a native alternative). */
  applicable: boolean;
  /** True when applicable AND no violation was found. */
  passed: boolean;
  violationCount: number;
}

export interface ReuseVerificationReport {
  /** 0–100. 100 = perfect reuse of everything the repo offers. */
  score: number;
  /** Minimum score required to pass (default {@link DEFAULT_REUSE_THRESHOLD}). */
  threshold: number;
  /** score >= threshold AND no critical violation. */
  passed: boolean;
  violations: ReuseViolation[];
  checks: ReuseCheckResult[];
  filesAudited: number;
  /** One-line verdict suitable for logs, e.g. "Repository Reuse Score 54% FAILED". */
  verdict: string;
}

/** Compact snapshot of what the profile loaded — Step 1/2 + debug panel. */
export interface RepositoryProfileDebugSummary {
  repositoryId: string | number | null;
  profileVersion: number | null;
  scannedAt: string | null;
  framework: string;
  language: string;
  pageObjects: string[];
  utilities: string[];
  businessFlows: number;
  testSuites: number;
  codingStyle: {
    loggingStyle: string;
    waitStyle: string;
    usesFixedTimeouts: boolean;
    namingConvention: string;
    quoteStyle: string;
    semicolons: boolean;
  };
  hasCustomFixtures: boolean;
  fixtures: string[];
  envConfigModule: string | null;
  envVars: string[];
  testDataHelpers: string[];
  dataFiles: string[];
  /** True when every "critical asset" bucket is non-empty — used by the panel. */
  looksComplete: boolean;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** Default pass mark for the reuse score. */
export const DEFAULT_REUSE_THRESHOLD = 80;

/** Weighted deduction per severity (points off the 100 baseline). */
const SEVERITY_WEIGHT: Record<ReuseSeverity, number> = {
  critical: 40,
  high: 15,
  medium: 8,
  warning: 0,
};

/* ------------------------------------------------------------------ */
/*  Step 1 / Step 2 — profile summary                                 */
/* ------------------------------------------------------------------ */

export interface ProfileSummaryMeta {
  repositoryId?: string | number | null;
  profileVersion?: number | null;
  scannedAt?: string | null;
}

/**
 * Build the structured "Repository Profile Loaded" summary. Pure, no logging —
 * the caller decides whether to log it (Step 1), dump it into the prompt-builder
 * trace (Step 2), or feed it to the developer debug panel (Step 6).
 */
export function summarizeProfileForDebug(
  profile: RepositoryProfile,
  meta: ProfileSummaryMeta = {},
): RepositoryProfileDebugSummary {
  const pageObjects = (profile.pageObjects ?? []).map((p) => p.name);
  // "Utilities" = helper functions + fixtures + custom commands, by name.
  const utilities = Array.from(
    new Set([
      ...(profile.helperFunctions ?? []).map((h) => h.name),
      ...(profile.customCommands ?? []).map((c) => c.name),
    ]),
  );
  const fixtures = (profile.fixtures ?? []).map((f) => f.name);
  const testDataHelpers = (profile.helperFunctions ?? [])
    .filter((h) => /record|user|data|fixture|seed|factory/i.test(h.name))
    .map((h) => h.name);
  const dataFiles = (profile.dataFiles ?? []).map((d) => d.path || d.name);

  const looksComplete =
    pageObjects.length > 0 &&
    utilities.length > 0 &&
    (profile.businessFlows ?? []).length > 0 &&
    (profile.testSuites ?? []).length > 0;

  return {
    repositoryId: meta.repositoryId ?? null,
    profileVersion: meta.profileVersion ?? null,
    scannedAt: meta.scannedAt ?? null,
    framework: profile.framework,
    language: profile.language,
    pageObjects,
    utilities,
    businessFlows: (profile.businessFlows ?? []).length,
    testSuites: (profile.testSuites ?? []).length,
    codingStyle: {
      loggingStyle: profile.codingStyle?.loggingStyle ?? 'none',
      waitStyle: profile.codingStyle?.waitStyle ?? 'none',
      usesFixedTimeouts: !!profile.codingStyle?.usesFixedTimeouts,
      namingConvention: profile.codingStyle?.namingConvention ?? 'mixed',
      quoteStyle: profile.codingStyle?.quoteStyle ?? 'mixed',
      semicolons: !!profile.codingStyle?.semicolons,
    },
    hasCustomFixtures: !!profile.hasCustomFixtures,
    fixtures,
    envConfigModule: profile.environment?.configModule ?? null,
    envVars: profile.environment?.envVars ?? [],
    testDataHelpers,
    dataFiles,
    looksComplete,
  };
}

/**
 * Render the debug summary as a human-readable multi-line block. Used for the
 * Step 1 "Repository Profile Loaded" log and the Step 2 prompt-builder dump.
 */
export function formatProfileSummary(summary: RepositoryProfileDebugSummary): string {
  const lines: string[] = [];
  lines.push('Repository Profile Loaded');
  lines.push(`  Repository Id    : ${summary.repositoryId ?? '(unknown)'}`);
  lines.push(`  Profile Version  : ${summary.profileVersion ?? '(unknown)'}`);
  lines.push(`  Scan Timestamp   : ${summary.scannedAt ?? '(unknown)'}`);
  lines.push(`  Framework        : ${summary.framework} / ${summary.language}`);
  lines.push(
    `  Page Objects     : ${summary.pageObjects.length}` +
      (summary.pageObjects.length ? ` [${summary.pageObjects.join(', ')}]` : ''),
  );
  lines.push(
    `  Utilities        : ${summary.utilities.length}` +
      (summary.utilities.length ? ` [${summary.utilities.join(', ')}]` : ''),
  );
  lines.push(`  Business Flows   : ${summary.businessFlows}`);
  lines.push(`  Test Suites      : ${summary.testSuites}`);
  lines.push(
    `  Coding Style     : logging=${summary.codingStyle.loggingStyle}, ` +
      `wait=${summary.codingStyle.waitStyle}, ` +
      `fixedTimeouts=${summary.codingStyle.usesFixedTimeouts}`,
  );
  lines.push(`  Env Config       : ${summary.envConfigModule ?? '(none)'}`);
  lines.push(
    `  Env Vars         : ${summary.envVars.length ? summary.envVars.join(', ') : '(none)'}`,
  );
  lines.push(
    `  Test Data Helpers: ${
      summary.testDataHelpers.length ? summary.testDataHelpers.join(', ') : '(none)'
    }`,
  );
  lines.push(`  Fixtures         : ${summary.hasCustomFixtures ? summary.fixtures.join(', ') || 'yes' : 'no'}`);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Step 3 — deterministic reuse audit                                */
/* ------------------------------------------------------------------ */

export interface VerifyOptions {
  /** Pass mark; defaults to {@link DEFAULT_REUSE_THRESHOLD}. */
  threshold?: number;
  /**
   * Only audit files whose path matches this predicate (default: *.spec.* and
   * *.test.* plus any generated data module). Keeps config/README noise out.
   */
  includeFile?: (path: string) => boolean;
}

/** Strip line/block comments so string matches don't fire inside comments. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function isSpecOrDataFile(path: string): boolean {
  return (
    /\.(spec|test)\.[cm]?[jt]sx?$/.test(path) ||
    /(^|[\\/])(data|test-data|fixtures?)[\\/].*\.[cm]?[jt]s$/.test(path) ||
    /test-data\.[cm]?[jt]s$/.test(path)
  );
}

/**
 * Deterministically audit generated files against what the repository profile
 * says is reusable. Returns a scored report with concrete violations.
 */
export function verifyRepoReuse(
  profile: RepositoryProfile,
  files: GeneratedFileInput[],
  opts: VerifyOptions = {},
): ReuseVerificationReport {
  const threshold = opts.threshold ?? DEFAULT_REUSE_THRESHOLD;
  const include = opts.includeFile ?? isSpecOrDataFile;
  const audited = files.filter((f) => include(f.path));

  const violations: ReuseViolation[] = [];

  // ---- capability flags derived from the profile ----
  const envVars = profile.environment?.envVars ?? [];
  const hasBaseUrlConfig =
    !!profile.environment?.configModule ||
    envVars.some((v) => /BASE_?URL|APP_?URL|HOST|ORIGIN/i.test(v));

  const dataHelpers = (profile.helperFunctions ?? []).filter((h) =>
    /record|user|data|fixture|seed|factory/i.test(h.name),
  );
  const dataHelperNames = dataHelpers.map((h) => h.name);
  const nativeDataModulePaths = Array.from(
    new Set(dataHelpers.map((h) => h.filePath).filter(Boolean)),
  );
  const hasDataHelper = dataHelperNames.length > 0;

  const usesLogger = profile.codingStyle?.loggingStyle === 'logger';
  const repoWrapsWaits =
    !profile.codingStyle?.usesFixedTimeouts &&
    ['web-first-assertions', 'locator-waitfor', 'response-wait', 'load-state'].includes(
      profile.codingStyle?.waitStyle ?? 'none',
    );

  const pageObjectNames = new Set((profile.pageObjects ?? []).map((p) => p.name));
  const hasPageObjects = pageObjectNames.size > 0;

  // ---- per-file checks ----
  for (const file of audited) {
    const raw = file.content;
    const code = stripComments(raw);

    // (a) CRITICAL — half-generated spec that throws instead of running.
    const throwMatches = raw.match(/throw new Error\(\s*["'`]Unsupported step/g);
    if (throwMatches && throwMatches.length) {
      violations.push({
        ruleId: 'half-generated-throw',
        severity: 'critical',
        message:
          'Generated spec ships a half-generated test: it throws "Unsupported step" ' +
          'instead of performing the action. A half-generated spec must never be emitted.',
        file: file.path,
        expected: 'A complete, runnable test',
        actual: 'throw new Error("Unsupported step …")',
        occurrences: throwMatches.length,
      });
    }

    // (b) HIGH — hardcoded URL when the repo has an env/config module.
    if (hasBaseUrlConfig) {
      const gotoUrls = [...code.matchAll(/\.goto\(\s*["'`](https?:\/\/[^"'`]+)["'`]/g)];
      if (gotoUrls.length) {
        violations.push({
          ruleId: 'hardcoded-url',
          severity: 'high',
          message:
            `Generated code hardcodes a URL in page.goto() although the repository ` +
            `resolves URLs via ${profile.environment?.configModule ?? 'its env config'}` +
            (envVars.length ? ` (env vars: ${envVars.join(', ')})` : '') +
            '. Use the repo env/config module, not a literal.',
          file: file.path,
          expected: profile.environment?.configModule ?? 'env/config BASE_URL',
          actual: gotoUrls.map((m) => m[1]).join(', '),
          occurrences: gotoUrls.length,
        });
      }
    }

    // (c) HIGH — parallel test-data module that redefines the repo's helper.
    if (hasDataHelper) {
      // A generated data module that re-exports a getRecord/getX helper the repo
      // already provides is a parallel, duplicated data layer.
      const redefinesHelper = dataHelperNames.some((n) =>
        new RegExp(`export\\s+(?:async\\s+)?function\\s+${n}\\b`).test(code) ||
        new RegExp(`export\\s+const\\s+${n}\\b`).test(code),
      );
      const isGeneratedDataModule =
        /test-data\.[cm]?[jt]s$/.test(file.path) || /(^|[\\/])data[\\/]/.test(file.path);
      if (redefinesHelper && isGeneratedDataModule) {
        violations.push({
          ruleId: 'parallel-test-data-module',
          severity: 'high',
          message:
            'A parallel test-data module redefines a data helper the repository ' +
            `already provides (${dataHelperNames.join(', ')}). Reuse the repo helper ` +
            'instead of generating a duplicate data layer.',
          file: file.path,
          expected: `repo helper(s): ${dataHelperNames.join(', ')}`,
          actual: 'generated duplicate data module',
          occurrences: 1,
        });
      }
    }

    // (d) MEDIUM — hard sleeps are an anti-pattern regardless of repo style.
    const hardSleeps = [...code.matchAll(/\.waitForTimeout\(/g)];
    if (hardSleeps.length) {
      violations.push({
        ruleId: 'hard-sleep',
        severity: 'medium',
        message:
          'Generated code uses page.waitForTimeout() (hard sleep) — an anti-pattern. ' +
          'Prefer web-first assertions or the repository wait utilities.',
        file: file.path,
        expected: 'web-first assertions / repo wait utility',
        actual: 'page.waitForTimeout(...)',
        occurrences: hardSleeps.length,
      });
    }

    // Only the audit of spec files (not the data module) applies below checks.
    const isSpec = /\.(spec|test)\.[cm]?[jt]sx?$/.test(file.path);
    if (!isSpec) continue;

    // (e) HIGH — logger convention bypassed.
    if (usesLogger) {
      const consoleLogs = [...code.matchAll(/console\.(log|info|warn|error)\(/g)];
      const usesRepoLogger = /\blogger\s*\./.test(code) || /\btest\.step\(/.test(code);
      if (consoleLogs.length && !usesRepoLogger) {
        violations.push({
          ruleId: 'logger-bypassed',
          severity: 'high',
          message:
            'Generated spec uses console.* although the repository logs via a ' +
            'dedicated logger. Use the repo logger utility.',
          file: file.path,
          expected: 'repo logger utility',
          actual: `console.${consoleLogs[0][1]}(...)`,
          occurrences: consoleLogs.length,
        });
      }
    }

    // (f) test-data helper bypassed: the repo's data helpers live in a real
    //     module (e.g. utils/testData), but the spec imports the SAME helper from
    //     a generated parallel module (data/test-data). The problem is the import
    //     SOURCE, not the function name — the repo may even export getRecord too.
    if (hasDataHelper) {
      const importsFromGeneratedData = new RegExp(
        `import\\s*\\{[^}]*\\b(?:${dataHelperNames.join('|')})\\b[^}]*\\}\\s*from\\s*["'\`][^"'\`]*data/test-data["'\`]`,
      ).test(code);
      const nativeIsGeneratedData = nativeDataModulePaths.some((p) =>
        /data[\\/]test-data/.test(p),
      );
      if (importsFromGeneratedData && !nativeIsGeneratedData) {
        violations.push({
          ruleId: 'test-data-helper-bypassed',
          severity: 'high',
          message:
            'Generated spec imports a data helper from a generated parallel module ' +
            `(data/test-data), but the repository already provides ${dataHelperNames.join(', ')}` +
            (nativeDataModulePaths.length ? ` in ${nativeDataModulePaths.join(', ')}` : '') +
            '. Import from the repository data module, not a duplicate.',
          file: file.path,
          expected:
            (nativeDataModulePaths[0] ?? 'repo data module') +
            ` (${dataHelperNames.join(', ')})`,
          actual: 'import from generated data/test-data',
          occurrences: 1,
        });
      }
    }

    // (g) WARNING — raw waitForLoadState while repo wraps waits. Low-confidence,
    //     so only a warning to avoid false FAILs.
    if (repoWrapsWaits) {
      const rawLoadState = [...code.matchAll(/\.waitForLoadState\(/g)];
      if (rawLoadState.length) {
        violations.push({
          ruleId: 'raw-wait-vs-repo-util',
          severity: 'warning',
          message:
            'Generated spec calls page.waitForLoadState() directly while the ' +
            'repository favours web-first assertions / wait utilities. Consider ' +
            'the repo convention (non-blocking; informational).',
          file: file.path,
          expected: `repo wait style: ${profile.codingStyle?.waitStyle}`,
          actual: 'page.waitForLoadState(...)',
          occurrences: rawLoadState.length,
        });
      }
    }

    // (h) page-object bypass: raw locator actions for a flow the POs cover.
    if (hasPageObjects) {
      const rawActions = [
        ...code.matchAll(/page\.locator\([^)]*\)\.(click|fill|type|check|selectOption)\(/g),
      ];
      const usesAnyPageObject = [...pageObjectNames].some((n) =>
        new RegExp(`new\\s+${n}\\b`).test(code),
      );
      // Only flag when the spec uses NO page object at all yet performs raw
      // actions — a spec that mixes is common and acceptable.
      if (rawActions.length && !usesAnyPageObject) {
        violations.push({
          ruleId: 'page-object-bypassed',
          severity: 'medium',
          message:
            'Generated spec performs raw page.locator().<action>() calls without ' +
            `instantiating any repository page object (${[...pageObjectNames].join(', ')}).`,
          file: file.path,
          expected: `page objects: ${[...pageObjectNames].join(', ')}`,
          actual: 'raw page.locator().action() with no page object',
          occurrences: rawActions.length,
        });
      }
    }
  }

  // ---- roll up per-rule checks ----
  const allRules: Array<{ ruleId: ReuseRuleId; applicable: boolean }> = [
    { ruleId: 'half-generated-throw', applicable: true },
    { ruleId: 'hardcoded-url', applicable: hasBaseUrlConfig },
    { ruleId: 'parallel-test-data-module', applicable: hasDataHelper },
    { ruleId: 'test-data-helper-bypassed', applicable: hasDataHelper },
    { ruleId: 'logger-bypassed', applicable: usesLogger },
    { ruleId: 'hard-sleep', applicable: true },
    { ruleId: 'raw-wait-vs-repo-util', applicable: repoWrapsWaits },
    { ruleId: 'page-object-bypassed', applicable: hasPageObjects },
  ];
  const checks: ReuseCheckResult[] = allRules.map((r) => {
    const count = violations.filter((v) => v.ruleId === r.ruleId).length;
    return {
      ruleId: r.ruleId,
      applicable: r.applicable,
      passed: r.applicable && count === 0,
      violationCount: count,
    };
  });

  // ---- score ----
  const deduction = violations.reduce(
    (sum, v) => sum + SEVERITY_WEIGHT[v.severity],
    0,
  );
  const score = Math.max(0, Math.min(100, 100 - deduction));
  const hasCritical = violations.some((v) => v.severity === 'critical');
  const passed = score >= threshold && !hasCritical;
  const verdict = `Repository Reuse Score ${score}% ${passed ? 'PASSED' : 'FAILED'}`;

  return {
    score,
    threshold,
    passed,
    violations,
    checks,
    filesAudited: audited.length,
    verdict,
  };
}
