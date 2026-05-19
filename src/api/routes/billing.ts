/**
 * Billing & Subscription API Routes
 *
 * GET  /api/billing/plans              — List all active plans
 * GET  /api/billing/plans/:slug        — Get plan by slug
 * GET  /api/billing/subscription       — Current subscription for company
 * POST /api/billing/subscribe          — Create / change subscription
 * POST /api/billing/cancel             — Cancel subscription
 * GET  /api/billing/usage              — Usage summary for current period
 * GET  /api/billing/usage/breakdown    — Per-operation credit breakdown
 * GET  /api/billing/usage/trend        — Daily usage trend
 * GET  /api/billing/credits            — Credit balance check
 * GET  /api/billing/invoices           — Invoice history
 * GET  /api/billing/events             — Billing event history
 * GET  /api/billing/payment-methods    — List payment methods
 * POST /api/billing/payment-methods    — Add payment method
 * DELETE /api/billing/payment-methods/:id — Remove payment method
 */

import { Router, type Request, type Response } from 'express';
import {
  getPlans,
  getPlanBySlug,
  getPlanById,
  getSubscription,
  createSubscription,
  updateSubscription,
  cancelSubscription,
  getUsageSummary,
  getUsageBreakdown,
  getUsageTrend,
  checkCredits,
  getInvoices,
  getBillingEvents,
  logBillingEvent,
  getPaymentMethods,
  addPaymentMethod,
  removePaymentMethod,
  ensureFreePlan,
  CREDIT_COSTS,
  getRoles,
  getTeamMembers,
  updateUserRole,
  createBillingAuditLog,
  getBillingAuditLogs,
  checkLicense,
} from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'billing-routes';

