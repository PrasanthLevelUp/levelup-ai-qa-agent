/**
 * Companies Management Routes (Founder-Admin)
 *
 * GET    /api/companies               — List all companies (with plan/status/trial)
 * POST   /api/companies               — Create company (+ optional admin onboarding)
 * GET    /api/companies/:id           — Company detail (subscription + plan + users)
 * PUT    /api/companies/:id           — Update company (name / is_active)
 * POST   /api/companies/:id/plan      — Manually assign / change plan
 * POST   /api/companies/:id/suspend   — Kill-switch: suspend company
 * POST   /api/companies/:id/activate  — Re-activate a suspended company
 * POST   /api/companies/:id/extend-trial — Extend trial/subscription by N days
 */

import { Router } from 'express';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import {
  getCompanies,
  createCompany,
  createCompanyWithAdmin,
  getCompanyById,
  getCompanyBySlug,
  getUserByUsername,
  updateCompany,
  assignPlan,
  suspendCompany,
  activateCompany,
  extendTrial,
  logAudit,
} from '../../db/postgres';
import { clearCompanyCache } from '../middleware/company';
import { logger } from '../../utils/logger';

const MOD = 'companies-route';
const SALT_ROUNDS = 12;

function slugify(input: string): string {
  return input.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
}

export function createCompaniesRouter(): Router {
  const router = Router();

  // List all companies (enriched)
  router.get('/', async (_req, res) => {
    try {
      const companies = await getCompanies();
      res.json({ success: true, data: companies });
    } catch (err) {
      logger.error(MOD, 'Failed to list companies', { error: err });
      res.status(500).json({ success: false, error: 'Failed to list companies' });
    }
  });

  /**
   * Create a company. Two modes:
   *  1. Full onboarding (adminEmail present): creates company + admin user +
   *     subscription in one transaction, returns login credentials.
   *  2. Bare create (name + slug only): legacy behaviour.
   */
  router.post('/', async (req, res) => {
    try {
      const { name, adminName, adminEmail, planSlug, trialDays } = req.body;
      const slug = req.body.slug ? slugify(req.body.slug) : slugify(name || '');

      if (!name || !slug) {
        res.status(400).json({ success: false, error: 'name (and a derivable slug) are required' });
        return;
      }

      // ── Full onboarding path ────────────────────────────────────
      if (adminEmail) {
        const adminUsername = String(adminEmail).toLowerCase().trim();
        const plan = planSlug || 'free';
        const days = Number.isFinite(Number(trialDays)) ? Math.max(0, parseInt(String(trialDays), 10)) : 30;

        // Guard against duplicates before opening the transaction.
        if (await getCompanyBySlug(slug)) {
          res.status(409).json({ success: false, error: `Company slug '${slug}' already exists` });
          return;
        }
        if (await getUserByUsername(adminUsername)) {
          res.status(409).json({ success: false, error: `A user with email '${adminUsername}' already exists` });
          return;
        }

        // Generate a readable temporary password.
        const tempPassword = crypto.randomBytes(9).toString('base64url');
        const passwordHash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

        const result = await createCompanyWithAdmin({
          name, slug, adminUsername, adminName, passwordHash,
          planSlug: plan, trialDays: days,
          createdBy: (req as any).user?.username || 'founder-admin',
        });
        clearCompanyCache();

        res.status(201).json({
          success: true,
          data: {
            company: { id: result.companyId, name, slug },
            plan: { slug: plan, name: result.planName },
            trialDays: days,
            trialEndsAt: result.periodEnd,
            admin: {
              id: result.adminUserId,
              email: adminUsername,
              temporaryPassword: tempPassword,
            },
          },
        });
        return;
      }

      // ── Bare create path (legacy) ───────────────────────────────
      const id = await createCompany(name, slug);
      clearCompanyCache();
      res.status(201).json({ success: true, data: { id, name, slug } });
    } catch (err: any) {
      if (err.code === '23505') {
        res.status(409).json({ success: false, error: 'Company name or slug already exists' });
        return;
      }
      logger.error(MOD, 'Failed to create company', { error: err });
      res.status(500).json({ success: false, error: err.message || 'Failed to create company' });
    }
  });

  // Get company by ID (enriched detail)
  router.get('/:id', async (req, res) => {
    try {
      const company = await getCompanyById(parseInt(req.params.id, 10));
      if (!company) {
        res.status(404).json({ success: false, error: 'Company not found' });
        return;
      }
      res.json({ success: true, data: company });
    } catch (err) {
      logger.error(MOD, 'Failed to get company', { error: err });
      res.status(500).json({ success: false, error: 'Failed to get company' });
    }
  });

  // Update company (name / is_active)
  router.put('/:id', async (req, res) => {
    try {
      const { name, is_active } = req.body;
      await updateCompany(parseInt(req.params.id, 10), { name, is_active });
      clearCompanyCache();
      res.json({ success: true });
    } catch (err) {
      logger.error(MOD, 'Failed to update company', { error: err });
      res.status(500).json({ success: false, error: 'Failed to update company' });
    }
  });

  // Manually assign / change plan
  router.post('/:id/plan', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const { planSlug } = req.body;
      if (!planSlug) {
        res.status(400).json({ success: false, error: 'planSlug is required' });
        return;
      }
      const { planName, previousPlan } = await assignPlan(id, planSlug);
      await logAudit({
        user_id: null,
        username: (req as any).user?.username || 'founder-admin',
        action: 'company_plan_changed',
        resource: 'companies',
        resource_id: String(id),
        details: { from: previousPlan, to: planName, planSlug },
      }).catch(() => { /* non-critical */ });
      res.json({ success: true, data: { planName, previousPlan } });
    } catch (err: any) {
      logger.error(MOD, 'Failed to change plan', { error: err });
      res.status(500).json({ success: false, error: err.message || 'Failed to change plan' });
    }
  });

  // Kill-switch: suspend
  router.post('/:id/suspend', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      await suspendCompany(id);
      clearCompanyCache();
      await logAudit({
        user_id: null,
        username: (req as any).user?.username || 'founder-admin',
        action: 'company_suspended',
        resource: 'companies',
        resource_id: String(id),
      }).catch(() => { /* non-critical */ });
      res.json({ success: true, data: { id, is_active: false, status: 'suspended' } });
    } catch (err: any) {
      logger.error(MOD, 'Failed to suspend company', { error: err });
      res.status(500).json({ success: false, error: err.message || 'Failed to suspend company' });
    }
  });

  // Re-activate
  router.post('/:id/activate', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      await activateCompany(id);
      clearCompanyCache();
      await logAudit({
        user_id: null,
        username: (req as any).user?.username || 'founder-admin',
        action: 'company_activated',
        resource: 'companies',
        resource_id: String(id),
      }).catch(() => { /* non-critical */ });
      res.json({ success: true, data: { id, is_active: true } });
    } catch (err: any) {
      logger.error(MOD, 'Failed to activate company', { error: err });
      res.status(500).json({ success: false, error: err.message || 'Failed to activate company' });
    }
  });

  // Extend trial / subscription period
  router.post('/:id/extend-trial', async (req, res) => {
    try {
      const id = parseInt(req.params.id, 10);
      const days = parseInt(String(req.body.days), 10);
      if (!Number.isFinite(days) || days <= 0 || days > 365) {
        res.status(400).json({ success: false, error: 'days must be between 1 and 365' });
        return;
      }
      const newEnd = await extendTrial(id, days);
      if (!newEnd) {
        res.status(404).json({ success: false, error: 'No subscription found for this company' });
        return;
      }
      await logAudit({
        user_id: null,
        username: (req as any).user?.username || 'founder-admin',
        action: 'company_trial_extended',
        resource: 'companies',
        resource_id: String(id),
        details: { days, newPeriodEnd: newEnd },
      }).catch(() => { /* non-critical */ });
      res.json({ success: true, data: { id, days, trialEndsAt: newEnd } });
    } catch (err: any) {
      logger.error(MOD, 'Failed to extend trial', { error: err });
      res.status(500).json({ success: false, error: err.message || 'Failed to extend trial' });
    }
  });

  return router;
}
