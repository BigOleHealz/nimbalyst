import React from 'react';
import '@testing-library/jest-dom/vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CalendarMode } from '../CalendarMode';
import { calendarEntries, entriesForDay } from '../calendarView';
import { calendarImportsAtom } from '../../../store/atoms/calendarImports';
import type { CalendarImportsSnapshot, ImportedCalendarEvent } from '../../../../shared/calendarImports';

const meeting: ImportedCalendarEvent = { id: 'meeting', calendarId: 'work', title: 'Pair programming', start: new Date(2026, 10, 6, 9).toISOString(), end: new Date(2026, 10, 6, 10).toISOString(), allDay: false, location: 'Video call', description: 'Review the implementation.', url: 'https://calendar.google.com/calendar/event?eid=meeting' };
const snapshot: CalendarImportsSnapshot = { clients: {}, connections: [{
  id: 'google', provider: 'google', label: 'me@work.test', calendars: [{ id: 'work', name: 'Work', primary: true }], selectedCalendarIds: ['work'], events: [meeting], autoRefresh: true,
}, {
  id: 'microsoft', provider: 'microsoft', label: 'me@ms.test', calendars: [{ id: 'office', name: 'Office', primary: true }], selectedCalendarIds: ['office'], events: [{ ...meeting, id: 'day-off', calendarId: 'office', title: 'Day off', allDay: true, start: '2026-11-06', end: '2026-11-07' }], autoRefresh: true,
}] };
const invoke = vi.fn();
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 10, 5, 12));
  invoke.mockReset().mockResolvedValue(structuredClone(snapshot));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
});
afterEach(() => { vi.useRealTimers(); });

function renderCalendar() {
  const target = createStore();
  const manage = vi.fn();
  render(<Provider store={target}><CalendarMode onManageAccounts={manage} /></Provider>);
  return { target, manage };
}

it('opens imported meetings in a month grid and exposes their details and provider link', async () => {
  renderCalendar();
  const meetingButton = await screen.findByRole('button', { name: /Pair programming.*me@work.test/ });
  expect(screen.getByRole('heading', { name: 'November 2026' })).toBeVisible();
  fireEvent.click(meetingButton);
  const agenda = screen.getByRole('complementary', { name: 'Day agenda' });
  expect(within(agenda).getByRole('heading', { name: 'Pair programming' })).toBeVisible();
  expect(within(agenda).getByText('Video call')).toBeVisible();
  expect(within(agenda).getByText('Review the implementation.')).toBeVisible();
  fireEvent.click(within(agenda).getByRole('button', { name: 'Open original event' }));
  expect(invoke).toHaveBeenCalledWith('calendar-imports:open-event', { accountId: 'google', calendarId: 'work', eventId: 'meeting' });
});

