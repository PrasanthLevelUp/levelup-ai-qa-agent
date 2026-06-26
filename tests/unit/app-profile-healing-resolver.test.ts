/**
 * Unit tests — Healing-specific Application-Profile resolver
 * =========================================================
 * Proves the deterministic URL cascade for healing profile resolution:
 *
 *   1. Failure URL (from TraceParser)
 *   2. Execution Base URL (from playwright.config or env)
 *   3. Latest Active Project Profile (last resort, project-scoped)
 *
 * All DB calls are mocked so these run without a database.
 */

const findProfileForUrl = jest.fn();
const getLatestActiveProjectProfile = jest.fn();

jest.mock('../../src/services/app-profile-healing', () => ({
  findProfileForUrl: (...a: any[]) => findProfileForUrl(...a),
  getLatestActiveProjectProfile: (...a: any[]) => getLatestActiveProjectProfile(...a),
}));

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { resolveProfileForHealing } from '../../src/services/app-profile-healing-resolver';

const PROFILE = (base: string) => ({ base_url: base, crawl_data: { elements: [] } } as any);

beforeEach(() => {
  findProfileForUrl.mockReset();
  getLatestActiveProjectProfile.mockReset();
});

describe('resolveProfileForHealing', () => {
  it('1. resolves by FAILURE URL first (most specific)', async () => {
    findProfileForUrl.mockResolvedValue(PROFILE('https://www.saucedemo.com'));
    const result = await resolveProfileForHealing(
      'https://www.saucedemo.com/inventory.html',
      'https://staging.example.com',
      '123',
      '456',
    );
    expect(result.profile?.base_url).toBe('https://www.saucedemo.com');
    expect(result.signal.source).toBe('failure_url');
    expect(result.signal.url).toBe('https://www.saucedemo.com/inventory.html');
    expect(findProfileForUrl).toHaveBeenCalledWith(
      'https://www.saucedemo.com/inventory.html',
      123,
      456,
    );
    // Should NOT call the fallback when a URL match is found
    expect(getLatestActiveProjectProfile).not.toHaveBeenCalled();
  });

  it('2. falls through to EXECUTION BASE URL when failure URL has no profile', async () => {
    findProfileForUrl.mockResolvedValueOnce(null); // failure URL miss
    findProfileForUrl.mockResolvedValueOnce(PROFILE('https://staging.example.com')); // execution base hit
    const result = await resolveProfileForHealing(
      'https://www.saucedemo.com/inventory.html',
      'https://staging.example.com',
      '123',
      '456',
    );
    expect(result.profile?.base_url).toBe('https://staging.example.com');
    expect(result.signal.source).toBe('execution_base_url');
    expect(result.signal.url).toBe('https://staging.example.com');
    expect(findProfileForUrl).toHaveBeenCalledTimes(2);
    expect(getLatestActiveProjectProfile).not.toHaveBeenCalled();
  });

  it('3. LAST RESORT: latest-active project profile when NO url matches', async () => {
    findProfileForUrl.mockResolvedValue(null); // All URL signals miss
    getLatestActiveProjectProfile.mockResolvedValue(PROFILE('https://app.example.com'));
    const result = await resolveProfileForHealing(
      'https://unknown.com',
      'https://also-unknown.com',
      '123',
      '456',
    );
    expect(result.profile?.base_url).toBe('https://app.example.com');
    expect(result.signal.source).toBe('project_latest_active');
    expect(result.signal.url).toBe('https://app.example.com');
    expect(findProfileForUrl).toHaveBeenCalledTimes(2); // failure + execution base
    expect(getLatestActiveProjectProfile).toHaveBeenCalledWith('123', '456');
  });

  it('4. returns none when nothing resolves', async () => {
    findProfileForUrl.mockResolvedValue(null);
    getLatestActiveProjectProfile.mockResolvedValue(null);
    const result = await resolveProfileForHealing(
      'https://unknown.com',
      null,
      '123',
      '456',
    );
    expect(result.profile).toBeNull();
    expect(result.signal.source).toBe('none');
    expect(result.signal.url).toBeNull();
  });

  it('5. does NOT call latest-active fallback when a URL already matched', async () => {
    findProfileForUrl.mockResolvedValue(PROFILE('https://www.saucedemo.com'));
    await resolveProfileForHealing(
      'https://www.saucedemo.com',
      null,
      '123',
      '456',
    );
    expect(getLatestActiveProjectProfile).not.toHaveBeenCalled();
  });

  it('6. de-dupes identical URL signals (no redundant lookups)', async () => {
    findProfileForUrl.mockResolvedValue(PROFILE('https://www.saucedemo.com'));
    await resolveProfileForHealing(
      'https://www.saucedemo.com',
      'https://www.saucedemo.com', // Same as failure URL
      '123',
      '456',
    );
    // Should only call findProfileForUrl ONCE (not twice) since URLs are identical
    expect(findProfileForUrl).toHaveBeenCalledTimes(1);
    expect(findProfileForUrl).toHaveBeenCalledWith('https://www.saucedemo.com', 123, 456);
  });
});
