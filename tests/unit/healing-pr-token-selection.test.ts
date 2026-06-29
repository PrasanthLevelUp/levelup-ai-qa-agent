/**
 * Unit tests — healing PR token selection
 * =======================================
 * Bug fixed: healing "Create PR" failed with a 403 "no push permission" even
 * though script-gen "Create PR" worked on the SAME repo. Root cause: healing
 * stopped at the first NON-EMPTY token (a read-only Tools-page connection) and
 * never tried process.env.GITHUB_TOKEN — the very token script-gen uses
 * successfully.
 *
 * `selectPushableToken` fixes this: it walks the candidates in priority order
 * and returns the FIRST one that actually has push access, so a read-only token
 * earlier in the list no longer blocks a writable token later in the list.
 */

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { selectPushableToken, type TokenCandidate } from '../../src/api/routes/healing-pr';

describe('selectPushableToken', () => {
  it('returns the first candidate that has push access', async () => {
    const candidates: TokenCandidate[] = [
      { token: 'tools-readonly', source: 'connected-tools-token' },
      { token: 'env-writable', source: 'env' },
    ];
    // Tools token cannot push; env token can.
    const verify = jest.fn(async (tok: string) =>
      tok === 'env-writable' ? { ok: true } : { ok: false, status: 403, reason: 'no push' },
    );

    const { selected, failure } = await selectPushableToken(candidates, verify);

    expect(selected).toEqual({ token: 'env-writable', source: 'env' });
    expect(failure).toBeNull();
    // It tried the read-only token first, then fell through to the writable one.
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('short-circuits on the first writable candidate (does not check later ones)', async () => {
    const candidates: TokenCandidate[] = [
      { token: 'request-writable', source: 'request' },
      { token: 'tools', source: 'connected-tools-token' },
      { token: 'env', source: 'env' },
    ];
    const verify = jest.fn(async () => ({ ok: true }));

    const { selected } = await selectPushableToken(candidates, verify);

    expect(selected?.source).toBe('request');
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it('returns failure when NO candidate can push, preferring a 401/403 signal', async () => {
    const candidates: TokenCandidate[] = [
      { token: 'a', source: 'connected-tools-token' },
      { token: 'b', source: 'env' },
    ];
    const verify = jest.fn(async (tok: string) =>
      tok === 'a'
        ? { ok: false, status: 404, reason: 'not found' }
        : { ok: false, status: 403, reason: 'no push permission' },
    );

    const { selected, failure } = await selectPushableToken(candidates, verify);

    expect(selected).toBeNull();
    // 403 is preferred over the earlier 404 as the most informative failure.
    expect(failure).toEqual({ status: 403, reason: 'no push permission', source: 'env' });
  });

  it('keeps the first failure when none are 401/403', async () => {
    const candidates: TokenCandidate[] = [
      { token: 'a', source: 'connected-tools-token' },
      { token: 'b', source: 'env' },
    ];
    const verify = jest.fn(async () => ({ ok: false, status: 500, reason: 'server error' }));

    const { selected, failure } = await selectPushableToken(candidates, verify);

    expect(selected).toBeNull();
    expect(failure?.source).toBe('connected-tools-token');
    expect(failure?.status).toBe(500);
  });

  it('defaults a missing status to 403', async () => {
    const candidates: TokenCandidate[] = [{ token: 'a', source: 'env' }];
    const verify = jest.fn(async () => ({ ok: false, reason: 'nope' }));

    const { failure } = await selectPushableToken(candidates, verify);

    expect(failure?.status).toBe(403);
  });

  it('returns no selection and null failure for an empty candidate list', async () => {
    const verify = jest.fn();
    const { selected, failure } = await selectPushableToken([], verify);
    expect(selected).toBeNull();
    expect(failure).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });
});
