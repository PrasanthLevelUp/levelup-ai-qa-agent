/**
 * Repository Health Intelligence Service (Repo Intelligence — Phase 3C)
 *
 * Computes a weighted repository health score (0-100) from five sub-scores —
 * quality, coverage, reuse, complexity and duplication — derived entirely from
 * the Phase 3 method index (`repository_methods`) and dependency graph
 * (`method_dependencies`). It persists a daily snapshot, derives trends between
 * snapshots and detects code-quality issues (high_complexity / duplicate /
 * unused / missing_tests).
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 * Everything here is gated behind the HEALTH_INTELLIGENCE feature flag AND the
 * runtime availability of BOTH the method-intelligence schema (it reads from
 * those tables) and the health schema (it writes snapshots/issues). When any of
 * these is off the public methods are cheap no-ops returning a null/empty
 * result — default product behaviour is therefore completely unchanged.
 *
 * NOTE: The original design spec referenced a `PostgresService` class that does
 * not exist in this codebase. This implementation is adapted to the real
 * functional persistence layer in `src/db/postgres.ts` and uses `getPool()`
 * directly for the read-only analytical aggregation queries.
 */

import { logger } from '../utils/logger';
import { FEATURE_FLAGS } from '../config/features';
import {
  getPool,
  isHealthIntelAvailable,
  isMethodIntelAvailable,
  saveHealthSnapshot,
  saveHealthTrend,
  replaceQualityIssues,
  getHealthSnapshots,
  type HealthSnapshotRecord,
  type QualityIssueInput,
} from '../db/postgres';

const MOD = 'repository-health';

/** Weights for the overall score — must sum to 1.0. */
export const HEALTH_WEIGHTS = {
  quality: 0.25,
  coverage: 0.25,
  reuse: 0.20,
  complexity: 0.15,
  duplication: 0.15,
} as const;

/** A method with the line/dependency metrics we score against. */
interface MethodMetric {
  id: number;
  methodName: string;
  filePath: string;
  methodType: string;
  usageCount: number;
  lineCount: number;
  hasDescription: boolean;
  codeHash: string | null;
  fanOut: number; // number of outgoing dependency edges
  fanIn: number;  // number of incoming dependency edges
}

export interface HealthScore {
  available: boolean;
  repositoryContextId: number;
  overallScore: number;
  subScores: {
    quality: number;
    coverage: number;
    reuse: number;
    complexity: number;
    duplication: number;
  };
  totals: {
    methods: number;
    tests: number;
    dependencies: number;
  };
  grade: string;
  computedAt: string;
}

export interface HealthTrendPoint {
  metric: string;
  previousValue: number;
  currentValue: number;
  delta: number;
  direction: 'up' | 'down' | 'flat';
}

