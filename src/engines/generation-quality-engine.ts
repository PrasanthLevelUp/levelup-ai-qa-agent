/**
 * Generation Quality Engine (Sprint 6.x)
 * =======================================
 *
 * A DETERMINISTIC, ZERO-LLM, self-contained post-generation quality gate that
 * every project reuses. It answers one question a senior QA lead asks after any
 * suite is generated:
 *
 *      "Is this a BALANCED, non-redundant suite — or 11 happy-paths, one
 *       negative, and zero edge cases?"
 *
 * WHY THIS EXISTS
 * ---------------
 * The generator (planner → LLM → dedup) decides WHAT to test. This engine is a
 * separate, independent AUDITOR that scores the OUTPUT after the fact. Keeping
 * it separate is the point: the thing that produces coverage cannot be trusted
 * to also grade its own coverage. This module never calls a model, never mutates
 * a test case, and has no dependency on the generation pipeline — so it can grade
 * a suite from ANY source (this generator, an imported suite, a competitor's
 * export) identically.
 *
 * WHAT IT PRODUCES
 * ----------------
 *  • Coverage Mix     — Positive:N Negative:N Edge:N (+ granular per-type counts
 *                       and percentages). The metric that makes the engine
 *                       self-aware about its own balance.
 *  • Risk Score       — LOW / MEDIUM / HIGH, with human-readable reasons, judged
 *                       RELATIVE to what the user actually asked for (a
 *                       positive-only request is not penalised for lacking edge
 *                       cases; a request that selected Edge and got zero is).
 *  • Duplicates       — near-identical business-flow clusters the semantic dedup
 *                       pass missed (lexical Jaccard, no embeddings/tokens).
 *  • Missing Categories — selected coverage families that came back empty or
 *                       under threshold → the exact set to regenerate.
 *  • Recommendations  — plain-English next actions ("Edge is 0% — regenerate
 *                       edge cases").
 *
 * All thresholds are named constants so product can tune them without touching
 * logic.
 */

import type { CoverageType } from './test-coverage-engine';

/* ---------------------------------------------------------------------------
 * Coverage families
 * ---------------------------------------------------------------------------
 * A senior QA reasons about balance in THREE core families — Positive, Negative,
 * Edge — not the seven granular coverage types. `boundary` is a form of edge
 * testing; security / integration / role_based / performance are advanced types
 * that are legitimately absent for many features, so they are grouped as
 * `advanced` and never counted against a suite's core balance.
 * ------------------------------------------------------------------------- */
export type CoverageFamily = 'positive' | 'negative' | 'edge' | 'advanced';

/** The three families a balanced functional suite is graded on. */
export const CORE_FAMILIES: readonly CoverageFamily[] = ['positive', 'negative', 'edge'] as const;

/** Map a granular coverage type onto its family. Unknown types → advanced. */
export function coverageFamily(type: string): CoverageFamily {
  const t = (type || '').toLowerCase().trim();
  if (t === 'positive') return 'positive';
  if (t === 'negative') return 'negative';
  if (t === 'edge_cases' || t === 'edge' || t === 'boundary') return 'edge';
  return 'advanced';
}

/* ---------------------------------------------------------------------------
 * Tunable thresholds (product-owned; logic-free knobs)
 * ------------------------------------------------------------------------- */
export const QUALITY_THRESHOLDS = {
  /** A suite whose negatives are below this share of the total is under-tested
   *  on the failure path. (User directive: "Negative < 20% → add negatives".) */
  NEGATIVE_MIN_SHARE: 0.2,
  /** Edge cases below this share signal a suite that only exercises the middle
   *  of the input space. (User directive: "Edge < 10% → regenerate edge".) */
  EDGE_MIN_SHARE: 0.1,
  /** A single family dominating beyond this share is a skew signal even if the
   *  others are technically present. */
  POSITIVE_MAX_SHARE: 0.85,
  /** Jaccard token overlap at/above which two cases are treated as near-duplicate
   *  business flows (title + objective + steps). Intentionally lexical + strict —
   *  this is a SAFETY NET behind the semantic dedup pass, not a replacement. */
  DUPLICATE_SIMILARITY: 0.8,
} as const;

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/* ---------------------------------------------------------------------------
 * Public shapes
 * ------------------------------------------------------------------------- */

/** The minimal test-case shape this engine grades. Deliberately loose so any
 *  suite (generated, imported, external) can be audited without adaptation. */
export interface QualityTestCase {
  /** Resolved coverage type (e.g. 'positive'). Falls back to 'positive' when a
   *  case has none — an unlabelled case is assumed a happy path, matching how
   *  the generator maps an untagged case to the first scenario. */
  coverageType?: string;
  title?: string;
  objective?: string;
  steps?: string[];
}

