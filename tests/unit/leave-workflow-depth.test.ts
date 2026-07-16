/**
 * Sprint 2 regression lock — Leave Request request/approval depth.
 *
 * Proves the two changes that lifted the Leave benchmark from 40% → 68% at the
 * planner ceiling stay in place:
 *   1. A leave/time-off request routed to a manager classifies as `workflow`
 *      (not the generic `crud` it fell into before), so it receives the
 *      request/approval knowledge instead of only generic CRUD obligations.
 *   2. The enriched `workflow` knowledge covers the specific, grounded
 *      validation opportunities a senior QA writes for a leave request — the
 *      critical Business-Rule guards (date order, insufficient balance) and the
 *      mandatory-field validation — all gated on vocabulary the requirement
 *      actually uses.
 *
 * These assertions target the *covered concepts*, not a headline percentage, so
 * they lock behaviour without being brittle to unrelated benchmark tuning.
 */

import { GOLD_BENCHMARKS } from '../../scripts/gold-benchmarks';
import { scoreBenchmark, plannerCeilingHaystacks } from '../../scripts/qa-architect-scorer';
import { classifyQACategory } from '../../src/engines/qa-knowledge-engine';

const leave = GOLD_BENCHMARKS.find((b) => b.id === 'leave')!;

describe('Leave Request — request/approval workflow depth', () => {
  it('classifies a leave request routed to a manager as workflow', () => {
    const result: any = classifyQACategory(leave.requirement as any);
    const category = typeof result === 'string' ? result : result.category;
    expect(category).toBe('workflow');
  });

  it('covers the critical Business-Rule guards and mandatory-field validation', () => {
    const score = scoreBenchmark(leave, plannerCeilingHaystacks(leave));
    const missing = new Set(score.missing.map((m) => `${m.category}/${m.name}`));

    // Critical guards that were absent when leave was misclassified as CRUD.
    expect(missing.has('Business Rule/End date before start date rejected')).toBe(false);
    expect(missing.has('Business Rule/Insufficient balance rejected')).toBe(false);

    // The four mandatory-field blanks are now all covered.
    const byCat = Object.fromEntries(score.byCategory.map((c) => [c.category, c]));
    expect(byCat['Validation'].percent).toBe(100);

    // Materially better than the 40% pre-Sprint-2 ceiling, without asserting an
    // exact number (that is the scorer's job, and it should be free to move up).
    expect(score.overallPercent).toBeGreaterThanOrEqual(60);
  });
});
