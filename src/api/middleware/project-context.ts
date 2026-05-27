/**
 * Project-Context Middleware
 *
 * Extracts project_id from:
 *  1. x-project-id header (set by dashboard proxy)
 *  2. project_id query parameter
 *
 * If present, validates the project belongs to the request's company.
 * Injects req.projectId (number | undefined) for downstream handlers.
 *
 * If project_id is provided but invalid → 403 Forbidden.
 * If project_id is absent → undefined (backward compat, no project filtering).
 */

import type { Request, Response, NextFunction } from 'express';
import { validateProjectAccess } from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'project-context-middleware';

export async function projectContextMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const companyId = (req as any).companyId as number | undefined;

    // Extract project_id from header or query
    const headerProjectId = req.headers['x-project-id'];
    const queryProjectId = req.query['project_id'] || req.query['projectId'];
    const rawProjectId = headerProjectId || queryProjectId;

    if (!rawProjectId) {
      // No project context — backward compatible (no filtering)
      (req as any).projectId = undefined;
      next();
      return;
    }

    const projectId = parseInt(String(rawProjectId), 10);
    if (isNaN(projectId) || projectId <= 0) {
      (req as any).projectId = undefined;
      next();
      return;
    }

    // Validate project access
    if (companyId) {
      const project = await validateProjectAccess(projectId, companyId);
      if (!project) {
        logger.warn(MOD, 'Project access denied', { projectId, companyId });
        res.status(403).json({
          error: 'Project not found or access denied',
          code: 'PROJECT_ACCESS_DENIED',
        });
        return;
      }
    }

    (req as any).projectId = projectId;
    next();
  } catch (err) {
    logger.error(MOD, 'Project context resolution failed', { error: err });
    // Don't block — just proceed without project context
    (req as any).projectId = undefined;
    next();
  }
}
