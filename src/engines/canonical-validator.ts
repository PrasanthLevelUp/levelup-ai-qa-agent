/**
 * Canonical Validator — the "prove it before the LLM sees it" stage.
 * ============================================================================
 *
 * Pipeline position (the next milestone after Formatter Mode):
 *
 *     … → Scenario Builder → Canonical Test Cases → VALIDATOR → LLM Formatter → …
 *
 * The Scenario Builder assembles complete, grounded canonical test-case objects.
 * Before they are ever handed to the model, the Validator asserts the invariants
 * a senior QA reviewer would check by hand:
 *
 *   • scenarioId present and UNIQUE (no two cases collapse onto one identity)
 *   • coverageType / tags present
 *   • a non-empty expected result
 *   • at least one step, and NO duplicate steps
 *   • every referenced SELECTOR actually exists in the crawled App Profile
 *   • the referenced DATASET actually exists in the retrieved Test Data
 *   • the navigation PAGE/URL actually exists in the App Profile
 *
 * Design discipline (identical to the planner/builder):
 *   • Pure & synchronous — no I/O, no LLM, no randomness.
 *   • FAIL-OPEN and NON-DESTRUCTIVE to coverage — the Validator NEVER drops a
 *     test case (that would reduce coverage, which is forbidden). It REPAIRS
 *     what it safely can (fills an empty expected result from the objective,
 *     removes exact-duplicate steps, de-collides duplicate ids) and otherwise
 *     records a WARNING. Grounding issues (unknown selector/dataset/page) are
 *     warnings, not errors — the requirement/app may legitimately outrun the
 *     crawl. The report is for telemetry + surfacing, not for silent deletion.
 *   • The point is to make the formatter almost impossible to break: by the time
 *     the LLM is called, every object is already internally consistent, so the
 *     only thing the model can affect is the wording.
 */

import type { FormatterTestCase } from './scenario-builder';

/* ------------------------------------------------------------------ */
/*  Loose structural shapes (decoupled from the engine types)          */
/* ------------------------------------------------------------------ */

interface FieldLike { name?: string; selector?: string; label?: string }
interface FormLike { page?: string; fields?: FieldLike[]; submitSelector?: string }
interface ElementLike { selector?: string }
interface PageLike { url?: string }
interface ProfileLike {
  baseUrl?: string; loginUrl?: string;
  pages?: PageLike[]; forms?: FormLike[]; keyElements?: ElementLike[];
}
interface DatasetLike { name?: string }
interface KnowledgeLike { applicationProfile?: ProfileLike; testData?: DatasetLike[]; [k: string]: any }

/* ------------------------------------------------------------------ */
/*  Report types                                                       */
/* ------------------------------------------------------------------ */

export type ValidationSeverity = 'error' | 'warn';

export interface CanonicalValidationIssue {
  scenarioId: string;
  /** The invariant that failed (e.g. "selector", "dataset", "duplicateSteps"). */
  check: string;
  severity: ValidationSeverity;
  message: string;
  /** True when the Validator repaired the case deterministically in place. */
  repaired?: boolean;
}

export interface CanonicalValidationReport {
  /** True when NO error-severity issues remain after repair. */
  ok: boolean;
  checked: number;
  errors: number;
  warnings: number;
  repaired: number;
  issues: CanonicalValidationIssue[];
}

