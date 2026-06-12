/**
 * Knowledge Graph Lite (Repo Intelligence — Phase 3C)
 *
 * Maps relationships between code artifacts — method->method (calls),
 * file->file (cross-file calls) and test->code (which tests exercise which
 * code) — using **pure PostgreSQL** queries over the Phase 3
 * `repository_methods` / `method_dependencies` tables. There is intentionally
 * NO Neo4j or other graph database: the graph is materialised on demand into a
 * JSON `{ nodes, edges }` document and a D3.js-friendly export format.
 *
 * ── Gating ────────────────────────────────────────────────────────────────
 * Everything here is gated behind the KNOWLEDGE_GRAPH feature flag AND the
 * runtime availability of the method-intelligence schema. When either is off
 * the public methods return an `available:false` empty graph. READ-ONLY — it
 * creates no tables.
 *
 * NOTE: The original design spec referenced a `PostgresService` class that does
 * not exist in this codebase. This implementation is adapted to the real
 * functional persistence layer in `src/db/postgres.ts` and uses `getPool()`
 * directly.
 */

import { logger } from '../utils/logger';
import { FEATURE_FLAGS } from '../config/features';
import { getPool, isMethodIntelAvailable } from '../db/postgres';

const MOD = 'knowledge-graph';

export type GraphNodeKind = 'method' | 'file' | 'test';

export interface GraphNode {
  id: string;            // stable string id (e.g. "m:42" or "f:src/foo.ts")
  label: string;
  kind: GraphNodeKind;
  group: number;         // numeric group for D3 colouring
  meta?: Record<string, unknown>;
}

export interface GraphEdge {
  source: string;
  target: string;
  type: 'calls' | 'in_file' | 'tests';
  weight: number;
}

export interface KnowledgeGraph {
  available: boolean;
  repositoryContextId: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: { nodeCount: number; edgeCount: number; fileCount: number; testCount: number };
}

/** D3 force-directed graph export shape. */
export interface D3Graph {
  nodes: Array<{ id: string; name: string; group: number; kind: GraphNodeKind }>;
  links: Array<{ source: string; target: string; value: number; type: string }>;
}

export class KnowledgeGraphService {
  private enabled(): boolean {
    return FEATURE_FLAGS.REPO_INTELLIGENCE.KNOWLEDGE_GRAPH && isMethodIntelAvailable();
  }

