// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => Promise<unknown>>(),
  settings: new Map<string, any>(),
  check: vi.fn(async () => {}),
}));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (name: string, fn: any) => mocks.handlers.set(name, fn) }));
vi.mock('../../utils/store', () => ({
  getWorkspaceState: (path: string) => mocks.settings.get(path) ?? {},
  updateWorkspaceState: (path: string, update: any) => { const state = mocks.settings.get(path) ?? {}; update(state); mocks.settings.set(path, state); },
}));
vi.mock('../../services/taskReminderRuntime', () => ({ checkTaskReminders: mocks.check }));
import { registerTaskReminderHandlers } from '../TaskReminderHandlers';
beforeEach(() => { mocks.settings.clear(); mocks.handlers.clear(); vi.clearAllMocks(); registerTaskReminderHandlers(); });
it('requires a workspace and rejects invalid preference values', async () => {
  const get = mocks.handlers.get('task-reminders:get')!;
  const set = mocks.handlers.get('task-reminders:set')!;
  await expect(get({}, '')).rejects.toThrow('workspacePath');
  await expect(set({}, '/a', { enabled: true, times: ['24:00'], notifyOnStartup: true })).rejects.toThrow('times');
  await expect(set({}, '/a', { enabled: true, times: [], notifyOnStartup: true })).rejects.toThrow('times');
  await expect(set({}, '/a', { enabled: 'true', times: ['05:00'], notifyOnStartup: true })).rejects.toThrow('enabled');
  await expect(set({}, '/a', { enabled: true, times: ['05:00'], notifyOnStartup: 'yes' })).rejects.toThrow('notifyOnStartup');
  expect(mocks.settings.size).toBe(0);
});
it('persists scoped preferences while preserving the delivery ledger', async () => {
  const get = mocks.handlers.get('task-reminders:get')!;
  const set = mocks.handlers.get('task-reminders:set')!;
  mocks.settings.set('/a', { taskReminders: { enabled: true, time: '09:00', delivered: { day: '2026-11-05', keys: ['sent'] } } });
  expect(await set({}, '/a', { enabled: false, times: ['08:00', '05:00', '08:00'], notifyOnStartup: true, delivered: { keys: [] } })).toEqual({ enabled: false, times: ['05:00', '08:00'], notifyOnStartup: true });
  expect(mocks.settings.get('/a').taskReminders.delivered.keys).toEqual(['sent']);
  expect(mocks.settings.get('/a').taskReminders.time).toBeUndefined();
  expect(await get({}, '/b')).toEqual({ enabled: true, times: ['05:00', '08:00'], notifyOnStartup: true });
  expect(mocks.check).toHaveBeenCalledOnce();
});
it('reads older single-time preferences without resetting a custom time or opt-out', async () => {
  mocks.settings.set('/legacy', { taskReminders: { enabled: false, time: '06:30' } });
  expect(await mocks.handlers.get('task-reminders:get')!({}, '/legacy')).toEqual({ enabled: false, times: ['06:30'], notifyOnStartup: true });
});
it('upgrades the old 9am default to startup, 5am and 8am reminders', async () => {
  mocks.settings.set('/old-default', { taskReminders: { enabled: true, time: '09:00' } });
  expect(await mocks.handlers.get('task-reminders:get')!({}, '/old-default')).toEqual({ enabled: true, times: ['05:00', '08:00'], notifyOnStartup: true });
});
