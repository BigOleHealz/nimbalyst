import { app, BrowserWindow, shell } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { CalendarImportService } from '../services/calendar/CalendarImportService';
import { calendarSourceUrl } from '../services/calendar/CalendarClient';
import { CalendarAutoRefresh } from '../services/calendar/CalendarAutoRefresh';
import { logger } from '../utils/logger';
import type { CalendarAddNoteInput, CalendarConnectOptions, CalendarImportRange, CalendarImportsSnapshot } from '../../shared/calendarImports';

let service: CalendarImportService | undefined;
let autoRefresh: CalendarAutoRefresh | undefined;
function calendars(): CalendarImportService { return service ??= new CalendarImportService(); }

function broadcast(snapshot: CalendarImportsSnapshot): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send('calendar-imports:changed', snapshot);
  }
}

async function mutation(operation: Promise<CalendarImportsSnapshot>): Promise<CalendarImportsSnapshot> {
  const snapshot = await operation;
  broadcast(snapshot);
  return snapshot;
}

function accountId(input: unknown): string {
  if (typeof input !== 'string' || !/^[a-f0-9]{64}$/.test(input)) throw new Error('A valid calendar account is required.');
  return input;
}

/** Shared by the calendar UI and agent tools so every write uses one service and broadcast. */
export function getCalendarImportsSnapshot(): CalendarImportsSnapshot { return calendars().snapshot(); }

export function addCalendarMeetingNote(input: CalendarAddNoteInput): Promise<CalendarImportsSnapshot> {
  accountId(input?.accountId);
  return mutation(calendars().addNote(input));
}

export function registerCalendarImportHandlers(): void {
  safeHandle('calendar-imports:get', () => calendars().snapshot());
  safeHandle('calendar-imports:add-note', (_event, input: CalendarAddNoteInput) => addCalendarMeetingNote(input));
  safeHandle('calendar-imports:connect', async (_event, input: CalendarConnectOptions) => {
    const snapshot = await mutation(calendars().connect(input));
    void autoRefresh?.refresh();
    return snapshot;
  });
  safeHandle('calendar-imports:cancel-connect', () => calendars().cancelConnect());
  safeHandle('calendar-imports:calendars', (_event, id: string) => mutation(calendars().listCalendars(accountId(id))));
  safeHandle('calendar-imports:import', (_event, input: { accountId: string; calendarIds: string[]; range?: CalendarImportRange }) => {
    if (!input) throw new Error('Choose a calendar account and date range.');
    return mutation(calendars().importEvents(accountId(input.accountId), input.calendarIds, input.range));
  });
  safeHandle('calendar-imports:auto-refresh', async (_event, input: { accountId: string; enabled: boolean }) => {
    const snapshot = await mutation(calendars().setAutoRefresh(accountId(input?.accountId), input.enabled));
    if (input.enabled) void autoRefresh?.refresh();
    return snapshot;
  });
  safeHandle('calendar-imports:disconnect', (_event, id: string) => mutation(calendars().disconnect(accountId(id))));
  safeHandle('calendar-imports:open-event', (_event, input: { accountId: string; calendarId: string; eventId: string }) => {
    const account = calendars().snapshot().connections.find(item => item.id === accountId(input?.accountId));
    const event = account?.events.find(item => item.id === input.eventId && item.calendarId === input.calendarId);
    const url = calendarSourceUrl(event?.url);
    if (!url) throw new Error('This event has no available source link.');
    return shell.openExternal(url);
  });
  if (!autoRefresh) {
    autoRefresh = new CalendarAutoRefresh(() => calendars().refreshAutomatically(), broadcast, () => {
      logger.main.warn('[CalendarAutoRefresh] Background refresh unavailable; retrying next cycle.');
    });
    autoRefresh.start();
    // before-quit may be canceled while agents are running; keep the scheduler alive until quit is certain.
    app.once('will-quit', () => { autoRefresh?.stop(); });
    app.once('before-quit', () => { void service?.cancelConnect(); });
  }
}
