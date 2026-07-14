/**
 * Repository Intelligence Auditor — deterministic, LLM-free.
 *
 * This is the Sprint-A *diagnostic gate*. It answers four plain questions with
 * EVIDENCE (not assumptions, not a score):
 *
 *   Q1  Did the Repository Profile load?                       → boolean
 *   Q2  Did it reach the Prompt Builder?                       → boolean
 *   Q3  Was it actually included in the LLM prompt?            → the exact
 *       prompt section + which asset categories it contained.
 *   Q4  Did the generated script follow it?                    → a per-asset
 *       checklist (Framework / Environment / Logger / Wait Strategy /
 *       Test Data / Page Objects / Completeness), each PASS | FAIL | N/A with
 *       the concrete Expected vs Actual evidence.
 *
 * Deliberately NOT here (per product direction):
 *   • No reuse *score* / percentage. A "54%" hides which of the four questions
 *     actually failed; the checklist names the exact asset instead.
 *   • No hard-fail gate. The auditor observes and reports; it never throws and
 *     never blocks generation. (A scoring/gating layer becomes meaningful only
 *     once Coverage Intelligence exists and can weight multiple reuse axes.)
 *
 * Design constraints:
 *   • CONSUMES the existing RepositoryProfile from RepositoryContextEngine.
 *     No new scanner, no parallel engine.
 *   • Conservative: only reports FAIL when the repo demonstrably offers a native
 *     alternative that the generated code ignored. Prefer N/A over a false FAIL.
 *     Never fabricates an expectation it cannot prove from the profile.
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

export type AuditStatus = 'PASS' | 'FAIL' | 'NOT_APPLICABLE';

export type AuditAsset =
  | 'Framework'
  | 'Environment'
  | 'Logger'
  | 'Wait Strategy'
  | 'Test Data'
  | 'Page Objects'
  | 'Completeness';

/** A single row of the "Did the generated script follow it?" checklist. */
export interface AssetAudit {
  asset: AuditAsset;
  status: AuditStatus;
  /** What the repository profile said the code SHOULD use. */
  expected: string;
  /** What the generated code actually did. */
  actual: string;
  /** Optional clarifying note (e.g. why a check was conservative). */
  detail?: string;
  /** Files (+ occurrence counts) that drove the status. */
  evidence: Array<{ file: string; occurrences: number }>;
}

/** Q3 — proof the profile was actually included in the LLM prompt. */
export interface PromptInclusionAudit {
  /** True when a non-empty repo prompt section was assembled. */
  included: boolean;
  /** Asset categories detected inside the prompt section. */
  detectedSections: string[];
  /** The EXACT text injected into the prompt (verbatim), or null. */
  promptSection: string | null;
}

/** The full Repository Intelligence Audit (Q1–Q4). */
export interface RepositoryIntelligenceAudit {
  profileLoaded: boolean;        // Q1
  reachedPromptBuilder: boolean; // Q2
  promptInclusion: PromptInclusionAudit; // Q3
  checklist: AssetAudit[];       // Q4
  filesAudited: number;
}

/** Compact snapshot of what the profile loaded — Step 1 debug + panel. */
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
  /** True when every "critical asset" bucket is non-empty. */
  looksComplete: boolean;
}

/* ------------------------------------------------------------------ */
/*  Step 1 — profile summary (debug log + panel)                       */
/* ------------------------------------------------------------------ */

export interface ProfileSummaryMeta {
  repositoryId?: string | number | null;
  profileVersion?: number | null;
  scannedAt?: string | null;
}

/**
 * Build the structured "Repository Profile Loaded" summary (Q1 evidence). Pure,
 * no logging — the caller decides whether to log it, dump it into the
 * prompt-builder trace, or feed it to the developer debug panel.
 */