  /** Deterministic small integer group id from an arbitrary string (e.g. file path). */
  hashString(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h << 5) - h + s.charCodeAt(i);
      h |= 0; // 32-bit
    }
    return Math.abs(h) % 20; // 20 colour buckets
  }

  /** Group method ids by their file path (helper for file-level edges). */
  groupByFile(methods: Array<{ id: number; filePath: string }>): Map<string, number[]> {
    const map = new Map<string, number[]>();
    for (const m of methods) {
      const arr = map.get(m.filePath) ?? [];
      arr.push(m.id);
      map.set(m.filePath, arr);
    }
    return map;
  }

  /**
   * Build the full knowledge graph for a repository context. Produces:
   *   - method nodes (kind 'method' or 'test')
   *   - file nodes (kind 'file')
   *   - 'calls' edges (method->method) from method_dependencies
   *   - 'in_file' edges (file->method) grouping methods under their file
   *   - 'tests' edges (test-method -> called production method)
   */
  async buildGraph(repoContextId: number): Promise<KnowledgeGraph> {
    const empty: KnowledgeGraph = {
      available: false,
      repositoryContextId: repoContextId,
      nodes: [],
      edges: [],
      stats: { nodeCount: 0, edgeCount: 0, fileCount: 0, testCount: 0 },
    };
    if (!this.enabled()) return empty;
    const p = getPool();

    const methodRows = await p.query(
      `SELECT id, method_name, file_path, method_type, usage_count
         FROM repository_methods
        WHERE repository_context_id = $1`,
      [repoContextId],
    );
    if (methodRows.rows.length === 0) return { ...empty, available: true };

    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    const fileSet = new Set<string>();
    let testCount = 0;

    const methodIds = new Set<number>();
    const methodMeta = new Map<number, { name: string; file: string; type: string }>();

    for (const r of methodRows.rows) {
      const isTest = r.method_type === 'test';
      if (isTest) testCount++;
      methodIds.add(r.id);
      methodMeta.set(r.id, { name: r.method_name, file: r.file_path, type: r.method_type ?? 'unknown' });
      fileSet.add(r.file_path);
      nodes.push({
        id: `m:${r.id}`,
        label: r.method_name,
        kind: isTest ? 'test' : 'method',
        group: this.hashString(r.file_path),
        meta: { filePath: r.file_path, methodType: r.method_type, usageCount: Number(r.usage_count ?? 0) },
      });
    }

    // File nodes + in_file edges.
    for (const file of fileSet) {
      nodes.push({ id: `f:${file}`, label: file, kind: 'file', group: this.hashString(file), meta: { filePath: file } });
    }
    for (const [id, meta] of methodMeta) {
      edges.push({ source: `f:${meta.file}`, target: `m:${id}`, type: 'in_file', weight: 1 });
    }

    // 'calls' edges from the dependency graph (scoped to this context).
    const depRows = await p.query(
      `SELECT md.caller_method_id AS caller, md.callee_method_id AS callee, md.call_count
         FROM method_dependencies md
         JOIN repository_methods rm ON rm.id = md.caller_method_id
        WHERE rm.repository_context_id = $1`,
      [repoContextId],
    );
    for (const d of depRows.rows) {
      if (!methodIds.has(d.caller) || !methodIds.has(d.callee)) continue;
      const callerMeta = methodMeta.get(d.caller)!;
      const isTestEdge = callerMeta.type === 'test';
      edges.push({
        source: `m:${d.caller}`,
        target: `m:${d.callee}`,
        type: isTestEdge ? 'tests' : 'calls',
        weight: Number(d.call_count ?? 1),
      });
    }

    return {
      available: true,
      repositoryContextId: repoContextId,
      nodes,
      edges,
      stats: {
        nodeCount: nodes.length,
        edgeCount: edges.length,
        fileCount: fileSet.size,
        testCount,
      },
    };
  }

  /**
   * Neighborhood subgraph around a single method, expanded outward to `depth`
   * hops in BOTH directions (callers and callees), using a recursive CTE.
   */
  async getMethodNeighborhood(methodId: number, depth = 2): Promise<KnowledgeGraph> {
    const empty: KnowledgeGraph = {
      available: false,
      repositoryContextId: 0,
      nodes: [],
      edges: [],
      stats: { nodeCount: 0, edgeCount: 0, fileCount: 0, testCount: 0 },
    };
    if (!this.enabled()) return empty;
    const p = getPool();
    const maxDepth = Math.max(1, Math.min(depth, 10));

    const res = await p.query(
      `WITH RECURSIVE nbr AS (
         SELECT $1::int AS method_id, 0 AS d
         UNION
         SELECT CASE WHEN md.caller_method_id = n.method_id THEN md.callee_method_id
                     ELSE md.caller_method_id END,
                n.d + 1
           FROM method_dependencies md
           JOIN nbr n ON md.caller_method_id = n.method_id OR md.callee_method_id = n.method_id
          WHERE n.d < $2
       )
       SELECT DISTINCT method_id FROM nbr`,
      [methodId, maxDepth],
    );
    const ids: number[] = res.rows.map((r: any) => r.method_id);
    if (ids.length === 0) return { ...empty, available: true };

    const methodRows = await p.query(
      `SELECT id, method_name, file_path, method_type, usage_count, repository_context_id
         FROM repository_methods WHERE id = ANY($1::int[])`,
      [ids],
    );
    const nodes: GraphNode[] = [];
    const fileSet = new Set<string>();
    let testCount = 0;
    let ctxId = 0;
    for (const r of methodRows.rows) {
      ctxId = r.repository_context_id ?? ctxId;
      if (r.method_type === 'test') testCount++;
      fileSet.add(r.file_path);
      nodes.push({
        id: `m:${r.id}`,
        label: r.method_name,
        kind: r.method_type === 'test' ? 'test' : 'method',
        group: this.hashString(r.file_path),
        meta: { filePath: r.file_path, methodType: r.method_type, usageCount: Number(r.usage_count ?? 0) },
      });
    }

    const edgeRows = await p.query(
      `SELECT caller_method_id AS caller, callee_method_id AS callee, call_count
         FROM method_dependencies
        WHERE caller_method_id = ANY($1::int[]) AND callee_method_id = ANY($1::int[])`,
      [ids],
    );
    const idSet = new Set(ids);
    const edges: GraphEdge[] = [];
    for (const e of edgeRows.rows) {
      if (!idSet.has(e.caller) || !idSet.has(e.callee)) continue;
      edges.push({ source: `m:${e.caller}`, target: `m:${e.callee}`, type: 'calls', weight: Number(e.call_count ?? 1) });
    }

    return {
      available: true,
      repositoryContextId: ctxId,
      nodes,
      edges,
      stats: { nodeCount: nodes.length, edgeCount: edges.length, fileCount: fileSet.size, testCount },
    };
  }

  /** Convert a KnowledgeGraph into the D3 force-directed layout shape. */
  exportForD3(graph: KnowledgeGraph): D3Graph {
    return {
      nodes: graph.nodes.map(n => ({ id: n.id, name: n.label, group: n.group, kind: n.kind })),
      links: graph.edges.map(e => ({ source: e.source, target: e.target, value: e.weight, type: e.type })),
    };
  }
}

export const knowledgeGraphService = new KnowledgeGraphService();