export interface CoverageMix {
  /** Count per granular coverage type actually present (e.g. { positive: 11, negative: 1 }). */
  byType: Record<string, number>;
  /** Count per core family (positive / negative / edge / advanced). */
  byFamily: Record<CoverageFamily, number>;
  /** Percentage (0–100, rounded) per core family, share of the total suite. */
  familyPercent: Record<CoverageFamily, number>;
  /** Total cases graded. */
  total: number;
  /** One-line human summary, e.g. "Positive: 11 · Negative: 1 · Edge: 0". */
  label: string;
}

export interface DuplicateCluster {
  /** Indices (into the graded array) of the near-identical cases. */
  indices: number[];
  /** Their titles, for display. */
  titles: string[];
  /** Peak pairwise similarity within the cluster (0–1). */
  similarity: number;
}

export interface RiskAssessment {
  score: RiskLevel;
  /** Human-readable reasons that drove the score (empty when LOW & clean). */
  reasons: string[];
}

export interface QualityReport {
  coverageMix: CoverageMix;
  risk: RiskAssessment;
  duplicates: DuplicateCluster[];
  /** Selected coverage families that came back empty or below threshold — the
   *  exact set the pipeline should regenerate. */
  missingCategories: CoverageFamily[];
  /** Granular coverage types (as selected by the user) that produced zero cases. */
  missingTypes: CoverageType[];
  /** Plain-English next actions for the reviewer / the regeneration loop. */
  recommendations: string[];
  /**
   * Cases whose coverage type could NOT be resolved by the pipeline (arrived as
   * the explicit sentinel 'unknown'). This is a PIPELINE DEFECT — an unknown type
   * is never silently reclassified as positive. Non-zero means information was
   * lost between the planner and the LLM handoff.
   */
  unknownCount: number;
  /**
   * Planner → LLM information-flow metric. Present only when the caller supplies
   * the planner scenario count. `lossPercent = unknown / llmReturned`. This is the
   * single number that says WHERE information disappeared: a non-zero loss means
   * the planner classified coverage that the pipeline then failed to carry through.
   */
  coverageLoss?: {
    plannerCreated: number;
    llmReturned: number;
    unknown: number;
    lossPercent: number;
  };
  /**
   * The concrete reasons the gate failed (empty when it passes). The gate BLOCKS
   * on any of these — a coverage-type loss, a HIGH risk score, a selected family
   * that came back empty/under-threshold, or duplicate clusters.
   */
  gateReasons: string[];
  /** True when the suite is balanced enough to accept as-is (no HIGH risk, no
   *  missing selected category, no duplicate clusters, and NO unresolved types). */
  passed: boolean;
}

/* ---------------------------------------------------------------------------
 * Lexical helpers (self-contained — no external tokenizer dependency so the
 * engine stays a standalone, reusable auditor).
 * ------------------------------------------------------------------------- */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'are', 'was', 'were',
  'has', 'have', 'had', 'not', 'but', 'when', 'then', 'into', 'per', 'via',
  'a', 'an', 'is', 'to', 'of', 'in', 'on', 'at', 'by', 'be', 'or', 'as', 'it',
]);

