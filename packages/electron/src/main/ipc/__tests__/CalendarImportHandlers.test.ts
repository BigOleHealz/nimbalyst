// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(), snapshot: vi.fn(), connect: vi.fn(), cancelConnect: vi.fn(),
  listCalendars: vi.fn(), importEvents: vi.fn(), disconnect: vi.fn(), open: vi.fn(),
}));
vi.mock('electron', () => ({ app: { once: vi.fn() }, shell: { openExternal: h.open } }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (channel: string, handler: (...args: any[]) => any) => h.handlers.set(channel, handler) }));
vi.mock('../../services/calendar/CalendarImportService', () => ({ CalendarImportService: class {
  snapshot = h.snapshot; connect = h.connect; cancelConnect = h.cancelConnect;
  listCalendars = h.listCalendars; importEvents = h.importEvents; disconnect = h.disconnect;
} }));

import { registerCalendarImportHandlers } from '../CalendarImportHandlers';
const id = 'a'.repeat(64);
const invoke = (channel: string, ...args: any[]) => h.handlers.get(channel)!({}, ...args);
beforeEach(() => { vi.clearAllMocks(); h.handlers.clear(); registerCalendarImportHandlers(); });

it('registers calendar imports and routes an account-scoped date range', () => {
  const range = { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' };
  invoke('calendar-imports:import', { accountId: id, calendarIds: ['primary'], range });
  expect(h.importEvents).toHaveBeenCalledWith(id, ['primary'], range);
  expect(() => invoke('calendar-imports:import', { accountId: '../another-account' })).toThrow('valid calendar account');
  expect(h.importEvents).toHaveBeenCalledTimes(1);
});

it('only opens source URLs belonging to an imported event', () => {
  h.snapshot.mockReturnValue({ connections: [{ id, events: [{ id: 'event', calendarId: 'cal', url: 'https://calendar.google.com/event' }] }] });
  invoke('calendar-imports:open-event', { accountId: id, calendarId: 'cal', eventId: 'event' });
  expect(h.open).toHaveBeenCalledWith('https://calendar.google.com/event');
  expect(() => invoke('calendar-imports:open-event', { accountId: id, calendarId: 'cal', eventId: 'missing' })).toThrow('no available source');
  expect(h.open).toHaveBeenCalledTimes(1);
});