export interface CanonicalValidationResult {
  /** The (possibly repaired) cases — ALWAYS the same COUNT as the input. */
  cases: FormatterTestCase[];
  report: CanonicalValidationReport;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const norm = (s?: string) => (s || '').trim().toLowerCase();

/** All real selectors known to the App Profile (fields, submit, key elements). */
function knownSelectors(k?: KnowledgeLike): Set<string> {
  const out = new Set<string>();
  const ap = k?.applicationProfile;
  if (!ap) return out;
  for (const f of ap.forms || []) {
    if (f.submitSelector) out.add(norm(f.submitSelector));
    for (const fd of f.fields || []) if (fd.selector) out.add(norm(fd.selector));
  }
  for (const e of ap.keyElements || []) if (e.selector) out.add(norm(e.selector));
  return out;
}

/** All real dataset names known to the retrieved Test Data. */
function knownDatasets(k?: KnowledgeLike): Set<string> {
  return new Set((k?.testData || []).map(d => norm(d.name)).filter(Boolean));
}

/** All real page URLs / form pages known to the App Profile (+ base/login url). */
function knownPages(k?: KnowledgeLike): Set<string> {
  const out = new Set<string>();
  const ap = k?.applicationProfile;
  if (!ap) return out;
  if (ap.baseUrl) out.add(norm(ap.baseUrl));
  if (ap.loginUrl) out.add(norm(ap.loginUrl));
  for (const p of ap.pages || []) if (p.url) out.add(norm(p.url));
  for (const f of ap.forms || []) if (f.page) out.add(norm(f.page));
  return out;
}

/** Pull the navigation target out of a "Navigate to X" step, if any. */
function navTargetOf(steps: string[]): string | undefined {
  for (const s of steps) {
    const m = s.match(/navigate to\s+(.+?)\s*$/i);
    if (m) return m[1].trim();
  }
  return undefined;
}

/** Extract the dataset name a testData reference points at ("name (keys: …)"). */
function datasetNameOf(testData?: string): string | undefined {
  if (!testData) return undefined;
  const m = testData.match(/^([^(]+?)(?:\s*\(|$)/);
  const name = m?.[1]?.trim();
  // Skip the "no dedicated dataset" fallback phrasing.
  if (!name || /no dedicated dataset|appropriate to the scenario/i.test(testData)) return undefined;
  return name;
}

/* ------------------------------------------------------------------ */
/*  Validator                                                          */
/* ------------------------------------------------------------------ */

/**
 * Validate + deterministically repair canonical test cases before the LLM call.
 * NEVER changes the case COUNT (coverage is sacred). Returns the repaired cases
 * plus a structured report.
 */
export function validateCanonicalTestCases(
  cases: FormatterTestCase[],
  knowledge?: KnowledgeLike,
): CanonicalValidationResult {
  const issues: CanonicalValidationIssue[] = [];
  const selectors = knownSelectors(knowledge);
  const datasets = knownDatasets(knowledge);
  const pages = knownPages(knowledge);
  const haveProfile = selectors.size > 0 || pages.size > 0;
  const haveData = datasets.size > 0;

  const seenIds = new Map<string, number>();
  let repaired = 0;

  const out = cases.map((original) => {
    // Work on a shallow clone so repairs never mutate the caller's objects.
    const tc: FormatterTestCase = { ...original, steps: original.steps.slice(), tags: original.tags.slice(), selectors: original.selectors.slice() };
    const sid = tc.scenarioId || '(missing)';

    // 1. scenarioId present + unique (de-collide by suffixing, never drop).
    if (!tc.scenarioId) {
      issues.push({ scenarioId: sid, check: 'scenarioId', severity: 'warn', message: 'Missing scenarioId — assigned a synthetic id.', repaired: true });
      tc.scenarioId = `case-${seenIds.size + 1}`;
      repaired++;
    }
    const prior = seenIds.get(tc.scenarioId) ?? 0;
    if (prior > 0) {
      const deduped = `${tc.scenarioId}#${prior + 1}`;
      issues.push({ scenarioId: tc.scenarioId, check: 'uniqueId', severity: 'warn', message: `Duplicate scenarioId — re-tagged as "${deduped}".`, repaired: true });
      seenIds.set(tc.scenarioId, prior + 1);
      tc.scenarioId = deduped;
      repaired++;
    } else {
      seenIds.set(tc.scenarioId, 1);
    }

    // 2. coverageType / tags present.
    if (!tc.tags || tc.tags.length === 0) {
      issues.push({ scenarioId: tc.scenarioId, check: 'coverage', severity: 'warn', message: 'No coverage tags on the case.' });
    }

    // 3. non-empty expected result (repair from objective).
    if (!tc.expectedResult || !tc.expectedResult.trim()) {
      tc.expectedResult = tc.objective || 'The scenario behaves as specified.';
      issues.push({ scenarioId: tc.scenarioId, check: 'expected', severity: 'warn', message: 'Empty expected result — filled from the objective.', repaired: true });
      repaired++;
    }

    // 4. at least one step; remove EXACT-duplicate steps (keep order/first).
    if (!tc.steps.length) {
      tc.steps = [`Exercise the "${tc.title}" scenario and verify the outcome.`];
      issues.push({ scenarioId: tc.scenarioId, check: 'steps', severity: 'warn', message: 'No steps — inserted a skeleton step.', repaired: true });
      repaired++;
    } else {
      const seenStep = new Set<string>();
      const deduped: string[] = [];
      for (const s of tc.steps) {
        const key = norm(s);
        if (seenStep.has(key)) continue;
        seenStep.add(key);
        deduped.push(s);
      }
      if (deduped.length !== tc.steps.length) {
        issues.push({ scenarioId: tc.scenarioId, check: 'duplicateSteps', severity: 'warn', message: `Removed ${tc.steps.length - deduped.length} duplicate step(s).`, repaired: true });
        tc.steps = deduped;
        // Keep the typed selector list in sync with the surviving steps.
        repaired++;
      }
    }

    // 5. selectors exist in the App Profile (grounding warning, never dropped).
    if (haveProfile && tc.selectors.length) {
      const unknownSel = tc.selectors.filter(s => !selectors.has(norm(s)));
      if (unknownSel.length) {
        issues.push({ scenarioId: tc.scenarioId, check: 'selector', severity: 'warn', message: `Selector(s) not found in App Profile: ${unknownSel.join(', ')}.` });
      }
    }

    // 6. dataset exists in the retrieved Test Data.
    const ds = datasetNameOf(tc.testData);
    if (haveData && ds && !datasets.has(norm(ds))) {
      issues.push({ scenarioId: tc.scenarioId, check: 'dataset', severity: 'warn', message: `Dataset "${ds}" not found in Test Data.` });
    }

    // 7. navigation page/URL exists in the App Profile.
    const nav = navTargetOf(tc.steps);
    if (haveProfile && nav && pages.size && !pages.has(norm(nav))) {
      issues.push({ scenarioId: tc.scenarioId, check: 'page', severity: 'warn', message: `Navigation target "${nav}" not found in App Profile pages.` });
    }

    return tc;
  });

  const errors = issues.filter(i => i.severity === 'error').length;
  const warnings = issues.filter(i => i.severity === 'warn').length;
  return {
    cases: out,
    report: { ok: errors === 0, checked: cases.length, errors, warnings, repaired, issues },
  };
}
