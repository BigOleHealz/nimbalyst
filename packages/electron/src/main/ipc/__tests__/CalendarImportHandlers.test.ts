// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), snapshot: vi.fn(), connect: vi.fn(), cancelConnect: vi.fn(),
  listCalendars: vi.fn(), importEvents: vi.fn(), disconnect: vi.fn(), open: vi.fn(), addNote: vi.fn(),
  setAutoRefresh: vi.fn(), refreshAutomatically: vi.fn(), start: vi.fn(), stop: vi.fn(), refresh: vi.fn(),
  send: vi.fn(), lifecycle: new Map<string, () => void>(), refreshAccounts: undefined as undefined | (() => unknown),
}));
vi.mock('electron', () => ({ app: { once: (event: string, callback: () => void) => { h.lifecycle.set(event, callback); } }, shell: { openExternal: h.open }, BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { isDestroyed: () => false, send: h.send } }] } }));
vi.mock('../../utils/logger', () => ({ logger: { main: { warn: vi.fn() } } }));
vi.mock('../../services/calendar/CalendarAutoRefresh', () => ({ CalendarAutoRefresh: class {
  constructor(refresh: () => unknown) { h.refreshAccounts = refresh; }
  start = h.start; stop = h.stop; refresh = h.refresh;
} }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (channel: string, handler: (...args: any[]) => any) => h.handlers.set(channel, handler) }));
vi.mock('../../services/calendar/CalendarImportService', () => ({ CalendarImportService: class {
  snapshot = h.snapshot; connect = h.connect; cancelConnect = h.cancelConnect;
  listCalendars = h.listCalendars; importEvents = h.importEvents; disconnect = h.disconnect;
  setAutoRefresh = h.setAutoRefresh; refreshAutomatically = h.refreshAutomatically;
  addNote = h.addNote;
} }));

let registerCalendarImportHandlers: typeof import('../CalendarImportHandlers').registerCalendarImportHandlers;
const id = 'a'.repeat(64);
const invoke = (channel: string, ...args: any[]) => h.handlers.get(channel)!({}, ...args);
beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); h.handlers.clear(); h.lifecycle.clear();
  h.importEvents.mockResolvedValue({ connections: [], clients: {} });
  ({ registerCalendarImportHandlers } = await import('../CalendarImportHandlers'));
  registerCalendarImportHandlers();
});

it('registers calendar imports and routes an account-scoped date range', () => {
  const range = { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' };
  invoke('calendar-imports:import', { accountId: id, calendarIds: ['primary'], range });
  expect(h.importEvents).toHaveBeenCalledWith(id, ['primary'], range);
  expect(() => invoke('calendar-imports:import', { accountId: '../another-account' })).toThrow('valid calendar account');
  expect(h.importEvents).toHaveBeenCalledTimes(1);
});

it('saves an event note and broadcasts it to all calendar surfaces', async () => {
  const snapshot = { connections: [], clients: {} };
  h.addNote.mockResolvedValue(snapshot);
  const input = { accountId: id, calendarId: 'cal', eventId: 'event', text: 'Ask about timing', clientMutationId: 'note-1' };
  await invoke('calendar-imports:add-note', input);
  expect(h.addNote).toHaveBeenCalledWith(input);
  expect(h.send).toHaveBeenCalledWith('calendar-imports:changed', snapshot);
});

it('only opens source URLs belonging to an imported event', () => {
  h.snapshot.mockReturnValue({ connections: [{ id, events: [{ id: 'event', calendarId: 'cal', url: 'https://calendar.google.com/event' }] }] });
  invoke('calendar-imports:open-event', { accountId: id, calendarId: 'cal', eventId: 'event' });
  expect(h.open).toHaveBeenCalledWith('https://calendar.google.com/event');
  expect(() => invoke('calendar-imports:open-event', { accountId: id, calendarId: 'cal', eventId: 'missing' })).toThrow('no available source');
  expect(h.open).toHaveBeenCalledTimes(1);
});

it('starts one scheduler during main-process registration and stops it on quit', () => {
  registerCalendarImportHandlers();
  expect(h.start).toHaveBeenCalledTimes(1);
  h.refreshAccounts?.();
  expect(h.refreshAutomatically).toHaveBeenCalledTimes(1);
  h.lifecycle.get('before-quit')?.();
  expect(h.stop).not.toHaveBeenCalled();
  expect(h.cancelConnect).toHaveBeenCalledTimes(1);
  h.lifecycle.get('will-quit')?.();
  expect(h.stop).toHaveBeenCalledTimes(1);
});

it('publishes successful changes to open windows and refreshes when auto refresh is enabled', async () => {
  const snapshot = { connections: [], clients: {} };
  h.setAutoRefresh.mockResolvedValue(snapshot);
  await invoke('calendar-imports:auto-refresh', { accountId: id, enabled: true });
  expect(h.setAutoRefresh).toHaveBeenCalledWith(id, true);
  expect(h.send).toHaveBeenCalledWith('calendar-imports:changed', snapshot);
  expect(h.refresh).toHaveBeenCalledTimes(1);
});
