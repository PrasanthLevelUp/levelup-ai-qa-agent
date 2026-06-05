/**
 * Requirements Traceability Matrix (RTM) — Sprint 2 service
 * =========================================================
 * Read/analytics layer over the RTM schema (Sprint 1). Provides the full
 * traceability matrix, gap analysis, per-requirement drill-down chain, and
 * coverage statistics.
 *
 * ── Adaptation notes (this repo's REAL schema, not a generic RTM template) ──
 * The naïve template references tables/columns that do not exist here:
 *   • `test_cases`            → real table is `generated_test_cases`
 *                               (SERIAL PK; NO deleted_at column; linked to a
 *                               requirement via the `requirement_id UUID`
 *                               column added in Sprint 1). Its real columns are
 *                               id/title/priority/severity/created_at/… — there
 *                               is no test_case_id / type / status column.
 *   • `generated_scripts`     → has `script_content`, `validation_status`
 *                               (NOT `status`), `model` (NOT `framework`),
 *                               `intelligence_metadata`, `deleted_at`,
 *                               and the `test_case_id INTEGER` link (Sprint 1).
 *   • `rtm_test_executions`   → the RTM execution log (UUID PK). The legacy
 *                               SERIAL `test_executions` table is untouched.
 *
 * Follows the repo service convention (cf. IntelligenceFusionService): a class
 * that takes an optional pg Pool and defaults to the shared application pool.
 */

import type { Pool } from 'pg';
import { getPool } from '../db/postgres';
import { logger } from '../utils/logger';

const MOD = 'rtm-service';

export interface RtmMatrixParams {
  companyId: number;
  projectId?: number | null;
  category?: string;
  priority?: string;
  status?: string;
}

export class RTMService {
  private readonly pool: Pool;

  /** Pool is optional — defaults to the shared application pool. */
  constructor(pool?: Pool) {
    this.pool = pool ?? getPool();
  }

  /**
   * Full RTM matrix: every requirement with its linked test cases, scripts,
   * latest execution, and rollup counts. Ordered by priority then recency.
   */
  async getMatrix(params: RtmMatrixParams): Promise<any[]> {
    const whereClauses: string[] = ['r.company_id = $1', 'r.deleted_at IS NULL'];
    const queryParams: any[] = [params.companyId];
    let paramIndex = 2;

    if (params.projectId !== undefined && params.projectId !== null) {
      whereClauses.push(`(r.project_id = $${paramIndex} OR r.project_id IS NULL)`);
      queryParams.push(params.projectId);
      paramIndex++;
    }
    if (params.category) {
      whereClauses.push(`r.category = $${paramIndex}`);
      queryParams.push(params.category);
      paramIndex++;
    }
    if (params.priority) {
      whereClauses.push(`r.priority = $${paramIndex}`);
      queryParams.push(params.priority);
      paramIndex++;
    }
    if (params.status) {
      whereClauses.push(`r.status = $${paramIndex}`);
      queryParams.push(params.status);
      paramIndex++;
    }

    const whereClause = whereClauses.join(' AND ');

    const query = `
      SELECT
        r.id,
        r.requirement_id,
        r.title,
        r.description,
        r.category,
        r.priority,
        r.status,
        r.coverage_percentage,
        r.acceptance_criteria,
        r.created_at,
        r.updated_at,

        -- Test cases array (generated_test_cases linked via requirement_id)
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object(
              'id', tc.id,
              'title', tc.title,
              'priority', tc.priority,
              'severity', tc.severity,
              'automation_ready', tc.automation_ready,
              'created_at', tc.created_at
            )
          ) FILTER (WHERE tc.id IS NOT NULL),
          '[]'
        ) AS test_cases,

        -- Scripts array (generated_scripts linked via test_case_id OR directly
        -- via the requirement_id FK — see the JOIN below).
        COALESCE(
          json_agg(
            DISTINCT jsonb_build_object(
              'id', gs.id,
              'test_case_id', gs.test_case_id,
              'model', gs.model,
              'validation_status', gs.validation_status,
              'reliability_score', gs.reliability_score,
              'created_at', gs.created_at
            )
          ) FILTER (WHERE gs.id IS NOT NULL),
          '[]'
        ) AS scripts,

        -- Latest RTM execution
        (
          SELECT jsonb_build_object(
            'id', te.id,
            'status', te.status,
            'executed_at', te.executed_at,
            'execution_time_ms', te.execution_time_ms,
            'healing_applied', te.healing_applied
          )
          FROM rtm_test_executions te
          WHERE te.requirement_id = r.id
          ORDER BY te.executed_at DESC
          LIMIT 1
        ) AS latest_execution,

        -- Rollup counts
        COUNT(DISTINCT tc.id)::int AS test_cases_count,
        COUNT(DISTINCT gs.id)::int AS scripts_count,
        COUNT(DISTINCT te.id)::int AS executions_count,
        COUNT(DISTINCT te.id) FILTER (WHERE te.status = 'passed')::int AS passed_count,
        COUNT(DISTINCT te.id) FILTER (WHERE te.status = 'failed')::int AS failed_count

      FROM requirements r
      LEFT JOIN generated_test_cases tc ON tc.requirement_id = r.id
      -- A script counts toward a requirement when it is linked EITHER through one
      -- of the requirement's test cases (gs.test_case_id) OR directly via the
      -- requirement FK stamped at generation time (gs.requirement_id). Counting
      -- only the test-case path left requirement-scoped scripts showing as "0"
      -- on the RTM dashboard even after a successful generation (Bug #3).
      LEFT JOIN generated_scripts gs
        ON (gs.test_case_id = tc.id OR gs.requirement_id = r.id)
        AND gs.deleted_at IS NULL
      LEFT JOIN rtm_test_executions te ON te.requirement_id = r.id
      WHERE ${whereClause}
      GROUP BY r.id
      ORDER BY
        CASE r.priority
          WHEN 'Critical' THEN 1
          WHEN 'High' THEN 2
          WHEN 'Medium' THEN 3
          WHEN 'Low' THEN 4
          ELSE 5
        END,
        r.created_at DESC
    `;

    const result = await this.pool.query(query, queryParams);
    return result.rows;
  }

