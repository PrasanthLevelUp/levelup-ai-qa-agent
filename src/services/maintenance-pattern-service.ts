/**
 * Maintenance Pattern Service — Loop 3 (Maintenance → Healing).
 *
 * Closes the third self-improvement loop of the platform:
 *
 *   Script Sync / Migration Assistant  ──►  learned old→new selector library
 *                                              │
 *                                              ▼
 *                                       Self-Healing Engine
 *                                  (checks library BEFORE calling AI)
 *
 * Every time the Maintenance Suite confidently rewrites a stale locator
 * (`old → new`) during a Script Sync or a Migration apply, that rewrite is a
 * real, observed fact about how this application's DOM evolves. We distill those
 * rewrites into a reusable PATTERN LIBRARY (`maintenance_patterns`). When the
 * healing engine later encounters the same broken selector, it consults the
 * library FIRST: a high-confidence match (> 0.8) is applied instantly with ZERO
 * AI cost. A feedback loop reinforces patterns that heal successfully and
 * penalises those that don't, so the library becomes more trustworthy with use.
 *
 * PRIVACY: every operation respects `learning_scope` (project | company |
 * disabled). When the scope is "disabled" the service is a strict no-op — no
 * patterns are learned and none are applied. "company" mode shares patterns
 * across a company's projects; "project" (default) keeps them isolated.
 *
 * Everything here is ADDITIVE and FAIL-SAFE: extraction is fire-and-forget and
 * never throws into a request path, and lookups tolerate a missing table.
 */

import { logger } from '../utils/logger';
import {
  upsertMaintenancePattern,
  getMaintenancePattern,
  getMaintenancePatterns,
  recordMaintenancePatternOutcome,
  getLearningScope,
  type MaintenancePattern,
  type LearningScope,
} from '../db/postgres';
import { concreteSelectorsFromLocator } from './script-sync';

const MOD = 'maintenance-patterns';

/** Confidence at/above which a learned pattern is trusted enough to apply a
 *  heal WITHOUT consulting the AI. The product spec's "> 80% match" bar. */
export const PATTERN_APPLY_THRESHOLD = 0.8;

export interface PatternScope {
  companyId?: number;
  projectId?: number;
}

/** A single observed old→new selector rewrite to learn from. */
export interface SelectorRewrite {
  oldSelector: string;
  newSelector: string;
  /** Optional 0..100 (or 0..1) confidence reported by sync/migration. */
  confidence?: number;
}

/**
 * Resolve whether learning is permitted, plus the EFFECTIVE storage scope.
 * "disabled" → not enabled. "company" → store company-wide (drop projectId so
 * the pattern is shared across the company). "project" → keep both ids.
 */
async function resolveScope(scope: PatternScope): Promise<{
  enabled: boolean; mode: LearningScope; companyId?: number; projectId?: number;
}> {
  try {
    const mode = await getLearningScope(scope.companyId, scope.projectId);
    if (mode === 'disabled') return { enabled: false, mode, ...scope };
    if (mode === 'company') {
      return { enabled: true, mode, companyId: scope.companyId, projectId: undefined };
    }
    return { enabled: true, mode, companyId: scope.companyId, projectId: scope.projectId };
  } catch {
    // Safe default: project-isolated, enabled.
    return { enabled: true, mode: 'project', companyId: scope.companyId, projectId: scope.projectId };
  }
}

/** Normalise a confidence value (which may be 0..1 or 0..100) into 0..1. */
function normaliseConfidence(c?: number): number | undefined {
  if (c == null || Number.isNaN(c)) return undefined;
  if (c > 1) return Math.min(1, c / 100);
  return Math.max(0, Math.min(1, c));
}

/**
 * Learn a batch of old→new selector rewrites observed during a maintenance
 * operation. Fire-and-forget safe: never throws. Honors `learning_scope`.
 *
 * Each rewrite contributes its CONCRETE comparable selectors (#id,
 * [data-testid], [name]) as well as the raw locator strings, so the healing
 * engine can match on whatever form the broken selector takes.
 *
 * @returns the number of patterns written (0 when disabled / nothing learnable).
 */
