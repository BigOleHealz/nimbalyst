export const CALENDAR_PROVIDERS = [
  { id: 'google', name: 'Google Calendar' },
  { id: 'microsoft', name: 'Microsoft 365 / Exchange Online / Outlook.com' },
] as const;

export type CalendarProvider = typeof CALENDAR_PROVIDERS[number]['id'];

export interface CalendarChoice {
  id: string;
  name: string;
  primary: boolean;
}

export interface ImportedCalendarEvent {
  id: string;
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  description?: string;
  url?: string;
  notes?: CalendarMeetingNote[];
}

export interface CalendarMeetingNote {
  id: string;
  text: string;
  createdAt: string;
}

export interface CalendarMeetingReference {
  accountId: string;
  calendarId: string;
  eventId: string;
}

export interface CalendarAddNoteInput extends CalendarMeetingReference {
  text: string;
  clientMutationId: string;
}

export interface CalendarImportRange {
  start: string;
  end: string;
}

export const CALENDAR_AUTO_REFRESH_MS = 5 * 60_000;

/** Local midnight boundaries preserve whole calendar days across DST changes. */
export function calendarAutoRefreshRange(now = new Date()): CalendarImportRange {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 7);
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 91);
  return { start: start.toISOString(), end: end.toISOString() };
}

export interface CalendarConnection {
  id: string;
  provider: CalendarProvider;
  label: string;
  calendars: CalendarChoice[];
  selectedCalendarIds: string[];
  importedAt?: string;
  range?: CalendarImportRange;
  autoRefresh?: boolean;
  syncError?: string;
  events: ImportedCalendarEvent[];
}

export interface CalendarImportsSnapshot {
  connections: CalendarConnection[];
  clients: Partial<Record<CalendarProvider, { clientId: string; hasClientSecret: boolean }>>;
}

export interface CalendarConnectOptions {
  provider: CalendarProvider;
  clientId: string;
  clientSecret?: string;
}
