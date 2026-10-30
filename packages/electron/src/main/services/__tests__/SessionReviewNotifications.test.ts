// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  enabled: vi.fn(() => true),
  away: vi.fn(() => true),
  show: vi.fn().mockResolvedValue(undefined),
  push: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../utils/store', () => ({ isSessionReviewNotificationsEnabled: mocks.enabled }));
vi.mock('../SyncManager', () => ({ isDesktopTrulyAway: mocks.away }));
vi.mock('../NotificationService', () => ({ notificationService: { showNotification: mocks.show } }));
vi.mock('../ai/mobilePushRequest', () => ({ requestMobilePush: mocks.push }));

import { notifySessionReview } from '../SessionReviewNotifications';

describe('review notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.enabled.mockReturnValue(true);
    mocks.away.mockReturnValue(true);
  });

  it('routes desktop and existing mobile alerts to the session', async () => {
    await notifySessionReview('s1', 'Parser', '/project', 'Ready to inspect');
    expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 's1', workspacePath: '/project', sourceLabel: 'Parser',
      title: 'Parser -- Ready for Review', body: 'Ready to inspect', kind: 'agent-complete',
    }));
    expect(mocks.push).toHaveBeenCalledWith('s1', 'Parser', 'Ready to inspect', { reason: 'session_complete' });
  });

  it('turns off both destinations independently of input alerts', async () => {
    mocks.enabled.mockReturnValue(false);
    await notifySessionReview('s1', 'Parser', '/project');
    expect(mocks.show).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('preserves mobile presence suppression', async () => {
    mocks.away.mockReturnValue(false);
    await notifySessionReview('s1', 'Parser', '/project');
    expect(mocks.show).toHaveBeenCalledTimes(1);
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it('still requests mobile delivery if the desktop notification fails', async () => {
    mocks.show.mockRejectedValueOnce(new Error('OS failed'));
    await expect(notifySessionReview('s1', 'Parser', '/project')).rejects.toThrow('OS failed');
    expect(mocks.push).toHaveBeenCalledTimes(1);
  });

  it('does not hold completion open while waiting for a mobile acknowledgement', async () => {
    mocks.push.mockImplementationOnce(() => new Promise(() => {}));
    await expect(notifySessionReview('s1', 'Parser', '/project')).resolves.toBeUndefined();
    expect(mocks.show).toHaveBeenCalledTimes(1);
  });
});
