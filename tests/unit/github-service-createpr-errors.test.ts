/**
 * Unit tests — GitHubService.createPR error surfacing
 * ===================================================
 * Regression guard for the "Failed to create PR" black box.
 *
 * Previously createPR() swallowed every GitHub API error and returned `null`,
 * so the route could only say "Branch was pushed but PR creation failed" with
 * no reason. The real, reproduced failure was:
 *     422 Validation Failed — "No commits between main and heal/<branch>"
 * (the pushed branch had no diff vs base because the same fix was already on main).
 *
 * createPR now throws a typed GitHubPRError carrying the HTTP status, GitHub's
 * own message, and classification flags (isNoDiff / isPermission) so the UI can
 * explain WHY — while still returning the existing PR on a duplicate (422 "already exists").
 */

jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import axios from 'axios';
import { GitHubService, GitHubPRError } from '../../src/services/github-service';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function svc(): GitHubService {
  return new GitHubService({ token: 'ghu_test_token', owner: 'acme', repo: 'demo' });
}

/** Build an axios-style error with a GitHub error body. */
function ghError(status: number, body: any) {
  return { response: { status, data: body } };
}

describe('GitHubService.createPR — error surfacing', () => {
  afterEach(() => jest.resetAllMocks());

  it('returns the PR on success', async () => {
    mockedAxios.post.mockResolvedValueOnce({ data: { number: 7, html_url: 'https://github.com/acme/demo/pull/7' } });
    const pr = await svc().createPR('heal/x', 'main', { title: 't', body: 'b' });
    expect(pr).toEqual({ url: 'https://github.com/acme/demo/pull/7', number: 7 });
  });

  it('throws GitHubPRError with isNoDiff on 422 "No commits between" (the reproduced production failure)', async () => {
    mockedAxios.post.mockRejectedValueOnce(
      ghError(422, {
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequest', code: 'custom', message: 'No commits between main and heal/x' }],
      }),
    );
    // No open PR exists for the head branch → not a duplicate.
    mockedAxios.get.mockResolvedValueOnce({ data: [] });

    await expect(svc().createPR('heal/x', 'main', { title: 't', body: 'b' })).rejects.toMatchObject({
      name: 'GitHubPRError',
      status: 422,
      isNoDiff: true,
      isPermission: false,
    });
  });

  it('recovers the existing PR when 422 means "a pull request already exists"', async () => {
    mockedAxios.post.mockRejectedValueOnce(
      ghError(422, { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:heal/x.' }] }),
    );
    mockedAxios.get.mockResolvedValueOnce({
      data: [{ number: 9, html_url: 'https://github.com/acme/demo/pull/9' }],
    });
    const pr = await svc().createPR('heal/x', 'main', { title: 't', body: 'b' });
    expect(pr).toEqual({ url: 'https://github.com/acme/demo/pull/9', number: 9 });
  });

  it('throws GitHubPRError with isPermission on 403 "Resource not accessible by integration"', async () => {
    mockedAxios.post.mockRejectedValueOnce(
      ghError(403, { message: 'Resource not accessible by integration' }),
    );
    await expect(svc().createPR('heal/x', 'main', { title: 't', body: 'b' })).rejects.toMatchObject({
      name: 'GitHubPRError',
      status: 403,
      isPermission: true,
      isNoDiff: false,
    });
  });

  it('carries GitHub message + nested errors in the thrown message for any other failure', async () => {
    mockedAxios.post.mockRejectedValueOnce(
      ghError(500, { message: 'Server Error', errors: [{ message: 'something broke' }] }),
    );
    let caught: any;
    try {
      await svc().createPR('heal/x', 'main', { title: 't', body: 'b' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GitHubPRError);
    expect(caught.message).toContain('Server Error');
    expect(caught.message).toContain('something broke');
    expect(caught.status).toBe(500);
  });
});
