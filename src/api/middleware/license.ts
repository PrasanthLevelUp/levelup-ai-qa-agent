/**
 * License Enforcement Middleware
 * Checks active subscription + credit balance before AI-heavy operations.
 * Attaches req.subscription and req.creditCheck for downstream handlers.
 */

import type { Request, Response, NextFunction } from 'express';
import { checkCredits, getSubscription, trackUsage, CREDIT_COSTS } from '../../db/postgres';
import { logger } from '../../utils/logger';

const MOD = 'license-middleware';

/**
 * Creates a license-checking middleware for a specific operation type.
 * @param operation - The operation key from CREDIT_COSTS (e.g. 'ai_reasoning', 'rca_analysis')
 * @param opts - Options: { skipDeduction?: boolean } - if true, only checks but doesn't deduct
 */
export function licenseCheck(operation: string, opts?: { skipDeduction?: boolean }) {
  const creditCost = CREDIT_COSTS[operation] ?? 0;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const companyId = (req as any).companyId;
    if (!companyId) {
      res.status(403).json({ error: 'Company context required for license check' });
      return;
    }

    try {
      // Check active subscription
      const subscription = await getSubscription(companyId);
      if (!subscription) {
        res.status(403).json({
          error: 'No active subscription',
          code: 'NO_SUBSCRIPTION',
          message: 'Please subscribe to a plan to use this feature.',
        });
        return;
      }

      // Check if subscription is active
      if (!['active', 'trialing'].includes(subscription.status)) {
        res.status(403).json({
          error: 'Subscription not active',
          code: 'SUBSCRIPTION_INACTIVE',
          status: subscription.status,
          message: 'Your subscription is not active. Please renew to continue.',
        });
        return;
      }

      // Check feature access based on plan
      const planFeatures = subscription.plan_features || {};
      const healingTypes = planFeatures.healing_types || ['rule_based'];

      // For healing operations, check if the strategy is allowed
      if (['rule_based', 'database_pattern', 'ai_reasoning'].includes(operation)) {
        if (!healingTypes.includes(operation)) {
          res.status(403).json({
            error: 'Feature not available',
            code: 'FEATURE_RESTRICTED',
            operation,
            plan: subscription.plan_name,
            message: `${operation} is not available on your ${subscription.plan_name} plan. Please upgrade.`,
          });
          return;
        }
      }

      // For other features, check specific feature flags
      const featureMap: Record<string, string> = {
        rca_analysis: 'rca',
        script_generation: 'script_generation',
        coverage_generation: 'coverage_generation',
        release_signoff: 'release_signoff',
        pr_automation: 'pr_automation',
      };
      if (featureMap[operation] && !planFeatures[featureMap[operation]]) {
        res.status(403).json({
          error: 'Feature not available',
          code: 'FEATURE_RESTRICTED',
          operation,
          plan: subscription.plan_name,
          message: `This feature is not available on your ${subscription.plan_name} plan. Please upgrade.`,
        });
        return;
      }

      // Check credits (skip for free operations)
      if (creditCost > 0) {
        const creditStatus = await checkCredits(companyId, creditCost);
        if (!creditStatus.allowed) {
          res.status(429).json({
            error: 'Insufficient credits',
            code: 'CREDITS_EXHAUSTED',
            required: creditCost,
            remaining: creditStatus.remaining,
            total: creditStatus.total,
            message: `This operation requires ${creditCost} credits but you only have ${creditStatus.remaining} remaining. Please upgrade your plan.`,
          });
          return;
        }

        // Attach credit info for downstream
        (req as any).creditCheck = creditStatus;
      }

      // Attach subscription for downstream
      (req as any).subscription = subscription;
      (req as any).operationCost = creditCost;
      (req as any).operationType = operation;

      next();
    } catch (err) {
      logger.error(MOD, `License check failed for operation: ${operation}`, { error: err });
      // Fail open — don't block operations if license check errors
      next();
    }
  };
}

/**
 * Deduct credits after a successful operation.
 * Call this in the route handler after the operation succeeds.
 */
export async function deductCredits(
  companyId: number,
  operation: string,
  metadata?: Record<string, any>
): Promise<void> {
  const creditCost = CREDIT_COSTS[operation] ?? 0;
  if (creditCost <= 0) return;

  try {
    await trackUsage(companyId, operation, creditCost, metadata);
    logger.info(MOD, `Deducted ${creditCost} credits for ${operation} (company: ${companyId})`);
  } catch (err) {
    logger.error(MOD, `Failed to deduct credits for ${operation}`, { error: err });
  }
}
