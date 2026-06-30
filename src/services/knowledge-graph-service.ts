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

  /* ──────────────────────────────────────────────────────────────────────────
   *  Intent-Based Queries (Phase 2 — Query-first retrieval)
   * ────────────────────────────────────────────────────────────────────────── */

  /**
   * Find reusable candidates (page objects, helpers, assertions, waits, fixtures)
   * relevant to a user intent (e.g., "login", "add to cart", "verify error").
   *
   * Strategy:
   * 1. Fuzzy-search method names for the intent keywords (pg_trgm or ILIKE)
   * 2. For top matches, expand their neighborhood (methods they call + are called by)
   * 3. Classify neighbors by type (assertion, wait, data, utility)
   * 4. Return a compact bundle: primary method + supporting neighbors
   */
  async getReuseCandidatesForIntent(
    repoContextId: number,
    intent: string,
    opts: { limit?: number; depth?: number } = {},
  ): Promise<IntentQueryResult> {
    const empty: IntentQueryResult = {
      available: false,
      intent,
      primaryMethods: [],
      supportingMethods: { assertions: [], waits: [], dataAccess: [], utilities: [] },
      relatedFlows: [],
    };
    if (!this.enabled() || !intent?.trim()) return empty;
    const p = getPool();
    const limit = Math.max(1, Math.min(opts.limit ?? 5, 20));
    const depth = Math.max(1, Math.min(opts.depth ?? 2, 3));

    // 1. Fuzzy-search for primary candidates (page objects, helpers matching intent)
    const intentTokens = intent.toLowerCase().split(/\s+/);
    const ilike = intentTokens.map(t => `%${t}%`).join('|');
    const primaryRows = await p.query(
      `SELECT id, method_name, file_path, method_type, usage_count, source_code, description
         FROM repository_methods
        WHERE repository_context_id = $1
          AND (method_name ILIKE ANY(ARRAY[$2]) OR LOWER(description) LIKE $3)
        ORDER BY usage_count DESC NULLS LAST, method_name
        LIMIT $4`,
      [repoContextId, intentTokens.map(t => `%${t}%`), `%${intent.toLowerCase()}%`, limit],
    );

    if (primaryRows.rows.length === 0) return { ...empty, available: true };

    const primaryMethods: ReusableMethod[] = primaryRows.rows.map((r: any) => ({
      id: r.id,
      name: r.method_name,
      filePath: r.file_path,
      methodType: r.method_type ?? 'unknown',
      sourceCode: (r.source_code ?? '').slice(0, 1000), // cap for prompt
      description: r.description ?? '',
      usageCount: Number(r.usage_count ?? 0),
    }));

    // 2. Expand neighborhood for each primary (depth hops in both directions)
    const primaryIds = primaryMethods.map(m => m.id);
    const neighborRes = await p.query(
      `WITH RECURSIVE nbr AS (
         SELECT id AS method_id, 0 AS d FROM repository_methods WHERE id = ANY($1::int[])
         UNION
         SELECT CASE WHEN md.caller_method_id = n.method_id THEN md.callee_method_id ELSE md.caller_method_id END, n.d + 1
           FROM method_dependencies md JOIN nbr n
             ON md.caller_method_id = n.method_id OR md.callee_method_id = n.method_id
          WHERE n.d < $2
       )
       SELECT DISTINCT rm.id, rm.method_name, rm.file_path, rm.method_type, rm.source_code, rm.description
         FROM nbr JOIN repository_methods rm ON rm.id = nbr.method_id
        WHERE rm.id != ALL($1::int[])`,
      [primaryIds, depth],
    );

    // 3. Classify neighbors by heuristic (mirrors reusable-helpers.ts logic)
    const supporting: IntentQueryResult['supportingMethods'] = {
      assertions: [],
      waits: [],
      dataAccess: [],
      utilities: [],
    };
    for (const r of neighborRes.rows) {
      const name = (r.method_name ?? '').toLowerCase();
      const desc = (r.description ?? '').toLowerCase();
      const category = this.classifyMethodByName(name, desc);
      const method: ReusableMethod = {
        id: r.id,
        name: r.method_name,
        filePath: r.file_path,
        methodType: r.method_type ?? 'unknown',
        sourceCode: (r.source_code ?? '').slice(0, 1000),
        description: r.description ?? '',
        usageCount: 0,
      };
      if (category === 'assertion') supporting.assertions.push(method);
      else if (category === 'wait') supporting.waits.push(method);
      else if (category === 'data') supporting.dataAccess.push(method);
      else supporting.utilities.push(method);
    }

    // Cap each bucket to avoid bloat
    const cap = (arr: ReusableMethod[]) => arr.slice(0, 5);
    supporting.assertions = cap(supporting.assertions);
    supporting.waits = cap(supporting.waits);
    supporting.dataAccess = cap(supporting.dataAccess);
    supporting.utilities = cap(supporting.utilities);

    return {
      available: true,
      intent,
      primaryMethods,
      supportingMethods: supporting,
      relatedFlows: [], // TODO: link to business flows from profile
    };
  }

  /**
   * Classify a method by name/description heuristic (mirrors reusable-helpers.ts).
   */
  private classifyMethodByName(name: string, description: string): 'assertion' | 'wait' | 'data' | 'utility' {
    const text = `${name} ${description}`;
    if (/\b(assert|expect|verify|validate|should|must|check|confirm|ensure)\b/i.test(text)) return 'assertion';
    if (/\b(wait|until|poll|retry|delay|timeout|sleep|pause)\b/i.test(text)) return 'wait';
    if (/\b(get.*record|load.*data|read.*json|fixture|seed|dataset|testdata)\b/i.test(text)) return 'data';
    return 'utility';
  }

  /**
   * Get business flows and test coverage (which flows have tests, which don't).
   * Requires linking profile flows to method nodes (future: link layer).
   * For now returns empty — placeholder for Test Case Lab integration.
   */
  async getFlowsAndCoverage(repoContextId: number): Promise<FlowCoverageResult> {
    if (!this.enabled()) return { available: false, flows: [], untestedFlows: [] };
    // TODO: join repository_contexts.profile.businessFlows with test method nodes
    // For now return empty — requires link layer implementation
    return { available: true, flows: [], untestedFlows: [] };
  }

  /**
   * Analyze change impact: given a method ID, find all affected tests and call chains.
   * This unifies Impact Analysis service logic into the graph service.
   */
  async getChangeImpact(methodId: number, opts: { maxDepth?: number } = {}): Promise<ChangeImpactResult> {
    if (!this.enabled()) return { available: false, methodId, affectedTests: [], callChains: [] };
    const p = getPool();
    const maxDepth = Math.max(1, Math.min(opts.maxDepth ?? 5, 10));

    // Recursive CTE walking callers upward to find tests
    const res = await p.query(
      `WITH RECURSIVE impact AS (
         SELECT md.caller_method_id AS method_id, 1 AS depth
           FROM method_dependencies md WHERE md.callee_method_id = $1
         UNION
         SELECT md.caller_method_id, i.depth + 1
           FROM method_dependencies md JOIN impact i ON md.callee_method_id = i.method_id
          WHERE i.depth < $2
       )
       SELECT rm.id, rm.method_name, rm.file_path, rm.method_type, MIN(impact.depth) AS depth
         FROM impact JOIN repository_methods rm ON rm.id = impact.method_id
        GROUP BY rm.id, rm.method_name, rm.file_path, rm.method_type
        ORDER BY depth, rm.method_name`,
      [methodId, maxDepth],
    );

    const affectedTests: AffectedTest[] = [];
    const allAffected: AffectedTest[] = [];
    for (const r of res.rows) {
      const entry: AffectedTest = {
        id: r.id,
        name: r.method_name,
        filePath: r.file_path,
        depth: Number(r.depth ?? 0),
      };
      allAffected.push(entry);
      if (r.method_type === 'test') affectedTests.push(entry);
    }

    return {
      available: true,
      methodId,
      affectedTests,
      callChains: allAffected, // all callers (tests + intermediates)
    };
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 *  Intent Query Result Types
 * ────────────────────────────────────────────────────────────────────────── */

export interface ReusableMethod {
  id: number;
  name: string;
  filePath: string;
  methodType: string;
  sourceCode: string;
  description: string;
  usageCount: number;
}

export interface IntentQueryResult {
  available: boolean;
  intent: string;
  primaryMethods: ReusableMethod[]; // page objects / main helpers matching intent
  supportingMethods: {
    assertions: ReusableMethod[];
    waits: ReusableMethod[];
    dataAccess: ReusableMethod[];
    utilities: ReusableMethod[];
  };
  relatedFlows: string[]; // business flow names (from profile, future)
}

export interface FlowCoverageResult {
  available: boolean;
  flows: Array<{ name: string; tested: boolean; relatedTests: string[] }>;
  untestedFlows: string[];
}

export interface AffectedTest {
  id: number;
  name: string;
  filePath: string;
  depth: number;
}

export interface ChangeImpactResult {
  available: boolean;
  methodId: number;
  affectedTests: AffectedTest[];
  callChains: AffectedTest[]; // all affected methods (tests + intermediates)
}

export const knowledgeGraphService = new KnowledgeGraphService();