function round2(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Map a 0-100 score to a letter grade. */
export function scoreToGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export class RepositoryHealthService {
  /**
   * True only when the feature flag is on AND both schemas are available.
   * Reads need the method index; writes need the health tables.
   */
  private enabled(): boolean {
    return (
      FEATURE_FLAGS.REPO_INTELLIGENCE.HEALTH_INTELLIGENCE &&
      isMethodIntelAvailable() &&
      isHealthIntelAvailable()
    );
  }

  /** Load per-method metrics (line counts, fan-in/out, description presence). */
  private async loadMethodMetrics(repoContextId: number): Promise<MethodMetric[]> {
    const p = getPool();
    const res = await p.query(
      `SELECT
         rm.id,
         rm.method_name,
         rm.file_path,
         rm.method_type,
         rm.usage_count,
         rm.code_hash,
         GREATEST(COALESCE(rm.line_end, 0) - COALESCE(rm.line_start, 0), 0) AS line_count,
         (rm.description IS NOT NULL AND length(trim(rm.description)) > 0) AS has_description,
         COALESCE(out_deps.c, 0) AS fan_out,
         COALESCE(in_deps.c, 0) AS fan_in
       FROM repository_methods rm
       LEFT JOIN (
         SELECT caller_method_id AS mid, COUNT(*)::int AS c
           FROM method_dependencies GROUP BY caller_method_id
       ) out_deps ON out_deps.mid = rm.id
       LEFT JOIN (
         SELECT callee_method_id AS mid, COUNT(*)::int AS c
           FROM method_dependencies GROUP BY callee_method_id
       ) in_deps ON in_deps.mid = rm.id
       WHERE rm.repository_context_id = $1`,
      [repoContextId],
    );
    return res.rows.map((r: any) => ({
      id: r.id,
      methodName: r.method_name,
      filePath: r.file_path,
      methodType: r.method_type ?? 'unknown',
      usageCount: Number(r.usage_count ?? 0),
      lineCount: Number(r.line_count ?? 0),
      hasDescription: r.has_description === true,
      codeHash: r.code_hash ?? null,
      fanOut: Number(r.fan_out ?? 0),
      fanIn: Number(r.fan_in ?? 0),
    }));
  }

  /**
   * Quality score: rewards documented methods and penalises very large
   * methods. quality = 100 * (0.5 * documentedRatio + 0.5 * reasonableSizeRatio)
   */
  calculateQualityScore(methods: MethodMetric[]): number {
    if (methods.length === 0) return 0;
    const documented = methods.filter(m => m.hasDescription).length;
    const reasonable = methods.filter(m => m.lineCount > 0 && m.lineCount <= 60).length;
    const documentedRatio = documented / methods.length;
    const reasonableRatio = reasonable / methods.length;
    return round2(clamp(100 * (0.5 * documentedRatio + 0.5 * reasonableRatio)));
  }

  /**
   * Coverage score: proportion of non-test methods that are exercised by at
   * least one test method. Approximated as the ratio of test methods to
   * production methods, capped at 100 (1 test per prod method == full marks).
   */
  calculateCoverage(methods: MethodMetric[]): number {
    const tests = methods.filter(m => m.methodType === 'test').length;
    const production = methods.filter(m => m.methodType !== 'test').length;
    if (production === 0) return tests > 0 ? 100 : 0;
    return round2(clamp((tests / production) * 100));
  }

  /**
   * Reuse score: proportion of methods that are actually reused (called by at
   * least one other method OR have usage_count > 1). Higher = less dead/siloed
   * code.
   */
  calculateReuse(methods: MethodMetric[]): number {
    if (methods.length === 0) return 0;
    const reused = methods.filter(m => m.fanIn > 0 || m.usageCount > 1).length;
    return round2(clamp((reused / methods.length) * 100));
  }

  /**
   * Map a single method's size + fan-out into a 0-100 "simplicity" score
   * (100 = simple, 0 = very complex). Used both for the aggregate complexity
   * score and for per-method issue detection.
   */
  scoreComplexity(lineCount: number, fanOut: number): number {
    // A rough cyclomatic proxy: longer methods and higher fan-out are riskier.
    const sizePenalty = Math.min(lineCount / 80, 1) * 60; // up to -60 for >=80 lines
    const fanPenalty = Math.min(fanOut / 15, 1) * 40;     // up to -40 for >=15 callees
    return round2(clamp(100 - sizePenalty - fanPenalty));
  }

  /** Aggregate complexity score: mean of per-method simplicity scores. */
  calculateComplexity(methods: MethodMetric[]): number {
    if (methods.length === 0) return 0;
    const sum = methods.reduce((acc, m) => acc + this.scoreComplexity(m.lineCount, m.fanOut), 0);
    return round2(clamp(sum / methods.length));
  }

  /**
   * Duplication score: 100 means no duplicates. Penalised by the fraction of
   * methods that share a code_hash with another method.
   */
  calculateDuplication(methods: MethodMetric[]): number {
    const withHash = methods.filter(m => m.codeHash);
    if (withHash.length === 0) return 100;
    const counts = new Map<string, number>();
    for (const m of withHash) counts.set(m.codeHash as string, (counts.get(m.codeHash as string) ?? 0) + 1);
    let duplicated = 0;
    for (const m of withHash) if ((counts.get(m.codeHash as string) ?? 0) > 1) duplicated++;
    const dupRatio = duplicated / withHash.length;
    return round2(clamp(100 * (1 - dupRatio)));
  }

  /**
   * Compute (and optionally persist) the full health score for a repository
   * context. Returns `{ available:false }` when the feature is off — no DB
   * writes happen in that case.
   */
  async calculateHealth(
    repoContextId: number,
    opts: { persist?: boolean } = {},
  ): Promise<HealthScore> {
    const unavailable: HealthScore = {
      available: false,
      repositoryContextId: repoContextId,
      overallScore: 0,
      subScores: { quality: 0, coverage: 0, reuse: 0, complexity: 0, duplication: 0 },
      totals: { methods: 0, tests: 0, dependencies: 0 },
      grade: 'F',
      computedAt: new Date().toISOString(),
    };
    if (!this.enabled()) return unavailable;

    const methods = await this.loadMethodMetrics(repoContextId);
    const quality = this.calculateQualityScore(methods);
    const coverage = this.calculateCoverage(methods);
    const reuse = this.calculateReuse(methods);
    const complexity = this.calculateComplexity(methods);
    const duplication = this.calculateDuplication(methods);

    const overall = round2(
      quality * HEALTH_WEIGHTS.quality +
      coverage * HEALTH_WEIGHTS.coverage +
      reuse * HEALTH_WEIGHTS.reuse +
      complexity * HEALTH_WEIGHTS.complexity +
      duplication * HEALTH_WEIGHTS.duplication,
    );

    const tests = methods.filter(m => m.methodType === 'test').length;
    const dependencies = methods.reduce((acc, m) => acc + m.fanOut, 0);

    const result: HealthScore = {
      available: true,
      repositoryContextId: repoContextId,
      overallScore: overall,
      subScores: { quality, coverage, reuse, complexity, duplication },
      totals: { methods: methods.length, tests, dependencies },
      grade: scoreToGrade(overall),
      computedAt: new Date().toISOString(),
    };

    if (opts.persist) {
      try {
        await this.saveSnapshot(result);
        await this.detectIssues(repoContextId, methods);
      } catch (err: any) {
        logger.warn(MOD, 'failed to persist health snapshot/issues', { error: err?.message });
      }
    }
    return result;
  }

  /** Persist a snapshot row from a computed HealthScore. */
  async saveSnapshot(score: HealthScore): Promise<number | null> {
    if (!this.enabled() || !score.available) return null;
    return saveHealthSnapshot({
      repositoryContextId: score.repositoryContextId,
      overallScore: score.overallScore,
      qualityScore: score.subScores.quality,
      coverageScore: score.subScores.coverage,
      reuseScore: score.subScores.reuse,
      complexityScore: score.subScores.complexity,
      duplicationScore: score.subScores.duplication,
      totalMethods: score.totals.methods,
      totalTests: score.totals.tests,
      totalDependencies: score.totals.dependencies,
      metrics: { grade: score.grade, weights: HEALTH_WEIGHTS },
    });
  }

  /**
   * Trend analysis: compare the two most recent snapshots and return a delta
   * per metric. Persists trend rows when persist=true. Returns [] with < 2
   * snapshots.
   */
  async getHealthTrend(
    repoContextId: number,
    opts: { persist?: boolean } = {},
  ): Promise<HealthTrendPoint[]> {
    if (!this.enabled()) return [];
    const snapshots = await getHealthSnapshots(repoContextId, 2);
    if (snapshots.length < 2) return [];
    const [current, previous] = snapshots; // newest first
    const metrics: Array<[string, number, number]> = [
      ['overall', previous.overallScore, current.overallScore],
      ['quality', previous.qualityScore, current.qualityScore],
      ['coverage', previous.coverageScore, current.coverageScore],
      ['reuse', previous.reuseScore, current.reuseScore],
      ['complexity', previous.complexityScore, current.complexityScore],
      ['duplication', previous.duplicationScore, current.duplicationScore],
    ];
    const points: HealthTrendPoint[] = metrics.map(([metric, prev, curr]) => {
      const delta = round2(curr - prev);
      const direction: 'up' | 'down' | 'flat' = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
      return { metric, previousValue: prev, currentValue: curr, delta, direction };
    });

    if (opts.persist) {
      for (const pt of points) {
        try {
          await saveHealthTrend({
            repositoryContextId: repoContextId,
            metric: pt.metric,
            previousValue: pt.previousValue,
            currentValue: pt.currentValue,
            delta: pt.delta,
            direction: pt.direction,
            periodStart: previous.snapshotDate,
            periodEnd: current.snapshotDate,
          });
        } catch (err: any) {
          logger.warn(MOD, 'failed to persist trend row', { error: err?.message, metric: pt.metric });
        }
      }
    }
    return points;
  }

  /**
   * Detect and persist code-quality issues from the loaded metrics:
   *   - high_complexity: simplicity score < 50
   *   - duplicate:       shares a code_hash with another method
   *   - unused:          no incoming edges and usage_count <= 1 (non-test)
   *   - missing_tests:   page_object_method / helper with no test coverage signal
   * Returns the list of detected issues (also persisted when the schema exists).
   */
  async detectIssues(
    repoContextId: number,
    preloaded?: MethodMetric[],
  ): Promise<QualityIssueInput[]> {
    if (!this.enabled()) return [];
    const methods = preloaded ?? (await this.loadMethodMetrics(repoContextId));

    // Build duplicate hash set.
    const hashCounts = new Map<string, number>();
    for (const m of methods) if (m.codeHash) hashCounts.set(m.codeHash, (hashCounts.get(m.codeHash) ?? 0) + 1);

    const hasAnyTests = methods.some(m => m.methodType === 'test');
    const issues: QualityIssueInput[] = [];

    for (const m of methods) {
      const simplicity = this.scoreComplexity(m.lineCount, m.fanOut);
      if (simplicity < 50) {
        issues.push({
          repositoryContextId: repoContextId,
          methodId: m.id,
          issueType: 'high_complexity',
          severity: simplicity < 30 ? 'high' : 'medium',
          filePath: m.filePath,
          methodName: m.methodName,
          details: { simplicityScore: simplicity, lineCount: m.lineCount, fanOut: m.fanOut },
        });
      }
      if (m.codeHash && (hashCounts.get(m.codeHash) ?? 0) > 1) {
        issues.push({
          repositoryContextId: repoContextId,
          methodId: m.id,
          issueType: 'duplicate',
          severity: 'medium',
          filePath: m.filePath,
          methodName: m.methodName,
          details: { duplicateCount: hashCounts.get(m.codeHash) },
        });
      }
      if (m.methodType !== 'test' && m.fanIn === 0 && m.usageCount <= 1) {
        issues.push({
          repositoryContextId: repoContextId,
          methodId: m.id,
          issueType: 'unused',
          severity: 'low',
          filePath: m.filePath,
          methodName: m.methodName,
          details: { fanIn: m.fanIn, usageCount: m.usageCount },
        });
      }
      if (!hasAnyTests && (m.methodType === 'page_object_method' || m.methodType === 'helper')) {
        issues.push({
          repositoryContextId: repoContextId,
          methodId: m.id,
          issueType: 'missing_tests',
          severity: 'medium',
          filePath: m.filePath,
          methodName: m.methodName,
          details: { reason: 'repository has no indexed test methods' },
        });
      }
    }

    try {
      await replaceQualityIssues(repoContextId, issues);
    } catch (err: any) {
      logger.warn(MOD, 'failed to persist quality issues', { error: err?.message });
    }
    return issues;
  }

  /** Convenience: latest persisted snapshots (newest first). */
  async getSnapshots(repoContextId: number, limit = 30): Promise<HealthSnapshotRecord[]> {
    if (!this.enabled()) return [];
    return getHealthSnapshots(repoContextId, limit);
  }
}

export const repositoryHealthService = new RepositoryHealthService();