it('adds a private note to the selected meeting and displays notes received from a prompt', async () => {
  const { target } = renderCalendar();
  fireEvent.click(await screen.findByRole('button', { name: /Pair programming.*me@work.test/ }));
  const next = structuredClone(snapshot);
  next.connections[0].events[0].notes = [{ id: 'prompt-note', text: 'Ask about the launch', createdAt: new Date().toISOString() }];
  await act(async () => { target.set(calendarImportsAtom, next); });
  expect(screen.getByText('Ask about the launch')).toBeVisible();
  const saved = structuredClone(next);
  saved.connections[0].events[0].notes!.push({ id: 'manual-note', text: 'Review owners', createdAt: new Date().toISOString() });
  invoke.mockResolvedValue(saved);
  fireEvent.change(screen.getByRole('textbox', { name: 'Add a note' }), { target: { value: 'Review owners' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
  await screen.findByText('Note saved.');
  expect(invoke).toHaveBeenCalledWith('calendar-imports:add-note', { accountId: 'google', calendarId: 'work', eventId: 'meeting', text: 'Review owners', clientMutationId: expect.any(String) });
  expect(screen.getByText('Review owners')).toBeVisible();
  expect(screen.getByText('Ask about the launch')).toBeVisible();
  expect(screen.getByRole('textbox', { name: 'Add a note' })).toHaveValue('');
});

it('keeps a failed note draft and reuses its retry ID without duplicating the request on double submit', async () => {
  renderCalendar();
  fireEvent.click(await screen.findByRole('button', { name: /Pair programming.*me@work.test/ }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Add a note' }), { target: { value: 'Keep this draft' } });
  invoke.mockRejectedValueOnce(new Error('Unavailable'));
  const button = screen.getByRole('button', { name: 'Add note' });
  fireEvent.click(button); fireEvent.click(button);
  await screen.findByRole('alert');
  expect(screen.getByRole('textbox', { name: 'Add a note' })).toHaveValue('Keep this draft');
  const first = invoke.mock.calls.filter(([channel]) => channel === 'calendar-imports:add-note');
  expect(first).toHaveLength(1);
  invoke.mockResolvedValue(snapshot);
  fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
  await screen.findByText('Note saved.');
  const requests = invoke.mock.calls.filter(([channel]) => channel === 'calendar-imports:add-note');
  expect(requests[1][1].clientMutationId).toBe(requests[0][1].clientMutationId);
});

it('keeps the latest live note snapshot when a delayed save response arrives', async () => {
  const { target } = renderCalendar();
  fireEvent.click(await screen.findByRole('button', { name: /Pair programming.*me@work.test/ }));
  let finish!: (value: CalendarImportsSnapshot) => void;
  invoke.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Add a note' }), { target: { value: 'My note' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add note' }));
  const latest = structuredClone(snapshot);
  latest.connections[0].events[0].notes = [{ id: 'newer', text: 'A newer note from the prompt', createdAt: new Date().toISOString() }];
  await act(async () => { target.set(calendarImportsAtom, latest); finish(structuredClone(snapshot)); });
  expect(screen.getByText('A newer note from the prompt')).toBeVisible();
});

it('navigates months, returns to today, and filters calendars without changing sync selections', async () => {
  const { target } = renderCalendar();
  await screen.findByRole('button', { name: /Pair programming.*me@work.test/ });
  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(screen.getByRole('heading', { name: 'December 2026' })).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Today' }));
  expect(screen.getByRole('heading', { name: 'November 2026' })).toBeVisible();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Show Work — me@work.test' }));
  expect(screen.queryByRole('button', { name: /Pair programming.*me@work.test/ })).not.toBeInTheDocument();
  expect(target.get(calendarImportsAtom).connections[0].selectedCalendarIds).toEqual(['work']);
  expect(screen.getByRole('button', { name: /Day off.*me@ms.test/ })).toBeVisible();
});

it('receives automatic refreshes and cancellations while the calendar stays open', async () => {
  const { target } = renderCalendar();
  await screen.findByRole('button', { name: /Pair programming.*me@work.test/ });
  const next = structuredClone(snapshot);
  next.connections[0].events = [];
  next.connections[1].events[0].title = 'Updated day off';
  await act(async () => { target.set(calendarImportsAtom, next); });
  expect(screen.queryByRole('button', { name: /Pair programming.*me@work.test/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Updated day off.*me@ms.test/ })).toBeVisible();
});

it('offers account setup from an empty calendar', async () => {
  invoke.mockResolvedValue({ connections: [], clients: {} });
  const { manage } = renderCalendar();
  await screen.findByText('Connect a calendar account to see your events.');
  fireEvent.click(screen.getByRole('button', { name: 'Manage accounts' }));
  expect(manage).toHaveBeenCalledTimes(1);
});

it('does not overwrite a newer live update with a delayed initial read', async () => {
  let finish!: (value: CalendarImportsSnapshot) => void;
  invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const { target } = renderCalendar();
  const next = structuredClone(snapshot);
  next.connections[0].events[0].title = 'Newly updated meeting';
  await act(async () => {
    target.set(calendarImportsAtom, next);
    finish(structuredClone(snapshot));
  });
  expect(screen.getByRole('button', { name: /Newly updated meeting.*me@work.test/ })).toBeVisible();
  expect(screen.queryByRole('button', { name: /Pair programming.*me@work.test/ })).not.toBeInTheDocument();
});

it('refreshes saved selections and preserves other accounts when one refresh fails', async () => {
  invoke.mockImplementation(async (channel: string, input?: { accountId: string }) => {
    if (channel === 'calendar-imports:import' && input?.accountId === 'google') throw new Error('Offline');
    return structuredClone(snapshot);
  });
  renderCalendar();
  await screen.findByRole('button', { name: /Pair programming.*me@work.test/ });
  fireEvent.click(screen.getByRole('button', { name: 'Refresh now' }));
  await screen.findByRole('alert');
  expect(invoke).toHaveBeenCalledWith('calendar-imports:import', { accountId: 'google', calendarIds: ['work'], range: undefined });
  expect(invoke).toHaveBeenCalledWith('calendar-imports:import', { accountId: 'microsoft', calendarIds: ['office'], range: undefined });
  expect(screen.getByRole('button', { name: /Pair programming.*me@work.test/ })).toBeVisible();
});

it('places multi-day events on every affected day and respects exclusive end dates and midnight', () => {
  const data = structuredClone(snapshot);
  data.connections = [data.connections[0]];
  data.connections[0].events = [
    { ...meeting, id: 'all-day', allDay: true, start: '2026-11-05', end: '2026-11-07' },
    { ...meeting, id: 'overnight', start: new Date(2026, 10, 5, 23).toISOString(), end: new Date(2026, 10, 6, 1).toISOString() },
    { ...meeting, id: 'midnight', start: new Date(2026, 10, 5, 22).toISOString(), end: new Date(2026, 10, 6).toISOString() },
  ];
  const entries = calendarEntries(data.connections);
  expect(entriesForDay(entries, '2026-11-05').map(entry => entry.event.id)).toEqual(['all-day', 'midnight', 'overnight']);
  expect(entriesForDay(entries, '2026-11-06').map(entry => entry.event.id)).toEqual(['all-day', 'overnight']);
  expect(entriesForDay(entries, '2026-11-07')).toEqual([]);
});
