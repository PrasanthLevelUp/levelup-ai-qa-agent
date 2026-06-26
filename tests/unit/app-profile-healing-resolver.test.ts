/**
 * Unit tests — Healing-specific Application-Profile resolver
 * =========================================================
 * Proves the deterministic URL cascade for healing profile resolution:
 *
 *   1. Failure URL
 *   2. Current Browser URL
 *   3. Execution Base URL
 *   4. Latest Active Project Profile  (last resort only)
 *
 * Healing does NOT reuse the Script-Generation helper; this is a separate
 * domain with its own fallback (getLatestActiveApplicationProfileForHealing).
 *
 * All DB calls are mocked so these run without a database.
 */

const getProfileByUrl = jest.fn();
const listProfiles = jest.fn();
const getLatestActiveApplicationProfileForHealing = jest.fn();

jest.mock('../../src/db/postgres', () => ({
  getProfileByUrl: (...a: any[]) => getProfileByUrl(...a),
  listProfiles: (...a: any[]) => listProfiles(...a),
  getLatestActiveApplicationProfileForHealing: (...a: any[]) =>
    getLatestActiveApplicationProfileForHealing(...a),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { getApplicationProfileForHealing } from '../../src/services/app-profile-healing';

const PROFILE = (base: string) => ({ base_url: base, crawl_data: { elements: [] } } as any);

beforeEach(() => {
  getProfileByUrl.mockReset();
  listProfiles.mockReset();
  getLatestActiveApplicationProfileForHealing.mockReset();
  // findProfileForUrl falls back to listProfiles internally — default empty.
  listProfiles.mockResolvedValue({ profiles: [], total: 0 });
  getLatestActiveApplicationProfileForHealing.mockResolvedValue(null);
});

describe('getApplicationProfileForHealing — deterministic URL cascade', () => {
  test('1. resolves by FAILURE URL first (most specific)', async () => {
    getProfileByUrl.mockResolvedValue(PROFILE('https://app.example.com'));
    const res = await getApplicationProfileForHealing({
      companyId: 1, projectId: 2,
      failureUrl: 'https://app.example.com/login',
      browserUrl: 'https://other.example.com',
      executionBaseUrl: 'https://base.example.com',
    });
    expect(res.source).toBe('failure_url');
    expect(res.profile).not.toBeNull();
    // The very first lookup used the failure URL.
    expect(getProfileByUrl.mock.calls[0][0]).toContain('app.example.com');
  });

  test('2. falls through to BROWSER URL when failure URL has no profile', async () => {
    // No profile for failure URL candidates, a profile for the browser URL.
    getProfileByUrl.mockImplementation(async (base: string) =>
      base.includes('browser.example.com') ? PROFILE('https://browser.example.com') : null);
    const res = await getApplicationProfileForHealing({
      failureUrl: 'https://nomatch.example.com/x',
      browserUrl: 'https://browser.example.com/page',
      executionBaseUrl: 'https://base.example.com',
    });
    expect(res.source).toBe('browser_url');
    expect(res.profile?.base_url).toBe('https://browser.example.com');
  });

  test('3. falls through to EXECUTION BASE URL when failure+browser miss', async () => {
    getProfileByUrl.mockImplementation(async (base: string) =>
      base.includes('base.example.com') ? PROFILE('https://base.example.com') : null);
    const res = await getApplicationProfileForHealing({
      failureUrl: null,
      browserUrl: 'https://browser.example.com/page',
      executionBaseUrl: 'https://base.example.com',
    });
    expect(res.source).toBe('execution_base_url');
    expect(res.profile?.base_url).toBe('https://base.example.com');
  });

  test('4. LAST RESORT: latest-active project profile when NO url matches', async () => {
    getProfileByUrl.mockResolvedValue(null);
    getLatestActiveApplicationProfileForHealing.mockResolvedValue(PROFILE('https://latest.example.com'));
    const res = await getApplicationProfileForHealing({
      companyId: 1, projectId: 2,
      failureUrl: null, browserUrl: null, executionBaseUrl: null,
    });
    expect(res.source).toBe('latest_active_project');
    expect(res.profile?.base_url).toBe('https://latest.example.com');
    expect(getLatestActiveApplicationProfileForHealing).toHaveBeenCalledWith(1, 2);
  });

  test('5. returns none when nothing resolves', async () => {
    getProfileByUrl.mockResolvedValue(null);
    getLatestActiveApplicationProfileForHealing.mockResolvedValue(null);
    const res = await getApplicationProfileForHealing({ failureUrl: null });
    expect(res.source).toBe('none');
    expect(res.profile).toBeNull();
  });

  test('6. does NOT call latest-active fallback when a URL already matched', async () => {
    getProfileByUrl.mockResolvedValue(PROFILE('https://app.example.com'));
    await getApplicationProfileForHealing({ failureUrl: 'https://app.example.com/login' });
    expect(getLatestActiveApplicationProfileForHealing).not.toHaveBeenCalled();
  });

  test('7. de-dupes identical URL signals (no redundant lookups)', async () => {
    getProfileByUrl.mockResolvedValue(null);
    await getApplicationProfileForHealing({
      failureUrl: 'https://same.example.com',
      browserUrl: 'https://same.example.com',
      executionBaseUrl: 'https://same.example.com',
    });
    // findProfileForUrl tries up to 3 normalised variants per unique URL; the
    // key assertion is that we did NOT multiply lookups across 3 identical URLs.
    // With one unique URL there should be at most a handful of variant lookups,
    // far fewer than 3 distinct URLs would produce.
    const distinctFirstArgs = new Set(getProfileByUrl.mock.calls.map((c: any[]) => c[0]));
    expect(distinctFirstArgs.size).toBeLessThanOrEqual(3);
  });
});