  /**
   * Gap analysis: requirements that are uncovered, failing, or high-priority
   * but not fully tested. Returns categorized buckets plus a total.
   */
  async getGaps(companyId: number, projectId?: number | null): Promise<{
    no_test_cases: any[];
    no_scripts: any[];
    failed_tests: any[];
    high_priority_incomplete: any[];
    total_gaps: number;
  }> {
    const query = `
      SELECT
        r.*,
        COUNT(DISTINCT tc.id)::int AS test_cases_count,
        COUNT(DISTINCT gs.id)::int AS scripts_count
      FROM requirements r
      LEFT JOIN generated_test_cases tc ON tc.requirement_id = r.id
      LEFT JOIN generated_scripts gs ON (gs.test_case_id = tc.id OR gs.requirement_id = r.id) AND gs.deleted_at IS NULL
      WHERE r.company_id = $1
        AND ($2::int IS NULL OR r.project_id = $2)
        AND r.deleted_at IS NULL
        AND (
          -- No test cases linked
          NOT EXISTS (
            SELECT 1 FROM generated_test_cases tc2
            WHERE tc2.requirement_id = r.id
          )
          -- Failed
          OR r.status = 'Failed'
          -- High priority not fully covered
          OR (r.priority IN ('Critical', 'High') AND r.coverage_percentage < 100)
        )
      GROUP BY r.id
      ORDER BY
        CASE r.priority
          WHEN 'Critical' THEN 1
          WHEN 'High' THEN 2
          WHEN 'Medium' THEN 3
          WHEN 'Low' THEN 4
          ELSE 5
        END,
        r.coverage_percentage ASC
    `;

    const result = await this.pool.query(query, [companyId, projectId ?? null]);
    const rows = result.rows;

    return {
      no_test_cases: rows.filter((r) => Number(r.test_cases_count) === 0),
      no_scripts: rows.filter(
        (r) => Number(r.test_cases_count) > 0 && Number(r.scripts_count) === 0,
      ),
      failed_tests: rows.filter((r) => r.status === 'Failed'),
      high_priority_incomplete: rows.filter(
        (r) => ['Critical', 'High'].includes(r.priority) && Number(r.coverage_percentage) < 100,
      ),
      total_gaps: rows.length,
    };
  }

