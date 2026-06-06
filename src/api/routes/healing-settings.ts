/**
 * Healing Settings endpoints (Issue #3).
 *
 * Mounted at `/api/healing-settings`. Lets admins tune the confidence thresholds
 * that route a healing between the Rule / Pattern / AI engines, toggle the AI
 * fallback, and cap cost (per healing $ and daily token budget). Settings are
 * scoped to the request's company + project; when none are stored the engine
 * defaults apply, preserving today's behaviour.
 */

import { Router, type Request, type Response } from 'express';
import { logger } from '../../utils/logger';
import {
  getHealingSettings,
  upsertHealingSettings,
  DEFAULT_HEALING_SETTINGS,
  type HealingSettings,
} from '../../db/postgres';

const MOD = 'healing-settings-route';

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/** Validate + normalize an incoming partial settings payload. */
function sanitize(body: any): Partial<HealingSettings> {
  const out: Partial<HealingSettings> = {};
  if (body.ruleThreshold != null) out.ruleThreshold = clamp01(Number(body.ruleThreshold));
  if (body.patternThreshold != null) out.patternThreshold = clamp01(Number(body.patternThreshold));
  if (body.aiThreshold != null) out.aiThreshold = clamp01(Number(body.aiThreshold));
  if (body.aiFallbackEnabled != null) out.aiFallbackEnabled = !!body.aiFallbackEnabled;
  if (body.maxCostPerHealing != null) {
    const v = Number(body.maxCostPerHealing);
    out.maxCostPerHealing = Number.isNaN(v) || v < 0 ? 0 : v;
  }
  if (body.maxDailyTokenBudget != null) {
    const v = parseInt(String(body.maxDailyTokenBudget), 10);
    out.maxDailyTokenBudget = Number.isNaN(v) || v < 0 ? 0 : v;
  }
  return out;
}

export function createHealingSettingsRouter(): Router {
  const router = Router();

  /* ---- GET / — current effective settings (merged over defaults) ---- */
  router.get('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const settings = await getHealingSettings(companyId, projectId);
      return res.json({ settings, defaults: DEFAULT_HEALING_SETTINGS });
    } catch (err: any) {
      logger.error(MOD, 'Failed to load healing settings', { error: err.message });
      return res.status(500).json({ error: 'Failed to load healing settings', details: err.message });
    }
  });

  /* ---- PUT / — upsert settings for this company/project scope ---- */
  router.put('/', async (req: Request, res: Response) => {
    try {
      const companyId = (req as any).companyId;
      const projectId = (req as any).projectId;
      const patch = sanitize(req.body || {});
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'No valid settings provided' });
      }
      const settings = await upsertHealingSettings(patch, companyId, projectId);
      logger.info(MOD, '⚙️ Healing settings updated', { companyId, projectId, patch });
      return res.json({ settings });
    } catch (err: any) {
      logger.error(MOD, 'Failed to update healing settings', { error: err.message });
      return res.status(500).json({ error: 'Failed to update healing settings', details: err.message });
    }
  });

  return router;
}
