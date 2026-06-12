/**
 * Impact Analysis Engine (Repo Intelligence — Phase 3C)
 *
 * Answers "what breaks if I change X?" by traversing the Phase 3 method
 * dependency graph (`method_dependencies`) with PostgreSQL **recursive CTEs**.
 * Given a method it finds every transitive caller (the blast radius), the
 * tests that would be affected, and the shortest dependency chains from those
 * callers back to the changed method. It also rolls method-level impact up to a
 * file-level summary.
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 * Everything here is gated behind the IMPACT_ANALYSIS feature flag AND the
 * runtime availability of the method-intelligence schema (it reads from those
 * tables). When either is off the public methods return an `available:false`
 * result with empty data. This engine is READ-ONLY — it creates no tables.
 *
 * NOTE: The original design spec referenced a `PostgresService` class that does
 * not exist in this codebase. This implementation is adapted to the real
 * functional persistence layer in `src/db/postgres.ts` and uses `getPool()`
 * directly for the recursive traversal queries.
 */

import { logger } from '../utils/logger';
import { FEATURE_FLAGS } from '../config/features';
import { getPool, isMethodIntelAvailable } from '../db/postgres';

const MOD = 'impact-analysis';

/** A node discovered during impact traversal. */
export interface ImpactedMethod {
  id: number;
  methodName: string;
  filePath: string;
  methodType: string;
  depth: number; // 1 = direct caller, 2 = caller-of-caller, ...
}

export interface DependencyChainStep {
  id: number;
  methodName: string;
  filePath: string;
}

export interface MethodImpactResult {
  available: boolean;
  method: { id: number; methodName: string; filePath: string; methodType: string } | null;
  affectedMethods: ImpactedMethod[];
  affectedTests: ImpactedMethod[];
  affectedFiles: string[];
  blastRadius: number;       // total distinct impacted methods
  maxDepth: number;          // deepest traversal level reached
  dependencyChains: DependencyChainStep[][];
}

export interface FileImpactResult {
  available: boolean;
  filePath: string;
  changedMethods: number;
  affectedMethods: ImpactedMethod[];
  affectedTests: ImpactedMethod[];
  affectedFiles: string[];
  blastRadius: number;
}

const MAX_DEPTH = 25; // recursion guard for the CTE

export class ImpactAnalysisService {
  private enabled(): boolean {
    return FEATURE_FLAGS.REPO_INTELLIGENCE.IMPACT_ANALYSIS && isMethodIntelAvailable();
  }

  /** Remove duplicate impacted nodes by id, keeping the shallowest depth. */
  deduplicateById(rows: ImpactedMethod[]): ImpactedMethod[] {
    const byId = new Map<number, ImpactedMethod>();
    for (const r of rows) {
      const existing = byId.get(r.id);
      if (!existing || r.depth < existing.depth) byId.set(r.id, r);
    }
    return Array.from(byId.values()).sort((a, b) => a.depth - b.depth || a.id - b.id);
  }

  /**
   * Find every transitive CALLER of a method (i.e. who would break if the
   * method changes), using a recursive CTE that walks `method_dependencies`
   * edges backwards (callee -> caller).
   */
  async analyzeMethodImpact(methodId: number): Promise<MethodImpactResult> {
    const empty: MethodImpactResult = {
      available: false,
      method: null,
      affectedMethods: [],
      affectedTests: [],
      affectedFiles: [],
      blastRadius: 0,
      maxDepth: 0,
      dependencyChains: [],
    };
    if (!this.enabled()) return empty;

    const p = getPool();

    // Resolve the target method first.
    const target = await p.query(
      `SELECT id, method_name, file_path, method_type
         FROM repository_methods WHERE id = $1`,
      [methodId],
    );
    if (target.rows.length === 0) return { ...empty, available: true };
    const t = target.rows[0];

    // Recursive CTE: start from the target, walk to every caller transitively.
    const res = await p.query(
      `WITH RECURSIVE impact AS (
         SELECT md.caller_method_id AS method_id, 1 AS depth
           FROM method_dependencies md
          WHERE md.callee_method_id = $1
         UNION
         SELECT md.caller_method_id, i.depth + 1
           FROM method_dependencies md
           JOIN impact i ON md.callee_method_id = i.method_id
          WHERE i.depth < $2
       )
       SELECT rm.id, rm.method_name, rm.file_path, rm.method_type, MIN(impact.depth) AS depth
         FROM impact
         JOIN repository_methods rm ON rm.id = impact.method_id
        GROUP BY rm.id, rm.method_name, rm.file_path, rm.method_type
        ORDER BY depth, rm.id`,
      [methodId, MAX_DEPTH],
    );

    const affected: ImpactedMethod[] = this.deduplicateById(
      res.rows.map((r: any) => ({
        id: r.id,
        methodName: r.method_name,
        filePath: r.file_path,
        methodType: r.method_type ?? 'unknown',
        depth: Number(r.depth ?? 1),
      })),
    );

    const affectedTests = affected.filter(m => m.methodType === 'test');
    const affectedFiles = Array.from(new Set(affected.map(m => m.filePath))).sort();
    const maxDepth = affected.reduce((mx, m) => Math.max(mx, m.depth), 0);

    const dependencyChains = await this.buildDependencyChains(methodId, affectedTests);

    return {
      available: true,
      method: { id: t.id, methodName: t.method_name, filePath: t.file_path, methodType: t.method_type ?? 'unknown' },
      affectedMethods: affected,
      affectedTests,
      affectedFiles,
      blastRadius: affected.length,
      maxDepth,
      dependencyChains,
    };
  }

