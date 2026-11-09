// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CalendarImportsSnapshot } from '../../../shared/calendarImports';
import { FIRST_PARTY_TOOL_TO_SERVER, MCP_SITUATIONAL } from '@nimbalyst/runtime/ai/server/services/mcpTopology';

const h = vi.hoisted(() => ({ snapshot: vi.fn(), addNote: vi.fn() }));
vi.mock('../../ipc/CalendarImportHandlers', () => ({ getCalendarImportsSnapshot: h.snapshot, addCalendarMeetingNote: h.addNote }));
import { calendarToolSchemas, handleCalendarAddNote, handleCalendarListMeetings } from '../tools/calendarToolHandlers';

let snapshot: CalendarImportsSnapshot;
const request = { text: 'Discuss the budget', clientMutationId: 'request-1' };
const decode = (value: { content: { text: string }[] }) => JSON.parse(value.content[0].text);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-07T12:00:00Z'));
  vi.clearAllMocks();
  snapshot = { clients: {}, connections: [{
    id: 'account', provider: 'google', label: 'me@work.test', calendars: [{ id: 'work', name: 'Work', primary: true }], selectedCalendarIds: ['work'],
    importedAt: '2026-11-07T11:58:00Z', events: [
      { id: 'past', calendarId: 'work', title: 'Past meeting', start: '2026-11-06T13:00:00Z', end: '2026-11-06T14:00:00Z', allDay: false },
      { id: 'review', calendarId: 'work', title: 'Design review', start: '2026-11-08T13:00:00Z', end: '2026-11-08T14:00:00Z', allDay: false },
      { id: 'planning', calendarId: 'work', title: 'Planning', start: '2026-11-09T13:00:00Z', end: '2026-11-09T14:00:00Z', allDay: false },
    ],
  }] };
  h.snapshot.mockImplementation(() => structuredClone(snapshot));
  h.addNote.mockResolvedValue(snapshot);
});
afterEach(() => { vi.useRealTimers(); });

