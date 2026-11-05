import type { CalendarImportRange, ImportedCalendarEvent } from '../../../../shared/calendarImports';

export function localCalendarDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** Date inputs are inclusive local days. Provider range ends are exclusive. */
export function calendarImportRange(from: string, through: string): CalendarImportRange {
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${through}T00:00:00`);
  if (localCalendarDate(start) !== from || localCalendarDate(end) !== through || end < start) throw new Error('Choose valid start and end dates.');
  end.setDate(end.getDate() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function calendarEventDay(event: ImportedCalendarEvent): string {
  return event.allDay ? event.start : localCalendarDate(new Date(event.start));
}

export function calendarEventOrder(event: ImportedCalendarEvent): number {
  return new Date(event.allDay ? `${event.start}T00:00:00` : event.start).getTime();
}
