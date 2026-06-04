/**
 * Environment & Sprint Context Middleware (Phase 1 Foundation)
 *
 * Extracts the active environment / sprint for a request from:
 *   1. x-environment-id / x-sprint-id headers (set by the dashboard proxy)
 *   2. environment_id / sprint_id query parameters
 *
 * Injects (req as any).environmentId / .sprintId (number | undefined) for
 * downstream handlers and the auto-filter query helpers.
 *
 * Must run AFTER projectContextMiddleware (which sets req.projectId). When a
 * projectId is known, the provided environment / sprint ids are validated to
 * belong to that project; an invalid id is ignored (treated as "not provided")
 * so the request degrades gracefully instead of failing — backward compatible.
 */

import type { Request, Response, NextFunction } from 'express';
import { getEnvironment, getSprint } from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'context-middleware';

function parseId(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = parseInt(String(raw), 10);
  return isNaN(n) || n <= 0 ? undefined : n;
}

export async function contextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const projectId = (req as any).projectId as number | undefined;

    const envId = parseId(req.headers['x-environment-id'] ?? req.query['environment_id'] ?? req.query['environmentId']);
    const sprintId = parseId(req.headers['x-sprint-id'] ?? req.query['sprint_id'] ?? req.query['sprintId']);

    let resolvedEnv: number | undefined;
    let resolvedSprint: number | undefined;

    if (projectId) {
      if (envId) {
        const env = await getEnvironment(envId, projectId).catch(() => null);
        if (env && env.is_active) resolvedEnv = env.id;
      }
      if (sprintId) {
        const sprint = await getSprint(sprintId, projectId).catch(() => null);
        if (sprint) resolvedSprint = sprint.id;
      }
    } else {
      // No project context to validate against — pass ids through as-is.
      resolvedEnv = envId;
      resolvedSprint = sprintId;
    }

    (req as any).environmentId = resolvedEnv;
    (req as any).sprintId = resolvedSprint;
    next();
  } catch (err) {
    logger.error(MOD, 'Context resolution failed', { error: err });
    // Never block — proceed without env/sprint context.
    (req as any).environmentId = undefined;
    (req as any).sprintId = undefined;
    next();
  }
}

/**
 * Write-path helper: read the active environment / sprint context for a request
 * so record-creation handlers can stamp new rows with attribution.
 *
 * Prefers the values resolved+validated by `contextMiddleware`
 * ((req as any).environmentId / .sprintId); falls back to parsing the raw
 * headers / query params when the middleware did not run (e.g. a route that is
 * not behind contextMiddleware but still wants best-effort attribution).
 *
 * Always backward compatible — returns `undefined` for anything not present, so
 * callers pass `?? null` and let the DB triggers fill project defaults.
 */
export function getContextFromRequest(
  req: Request,
): { environmentId?: number; sprintId?: number } {
  const environmentId =
    ((req as any).environmentId as number | undefined) ??
    parseId(req.headers['x-environment-id'] ?? req.query?.['environment_id'] ?? req.query?.['environmentId']);
  const sprintId =
    ((req as any).sprintId as number | undefined) ??
    parseId(req.headers['x-sprint-id'] ?? req.query?.['sprint_id'] ?? req.query?.['sprintId']);
  return { environmentId, sprintId };
}

/**
 * Query helper: append `environment_id` / `sprint_id` equality filters to a
 * parameterised WHERE clause when the request carries that context. Returns the
 * extra SQL fragment and the params to push. Backward compatible — emits nothing
 * when no context is present.
 *
 * Usage:
 *   const { clause, params } = contextFilters(req, params.length);
 *   sql += clause; params.push(...params);
 */
export function contextFilters(
  req: Request,
  startIndex: number,
  opts: { environmentColumn?: string; sprintColumn?: string } = {},
): { clause: string; params: any[] } {
  const envCol = opts.environmentColumn ?? 'environment_id';
  const sprintCol = opts.sprintColumn ?? 'sprint_id';
  const environmentId = (req as any).environmentId as number | undefined;
  const sprintId = (req as any).sprintId as number | undefined;
  const parts: string[] = [];
  const params: any[] = [];
  let idx = startIndex;
  if (environmentId) {
    idx += 1;
    parts.push(`${envCol} = $${idx}`);
    params.push(environmentId);
  }
  if (sprintId) {
    idx += 1;
    parts.push(`${sprintCol} = $${idx}`);
    params.push(sprintId);
  }
  return { clause: parts.length ? ` AND ${parts.join(' AND ')}` : '', params };
}