it('discovers upcoming meetings with occurrence IDs, notes, source freshness, and local time zone', () => {
  snapshot.connections[0].events[1].notes = [{ id: 'note', text: 'Existing prep', createdAt: '2026-11-07T11:00:00Z' }];
  const result = decode(handleCalendarListMeetings({}));
  expect(result.meetings.map((meeting: any) => meeting.eventId)).toEqual(['review', 'planning']);
  expect(result.meetings[0]).toMatchObject({ accountId: 'account', calendarId: 'work', calendar: 'Work', account: 'me@work.test', notes: [{ text: 'Existing prep' }] });
  expect(result.sources[0].importedAt).toBe('2026-11-07T11:58:00Z');
  expect(result.timeZone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
});

it('asks which meeting for a vague note without saving, including when only one meeting exists', async () => {
  let result = decode(await handleCalendarAddNote(request));
  expect(result.status).toBe('needs_selection');
  expect(result.meetings).toHaveLength(2);
  snapshot.connections[0].events.splice(2, 1);
  result = decode(await handleCalendarAddNote(request));
  expect(result.status).toBe('needs_selection');
  expect(h.addNote).not.toHaveBeenCalled();
});

it('adds a note directly when the supplied meeting title is unique', async () => {
  const result = decode(await handleCalendarAddNote({ ...request, filter: { title: 'DESIGN review' } }));
  expect(result).toMatchObject({ status: 'saved', meeting: { title: 'Design review', eventId: 'review' } });
  expect(h.addNote).toHaveBeenCalledWith({ ...request, accountId: 'account', calendarId: 'work', eventId: 'review' });
});

it('asks about recurring titles, then saves only the occurrence chosen by the user', async () => {
  snapshot.connections[0].events.push({ ...snapshot.connections[0].events[1], id: 'review-next-week', start: '2026-11-15T13:00:00Z', end: '2026-11-15T14:00:00Z' });
  const ambiguous = decode(await handleCalendarAddNote({ ...request, filter: { title: 'Design review' } }));
  expect(ambiguous.status).toBe('needs_selection');
  expect(h.addNote).not.toHaveBeenCalled();
  const chosen = ambiguous.meetings[1];
  const saved = decode(await handleCalendarAddNote({ ...request, meeting: { accountId: chosen.accountId, calendarId: chosen.calendarId, eventId: chosen.eventId } }));
  expect(saved.meeting.eventId).toBe('review-next-week');
  expect(h.addNote).toHaveBeenCalledTimes(1);
  expect(h.addNote).toHaveBeenCalledWith({ ...request, accountId: 'account', calendarId: 'work', eventId: 'review-next-week' });
});

it('uses explicit local-day time boundaries to disambiguate recurring occurrences', async () => {
  snapshot.connections[0].events.push({ ...snapshot.connections[0].events[1], id: 'later', start: '2026-11-15T13:00:00Z', end: '2026-11-15T14:00:00Z' });
  const saved = decode(await handleCalendarAddNote({ ...request, filter: { title: 'Design review', start: '2026-11-08T00:00:00-05:00', end: '2026-11-09T00:00:00-05:00' } }));
  expect(saved.meeting.eventId).toBe('review');
});

it('lists ongoing meetings but uses a future start for an explicit next-meeting request', async () => {
  snapshot.connections[0].events.push({ id: 'ongoing', calendarId: 'work', title: 'In progress', start: '2026-11-07T11:00:00Z', end: '2026-11-07T13:00:00Z', allDay: false });
  expect(decode(handleCalendarListMeetings({})).meetings[0].eventId).toBe('ongoing');
  expect(decode(await handleCalendarAddNote({ ...request, filter: { nextMeeting: true } })).meeting.eventId).toBe('review');
});

it('handles all-day events using local calendar-day boundaries and excludes unselected calendars', () => {
  snapshot.connections[0].events = [
    { id: 'all-day', calendarId: 'work', title: 'Workshop', start: '2026-11-08', end: '2026-11-09', allDay: true },
    { id: 'hidden', calendarId: 'unselected', title: 'Hidden', start: '2026-11-08', end: '2026-11-09', allDay: true },
  ];
  const start = new Date(2026, 10, 8).toISOString();
  const end = new Date(2026, 10, 9).toISOString();
  expect(decode(handleCalendarListMeetings({ start, end })).meetings.map((meeting: any) => meeting.eventId)).toEqual(['all-day']);
});

it('disambiguates the same meeting on multiple connected accounts and tied next meetings', async () => {
  const duplicate = structuredClone(snapshot.connections[0]);
  duplicate.id = 'other-account'; duplicate.label = 'me@personal.test';
  snapshot.connections.push(duplicate);
  expect(decode(await handleCalendarAddNote({ ...request, filter: { title: 'Design review' } })).status).toBe('needs_selection');
  expect(decode(await handleCalendarAddNote({ ...request, filter: { nextMeeting: true } })).status).toBe('needs_selection');
  expect(h.addNote).not.toHaveBeenCalled();
  snapshot.connections.pop();
  expect(decode(await handleCalendarAddNote({ ...request, filter: { nextMeeting: true } })).meeting.eventId).toBe('review');
});

it('does not save when nothing matches, a choice was canceled, a selected meeting vanished, or a write fails', async () => {
  expect(decode(await handleCalendarAddNote({ ...request, filter: { title: 'Missing' } })).status).toBe('no_matches');
  await expect(handleCalendarAddNote({ ...request, meeting: { accountId: 'account', calendarId: 'work', eventId: 'missing' } })).rejects.toThrow('no longer available');
  await expect(handleCalendarAddNote({ ...request, meeting: null })).rejects.toThrow();
  expect(h.addNote).not.toHaveBeenCalled();
  h.addNote.mockRejectedValueOnce(new Error('Secure storage unavailable'));
  await expect(handleCalendarAddNote({ ...request, filter: { title: 'Planning' } })).rejects.toThrow('Secure storage unavailable');
});

it('rejects invalid date ranges and incomplete references before writing', async () => {
  await expect(handleCalendarAddNote({ ...request, filter: { start: 'bad-date' } })).rejects.toThrow();
  await expect(handleCalendarAddNote({ ...request, meeting: { eventId: 'review' } })).rejects.toThrow();
  expect(() => handleCalendarListMeetings({ start: '2026-11-09T00:00:00Z', end: '2026-11-08T00:00:00Z' })).toThrow('End must be after start');
  expect(h.addNote).not.toHaveBeenCalled();
});

it('keeps discovery truncation explicit and never treats the first page as a unique match', async () => {
  snapshot.connections[0].events = Array.from({ length: 101 }, (_, index) => ({ ...snapshot.connections[0].events[1], id: `review-${index}` }));
  const result = decode(await handleCalendarAddNote({ ...request, filter: { title: 'Design review' } }));
  expect(result).toMatchObject({ status: 'needs_selection', totalCount: 101, truncated: true });
  expect(result.meetings).toHaveLength(100);
  expect(h.addNote).not.toHaveBeenCalled();
});

it('registers both calendar tools on the deferred situational endpoint', () => {
  expect(calendarToolSchemas.map(tool => [tool.name, FIRST_PARTY_TOOL_TO_SERVER.get(tool.name)])).toEqual([
    ['calendar_list_meetings', MCP_SITUATIONAL], ['calendar_add_note', MCP_SITUATIONAL],
  ]);
});