function tokenize(text: string): Set<string> {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function pct(n: number, total: number): number {
  return total <= 0 ? 0 : Math.round((n / total) * 100);
}

/* ---------------------------------------------------------------------------
 * 1) Coverage Mix
 * ------------------------------------------------------------------------- */
export function analyzeCoverageMix(cases: QualityTestCase[]): CoverageMix {
  const byType: Record<string, number> = {};
  const byFamily: Record<CoverageFamily, number> = {
    positive: 0, negative: 0, edge: 0, advanced: 0,
  };
  for (const tc of cases) {
    const type = (tc.coverageType || 'positive').toLowerCase().trim();
    byType[type] = (byType[type] ?? 0) + 1;
    byFamily[coverageFamily(type)] += 1;
  }
  const total = cases.length;
  const familyPercent: Record<CoverageFamily, number> = {
    positive: pct(byFamily.positive, total),
    negative: pct(byFamily.negative, total),
    edge: pct(byFamily.edge, total),
    advanced: pct(byFamily.advanced, total),
  };
  const label = `Positive: ${byFamily.positive} · Negative: ${byFamily.negative} · Edge: ${byFamily.edge}`;
  return { byType, byFamily, familyPercent, total, label };
}

/* ---------------------------------------------------------------------------
 * 2) Duplicate detection (lexical safety net behind semantic dedup)
 * ------------------------------------------------------------------------- */
export function detectDuplicates(
  cases: QualityTestCase[],
  threshold: number = QUALITY_THRESHOLDS.DUPLICATE_SIMILARITY,
): DuplicateCluster[] {
  const signatures = cases.map(tc =>
    tokenize(`${tc.title || ''} ${tc.objective || ''} ${(tc.steps || []).join(' ')}`),
  );
  const n = cases.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; }
    return x;
  };
  const union = (a: number, b: number) => { parent[find(a)] = find(b); };
  const peak: Record<string, number> = {};

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = jaccard(signatures[i], signatures[j]);
      if (sim >= threshold) {
        union(i, j);
        const root = String(find(i));
        peak[root] = Math.max(peak[root] ?? 0, sim);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(i);
  }

  const clusters: DuplicateCluster[] = [];
  for (const [root, indices] of groups) {
    if (indices.length < 2) continue; // singletons are not duplicates
    clusters.push({
      indices,
      titles: indices.map(i => cases[i].title || `Case ${i + 1}`),
      similarity: Math.round((peak[String(root)] ?? threshold) * 100) / 100,
    });
  }
  // Largest / most-similar clusters first.
  clusters.sort((a, b) => b.indices.length - a.indices.length || b.similarity - a.similarity);
  return clusters;
}

/* ---------------------------------------------------------------------------
 * 3) Expected families — what the user actually asked for
 * ------------------------------------------------------------------------- */
export function expectedFamiliesFor(selectedTypes: CoverageType[] | undefined): Set<CoverageFamily> {
  const fams = new Set<CoverageFamily>();
  for (const t of selectedTypes ?? []) {
    const f = coverageFamily(t);
    if (f !== 'advanced') fams.add(f);
  }
  // No explicit selection → the honest floor is "positive" only, so an all-happy
  // -path suite for an unspecified request is not falsely flagged.
  if (fams.size === 0) fams.add('positive');
  return fams;
}

/* ---------------------------------------------------------------------------
 * 4) Missing categories — selected families that came back empty/under threshold
 * ------------------------------------------------------------------------- */
export function detectMissingCategories(
  mix: CoverageMix,
  expected: Set<CoverageFamily>,
): CoverageFamily[] {
  const missing: CoverageFamily[] = [];
  for (const fam of CORE_FAMILIES) {
    if (!expected.has(fam)) continue;
    if (fam === 'positive') {
      // A suite with zero positives is degenerate; flag only that case.
      if (mix.byFamily.positive === 0) missing.push('positive');
      continue;
    }
    const share = (mix.familyPercent[fam] ?? 0) / 100;
    const min = fam === 'negative'
      ? QUALITY_THRESHOLDS.NEGATIVE_MIN_SHARE
      : QUALITY_THRESHOLDS.EDGE_MIN_SHARE;
    if (mix.byFamily[fam] === 0 || share < min) missing.push(fam);
  }
  return missing;
}

/* ---------------------------------------------------------------------------
 * 5) Risk score — judged RELATIVE to what was requested
 * ------------------------------------------------------------------------- */
export function computeRiskScore(
  mix: CoverageMix,
  expected: Set<CoverageFamily>,
  duplicateClusters: number,
): RiskAssessment {
  const reasons: string[] = [];
  const criticalMisses: CoverageFamily[] = []; // expected family, ZERO cases
  const softMisses: CoverageFamily[] = [];     // expected family present but below threshold

  for (const fam of CORE_FAMILIES) {
    if (fam === 'positive' || !expected.has(fam)) continue;
    const count = mix.byFamily[fam];
    const share = (mix.familyPercent[fam] ?? 0);
    const minPct = Math.round((fam === 'negative'
      ? QUALITY_THRESHOLDS.NEGATIVE_MIN_SHARE
      : QUALITY_THRESHOLDS.EDGE_MIN_SHARE) * 100);
    if (count === 0) {
      criticalMisses.push(fam);
      reasons.push(`${cap(fam)} coverage was selected but the suite has 0 ${fam} cases.`);
    } else if (share < minPct) {
      softMisses.push(fam);
      reasons.push(`${cap(fam)} is only ${share}% of the suite (below the ${minPct}% floor).`);
    }
  }

  // Skew: one family dominating even when others are nominally present.
  if (mix.total > 0 && (mix.familyPercent.positive / 100) > QUALITY_THRESHOLDS.POSITIVE_MAX_SHARE) {
    reasons.push(`Positive cases are ${mix.familyPercent.positive}% of the suite — heavily skewed to the happy path.`);
  }

  if (duplicateClusters > 0) {
    reasons.push(`${duplicateClusters} near-duplicate case cluster${duplicateClusters > 1 ? 's' : ''} detected — redundant business flows.`);
  }

  let score: RiskLevel;
  if (criticalMisses.length >= 1 || softMisses.length >= 2) {
    score = 'HIGH';
  } else if (softMisses.length === 1 || duplicateClusters > 0
    || (mix.familyPercent.positive / 100) > QUALITY_THRESHOLDS.POSITIVE_MAX_SHARE) {
    score = 'MEDIUM';
  } else {
    score = 'LOW';
  }
  return { score, reasons };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ---------------------------------------------------------------------------
 * 6) Full report — the one call the pipeline / any consumer makes
 * ------------------------------------------------------------------------- */
