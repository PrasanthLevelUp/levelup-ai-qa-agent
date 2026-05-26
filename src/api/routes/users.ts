/**
 * User Management Routes
 *
 * POST   /api/users/invite         — Invite / create a new user
 * GET    /api/users                 — List all users in company
 * GET    /api/users/:id             — Get single user details
 * PUT    /api/users/:id/role        — Update user role
 * PUT    /api/users/:id/reactivate  — Reactivate a deactivated user
 * DELETE /api/users/:id             — Deactivate (soft-delete) user
 */

import { Router, type Request, type Response } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import { logger } from '../../utils/logger';
import {
  createUser,
  getUserById,
  getUserByUsername,
  listUsers,
  updateUserRole,
  deactivateUser,
  getPool,
  logAudit,
} from '../../db/postgres';

const MOD = 'user-routes';
const SALT_ROUNDS = 12;

/* Valid roles in the system */
const VALID_ROLES = ['admin', 'qa_manager', 'qa_engineer', 'viewer', 'client'] as const;

export function createUsersRouter(): Router {
  const router = Router();

  /* ── List Users ──────────────────────────────────────────────── */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const users = await listUsers(companyId);

      // Strip password hashes from response
      const safe = users.map(({ password_hash, ...rest }) => rest);
      res.json({ success: true, data: safe });
    } catch (err: any) {
      logger.error(MOD, 'List users failed', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to list users' });
    }
  });

  /* ── Get Single User ─────────────────────────────────────────── */
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params['id'] as string, 10);
      if (isNaN(userId)) {
        return res.status(400).json({ success: false, error: 'Invalid user ID' });
      }

      const user = await getUserById(userId);
      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      const { password_hash, ...safe } = user;
      res.json({ success: true, data: safe });
    } catch (err: any) {
      logger.error(MOD, 'Get user failed', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to get user' });
    }
  });

  /* ── Invite / Create User ────────────────────────────────────── */
  router.post('/invite', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId as number;
      const { email, name, role, password } = req.body;

      if (!email) {
        return res.status(400).json({ success: false, error: 'Email is required' });
      }

      // Use email as username
      const username = email.toLowerCase().trim();

      // Check if user already exists
      const existing = await getUserByUsername(username);
      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'User with this email already exists',
          existingUser: { id: existing.id, username: existing.username, role: existing.role, is_active: existing.is_active },
        });
      }

      // Validate role
      const userRole = role || 'viewer';
      if (!VALID_ROLES.includes(userRole)) {
        return res.status(400).json({
          success: false,
          error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`,
        });
      }

      // Generate temporary password if not provided
      const tempPassword = password || crypto.randomBytes(12).toString('base64url');
      const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

      const newUser = await createUser({
        username,
        password_hash: passwordHash,
        role: userRole,
        company_name: name || username.split('@')[0],
        company_id: companyId,
      });

      // Log audit
      try {
        await logAudit({
          user_id: null,
          username: 'system',
          action: 'user_invited',
          resource: 'users',
          resource_id: String(newUser.id),
          details: { email: username, role: userRole, name },
        });
      } catch { /* non-critical */ }

      logger.info(MOD, 'User created', { userId: newUser.id, email: username, role: userRole });

      res.status(201).json({
        success: true,
        data: {
          id: newUser.id,
          username: newUser.username,
          role: newUser.role,
          company_id: newUser.company_id,
          is_active: newUser.is_active,
          created_at: newUser.created_at,
        },
        credentials: {
          email: username,
          temporaryPassword: tempPassword,
          mustChangePassword: !password,
          loginUrl: '/login',
        },
        message: `User ${username} created with role "${userRole}". Share the temporary password securely.`,
      });
    } catch (err: any) {
      logger.error(MOD, 'Invite user failed', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to create user' });
    }
  });

  /* ── Update User Role ────────────────────────────────────────── */
  router.put('/:id/role', async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params['id'] as string, 10);
      if (isNaN(userId)) {
        return res.status(400).json({ success: false, error: 'Invalid user ID' });
      }

      const { role } = req.body;
      if (!role || !VALID_ROLES.includes(role)) {
        return res.status(400).json({
          success: false,
          error: `Invalid role. Must be one of: ${VALID_ROLES.join(', ')}`,
        });
      }

      const updated = await updateUserRole(userId, role);
      if (!updated) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      // Log audit
      try {
        await logAudit({
          user_id: null,
          username: 'system',
          action: 'user_role_changed',
          resource: 'users',
          resource_id: String(userId),
          details: { newRole: role },
        });
      } catch { /* non-critical */ }

      logger.info(MOD, 'User role updated', { userId, newRole: role });

      res.json({ success: true, data: updated, message: `Role updated to "${role}"` });
    } catch (err: any) {
      logger.error(MOD, 'Update role failed', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to update role' });
    }
  });

  /* ── Reactivate User ─────────────────────────────────────────── */
  router.put('/:id/reactivate', async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params['id'] as string, 10);
      if (isNaN(userId)) {
        return res.status(400).json({ success: false, error: 'Invalid user ID' });
      }

      const pool = getPool();
      const { rows } = await pool.query(
        `UPDATE users SET is_active = true, updated_at = NOW() WHERE id = $1 RETURNING id, username, role, is_active`,
        [userId],
      );

      if (rows.length === 0) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      logger.info(MOD, 'User reactivated', { userId });
      res.json({ success: true, data: rows[0], message: 'User reactivated' });
    } catch (err: any) {
      logger.error(MOD, 'Reactivate user failed', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to reactivate user' });
    }
  });

  /* ── Deactivate User ─────────────────────────────────────────── */
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params['id'] as string, 10);
      if (isNaN(userId)) {
        return res.status(400).json({ success: false, error: 'Invalid user ID' });
      }

      const user = await getUserById(userId);
      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      await deactivateUser(userId);

      // Log audit
      try {
        await logAudit({
          user_id: null,
          username: 'system',
          action: 'user_deactivated',
          resource: 'users',
          resource_id: String(userId),
          details: { email: user.username },
        });
      } catch { /* non-critical */ }

      logger.info(MOD, 'User deactivated', { userId, username: user.username });
      res.json({ success: true, message: `User ${user.username} deactivated` });
    } catch (err: any) {
      logger.error(MOD, 'Deactivate user failed', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to deactivate user' });
    }
  });

  /* ── Reset Password ──────────────────────────────────────────── */
  router.put('/:id/reset-password', async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.params['id'] as string, 10);
      if (isNaN(userId)) {
        return res.status(400).json({ success: false, error: 'Invalid user ID' });
      }

      const user = await getUserById(userId);
      if (!user) {
        return res.status(404).json({ success: false, error: 'User not found' });
      }

      // Generate new temporary password
      const tempPassword = crypto.randomBytes(12).toString('base64url');
      const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

      const pool = getPool();
      await pool.query(
        `UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2`,
        [passwordHash, userId],
      );

      logger.info(MOD, 'Password reset', { userId });
      res.json({
        success: true,
        credentials: {
          email: user.username,
          temporaryPassword: tempPassword,
          message: 'Share this password securely. User should change it after login.',
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'Reset password failed', { error: err.message });
      res.status(500).json({ success: false, error: 'Failed to reset password' });
    }
  });

  return router;
}