export async function learnFromRewrites(
  rewrites: SelectorRewrite[],
  scope: PatternScope = {},
  source = 'script-sync',
): Promise<number> {
  if (!rewrites?.length) return 0;
  const eff = await resolveScope(scope);
  if (!eff.enabled) {
    logger.info(MOD, '🔒 Learning disabled for scope — skipping pattern extraction', { scope });
    return 0;
  }

  let written = 0;
  for (const rw of rewrites) {
    const oldLoc = (rw.oldSelector || '').trim();
    const newLoc = (rw.newSelector || '').trim();
    if (!oldLoc || !newLoc || oldLoc === newLoc) continue;

    const confidenceHint = normaliseConfidence(rw.confidence);

    // 1) Learn the raw locator → locator rewrite (handles role/text locators).
    try {
      await upsertMaintenancePattern(oldLoc, newLoc, {
        companyId: eff.companyId, projectId: eff.projectId, source, confidenceHint,
      });
      written++;
    } catch (err: any) {
      logger.warn(MOD, `upsert (raw) failed: ${err?.message || err}`);
    }

    // 2) Learn each concrete selector pairing when both sides expose one.
    const oldConcrete = concreteSelectorsFromLocator(oldLoc);
    const newConcrete = concreteSelectorsFromLocator(newLoc);
    if (oldConcrete.length && newConcrete.length) {
      const newPrimary = newConcrete[0];
      for (const oc of oldConcrete) {
        if (oc === newPrimary) continue;
        try {
          await upsertMaintenancePattern(oc, newPrimary, {
            companyId: eff.companyId, projectId: eff.projectId, source, confidenceHint,
          });
          written++;
        } catch (err: any) {
          logger.warn(MOD, `upsert (concrete) failed: ${err?.message || err}`);
        }
      }
    }
  }

  if (written) {
    logger.info(MOD, `📚 Learned ${written} maintenance pattern(s)`, { source, mode: eff.mode });
  }
  return written;
}

/**
 * Adapter for Script Sync results: extract `{ oldLocator, newLocator,
 * confidence }` changes and learn them. Safe to call fire-and-forget.
 */
export async function learnFromSyncChanges(
  changes: Array<{ oldLocator?: string; newLocator?: string; confidence?: number }> | undefined,
  scope: PatternScope = {},
): Promise<number> {
  if (!changes?.length) return 0;
  const rewrites: SelectorRewrite[] = changes
    .filter((c) => c && c.oldLocator && c.newLocator)
    .map((c) => ({ oldSelector: c.oldLocator as string, newSelector: c.newLocator as string, confidence: c.confidence }));
  return learnFromRewrites(rewrites, scope, 'script-sync');
}

/**
 * Adapter for Migration Assistant diffs: extract `{ oldSelector, newSelector }`
 * replacements and learn them. Safe to call fire-and-forget.
 */
export async function learnFromMigrationReplacements(
  replacements: Array<{ oldSelector?: string; newSelector?: string }> | undefined,
  scope: PatternScope = {},
): Promise<number> {
  if (!replacements?.length) return 0;
  const rewrites: SelectorRewrite[] = replacements
    .filter((r) => r && r.oldSelector && r.newSelector)
    .map((r) => ({ oldSelector: r.oldSelector as string, newSelector: r.newSelector as string, confidence: 90 }));
  return learnFromRewrites(rewrites, scope, 'migration');
}

/**
 * Look up the best learned replacement for a broken selector. Returns null when
 * learning is disabled for the scope, no pattern matches, or the table is
 * absent. Does NOT apply a confidence threshold — callers decide (the healing
 * engine uses PATTERN_APPLY_THRESHOLD).
 */
export async function findMaintenancePattern(
  brokenSelector: string,
  scope: PatternScope = {},
): Promise<MaintenancePattern | null> {
  if (!brokenSelector) return null;
  const eff = await resolveScope(scope);
  if (!eff.enabled) return null;
  try {
    return await getMaintenancePattern(brokenSelector, eff.companyId, eff.projectId);
  } catch (err: any) {
    logger.warn(MOD, `lookup failed: ${err?.message || err}`);
    return null;
  }
}

/** List the learned pattern library for a scope (highest confidence first). */
export async function listMaintenancePatterns(
  scope: PatternScope = {},
  limit = 100,
): Promise<MaintenancePattern[]> {
  const eff = await resolveScope(scope);
  if (!eff.enabled) return [];
  try {
    return await getMaintenancePatterns(eff.companyId, eff.projectId, limit);
  } catch (err: any) {
    logger.warn(MOD, `list failed: ${err?.message || err}`);
    return [];
  }
}

/**
 * Feedback loop entry point. After a heal that USED a learned pattern, report
 * whether it worked so the library self-improves. Fire-and-forget safe.
 */
export async function reportPatternOutcome(patternId: number | null | undefined, success: boolean): Promise<void> {
  if (!patternId) return;
  try {
    await recordMaintenancePatternOutcome(patternId, success);
  } catch (err: any) {
    logger.warn(MOD, `outcome update failed: ${err?.message || err}`);
  }
}
