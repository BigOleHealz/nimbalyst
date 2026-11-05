// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  services: new Map<string, { listTrackerItems: () => Promise<any[]> }>(),
  states: new Map<string, any>(),
  notify: vi.fn(async (_options: any) => ({ shown: true })),
  ensure: vi.fn(),
  schemas: vi.fn((_path: string, _type: string) => undefined),
}));
vi.mock('../../window/WindowManager', () => ({ documentServices: mocks.services }));
vi.mock('../../utils/store', () => ({
  getWorkspaceState: (path: string) => mocks.states.get(path) ?? {},
  updateWorkspaceState: (path: string, update: any) => { const state = mocks.states.get(path) ?? {}; update(state); mocks.states.set(path, state); },
}));
vi.mock('../NotificationService', () => ({ notificationService: { showNotificationWithResult: mocks.notify } }));
vi.mock('../TrackerSchemaService', () => ({ ensureWorkspaceTrackerSchemasLoaded: mocks.ensure }));
vi.mock('@nimbalyst/tracker-schema', () => ({ globalRegistry: { getForWorkspace: mocks.schemas } }));
vi.mock('../../utils/logger', () => ({ logger: { main: { warn: vi.fn(), error: vi.fn() } } }));
import { checkTaskReminders, startTaskReminders } from '../taskReminderRuntime';
afterEach(() => { vi.useRealTimers(); mocks.services.clear(); mocks.states.clear(); vi.clearAllMocks(); });
it('starts a background scheduler that routes native notifications to each workspace and stops on cleanup', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 5, 10));
  mocks.services.set('/work/client', { listTrackerItems: async () => [{ id: 't1', type: 'task', title: 'File report', status: 'to-do', workspace: '/work/client', dueDate: '2026-11-05', customFields: { scheduledDate: '2026-11-05' } }] });
  const stop = startTaskReminders();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.notify).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: '/work/client', title: 'client · 1 task needs your attention today', bypassFocusCheck: true, body: expect.stringContaining('ON 2026-11-05: File report') }));
  expect(mocks.notify.mock.calls[0][0].body).toContain('BY 2026-11-05: File report');
  expect(mocks.schemas).toHaveBeenCalledWith('/work/client', 'task');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.notify).toHaveBeenCalledTimes(1);
  stop();
  mocks.states.clear();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.notify).toHaveBeenCalledTimes(1);
  await checkTaskReminders();
  expect(mocks.notify).toHaveBeenCalledTimes(2);
});
it('uses startup plus 5am and 8am defaults after the restored workspace services are available', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 10, 5, 4));
  mocks.services.set('/work/early', { listTrackerItems: async () => [{ id: 'early', type: 'task', title: 'Morning task', status: 'to-do', workspace: '/work/early', dueDate: '2026-11-05' }] });
  const stop = startTaskReminders();
  await vi.advanceTimersByTimeAsync(0);
  expect(mocks.notify).toHaveBeenCalledTimes(1);
  expect(mocks.states.get('/work/early').taskReminders).toMatchObject({ enabled: true, times: ['05:00', '08:00'], notifyOnStartup: true });
  vi.setSystemTime(new Date(2026, 10, 5, 5));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.notify).toHaveBeenCalledTimes(2);
  vi.setSystemTime(new Date(2026, 10, 5, 8));
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.notify).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(mocks.notify).toHaveBeenCalledTimes(3);
  stop();
});
