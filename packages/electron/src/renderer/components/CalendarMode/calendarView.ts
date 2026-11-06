import type { CalendarConnection, ImportedCalendarEvent } from '../../../shared/calendarImports';
import { calendarEventOrder } from '../GlobalSettings/panels/calendarAgenda';

export interface CalendarViewEntry {
  key: string;
  account: CalendarConnection;
  event: ImportedCalendarEvent;
}

export const calendarViewKey = (accountId: string, calendarId: string) => JSON.stringify([accountId, calendarId]);

export function calendarEntries(accounts: CalendarConnection[]): CalendarViewEntry[] {
  return accounts.flatMap(account => account.events.map(event => ({ account, event, key: JSON.stringify([account.id, event.calendarId, event.id]) })))
    .sort((a, b) => calendarEventOrder(a.event) - calendarEventOrder(b.event) || a.event.title.localeCompare(b.event.title));
}

/** Provider end dates are exclusive; timed occurrences are compared to local day boundaries. */
export function entriesForDay(entries: CalendarViewEntry[], day: string): CalendarViewEntry[] {
  const start = new Date(`${day}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return entries.filter(({ event }) => {
    if (event.allDay) return event.start <= day && day < event.end;
    const eventStart = Date.parse(event.start);
    const eventEnd = Date.parse(event.end);
    return eventStart < end.getTime() && (eventEnd > eventStart ? eventEnd > start.getTime() : eventStart >= start.getTime());
  });
}

export function calendarEventTime(event: ImportedCalendarEvent): string {
  if (event.allDay) return 'All day';
  const options: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
  return `${new Date(event.start).toLocaleTimeString(undefined, options)}–${new Date(event.end).toLocaleTimeString(undefined, options)}`;
}
