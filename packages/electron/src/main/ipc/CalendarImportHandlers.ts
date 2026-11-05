import { app, shell } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { CalendarImportService } from '../services/calendar/CalendarImportService';
import { calendarSourceUrl } from '../services/calendar/CalendarClient';
import type { CalendarConnectOptions, CalendarImportRange } from '../../shared/calendarImports';

let service: CalendarImportService | undefined;
function calendars(): CalendarImportService { return service ??= new CalendarImportService(); }

function accountId(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) throw new Error('A valid calendar account is required.');
  return input;
}

export function registerCalendarImportHandlers(): void {
  safeHandle('calendar-imports:get', () => calendars().snapshot());
  safeHandle('calendar-imports:connect', (_event, input: CalendarConnectOptions) => calendars().connect(input));
  safeHandle('calendar-imports:cancel-connect', () => calendars().cancelConnect());
  safeHandle('calendar-imports:calendars', (_event, id: string) => calendars().listCalendars(accountId(id)));
  safeHandle('calendar-imports:import', (_event, input: { accountId: string; calendarIds: string[]; range: CalendarImportRange }) => {
    if (!input) throw new Error('Choose a calendar account and date range.');
    return calendars().importEvents(accountId(input.accountId), input.calendarIds, input.range);
  });
  safeHandle('calendar-imports:disconnect', (_event, id: string) => calendars().disconnect(accountId(id)));
  safeHandle('calendar-imports:open-event', (_event, input: { accountId: string; calendarId: string; eventId: string }) => {
    const account = calendars().snapshot().connections.find(item => item.id === accountId(input?.accountId));
    const event = account?.events.find(item => item.id === input.eventId && item.calendarId === input.calendarId);
    const url = calendarSourceUrl(event?.url);
    if (!url) throw new Error('This event has no available source link.');
    return shell.openExternal(url);
  });
  app.once('before-quit', () => { void service?.cancelConnect(); });
}