export function createBillingRouter(): Router {
  const router = Router();

  /* ── Plans ──────────────────────────────────────────────────── */

  router.get('/plans', async (_req: Request, res: Response) => {
    try {
      const plans = await getPlans();
      res.json({ success: true, data: plans });
    } catch (err: any) {
      logger.error(MOD, 'Get plans error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/plans/:slug', async (req: Request, res: Response) => {
    try {
      const plan = await getPlanBySlug(req.params.slug as string);
      if (!plan) {
        res.status(404).json({ success: false, error: 'Plan not found' });
        return;
      }
      res.json({ success: true, data: plan });
    } catch (err: any) {
      logger.error(MOD, 'Get plan error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Subscription ───────────────────────────────────────────── */

  router.get('/subscription', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      let subscription = await getSubscription(companyId);
      
      // Auto-assign free plan if no subscription exists
      if (!subscription) {
        await ensureFreePlan(companyId);
        subscription = await getSubscription(companyId);
      }

      // Get usage for context
      const usage = await getUsageSummary(companyId);

      res.json({
        success: true,
        data: {
          subscription,
          usage: {
            creditsUsed: usage.totalCreditsUsed,
            creditsAllowed: usage.creditsAllowed,
            creditsRemaining: usage.creditsRemaining,
            periodStart: usage.periodStart,
            periodEnd: usage.periodEnd,
          },
        },
      });
    } catch (err: any) {
      logger.error(MOD, 'Get subscription error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/subscribe', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const { planSlug, billingCycle, currency, gatewaySubId, gatewayCustomerId } = req.body;

      if (!planSlug) {
        res.status(400).json({ success: false, error: 'planSlug is required' });
        return;
      }

      const plan = await getPlanBySlug(planSlug);
      if (!plan) {
        res.status(404).json({ success: false, error: 'Plan not found' });
        return;
      }

      // Check if there's an existing active subscription
      const existing = await getSubscription(companyId);
      if (existing) {
        // Upgrade/downgrade: cancel old, create new
        await updateSubscription(existing.id, { status: 'cancelled', cancelledAt: new Date().toISOString() });
        await logBillingEvent({
          companyId,
          subscriptionId: existing.id,
          eventType: 'plan_change',
          description: `Changed from ${existing.plan_name} to ${plan.name}`,
        });
      }

      const subId = await createSubscription({
        companyId,
        planId: plan.id,
        billingCycle: billingCycle || 'monthly',
        currency: currency || 'USD',
        gatewaySubId,
        gatewayCustomerId,
      });

      // Log billing event
      const price = billingCycle === 'annually'
        ? (currency === 'INR' ? plan.price_inr_annually : plan.price_usd_annually)
        : (currency === 'INR' ? plan.price_inr_monthly : plan.price_usd_monthly);

      await logBillingEvent({
        companyId,
        subscriptionId: subId,
        eventType: 'subscription_created',
        amount: price,
        currency: currency || 'USD',
        description: `Subscribed to ${plan.name} (${billingCycle || 'monthly'})`,
      });

      const subscription = await getSubscription(companyId);
      res.json({ success: true, data: subscription });
    } catch (err: any) {
      logger.error(MOD, 'Subscribe error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/cancel', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const existing = await getSubscription(companyId);

      if (!existing) {
        res.status(404).json({ success: false, error: 'No active subscription to cancel' });
        return;
      }

      const cancelled = await cancelSubscription(companyId);
      if (cancelled) {
        await logBillingEvent({
          companyId,
          subscriptionId: existing.id,
          eventType: 'subscription_cancelled',
          description: `Cancelled ${existing.plan_name} plan`,
        });

        // Auto-assign free plan
        await ensureFreePlan(companyId);
      }

      res.json({ success: true, cancelled });
    } catch (err: any) {
      logger.error(MOD, 'Cancel error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Usage & Credits ────────────────────────────────────────── */

  router.get('/usage', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const summary = await getUsageSummary(companyId);
      res.json({ success: true, data: summary });
    } catch (err: any) {
      logger.error(MOD, 'Get usage error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/usage/breakdown', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const breakdown = await getUsageBreakdown(companyId);
      res.json({ success: true, data: breakdown });
    } catch (err: any) {
      logger.error(MOD, 'Get usage breakdown error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/usage/trend', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const days = parseInt(req.query.days as string) || 30;
      const trend = await getUsageTrend(companyId, days);
      res.json({ success: true, data: trend });
    } catch (err: any) {
      logger.error(MOD, 'Get usage trend error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/credits', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const required = parseInt(req.query.required as string) || 0;
      const credits = await checkCredits(companyId, required);
      res.json({ success: true, data: credits });
    } catch (err: any) {
      logger.error(MOD, 'Check credits error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Credit cost reference endpoint
  router.get('/credit-costs', async (_req: Request, res: Response) => {
    res.json({ success: true, data: CREDIT_COSTS });
  });

  /* ── Invoices & Billing Events ──────────────────────────────── */

  router.get('/invoices', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const invoices = await getInvoices(companyId);
      res.json({ success: true, data: invoices });
    } catch (err: any) {
      logger.error(MOD, 'Get invoices error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/events', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const limit = parseInt(req.query.limit as string) || 50;
      const events = await getBillingEvents(companyId, limit);
      res.json({ success: true, data: events });
    } catch (err: any) {
      logger.error(MOD, 'Get billing events error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Payment Methods ────────────────────────────────────────── */

  router.get('/payment-methods', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const methods = await getPaymentMethods(companyId);
      res.json({ success: true, data: methods });
    } catch (err: any) {
      logger.error(MOD, 'Get payment methods error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.post('/payment-methods', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const { type, lastFour, brand, expMonth, expYear, isDefault, gateway, gatewayPmId } = req.body;
      const id = await addPaymentMethod({
        companyId, type, lastFour, brand, expMonth, expYear, isDefault, gateway, gatewayPmId,
      });
      res.json({ success: true, data: { id } });
    } catch (err: any) {
      logger.error(MOD, 'Add payment method error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.delete('/payment-methods/:id', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const id = parseInt(req.params.id as string);
      const removed = await removePaymentMethod(id, companyId);
      res.json({ success: true, removed });
    } catch (err: any) {
      logger.error(MOD, 'Remove payment method error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Roles & Team ───────────────────────────────────────────── */

  router.get('/roles', async (_req: Request, res: Response) => {
    try {
      const roles = await getRoles();
      res.json({ success: true, data: roles });
    } catch (err: any) {
      logger.error(MOD, 'Get roles error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.get('/team', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const members = await getTeamMembers(companyId);
      res.json({ success: true, data: members });
    } catch (err: any) {
      logger.error(MOD, 'Get team members error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  router.put('/team/:userId/role', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const userId = parseInt(req.params.userId as string);
      const { roleSlug } = req.body;
      if (!roleSlug) {
        res.status(400).json({ success: false, error: 'roleSlug is required' });
        return;
      }
      const updated = await updateUserRole(userId, roleSlug);
      if (!updated) {
        res.status(404).json({ success: false, error: 'User not found' });
        return;
      }
      await createBillingAuditLog({
        companyId,
        userId: (req as any).userId,
        action: 'role_changed',
        category: 'team',
        severity: 'warning',
        target: `user:${userId}`,
        details: { newRole: roleSlug, targetUser: updated.username },
      });
      res.json({ success: true, data: updated });
    } catch (err: any) {
      logger.error(MOD, 'Update user role error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── Audit Logs ─────────────────────────────────────────────── */

  router.get('/audit-logs', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const { category, severity, search, limit, offset } = req.query;
      const result = await getBillingAuditLogs({
        companyId,
        category: category as string,
        severity: severity as string,
        search: search as string,
        limit: limit ? parseInt(limit as string) : 50,
        offset: offset ? parseInt(offset as string) : 0,
      });
      res.json({ success: true, data: result.logs, total: result.total });
    } catch (err: any) {
      logger.error(MOD, 'Get audit logs error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /* ── License Check ──────────────────────────────────────────── */

  router.get('/license/:operation', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const result = await checkLicense(companyId, req.params.operation as string);
      res.json({ success: true, data: result });
    } catch (err: any) {
      logger.error(MOD, 'License check error', { error: err });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
}