  /**
   * Build a shortest-path dependency chain from each affected test back to the
   * changed method, using a recursive CTE that tracks the path array. Limited
   * to a handful of chains to keep payloads small.
   */
  async buildDependencyChains(
    targetMethodId: number,
    fromMethods: ImpactedMethod[],
    maxChains = 5,
  ): Promise<DependencyChainStep[][]> {
    if (!this.enabled() || fromMethods.length === 0) return [];
    const p = getPool();
    const starts = fromMethods.slice(0, maxChains).map(m => m.id);

    const chains: DependencyChainStep[][] = [];
    for (const startId of starts) {
      const res = await p.query(
        `WITH RECURSIVE chain AS (
           SELECT $1::int AS method_id, ARRAY[$1::int] AS path, 0 AS depth
           UNION ALL
           SELECT md.callee_method_id, c.path || md.callee_method_id, c.depth + 1
             FROM method_dependencies md
             JOIN chain c ON md.caller_method_id = c.method_id
            WHERE NOT md.callee_method_id = ANY(c.path)
              AND c.depth < $3
         )
         SELECT path FROM chain
          WHERE method_id = $2
          ORDER BY depth ASC
          LIMIT 1`,
        [startId, targetMethodId, MAX_DEPTH],
      );
      if (res.rows.length === 0) continue;
      const path: number[] = res.rows[0].path;
      // Resolve ids -> method metadata preserving path order.
      const meta = await p.query(
        `SELECT id, method_name, file_path FROM repository_methods WHERE id = ANY($1::int[])`,
        [path],
      );
      const byId = new Map<number, DependencyChainStep>(
        meta.rows.map((r: any) => [r.id, { id: r.id, methodName: r.method_name, filePath: r.file_path }]),
      );
      const chain = path.map(id => byId.get(id)).filter((s): s is DependencyChainStep => !!s);
      if (chain.length > 0) chains.push(chain);
    }
    return chains;
  }

  /**
   * File-level impact: union the impact of every method defined in a file
   * (within a given repository context).
   */
  async analyzeFileImpact(repoContextId: number, filePath: string): Promise<FileImpactResult> {
    const empty: FileImpactResult = {
      available: false,
      filePath,
      changedMethods: 0,
      affectedMethods: [],
      affectedTests: [],
      affectedFiles: [],
      blastRadius: 0,
    };
    if (!this.enabled()) return empty;
    const p = getPool();

    const methodRows = await p.query(
      `SELECT id FROM repository_methods
        WHERE repository_context_id = $1 AND file_path = $2`,
      [repoContextId, filePath],
    );
    if (methodRows.rows.length === 0) return { ...empty, available: true };

    const all: ImpactedMethod[] = [];
    for (const row of methodRows.rows) {
      const impact = await this.analyzeMethodImpact(row.id);
      all.push(...impact.affectedMethods);
    }
    // Exclude methods that live in the changed file itself from the "affected" view.
    const affected = this.deduplicateById(all).filter(m => m.filePath !== filePath);
    const affectedTests = affected.filter(m => m.methodType === 'test');
    const affectedFiles = Array.from(new Set(affected.map(m => m.filePath))).sort();

    return {
      available: true,
      filePath,
      changedMethods: methodRows.rows.length,
      affectedMethods: affected,
      affectedTests,
      affectedFiles,
      blastRadius: affected.length,
    };
  }

  /**
   * Convenience helper: just the tests that would break if a method changes.
   */
  async findBreakingTests(methodId: number): Promise<ImpactedMethod[]> {
    if (!this.enabled()) return [];
    const impact = await this.analyzeMethodImpact(methodId);
    return impact.affectedTests;
  }
}

export const impactAnalysisService = new ImpactAnalysisService();