export function buildQualityReport(
  cases: QualityTestCase[],
  opts?: {
    selectedTypes?: CoverageType[];
    /** The number of scenarios the PLANNER produced. When supplied, the report
     *  carries the Coverage Loss metric (plannerCreated → llmReturned → unknown). */
    plannerScenarioCount?: number;
  },
): QualityReport {
  const selectedTypes = opts?.selectedTypes ?? [];
  const coverageMix = analyzeCoverageMix(cases);
  const expected = expectedFamiliesFor(selectedTypes);
  const duplicates = detectDuplicates(cases);
  const missingCategories = detectMissingCategories(coverageMix, expected);
  const risk = computeRiskScore(coverageMix, expected, duplicates.length);

  // Granular selected types that produced zero cases (for the regeneration loop).
  const missingTypes: CoverageType[] = (selectedTypes || []).filter(
    t => (coverageMix.byType[(t || '').toLowerCase().trim()] ?? 0) === 0,
  );

  const recommendations: string[] = [];
  for (const fam of missingCategories) {
    if (fam === 'positive') {
      recommendations.push('Suite has no positive/happy-path case — regenerate the core positive flow.');
    } else if (coverageMix.byFamily[fam] === 0) {
      recommendations.push(`Regenerate ${fam} cases — the requirement selected ${cap(fam)} but none were produced.`);
    } else {
      recommendations.push(`Add more ${fam} cases — currently ${coverageMix.familyPercent[fam]}% of the suite.`);
    }
  }
  if (duplicates.length > 0) {
    recommendations.push(`Merge ${duplicates.length} near-duplicate cluster${duplicates.length > 1 ? 's' : ''} into distinct flows.`);
  }

  // ── Coverage loss — cases whose type could not be resolved (a defect) ──────
  // These arrive as the explicit 'unknown' sentinel (the pipeline NEVER silently
  // maps them to positive). A single non-zero here means the planner→LLM handoff
  // dropped a classification, so it leads the recommendations and BLOCKS the gate.
  const unknownCount = coverageMix.byType['unknown'] ?? 0;
  if (unknownCount > 0) {
    recommendations.unshift(
      `${unknownCount} case${unknownCount > 1 ? 's' : ''} lost their coverage type in the pipeline — investigate the planner→LLM handoff. An unknown type is a defect, never a positive.`,
    );
  }
  if (recommendations.length === 0) {
    recommendations.push('Balanced suite — no regeneration required.');
  }

  // ── The gate — one explicit list of blocking reasons (empty ⇒ pass) ────────
  const gateReasons: string[] = [];
  if (unknownCount > 0) {
    gateReasons.push(`${unknownCount} case(s) have an unresolved coverage type (coverage loss) — a pipeline defect.`);
  }
  if (risk.score === 'HIGH') {
    gateReasons.push(`Coverage risk is HIGH — ${risk.reasons.join(' ')}`);
  }
  for (const fam of missingCategories) {
    gateReasons.push(`Selected ${cap(fam)} coverage came back empty or below the minimum share.`);
  }
  if (duplicates.length > 0) {
    gateReasons.push(`${duplicates.length} near-duplicate case cluster(s) detected.`);
  }
  const passed = gateReasons.length === 0;

  const coverageLoss = opts?.plannerScenarioCount != null
    ? {
        plannerCreated: opts.plannerScenarioCount,
        llmReturned: coverageMix.total,
        unknown: unknownCount,
        lossPercent: coverageMix.total > 0 ? Math.round((unknownCount / coverageMix.total) * 100) : 0,
      }
    : undefined;

  return {
    coverageMix,
    risk,
    duplicates,
    missingCategories,
    missingTypes,
    recommendations,
    unknownCount,
    coverageLoss,
    gateReasons,
    passed,
  };
}
