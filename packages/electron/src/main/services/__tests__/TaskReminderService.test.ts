// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { TaskReminderService, type TaskReminderState } from '../TaskReminderService';
import type { TrackerRecord } from '@nimbalyst/tracker-core';

const task = (id: string, fields: Record<string, unknown> = {}): TrackerRecord => ({
  id, primaryType: 'task', typeTags: ['task'], archived: false, source: 'native', syncStatus: 'local',
  system: { workspace: '/project', createdAt: '', updatedAt: '' },
  fields: { title: id, status: 'to-do', ...fields },
} as TrackerRecord);
let state: TaskReminderState;
let items: TrackerRecord[];
const notify = vi.fn(async (_workspacePath: string, _title: string, _body: string) => true);
const deps = {
  workspaces: () => ['/project'],
  readState: () => state,
  writeState: (_path: string, next: TaskReminderState) => { state = next; },
  listTasks: async () => items,
  notify,
  onError: vi.fn(),
};
beforeEach(() => {
  state = { enabled: true, times: ['09:00'], notifyOnStartup: false };
  items = [task('On today', { scheduledDate: '2026-11-05' }), task('By today', { dueDate: '2026-11-05' })];
  vi.clearAllMocks();
});
it('catches up after the reminder time and persists delivery across restarts', async () => {
  const service = new TaskReminderService(deps);
  await service.check(new Date(2026, 10, 5, 8, 59));
  expect(notify).not.toHaveBeenCalled();
  await service.check(new Date(2026, 10, 5, 10));
  expect(notify).toHaveBeenCalledWith('/project', expect.stringContaining('2 tasks'), expect.stringMatching(/ON.*On today[\s\S]*BY.*By today/));
  await new TaskReminderService(deps).check(new Date(2026, 10, 5, 11));
  expect(notify).toHaveBeenCalledTimes(1);
});
it('includes overdue deadlines, skips old scheduled dates, done and archived tasks', async () => {
  items = [task('Overdue', { dueDate: '2026-11-04' }), task('Past appointment', { scheduledDate: '2026-11-04' }), task('Done', { dueDate: '2026-11-05', status: 'done' }), { ...task('Archived', { dueDate: '2026-11-05' }), archived: true }];
  await new TaskReminderService(deps).check(new Date(2026, 10, 5, 9));
  expect(notify).toHaveBeenCalledWith('/project', expect.stringContaining('1 task'), expect.stringContaining('OVERDUE BY 2026-11-04: Overdue'));
  expect(notify.mock.calls[0][2]).not.toMatch(/Done|Archived|Past appointment/);
});
it('retries suppressed delivery, respects opt-out and picks up newly dated tasks', async () => {
  const service = new TaskReminderService(deps);
  notify.mockResolvedValueOnce(false);
  await service.check(new Date(2026, 10, 5, 9));
  expect(state.delivered).toBeUndefined();
  await service.check(new Date(2026, 10, 5, 9, 1));
  items.push(task('Added later', { dueDate: '2026-11-05' }));
  await service.check(new Date(2026, 10, 5, 9, 2));
  expect(notify.mock.calls[2][2]).toBe('BY 2026-11-05: Added later');
  state.enabled = false;
  await service.check(new Date(2026, 10, 6, 9));
  expect(notify).toHaveBeenCalledTimes(3);
});
it('reminds again about overdue deadlines the next day without repeating yesterday’s appointments', async () => {
  const service = new TaskReminderService(deps);
  await service.check(new Date(2026, 10, 5, 9));
  await service.check(new Date(2026, 10, 6, 9));
  expect(notify.mock.calls[1][2]).toBe('OVERDUE BY 2026-11-05: By today');
  expect(state.delivered?.day).toBe('2026-11-06');
});
it('continues to another workspace after a load failure and keeps its notification scoped', async () => {
  const service = new TaskReminderService({
    ...deps, workspaces: () => ['/broken', '/healthy'],
    listTasks: async path => { if (path === '/broken') throw new Error('unavailable'); return items; },
  });
  await service.check(new Date(2026, 10, 5, 9));
  expect(deps.onError).toHaveBeenCalledWith('/broken', expect.any(Error));
  expect(notify).toHaveBeenCalledWith('/healthy', expect.any(String), expect.any(String));
});
it('does not run overlapping checks and isolates workspace failures', async () => {
  let release!: () => void;
  const listTasks = vi.fn(() => new Promise<TrackerRecord[]>(resolve => { release = () => resolve(items); }));
  const service = new TaskReminderService({ ...deps, listTasks });
  const checking = service.check(new Date(2026, 10, 5, 9));
  await service.check(new Date(2026, 10, 5, 9));
  expect(listTasks).toHaveBeenCalledTimes(1);
  release();
  await checking;
  await new TaskReminderService({ ...deps, listTasks: async () => { throw new Error('offline'); } }).check(new Date(2026, 10, 6, 9));
  expect(deps.onError).toHaveBeenCalledWith('/project', expect.any(Error));
});
it('notifies at startup before 5am, then independently at 5am and 8am', async () => {
  state = { enabled: true, times: ['05:00', '08:00'], notifyOnStartup: true };
  const service = new TaskReminderService(deps);
  await service.check(new Date(2026, 10, 5, 4));
  expect(notify).toHaveBeenCalledTimes(1);
  await service.check(new Date(2026, 10, 5, 4, 59));
  expect(notify).toHaveBeenCalledTimes(1);
  await service.check(new Date(2026, 10, 5, 5));
  expect(notify).toHaveBeenCalledTimes(2);
  await service.check(new Date(2026, 10, 5, 5, 1));
  expect(notify).toHaveBeenCalledTimes(2);
  items[0].fields.status = 'done';
  await service.check(new Date(2026, 10, 5, 8));
  expect(notify).toHaveBeenCalledTimes(3);
  expect(notify.mock.calls[2][2]).toBe('BY 2026-11-05: By today');
  await service.check(new Date(2026, 10, 5, 8, 1));
  expect(notify).toHaveBeenCalledTimes(3);
});
it('gives a fresh startup reminder on each app launch without duplicating elapsed daily slots', async () => {
  state = { enabled: true, times: ['05:00', '08:00'], notifyOnStartup: true };
  await new TaskReminderService(deps).check(new Date(2026, 10, 5, 10));
  expect(notify).toHaveBeenCalledTimes(1);
  const restarted = new TaskReminderService(deps);
  await restarted.check(new Date(2026, 10, 5, 11));
  expect(notify).toHaveBeenCalledTimes(2);
  await restarted.check(new Date(2026, 10, 5, 11, 1));
  expect(notify).toHaveBeenCalledTimes(2);
});
it('retries startup delivery when tasks load later or the notification is suppressed', async () => {
  state = { enabled: true, times: ['05:00', '08:00'], notifyOnStartup: true };
  const loaded = items;
  items = [];
  const service = new TaskReminderService(deps);
  await service.check(new Date(2026, 10, 5, 3));
  expect(notify).not.toHaveBeenCalled();
  items = loaded;
  notify.mockResolvedValueOnce(false);
  await service.check(new Date(2026, 10, 5, 3, 1));
  await service.check(new Date(2026, 10, 5, 3, 2));
  expect(notify).toHaveBeenCalledTimes(2);
  await service.check(new Date(2026, 10, 5, 3, 3));
  expect(notify).toHaveBeenCalledTimes(2);
});
