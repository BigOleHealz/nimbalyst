// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  review: true,
}));
vi.mock('electron', () => ({ BrowserWindow: {} }));
vi.mock('../../services/NotificationService', () => ({ notificationService: {} }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn() } } }));
vi.mock('../../utils/ipcRegistry', () => ({
  safeHandle: (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => mocks.handlers.set(channel, handler),
}));
vi.mock('../../utils/store', () => ({
  isSessionReviewNotificationsEnabled: () => mocks.review,
  setSessionReviewNotificationsEnabled: (enabled: boolean) => { mocks.review = enabled; },
}));
import { registerNotificationHandlers } from '../NotificationHandlers';

beforeEach(() => {
  mocks.review = true;
  mocks.handlers.clear();
  registerNotificationHandlers();
});

it('round-trips the review setting over the existing notification IPC API', async () => {
  const get = mocks.handlers.get('notifications:get-review-enabled')!;
  const set = mocks.handlers.get('notifications:set-review-enabled')!;
  expect(await get()).toBe(true);
  expect(await set({}, false)).toEqual({ success: true });
  expect(await get()).toBe(false);
  await set({}, true);
  expect(await get()).toBe(true);
});

it('rejects invalid setting values without changing the preference', async () => {
  await expect(mocks.handlers.get('notifications:set-review-enabled')!({}, 'false')).rejects.toThrow('enabled must be a boolean');
  expect(mocks.review).toBe(true);
});
