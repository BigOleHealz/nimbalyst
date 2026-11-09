import { z } from 'zod';
import { addCalendarMeetingNote, getCalendarImportsSnapshot } from '../../ipc/CalendarImportHandlers';
import type { CalendarImportsSnapshot } from '../../../shared/calendarImports';

const reference = z.object({ accountId: z.string().min(1), calendarId: z.string().min(1), eventId: z.string().min(1) }).strict();
const filters = z.object({
  title: z.string().trim().min(1).optional(),
  start: z.string().datetime({ offset: true }).optional(),
  end: z.string().datetime({ offset: true }).optional(),
  nextMeeting: z.boolean().optional(),
}).strict().refine(input => !input.start || !input.end || Date.parse(input.end) > Date.parse(input.start), 'End must be after start.');
const addInput = z.object({
  text: z.string().trim().min(1).max(50_000),
  clientMutationId: z.string().min(1).max(200),
  meeting: reference.optional(),
  filter: filters.optional(),
}).strict();

const filterProperties = {
  title: { type: 'string', description: 'Case-insensitive title fragment explicitly identified by the user.' },
  start: { type: 'string', description: 'Inclusive meeting start boundary, ISO timestamp with time zone. Use the user’s local day boundaries.' },
  end: { type: 'string', description: 'Exclusive meeting start boundary, ISO timestamp with time zone.' },
  nextMeeting: { type: 'boolean', description: 'Use only when the user explicitly means their next meeting. Simultaneous meetings still require a choice.' },
};

export const calendarToolSchemas = [
  {
    name: 'calendar_list_meetings',
    description: 'Find upcoming imported Google and Microsoft calendar meetings and their private Nimbalyst notes. Uses the latest local calendar snapshot; returns source freshness and time zone. Before adding a meeting note, identify the intended occurrence. If the user did not identify a meeting, or several meetings fit, use AskUserQuestion or PromptForUserInput to ask which meeting, with title, date/time, calendar and account. Never guess from list order.',
    inputSchema: { type: 'object', properties: filterProperties, additionalProperties: false },
  },
  {
    name: 'calendar_add_note',
    description: 'Append a private Nimbalyst note to one calendar meeting; never changes the provider event or sends to attendees. A unique user-supplied title/date/next-meeting filter can save directly. Missing or ambiguous meeting information returns needs_selection without saving: ask which meeting through AskUserQuestion or PromptForUserInput, wait for the answer, then retry using the chosen meeting IDs. Only pass explicit meeting IDs obtained from discovery when the user clearly identified that occurrence or selected it. Preserve the same clientMutationId on retries to prevent duplicates. Confirm the saved meeting title/date to the user only after status saved.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['text', 'clientMutationId'],
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 50_000, description: 'The note to append, preserving the user’s wording.' },
        clientMutationId: { type: 'string', minLength: 1, maxLength: 200, description: 'Unique stable ID for this note request; reuse on retries.' },
        meeting: { type: 'object', additionalProperties: false, required: ['accountId', 'calendarId', 'eventId'], properties: {
          accountId: { type: 'string' }, calendarId: { type: 'string' }, eventId: { type: 'string' },
        } },
        filter: { type: 'object', additionalProperties: false, properties: filterProperties },
      },
    },
  },
];

function eventInstant(value: string, allDay: boolean): number {
  return Date.parse(allDay ? `${value}T00:00:00` : value);
}

function findMeetings(snapshot: CalendarImportsSnapshot, filter: z.infer<typeof filters>) {
  const start = filter.start ? Date.parse(filter.start) : Date.now();
  const end = filter.end ? Date.parse(filter.end) : Infinity;
  const title = filter.title?.toLocaleLowerCase();
  const meetings = snapshot.connections.flatMap(account => account.events
    .filter(event => account.selectedCalendarIds.includes(event.calendarId))
    .filter(event => (!title || event.title.toLocaleLowerCase().includes(title))
      && (filter.start || filter.nextMeeting ? eventInstant(event.start, event.allDay) >= start : eventInstant(event.end, event.allDay) > start)
      && eventInstant(event.start, event.allDay) < end)
    .map(event => ({
      accountId: account.id, calendarId: event.calendarId, eventId: event.id,
      title: event.title, start: event.start, end: event.end, allDay: event.allDay,
      account: account.label, calendar: account.calendars.find(calendar => calendar.id === event.calendarId)?.name ?? event.calendarId,
      notes: event.notes ?? [],
    })))
    .sort((a, b) => eventInstant(a.start, a.allDay) - eventInstant(b.start, b.allDay) || a.title.localeCompare(b.title));
  if (filter.nextMeeting && meetings.length) {
    const first = eventInstant(meetings[0].start, meetings[0].allDay);
    return meetings.filter(meeting => eventInstant(meeting.start, meeting.allDay) === first);
  }
  return meetings;
}

const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });

function discovery(snapshot: CalendarImportsSnapshot, meetings: ReturnType<typeof findMeetings>) {
  return {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    now: new Date().toISOString(),
    sources: snapshot.connections.map(account => ({ account: account.label, importedAt: account.importedAt, syncError: account.syncError, range: account.range })),
    meetings: meetings.slice(0, 100), totalCount: meetings.length, truncated: meetings.length > 100,
  };
}

export function handleCalendarListMeetings(args: unknown) {
  const filter = filters.parse(args ?? {});
  const snapshot = getCalendarImportsSnapshot();
  return result(discovery(snapshot, findMeetings(snapshot, filter)));
}

export async function handleCalendarAddNote(args: unknown) {
  const input = addInput.parse(args);
  const snapshot = getCalendarImportsSnapshot();
  const filter = input.filter ?? {};
  const meetings = findMeetings(snapshot, filter);
  const explicit = input.meeting && snapshot.connections.flatMap(account => account.events.map(event => ({
    accountId: account.id, calendarId: event.calendarId, eventId: event.id, title: event.title, start: event.start,
  }))).find(meeting => meeting.accountId === input.meeting!.accountId && meeting.calendarId === input.meeting!.calendarId && meeting.eventId === input.meeting!.eventId);
  if (input.meeting && !explicit) throw new Error('This meeting is no longer available. List meetings and ask the user again.');
  const identified = Boolean(filter.title || filter.start || filter.end || filter.nextMeeting);
  const selected = explicit ?? (identified && meetings.length === 1 ? meetings[0] : undefined);
  if (!selected) {
    return result({
      status: meetings.length ? 'needs_selection' : 'no_matches',
      instruction: meetings.length
        ? 'Ask which meeting using AskUserQuestion or PromptForUserInput. Include title, local date/time, calendar and account. Wait for the answer, then retry with the chosen meeting reference and the same note and clientMutationId. If truncated, narrow the date/title filter before offering choices.'
        : 'No matching imported meetings. Check calendar connections, freshness and date range, or ask for a different title/date. No note was saved.',
      ...discovery(snapshot, meetings),
    });
  }
  await addCalendarMeetingNote({ accountId: selected.accountId, calendarId: selected.calendarId, eventId: selected.eventId, text: input.text, clientMutationId: input.clientMutationId });
  return result({ status: 'saved', meeting: { accountId: selected.accountId, calendarId: selected.calendarId, eventId: selected.eventId, title: selected.title, start: selected.start }, text: input.text });
}
