/**
 * Unit tests for the Workspace scope filter helpers (Sprint 1).
 * Verifies the core INVARIANT: every filter is additive and optional, emits
 * correct positional placeholders, and contributes nothing when absent.
 */
import {
  parseScopeId,
  parseScopeDate,
  buildDateFilter,
  buildEnvironmentFilter,
} from '../../src/db/filter-helpers';

describe('parseScopeId', () => {
  it('parses positive integers', () => {
    expect(parseScopeId('42')).toBe(42);
    expect(parseScopeId(7)).toBe(7);
  });
  it('rejects empty / invalid / non-positive', () => {
    expect(parseScopeId('')).toBeNull();
    expect(parseScopeId(undefined)).toBeNull();
    expect(parseScopeId(null)).toBeNull();
    expect(parseScopeId('abc')).toBeNull();
    expect(parseScopeId('0')).toBeNull();
    expect(parseScopeId('-3')).toBeNull();
  });
});

describe('parseScopeDate', () => {
  it('accepts YYYY-MM-DD and full ISO', () => {
    expect(parseScopeDate('2026-07-01')).toBe('2026-07-01');
    expect(parseScopeDate('2026-07-01T10:00:00Z')).toBe('2026-07-01T10:00:00Z');
  });
  it('rejects empty / invalid', () => {
    expect(parseScopeDate('')).toBeNull();
    expect(parseScopeDate(undefined)).toBeNull();
    expect(parseScopeDate('not-a-date')).toBeNull();
  });
});

describe('buildDateFilter', () => {
  it('emits nothing when no dates supplied (additive/optional invariant)', () => {
    const params: any[] = [1];
    expect(buildDateFilter(params, {})).toBe('');
    expect(params).toEqual([1]); // untouched
  });
  it('emits start-only with correct placeholder index', () => {
    const params: any[] = ['co', 5]; // 2 existing params
    const clause = buildDateFilter(params, { startDate: '2026-07-01' });
    expect(clause).toBe(' AND created_at >= $3');
    expect(params[2]).toBe('2026-07-01');
  });
  it('emits both bounds and honours a custom column', () => {
    const params: any[] = [];
    const clause = buildDateFilter(params, { startDate: '2026-07-01', endDate: '2026-07-31', column: 'ha.created_at' });
    expect(clause).toBe(' AND ha.created_at >= $1 AND ha.created_at <= $2');
    expect(params).toEqual(['2026-07-01', '2026-07-31']);
  });
  it('ignores invalid dates (no fake filtering)', () => {
    const params: any[] = [];
    expect(buildDateFilter(params, { startDate: 'garbage' })).toBe('');
    expect(params).toEqual([]);
  });
});

describe('buildEnvironmentFilter', () => {
  it('emits nothing when no id (additive/optional invariant)', () => {
    const params: any[] = [];
    expect(buildEnvironmentFilter(params, {})).toBe('');
    expect(buildEnvironmentFilter(params, { environmentId: null })).toBe('');
    expect(buildEnvironmentFilter(params, { environmentId: 0 })).toBe('');
    expect(params).toEqual([]);
  });
  it('emits equality clause with correct placeholder + custom column', () => {
    const params: any[] = ['co', 20];
    const clause = buildEnvironmentFilter(params, { environmentId: 9, column: 'ha.environment_id' });
    expect(clause).toBe(' AND ha.environment_id = $3');
    expect(params[2]).toBe(9);
  });
  it('composes with date filter using continuous placeholder numbering', () => {
    const params: any[] = ['co'];
    let clause = '';
    clause += buildEnvironmentFilter(params, { environmentId: 3 });
    clause += buildDateFilter(params, { startDate: '2026-07-01', endDate: '2026-07-31' });
    expect(clause).toBe(' AND environment_id = $2 AND created_at >= $3 AND created_at <= $4');
    expect(params).toEqual(['co', 3, '2026-07-01', '2026-07-31']);
  });
});
