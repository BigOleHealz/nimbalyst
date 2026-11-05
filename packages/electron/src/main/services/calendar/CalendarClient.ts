import type { CalendarProvider, CalendarChoice, CalendarImportRange, ImportedCalendarEvent } from '../../../shared/calendarImports';

export class CalendarApiError extends Error {
  constructor(public readonly status: number) {
    super(status === 401 ? 'Calendar sign-in expired. Reconnect this account.'
      : status === 403 ? 'Calendar access was denied. Check the app permissions and your organization’s access policy.'
      : status === 429 ? 'The calendar provider is rate limiting requests. Wait and retry the import.'
      : `The calendar provider could not complete the request (${status}). Retry the import.`);
  }
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`The calendar provider returned an invalid ${field}.`);
  return value;
}

export function calendarSourceUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.toString() : undefined;
  } catch { return undefined; }
}

function eventTime(value: unknown, allDay: boolean, assumeUtc: boolean): string {
  const text = requiredString(value, 'event time');
  if (allDay) {
    const date = text.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))) throw new Error('The calendar provider returned an invalid event date.');
    return date;
  }
  // Graph returns UTC dateTime values without an offset even when UTC was requested.
  const hasOffset = /(?:Z|[+-]\d\d:\d\d)$/i.test(text);
  if (!hasOffset && !assumeUtc) throw new Error('The calendar provider returned an event without a time zone offset.');
  const instant = hasOffset ? text : `${text}Z`;
  if (!Number.isFinite(Date.parse(instant))) throw new Error('The calendar provider returned an invalid event time.');
  return new Date(instant).toISOString();
}

export class CalendarClient {
  constructor(private readonly request: typeof fetch = fetch) {}

  private async json(url: URL, token: string, headers?: Record<string, string>): Promise<any> {
    let response: Response;
    try {
      response = await this.request(url, { headers: { Authorization: `Bearer ${token}`, ...headers }, redirect: 'error', signal: AbortSignal.timeout(30_000) });
    } catch { throw new Error('The calendar provider could not be reached. Check your connection and retry.'); }
    if (!response.ok) throw new CalendarApiError(response.status);
    try { return await response.json(); }
    catch { throw new Error('The calendar provider returned an unreadable response.'); }
  }

  private async pages(provider: CalendarProvider, first: URL, token: string): Promise<any[]> {
    const records: any[] = [];
    const seen = new Set<string>();
    let url: URL | undefined = first;
    while (url) {
      if (seen.has(url.href) || seen.size >= 100) throw new Error('The calendar provider repeated or exceeded its page limit. Use a shorter date range and retry.');
      seen.add(url.href);
      const page = await this.json(url, token, provider === 'microsoft' ? { Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' } : undefined);
      const items = provider === 'google' ? page.items : page.value;
      if (!Array.isArray(items)) throw new Error('The calendar provider returned an invalid page.');
      records.push(...items);
      if (records.length > 20_000) throw new Error('This calendar has too many events. Choose a shorter date range.');
      const next = provider === 'google' ? page.nextPageToken : page['@odata.nextLink'];
      if (next !== undefined && (typeof next !== 'string' || !next)) throw new Error('The calendar provider returned an invalid page cursor.');
      if (!next) break;
      if (provider === 'google') {
        url = new URL(first);
        url.searchParams.set('pageToken', next);
      } else {
        const continuation: URL = new URL(next);
        if (continuation.origin !== 'https://graph.microsoft.com' || !continuation.pathname.startsWith('/v1.0/me/') || continuation.username || continuation.password) {
          throw new Error('The calendar provider returned an unsafe page URL.');
        }
        url = continuation;
      }
    }
    return records;
  }

  async profile(provider: CalendarProvider, token: string): Promise<{ id: string; label: string }> {
    const url = provider === 'google' ? 'https://openidconnect.googleapis.com/v1/userinfo' : 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName';
    const data = await this.json(new URL(url), token);
    return {
      id: requiredString(provider === 'google' ? data.sub : data.id, 'account ID'),
      label: requiredString(provider === 'google' ? data.email : data.mail || data.userPrincipalName || data.displayName, 'account name'),
    };
  }

  async calendars(provider: CalendarProvider, token: string): Promise<CalendarChoice[]> {
    const url = provider === 'google' ? 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&minAccessRole=reader'
      : 'https://graph.microsoft.com/v1.0/me/calendars?$top=100&$select=id,name,isDefaultCalendar';
    const rows = await this.pages(provider, new URL(url), token);
    return rows.filter(row => !row.deleted).map(row => ({
      id: requiredString(row.id, 'calendar ID'),
      name: requiredString(provider === 'google' ? row.summaryOverride || row.summary || row.id : row.name, 'calendar name'),
      primary: Boolean(provider === 'google' ? row.primary : row.isDefaultCalendar),
    }));
  }

  async events(provider: CalendarProvider, token: string, calendarId: string, range: CalendarImportRange): Promise<ImportedCalendarEvent[]> {
    const url = new URL(provider === 'google'
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`
      : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(calendarId)}/calendarView`);
    if (provider === 'google') {
      url.search = new URLSearchParams({ timeMin: range.start, timeMax: range.end, singleEvents: 'true', orderBy: 'startTime', showDeleted: 'false', maxResults: '250', timeZone: 'UTC' }).toString();
    } else {
      url.search = new URLSearchParams({ startDateTime: range.start, endDateTime: range.end, $top: '250', $select: 'id,subject,start,end,isAllDay,isCancelled,location,bodyPreview,webLink' }).toString();
    }
    const rows = await this.pages(provider, url, token);
    const events = rows.filter(row => row.status !== 'cancelled' && !row.isCancelled).map(row => {
      const allDay = provider === 'google' ? Boolean(row.start?.date) : Boolean(row.isAllDay);
      const start = eventTime(provider === 'google' ? row.start?.date || row.start?.dateTime : row.start?.dateTime, allDay, provider === 'microsoft');
      const end = eventTime(provider === 'google' ? row.end?.date || row.end?.dateTime : row.end?.dateTime, allDay, provider === 'microsoft');
      if (end <= start) throw new Error('The calendar provider returned an event ending before it starts.');
      return {
        id: requiredString(row.id, 'event ID'), calendarId, start, end, allDay,
        title: String((provider === 'google' ? row.summary : row.subject) || 'Untitled event'),
        location: typeof row.location === 'string' ? row.location : row.location?.displayName,
        description: provider === 'google' ? row.description : row.bodyPreview,
        url: calendarSourceUrl(provider === 'google' ? row.htmlLink : row.webLink),
      };
    });
    return [...new Map(events.map(event => [event.id, event])).values()];
  }
}