export function summarizeProfileForDebug(
  profile: RepositoryProfile,
  meta: ProfileSummaryMeta = {},
): RepositoryProfileDebugSummary {
  const pageObjects = (profile.pageObjects ?? []).map((p) => p.name);
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

/** Render the debug summary as a human-readable block (Step 1 / Step 2 log). */
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
  lines.push(
    `  Fixtures         : ${summary.hasCustomFixtures ? summary.fixtures.join(', ') || 'yes' : 'no'}`,
  );
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/*  Q3 — prompt inclusion                                              */
/* ------------------------------------------------------------------ */

/**
 * Inspect the repo prompt section that was (or would be) injected into the LLM
 * prompt and report which asset categories it actually contains. `promptSection`
 * is the verbatim string the engine concatenates into the prompt — passing it
 * here is what makes Q3 evidence-based rather than assumed.
 */
export function auditPromptInclusion(
  promptSection: string | null | undefined,
): PromptInclusionAudit {
  const section = (promptSection ?? '').trim();
  if (!section) {
    return { included: false, detectedSections: [], promptSection: null };
  }
  const probes: Array<{ label: string; re: RegExp }> = [
    { label: 'Framework', re: /framework\s*:/i },
    { label: 'Page Objects', re: /page objects?/i },
    { label: 'Helpers', re: /helpers?|reuse existing project code/i },
    { label: 'Test Data', re: /test data|data access|datasets?/i },
    { label: 'Wait Strategy', re: /synchroni[sz]ation|wait/i },
    { label: 'Logger', re: /logging|logger/i },
    { label: 'Locators', re: /locators?/i },
  ];
  const detectedSections = probes.filter((p) => p.re.test(section)).map((p) => p.label);
  return { included: true, detectedSections, promptSection: section };
}

/* ------------------------------------------------------------------ */
/*  Q4 — did the generated script follow the profile?                  */
/* ------------------------------------------------------------------ */

export interface AuditOptions {
  /** Only audit files matching this predicate (default: specs + data modules). */
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

const isSpec = (path: string) => /\.(spec|test)\.[cm]?[jt]sx?$/.test(path);

/**
 * Produce the per-asset checklist (Q4). One row per asset, aggregated across all
 * generated files. No score, no gate — just PASS | FAIL | N/A with evidence.
 */
export function auditGeneratedScripts(
  profile: RepositoryProfile,
  files: GeneratedFileInput[],
  opts: AuditOptions = {},
): { checklist: AssetAudit[]; filesAudited: number } {
  const include = opts.includeFile ?? isSpecOrDataFile;
  const audited = files.filter((f) => include(f.path));
  const specs = audited.filter((f) => isSpec(f.path));

  // Pre-strip comments once per file.
  const clean = new Map<string, string>();
  for (const f of audited) clean.set(f.path, stripComments(f.content));

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

  // Wait wrapper: we can only claim a repo wait helper if the profile actually
  // surfaces one (function named like a wait). We do NOT fabricate a method we
  // cannot see. (Repos that export waits as a const object are not currently
  // captured as helpers — that is a scanner gap, reported, not guessed here.)
  const waitHelpers = (profile.helperFunctions ?? []).filter((h) =>
    /wait|sync|settle|ready|load/i.test(h.name),
  );
  const waitStyle = profile.codingStyle?.waitStyle ?? 'none';

  const pageObjectNames = (profile.pageObjects ?? []).map((p) => p.name);
  const hasPageObjects = pageObjectNames.length > 0;

  const checklist: AssetAudit[] = [];
  const countMatches = (re: RegExp, code: string) => (code.match(re) ?? []).length;

  /* ---- Framework ---- */
  {
    const expected = profile.framework || '(unknown)';
    if (!specs.length) {
      checklist.push({
        asset: 'Framework', status: 'NOT_APPLICABLE',
        expected, actual: 'no spec files generated', evidence: [],
      });
    } else {
      const wantPw = /playwright/i.test(expected);
      const evidence = specs
        .filter((f) => /@playwright\/test/.test(clean.get(f.path)!))
        .map((f) => ({ file: f.path, occurrences: 1 }));
      const followed = wantPw ? evidence.length === specs.length : true;
      checklist.push({
        asset: 'Framework',
        status: followed ? 'PASS' : 'FAIL',
        expected,
        actual: evidence.length
          ? `imports @playwright/test in ${evidence.length}/${specs.length} spec(s)`
          : 'no @playwright/test import found',
        evidence,
      });
    }
  }

  /* ---- Environment (base URL / config module) ---- */
  {
    if (!hasBaseUrlConfig) {
      checklist.push({
        asset: 'Environment', status: 'NOT_APPLICABLE',
        expected: 'no env/config module in profile',
        actual: 'n/a', evidence: [],
      });
    } else {
      const expected = profile.environment?.configModule ?? `env (${envVars.join(', ')})`;
      const evidence: AssetAudit['evidence'] = [];
      const urls = new Set<string>();
      for (const f of specs) {
        const code = clean.get(f.path)!;
        const found = [...code.matchAll(/\.goto\(\s*["'`](https?:\/\/[^"'`]+)["'`]/g)];
        if (found.length) {
          evidence.push({ file: f.path, occurrences: found.length });
          found.forEach((m) => urls.add(m[1]));
        }
      }
      const failed = evidence.length > 0;
      checklist.push({
        asset: 'Environment',
        status: failed ? 'FAIL' : 'PASS',
        expected,
        actual: failed
          ? `hardcoded URL(s): ${[...urls].slice(0, 3).join(', ')}${urls.size > 3 ? ' …' : ''}`
          : 'no hardcoded URL in page.goto()',
        evidence,
      });
    }
  }

  /* ---- Logger ---- */
  {
    if (!usesLogger) {
      checklist.push({
        asset: 'Logger', status: 'NOT_APPLICABLE',
        expected: 'repo does not use a dedicated logger',
        actual: 'n/a', evidence: [],
      });
    } else {
      const evidence: AssetAudit['evidence'] = [];
      for (const f of specs) {
        const code = clean.get(f.path)!;
        const consoleCount = countMatches(/console\.(log|info|warn|error)\(/g, code);
        const usesRepoLogger = /\blogger\s*\./.test(code) || /\btest\.step\(/.test(code);
        if (consoleCount && !usesRepoLogger) {
          evidence.push({ file: f.path, occurrences: consoleCount });
        }
      }
      const failed = evidence.length > 0;
      checklist.push({
        asset: 'Logger',
        status: failed ? 'FAIL' : 'PASS',
        expected: 'logger.* (repo logging convention)',
        actual: failed ? 'console.* used instead of the repo logger' : 'repo logger / no stray console.*',
        evidence,
      });
    }
  }

  /* ---- Wait Strategy ---- */
  {
    const applicable = waitStyle !== 'none' || !!profile.codingStyle?.usesFixedTimeouts;
    if (!applicable) {
      checklist.push({
        asset: 'Wait Strategy', status: 'NOT_APPLICABLE',
        expected: 'no wait convention detected', actual: 'n/a', evidence: [],
      });
    } else {
      const sleepEvidence: AssetAudit['evidence'] = [];
      const loadStateEvidence: AssetAudit['evidence'] = [];
      for (const f of specs) {
        const code = clean.get(f.path)!;
        const sleeps = countMatches(/\.waitForTimeout\(/g, code);
        const loadStates = countMatches(/\.waitForLoadState\(/g, code);
        if (sleeps) sleepEvidence.push({ file: f.path, occurrences: sleeps });
        if (loadStates) loadStateEvidence.push({ file: f.path, occurrences: loadStates });
      }
      const waitHelperName = waitHelpers[0]?.name;
      // Hard sleeps are always a FAIL (anti-pattern). Raw waitForLoadState is a
      // FAIL only when the repo demonstrably exposes a wait helper to use.
      if (sleepEvidence.length) {
        checklist.push({
          asset: 'Wait Strategy', status: 'FAIL',
          expected: waitHelperName ? `${waitHelperName}(...)` : `repo style: ${waitStyle} (no hard sleeps)`,
          actual: 'page.waitForTimeout() hard sleep',
          evidence: sleepEvidence,
        });
      } else if (waitHelperName && loadStateEvidence.length) {
        checklist.push({
          asset: 'Wait Strategy', status: 'FAIL',
          expected: `${waitHelperName}(...)`,
          actual: 'raw page.waitForLoadState() instead of the repo wait helper',
          evidence: loadStateEvidence,
        });
      } else {
        checklist.push({
          asset: 'Wait Strategy', status: 'PASS',
          expected: waitHelperName ? `${waitHelperName}(...)` : `repo style: ${waitStyle}`,
          actual: loadStateEvidence.length
            ? 'web-first / load-state waits, no hard sleeps'
            : 'no hard sleeps',
          detail:
            !waitHelperName && loadStateEvidence.length
              ? 'Repo wait utility not surfaced by the scanner (const-object export); ' +
                'raw waitForLoadState treated as acceptable rather than fabricating an expected method.'
              : undefined,
          evidence: loadStateEvidence,
        });
      }
    }
  }

  /* ---- Test Data ---- */
  {
    if (!hasDataHelper) {
      checklist.push({
        asset: 'Test Data', status: 'NOT_APPLICABLE',
        expected: 'no repo data helpers in profile', actual: 'n/a', evidence: [],
      });
    } else {
      const nativeIsGeneratedData = nativeDataModulePaths.some((p) => /data[\\/]test-data/.test(p));
      const importRe = new RegExp(
        `import\\s*\\{[^}]*\\b(?:${dataHelperNames.join('|')})\\b[^}]*\\}\\s*from\\s*["'\`][^"'\`]*data/test-data["'\`]`,
      );
      const evidence: AssetAudit['evidence'] = [];
      // (i) specs importing from the generated parallel data module
      for (const f of specs) {
        if (!nativeIsGeneratedData && importRe.test(clean.get(f.path)!)) {
          evidence.push({ file: f.path, occurrences: 1 });
        }
      }
      // (ii) a generated data module that redefines the repo's helper
      for (const f of audited) {
        const code = clean.get(f.path)!;
        const isGenDataModule =
          /test-data\.[cm]?[jt]s$/.test(f.path) || /(^|[\\/])data[\\/]/.test(f.path);
        const redefines = dataHelperNames.some((n) =>
          new RegExp(`export\\s+(?:async\\s+)?function\\s+${n}\\b`).test(code) ||
          new RegExp(`export\\s+const\\s+${n}\\b`).test(code),
        );
        if (isGenDataModule && redefines && !nativeIsGeneratedData) {
          evidence.push({ file: f.path, occurrences: 1 });
        }
      }
      const failed = evidence.length > 0;
      checklist.push({
        asset: 'Test Data',
        status: failed ? 'FAIL' : 'PASS',
        expected: `${nativeDataModulePaths[0] ?? 'repo data module'} (${dataHelperNames.join(', ')})`,
        actual: failed
          ? 'generated parallel data/test-data module (duplicate data layer)'
          : 'binds to the repository data module',
        evidence,
      });
    }
  }

  /* ---- Page Objects ---- */
  {
    if (!hasPageObjects) {
      checklist.push({
        asset: 'Page Objects', status: 'NOT_APPLICABLE',
        expected: 'no page objects in profile', actual: 'n/a', evidence: [],
      });
    } else {
      const evidence: AssetAudit['evidence'] = [];
      for (const f of specs) {
        const code = clean.get(f.path)!;
        const rawActions = countMatches(
          /page\.locator\([^)]*\)\.(click|fill|type|check|selectOption)\(/g, code,
        );
        const usesAnyPO = pageObjectNames.some((n) => new RegExp(`new\\s+${n}\\b`).test(code));
        if (rawActions && !usesAnyPO) {
          evidence.push({ file: f.path, occurrences: rawActions });
        }
      }
      const failed = evidence.length > 0;
      checklist.push({
        asset: 'Page Objects',
        status: failed ? 'FAIL' : 'PASS',
        expected: pageObjectNames.join(', '),
        actual: failed
          ? 'raw page.locator().action() with no page object instantiated'
          : 'instantiates & calls repository page objects',
        evidence,
      });
    }
  }

  /* ---- Completeness (half-generated specs) ---- */
  {
    const evidence: AssetAudit['evidence'] = [];
    for (const f of specs) {
      const n = countMatches(/throw new Error\(\s*["'`]Unsupported step/g, f.content);
      if (n) evidence.push({ file: f.path, occurrences: n });
    }
    const failed = evidence.length > 0;
    checklist.push({
      asset: 'Completeness',
      status: specs.length ? (failed ? 'FAIL' : 'PASS') : 'NOT_APPLICABLE',
      expected: 'every test is complete & runnable',
      actual: failed
        ? 'ships half-generated tests that throw "Unsupported step"'
        : 'no half-generated tests',
      evidence,
    });
  }

  return { checklist, filesAudited: audited.length };
}

/**
 * Assemble the full Repository Intelligence Audit (Q1–Q4). `promptSection` is
 * the verbatim repo block the engine injected into the LLM prompt (or null when
 * none was built); passing it makes Q2/Q3 evidence-based.
 */
export function auditRepositoryIntelligence(args: {
  profile: RepositoryProfile | null;
  files: GeneratedFileInput[];
  promptSection?: string | null;
  reachedPromptBuilder?: boolean;
  options?: AuditOptions;
}): RepositoryIntelligenceAudit {
  const { profile, files, promptSection, reachedPromptBuilder, options } = args;
  const promptInclusion = auditPromptInclusion(promptSection);
  if (!profile) {
    return {
      profileLoaded: false,
      reachedPromptBuilder: !!reachedPromptBuilder,
      promptInclusion,
      checklist: [],
      filesAudited: 0,
    };
  }
  const { checklist, filesAudited } = auditGeneratedScripts(profile, files, options);
  return {
    profileLoaded: true,
    reachedPromptBuilder: reachedPromptBuilder ?? promptInclusion.included,
    promptInclusion,
    checklist,
    filesAudited,
  };
}

/* ------------------------------------------------------------------ */
/*  Human-readable formatter                                           */
/* ------------------------------------------------------------------ */

const STATUS_MARK: Record<AuditStatus, string> = {
  PASS: '✓ PASS',
  FAIL: '✗ FAIL',
  NOT_APPLICABLE: '– N/A',
};

/** Render the audit as the developer-facing "Repository Intelligence Audit". */
export function formatAudit(audit: RepositoryIntelligenceAudit): string {
  const lines: string[] = [];
  lines.push('Repository Intelligence Audit');
  lines.push(`  Q1 Profile loaded          : ${audit.profileLoaded ? 'YES' : 'NO'}`);
  lines.push(`  Q2 Reached Prompt Builder  : ${audit.reachedPromptBuilder ? 'YES' : 'NO'}`);
  lines.push(
    `  Q3 Included in LLM prompt  : ${audit.promptInclusion.included ? 'YES' : 'NO'}` +
      (audit.promptInclusion.included
        ? ` [${audit.promptInclusion.detectedSections.join(', ')}]`
        : ''),
  );
  lines.push('  Q4 Generated script followed it:');
  const pad = (s: string, n: number) => (s + ' '.repeat(n)).slice(0, n);
  for (const c of audit.checklist) {
    lines.push(
      `     ${pad(c.asset, 16)} ${pad(STATUS_MARK[c.status], 8)}` +
        (c.status === 'FAIL'
          ? `  expected: ${c.expected}  |  actual: ${c.actual}`
          : c.status === 'PASS'
          ? `  (${c.actual})`
          : ''),
    );
  }
  return lines.join('\n');
}
