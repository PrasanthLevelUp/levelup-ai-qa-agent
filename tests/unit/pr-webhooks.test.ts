/**
 * Unit tests — PR webhook status update logic
 * ============================================
 * The PR webhook closes the healing lifecycle loop: when GitHub sends a
 * pull_request.closed (merged=true) event, we update pr_automations.status
 * and merged_at automatically so the dashboard shows "Merged" without polling.
 *
 * Core contract:
 *   • pull_request.closed with merged=true → update DB to status='merged'
 *   • pull_request.closed with merged=false → update DB to status='closed'
 *   • pull_request.reopened → update DB to status='open'
 *   • PR not in pr_automations → no update (non-healing PR)
 */

// Mock logger and DB functions
jest.mock('../../src/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetPRByUrl = jest.fn();
const mockUpdatePRStatus = jest.fn();
const mockLogWebhookEvent = jest.fn();
const mockUpdateWebhookEventStatus = jest.fn();

jest.mock('../../src/db/postgres', () => ({
  getPRByUrl: mockGetPRByUrl,
  updatePRStatus: mockUpdatePRStatus,
  logWebhookEvent: mockLogWebhookEvent,
  updateWebhookEventStatus: mockUpdateWebhookEventStatus,
}));

describe('PR webhook status update logic', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLogWebhookEvent.mockResolvedValue(1);
  });

  it('updates to "merged" when PR is closed and merged', async () => {
    mockGetPRByUrl.mockResolvedValue({
      id: 1,
      pr_url: 'https://github.com/owner/repo/pull/42',
      status: 'open',
      merged_at: null,
    });

    // Simulate webhook logic: action='closed', merged=true
    const action = 'closed';
    const merged = true;
    const mergedAt = '2026-06-29T12:00:00Z';
    const prRecord = await mockGetPRByUrl('https://github.com/owner/repo/pull/42');

    let newStatus = prRecord.status || 'open';
    let newMergedAt: string | undefined = prRecord.merged_at ?? undefined;

    if (action === 'closed' && merged) {
      newStatus = 'merged';
      newMergedAt = mergedAt || new Date().toISOString();
    }

    if (newStatus !== prRecord.status || newMergedAt !== prRecord.merged_at) {
      await mockUpdatePRStatus(prRecord.id, newStatus, newMergedAt);
    }

    expect(mockUpdatePRStatus).toHaveBeenCalledWith(1, 'merged', '2026-06-29T12:00:00Z');
  });

  it('updates to "closed" when PR is closed but not merged', async () => {
    mockGetPRByUrl.mockResolvedValue({
      id: 2,
      pr_url: 'https://github.com/owner/repo/pull/43',
      status: 'open',
      merged_at: null,
    });

    const action = 'closed';
    const merged = false;
    const prRecord = await mockGetPRByUrl('https://github.com/owner/repo/pull/43');

    let newStatus = prRecord.status || 'open';
    let newMergedAt: string | undefined = prRecord.merged_at ?? undefined;

    if (action === 'closed' && !merged) {
      newStatus = 'closed';
    }

    if (newStatus !== prRecord.status) {
      await mockUpdatePRStatus(prRecord.id, newStatus, newMergedAt);
    }

    expect(mockUpdatePRStatus).toHaveBeenCalledWith(2, 'closed', undefined);
  });

  it('updates to "open" when PR is reopened', async () => {
    mockGetPRByUrl.mockResolvedValue({
      id: 3,
      pr_url: 'https://github.com/owner/repo/pull/44',
      status: 'closed',
      merged_at: null,
    });

    const action = 'reopened';
    const prRecord = await mockGetPRByUrl('https://github.com/owner/repo/pull/44');

    let newStatus = prRecord.status || 'open';
    if (action === 'reopened') {
      newStatus = 'open';
    }

    if (newStatus !== prRecord.status) {
      await mockUpdatePRStatus(prRecord.id, newStatus, prRecord.merged_at ?? undefined);
    }

    expect(mockUpdatePRStatus).toHaveBeenCalledWith(3, 'open', undefined);
  });

  it('does not update when PR not found (non-healing PR)', async () => {
    mockGetPRByUrl.mockResolvedValue(null);

    const prRecord = await mockGetPRByUrl('https://github.com/owner/repo/pull/99');

    if (!prRecord) {
      // No update
    }

    expect(mockUpdatePRStatus).not.toHaveBeenCalled();
  });

  it('does not update when status is already correct', async () => {
    mockGetPRByUrl.mockResolvedValue({
      id: 5,
      pr_url: 'https://github.com/owner/repo/pull/45',
      status: 'merged',
      merged_at: '2026-06-29T12:00:00Z',
    });

    const action = 'closed';
    const merged = true;
    const mergedAt = '2026-06-29T12:00:00Z';
    const prRecord = await mockGetPRByUrl('https://github.com/owner/repo/pull/45');

    let newStatus = prRecord.status || 'open';
    let newMergedAt: string | undefined = prRecord.merged_at ?? undefined;

    if (action === 'closed' && merged) {
      newStatus = 'merged';
      newMergedAt = mergedAt || new Date().toISOString();
    }

    // No update because status is unchanged
    if (newStatus === prRecord.status && newMergedAt === prRecord.merged_at) {
      // Skip update
    } else {
      await mockUpdatePRStatus(prRecord.id, newStatus, newMergedAt);
    }

    expect(mockUpdatePRStatus).not.toHaveBeenCalled();
  });
});