  /**
   * Complete traceability chain for a single requirement:
   * Requirement → Test Cases (+ their Scripts) → Executions, plus a coverage
   * timeline and rollup stats. Returns null if the requirement is not found.
   */
  async getTraceability(
    requirementId: string,
    companyId: number,
  ): Promise<{
    requirement: any;
    test_cases: any[];
    executions: any[];
    coverage_timeline: any[];
    stats: {
      total_test_cases: number;
      total_scripts: number;
      total_executions: number;
      passed_executions: number;
      failed_executions: number;
    };
  } | null> {
    const reqResult = await this.pool.query(
      `SELECT * FROM requirements
       WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL`,
      [requirementId, companyId],
    );
    if (reqResult.rows.length === 0) return null;
    const requirement = reqResult.rows[0];

    // Test cases with their scripts
    const tcResult = await this.pool.query(
      `SELECT
         tc.*,
         COALESCE(
           json_agg(
             jsonb_build_object(
               'id', gs.id,
               'model', gs.model,
               'validation_status', gs.validation_status,
               'reliability_score', gs.reliability_score,
               'script_content', gs.script_content,
               'intelligence_metadata', gs.intelligence_metadata,
               'created_at', gs.created_at
             )
           ) FILTER (WHERE gs.id IS NOT NULL),
           '[]'
         ) AS scripts
       FROM generated_test_cases tc
       LEFT JOIN generated_scripts gs ON gs.test_case_id = tc.id AND gs.deleted_at IS NULL
       WHERE tc.requirement_id = $1
       GROUP BY tc.id
       ORDER BY tc.created_at DESC`,
      [requirementId],
    );

    // All executions (joined to test case + script context)
    const execResult = await this.pool.query(
      `SELECT
         te.*,
         tc.title AS test_case_title,
         gs.model AS script_model
       FROM rtm_test_executions te
       LEFT JOIN generated_test_cases tc ON tc.id = te.test_case_id
       LEFT JOIN generated_scripts gs ON gs.id = te.script_id
       WHERE te.requirement_id = $1
       ORDER BY te.executed_at DESC
       LIMIT 50`,
      [requirementId],
    );

    // Coverage timeline (executions per day)
    const timelineResult = await this.pool.query(
      `SELECT
         DATE(executed_at) AS date,
         COUNT(*)::int AS total_runs,
         COUNT(*) FILTER (WHERE status = 'passed')::int AS passed,
         COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
       FROM rtm_test_executions
       WHERE requirement_id = $1
       GROUP BY DATE(executed_at)
       ORDER BY date DESC
       LIMIT 30`,
      [requirementId],
    );

    const testCases = tcResult.rows;
    const executions = execResult.rows;

    return {
      requirement,
      test_cases: testCases,
      executions,
      coverage_timeline: timelineResult.rows,
      stats: {
        total_test_cases: testCases.length,
        total_scripts: testCases.reduce(
          (acc: number, tc: any) => acc + (Array.isArray(tc.scripts) ? tc.scripts.length : 0),
          0,
        ),
        total_executions: executions.length,
        passed_executions: executions.filter((e: any) => e.status === 'passed').length,
        failed_executions: executions.filter((e: any) => e.status === 'failed').length,
      },
    };
  }

  /**
   * Coverage statistics: rollups by category, by priority, and a 30-day
   * creation/coverage trend.
   */
  async getStatistics(
    companyId: number,
    projectId?: number | null,
  ): Promise<{ by_category: any[]; by_priority: any[]; trends: any[] }> {
    const pid = projectId ?? null;

    const categoryResult = await this.pool.query(
      `SELECT
         COALESCE(category, 'Uncategorized') AS category,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE coverage_percentage > 0)::int AS covered,
         COUNT(*) FILTER (WHERE status = 'Passed')::int AS passed,
         COALESCE(ROUND(AVG(coverage_percentage))::int, 0) AS avg_coverage
       FROM requirements
       WHERE company_id = $1
         AND ($2::int IS NULL OR project_id = $2)
         AND deleted_at IS NULL
       GROUP BY COALESCE(category, 'Uncategorized')
       ORDER BY total DESC`,
      [companyId, pid],
    );

    const priorityResult = await this.pool.query(
      `SELECT
         COALESCE(priority, 'Unspecified') AS priority,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE coverage_percentage > 0)::int AS covered,
         COUNT(*) FILTER (WHERE status = 'Passed')::int AS passed,
         COALESCE(ROUND(AVG(coverage_percentage))::int, 0) AS avg_coverage
       FROM requirements
       WHERE company_id = $1
         AND ($2::int IS NULL OR project_id = $2)
         AND deleted_at IS NULL
       GROUP BY COALESCE(priority, 'Unspecified')`,
      [companyId, pid],
    );

    const trendResult = await this.pool.query(
      `SELECT
         DATE(created_at) AS date,
         COUNT(*)::int AS requirements_created,
         COUNT(*) FILTER (WHERE coverage_percentage > 0)::int AS requirements_covered
       FROM requirements
       WHERE company_id = $1
         AND ($2::int IS NULL OR project_id = $2)
         AND deleted_at IS NULL
         AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at)
       ORDER BY date DESC`,
      [companyId, pid],
    );

    logger.debug(MOD, 'statistics computed', {
      companyId,
      projectId: pid,
      categories: categoryResult.rowCount,
      priorities: priorityResult.rowCount,
    });

    return {
      by_category: categoryResult.rows,
      by_priority: priorityResult.rows,
      trends: trendResult.rows,
    };
  }
}
