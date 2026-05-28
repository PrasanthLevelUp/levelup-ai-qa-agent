/**
 * Role-Based Access Control (RBAC) Middleware
 *
 * Enforces permissions based on the user's role within their company.
 * Must run AFTER companyMiddleware (needs companyId) and sessionMiddleware (needs userId).
 *
 * Usage:
 *   router.post('/generate', requirePermission('test_coverage', 'create'), handler);
 *   router.delete('/:id', requirePermission('projects', 'delete'), handler);
 */

import type { Request, Response, NextFunction } from 'express';
import { hasPermission, logAudit } from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'rbac-middleware';

/**
 * Create a middleware that checks if the current user has the required permission.
 *
 * If userId is not available on the request (e.g., API key auth without user context),
 * the middleware passes through (backward compatible). This allows gradual adoption —
 * permissions are only enforced when user identity is known.
 */
export function requirePermission(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = (req as any).userId as number | undefined;
    const companyId = (req as any).companyId as number | undefined;

    // If no user identity resolved (API key only, no session), skip RBAC
    // This allows backward compatibility during migration
    if (!userId || !companyId) {
      logger.debug(MOD, 'Skipping RBAC — no userId on request', { resource, action });
      next();
      return;
    }

    try {
      const allowed = await hasPermission(userId, companyId, resource, action);

      if (!allowed) {
        logger.warn(MOD, 'Permission denied', { userId, companyId, resource, action });

        // Audit the denial
        try {
          await logAudit({
            user_id: userId,
            username: (req as any).username || 'unknown',
            action: 'permission_denied',
            resource,
            resource_id: req.params?.id ? String(req.params.id) : undefined,
            ip_address: req.ip || req.socket?.remoteAddress || 'unknown',
            user_agent: req.headers['user-agent'] || '',
            details: { requiredPermission: `${resource}:${action}` },
          });
        } catch { /* never block on audit */ }

        res.status(403).json({
          error: 'Insufficient permissions',
          message: `You do not have permission to ${action} ${resource}.`,
          required: `${resource}:${action}`,
        });
        return;
      }

      next();
    } catch (err) {
      logger.error(MOD, 'RBAC check failed', { error: (err as Error).message, userId, companyId, resource, action });
      // On error, deny access (fail closed)
      res.status(403).json({
        error: 'Permission check failed',
        message: 'Could not verify your permissions. Please try again.',
      });
    }
  };
}

/**
 * Middleware that requires the user to have admin role.
 * Convenience wrapper for common admin-only endpoints.
 */
export function requireAdmin() {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const userId = (req as any).userId as number | undefined;
    const companyId = (req as any).companyId as number | undefined;

    if (!userId || !companyId) {
      // No user context — allow (backward compat)
      next();
      return;
    }

    try {
      // Check if user has wildcard permission (admin)
      const allowed = await hasPermission(userId, companyId, '*', '*');
      if (!allowed) {
        res.status(403).json({
          error: 'Admin access required',
          message: 'This operation requires administrator privileges.',
        });
        return;
      }
      next();
    } catch (err) {
      logger.error(MOD, 'Admin check failed', { error: (err as Error).message });
      res.status(403).json({ error: 'Permission check failed' });
    }
  };
}
