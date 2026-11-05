// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { CalendarApiError, CalendarClient } from '../CalendarClient';

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const range = { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' };

it('paginates Google calendars without losing the reader access filter', async () => {
  const request = vi.fn().mockResolvedValueOnce(json({ items: [{ id: 'work', summary: 'Work', primary: true }], nextPageToken: 'next' }))
    .mockResolvedValueOnce(json({ items: [{ id: 'personal', summary: 'Personal' }] }));
  expect(await new CalendarClient(request).calendars('google', 'token')).toEqual([
    { id: 'work', name: 'Work', primary: true }, { id: 'personal', name: 'Personal', primary: false },
  ]);
  const next = request.mock.calls[1][0] as URL;
  expect(next.searchParams.get('pageToken')).toBe('next');
  expect(next.searchParams.get('minAccessRole')).toBe('reader');
});

it('imports Google occurrences, all-day dates and offsets and excludes canceled events', async () => {
  const request = vi.fn().mockResolvedValueOnce(json({ items: [
    { id: 'series_occurrence', summary: 'Meeting', start: { dateTime: '2026-11-03T09:00:00-05:00' }, end: { dateTime: '2026-11-03T10:00:00-05:00' }, htmlLink: 'javascript:alert(1)' },
    { id: 'day', summary: 'Holiday', start: { date: '2026-11-04' }, end: { date: '2026-11-05' } },
    { id: 'canceled', status: 'cancelled' },
  ] }));
  const events = await new CalendarClient(request).events('google', 'token', 'cal/id', range);
  expect(events).toMatchObject([
    { id: 'series_occurrence', start: '2026-11-03T14:00:00.000Z', allDay: false, url: undefined },
    { id: 'day', start: '2026-11-04', end: '2026-11-05', allDay: true },
  ]);
  const url = request.mock.calls[0][0] as URL;
  expect(url.pathname).toContain('cal%2Fid');
  expect(url.searchParams.get('singleEvents')).toBe('true');
  expect(url.searchParams.get('timeMin')).toBe(range.start);
});

it('expands Microsoft calendarView occurrences and follows only Graph continuations', async () => {
  const next = 'https://graph.microsoft.com/v1.0/me/calendars/work/calendarView?$skiptoken=next';
  const request = vi.fn().mockResolvedValueOnce(json({ value: [{ id: 'first', subject: 'Standup', start: { dateTime: '2026-11-03T14:00:00.0000000', timeZone: 'UTC' }, end: { dateTime: '2026-11-03T15:00:00.0000000', timeZone: 'UTC' } }], '@odata.nextLink': next }))
    .mockResolvedValueOnce(json({ value: [{ id: 'holiday', subject: 'Holiday', isAllDay: true, start: { dateTime: '2026-11-04T00:00:00' }, end: { dateTime: '2026-11-05T00:00:00' } }, { id: 'cancel', isCancelled: true }] }));
  const events = await new CalendarClient(request).events('microsoft', 'token', 'work', range);
  expect(events).toMatchObject([{ start: '2026-11-03T14:00:00.000Z', allDay: false }, { start: '2026-11-04', allDay: true }]);
  expect(request.mock.calls[1][0].href).toBe(next);
  expect(request.mock.calls[0][1].headers.Prefer).toContain('outlook.timezone="UTC"');
});

it('does not forward tokens to a malicious pagination URL or repeat a cursor forever', async () => {
  const unsafe = vi.fn().mockResolvedValue(json({ value: [], '@odata.nextLink': 'https://attacker.example/steal' }));
  await expect(new CalendarClient(unsafe).calendars('microsoft', 'secret')).rejects.toThrow('unsafe page');
  expect(unsafe).toHaveBeenCalledTimes(1);
  const repeated = vi.fn().mockImplementation(async () => json({ items: [], nextPageToken: 'same' }));
  await expect(new CalendarClient(repeated).calendars('google', 'secret')).rejects.toThrow('repeated');
  expect(repeated).toHaveBeenCalledTimes(2);
});

it('surfaces provider errors without exposing their response body', async () => {
  const request = vi.fn().mockResolvedValue(new Response('private access token', { status: 401 }));
  await expect(new CalendarClient(request).calendars('google', 'secret')).rejects.toEqual(new CalendarApiError(401));
});
