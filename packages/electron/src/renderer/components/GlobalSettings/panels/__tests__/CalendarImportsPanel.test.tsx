import React from 'react';
import '@testing-library/jest-dom/vitest';
import { beforeEach, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { getDefaultStore } from 'jotai';
import { calendarImportsAtom } from '../../../../store/atoms/calendarImports';
import { CalendarImportsPanel } from '../CalendarImportsPanel';
import { calendarImportRange } from '../calendarAgenda';
import type { CalendarImportsSnapshot } from '../../../../../shared/calendarImports';

const snapshot: CalendarImportsSnapshot = { clients: {}, connections: [
  { id: 'google', provider: 'google', label: 'me@gmail.test', calendars: [{ id: 'work', name: 'Work calendar', primary: true }], selectedCalendarIds: ['work'], events: [{ id: 'standup', calendarId: 'work', title: 'Google standup', start: '2026-11-05T14:00:00Z', end: '2026-11-05T15:00:00Z', allDay: false }] },
  { id: 'microsoft', provider: 'microsoft', label: 'me@work.test', calendars: [{ id: 'office', name: 'Office calendar', primary: true }], selectedCalendarIds: ['office'], events: [{ id: 'holiday', calendarId: 'office', title: 'Microsoft holiday', start: '2026-11-05', end: '2026-11-06', allDay: true }] },
] };
const invoke = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  getDefaultStore().set(calendarImportsAtom, { connections: [], clients: {} });
  snapshot.connections.forEach(account => { account.autoRefresh = false; });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
  invoke.mockResolvedValue(structuredClone(snapshot));
});

it('shows both providers in one agenda and one expandable provider setup form', async () => {
  render(<CalendarImportsPanel />);
  await screen.findByText('Google standup');
  expect(screen.getByText('Microsoft holiday')).toBeVisible();
  expect(screen.getByLabelText('Work calendar (primary)')).toBeChecked();
  expect(screen.getByLabelText('Office calendar (primary)')).toBeChecked();
  fireEvent.click(screen.getByText('Add calendar account'));
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'microsoft' } });
  expect(screen.queryByLabelText('Google Desktop app client secret')).not.toBeInTheDocument();
  expect(screen.getByText('Connection setup for Microsoft 365 / Exchange Online / Outlook.com')).toBeVisible();
  expect(screen.getAllByRole('region', { name: 'Unified calendar agenda' })).toHaveLength(1);
});

it('imports only the selected calendars for the chosen inclusive local dates', async () => {
  render(<CalendarImportsPanel />);
  await screen.findByText('Google standup');
  fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-11-05' } });
  fireEvent.change(screen.getByLabelText('Through'), { target: { value: '2026-11-06' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Import events' })[0]);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('calendar-imports:import', {
    accountId: 'google', calendarIds: ['work'], range: calendarImportRange('2026-11-05', '2026-11-06'),
  }));
});

it('keeps the last successful agenda visible when a new import fails', async () => {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'calendar-imports:import') throw new Error('Provider unavailable');
    return structuredClone(snapshot);
  });
  render(<CalendarImportsPanel />);
  await screen.findByText('Google standup');
  fireEvent.click(screen.getAllByRole('button', { name: 'Import events' })[0]);
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Provider unavailable'));
  expect(screen.getByText('Google standup')).toBeVisible();
  expect(screen.getByText('Microsoft holiday')).toBeVisible();
});

it('uses the rolling range and persists the per-account automatic refresh preference', async () => {
  const automatic = structuredClone(snapshot);
  automatic.connections.forEach(account => { account.autoRefresh = true; });
  invoke.mockResolvedValue(automatic);
  render(<CalendarImportsPanel />);
  await screen.findByText('Google standup');
  expect(screen.queryByLabelText('From')).not.toBeInTheDocument();
  fireEvent.click(screen.getAllByRole('button', { name: 'Refresh now' })[0]);
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('calendar-imports:import', { accountId: 'google', calendarIds: ['work'], range: undefined }));
  await waitFor(() => expect(screen.getByLabelText('Automatic refresh for me@gmail.test')).toBeEnabled());
  fireEvent.click(screen.getByLabelText('Automatic refresh for me@gmail.test'));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('calendar-imports:auto-refresh', { accountId: 'google', enabled: false }));
});

it('updates the visible agenda from a background snapshot without remounting settings', async () => {
  render(<CalendarImportsPanel />);
  await screen.findByText('Google standup');
  const changed = structuredClone(snapshot);
  changed.connections[0].events = [];
  changed.connections[1].events[0].title = 'Changed meeting';
  await act(async () => { getDefaultStore().set(calendarImportsAtom, changed); });
  expect(screen.queryByText('Google standup')).not.toBeInTheDocument();
  expect(screen.getByText('Changed meeting')).toBeVisible();
});
