/**
 * Generation Plan Store — ties "preview" and "execute" into ONE analysis.
 *
 * The Generation Plan is computed ONCE (POST /api/scripts/plan). The frozen
 * intelligence artifacts that back it — the `RequirementIntelligence` and the
 * `ScriptGenerationPlan` — are cached here under an opaque `planId`. When the
 * customer approves, POST /api/scripts/generate is called with that `planId`
 * and EXECUTES the already-approved plan instead of re-running the pipeline:
 *
 *     Generate Script → POST /plan ─────────────┐   (one analysis)
 *                          ↓                      │
 *                     GenerationPlan (+ planId)   │
 *                          ↓                      │
 *                     Execute → POST /generate ───┘   (reuses planId)
 *
 * This module owns NO intelligence. It is a plain, bounded, in-memory cache
 * (TTL + max size) of the frozen artifacts — never re-derives a decision.
 *
 * Bounded + self-evicting so a long-running server never leaks memory: entries
 * expire after `PLAN_TTL_MS` and the oldest are dropped past `MAX_PLANS`.
 */

import { randomUUID, createHash } from 'crypto';
import type { RequirementIntelligence } from './types';
import type { ScriptGenerationPlan } from './script-generation-consumer';
import type { GenerationPlanView } from './generation-plan-view';

/** How long an approved plan may sit before it must be recomputed. */
export const PLAN_TTL_MS = Number(process.env.GENERATION_PLAN_TTL_MS ?? 30 * 60 * 1000);
/** Hard cap on cached plans; oldest evicted first. */
export const MAX_PLANS = Number(process.env.GENERATION_PLAN_MAX ?? 500);

/** The artifacts cached for one approved plan. */
export interface StoredGenerationPlan {
  planId: string;
  createdAt: number;
  /** Identifies the request this plan was built for (see `planFingerprint`). */
  fingerprint: string;
  /** Frozen intelligence artifacts, reused verbatim at execution time. */
  intelligence: RequirementIntelligence;
  plan: ScriptGenerationPlan;
  /** The render-ready view (so the plan can be re-served without recompute). */
  view: GenerationPlanView;
}

const store = new Map<string, StoredGenerationPlan>();

/**
 * A stable fingerprint of the *inputs* a plan was built for. `/generate`
 * compares it against its own request so an approved plan can only execute the
 * request it describes (a mismatch simply falls back to a fresh analysis).
 */
export function planFingerprint(input: {
  requirementId?: string | number | null;
  testCaseId?: string | number | null;
  repoId?: string | number | null;
  testCaseIds?: Array<string | number>;
}): string {
  const norm = {
    requirementId: input.requirementId != null ? String(input.requirementId) : null,
    testCaseId: input.testCaseId != null ? String(input.testCaseId) : null,
    repoId: input.repoId != null ? String(input.repoId) : null,
    testCaseIds: (input.testCaseIds ?? []).map(String).sort(),
  };
  return createHash('sha1').update(JSON.stringify(norm)).digest('hex');
}

/** Drop expired entries, then evict oldest if over capacity. */
function sweep(): void {
  const now = Date.now();
  for (const [id, entry] of store) {
    if (now - entry.createdAt > PLAN_TTL_MS) store.delete(id);
  }
  while (store.size > MAX_PLANS) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

/** Cache the frozen artifacts for an approved plan; returns the new planId. */
export function savePlan(entry: {
  fingerprint: string;
  intelligence: RequirementIntelligence;
  plan: ScriptGenerationPlan;
  view: GenerationPlanView;
}): string {
  sweep();
  const planId = randomUUID();
  store.set(planId, { planId, createdAt: Date.now(), ...entry });
  return planId;
}

/**
 * Retrieve an approved plan by id. Returns `undefined` if unknown or expired
 * (callers then recompute — the flow degrades gracefully, never errors).
 */
export function getPlan(planId: string | undefined | null): StoredGenerationPlan | undefined {
  if (!planId) return undefined;
  const entry = store.get(planId);
  if (!entry) return undefined;
  if (Date.now() - entry.createdAt > PLAN_TTL_MS) {
    store.delete(planId);
    return undefined;
  }
  return entry;
}

/** Test-only: clear the cache. */
export function __clearPlanStore(): void {
  store.clear();
}
