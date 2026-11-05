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
}

export interface CalendarImportRange {
  start: string;
  end: string;
}

export interface CalendarConnection {
  id: string;
  provider: CalendarProvider;
  label: string;
  calendars: CalendarChoice[];
  selectedCalendarIds: string[];
  importedAt?: string;
  range?: CalendarImportRange;
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
