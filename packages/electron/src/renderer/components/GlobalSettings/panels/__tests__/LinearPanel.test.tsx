import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { LinearPanel } from '../LinearPanel';

const invoke = vi.fn();
const openWorkspace = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  openWorkspace.mockResolvedValue({ success: true });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke, workspaceManager: { openWorkspace } } });
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'linear:get-settings') return { hasToken: false };
    if (channel === 'linear:connect') return { name: 'Pat' };
    if (channel === 'linear:projects') return { nodes: [{ id: 'p1', name: 'One', state: 'started' }], nextCursor: 'next' };
    if (channel === 'linear:choose-destination') return '/imports';
    if (channel === 'linear:import-project') return { projectId: 'p1', name: 'One', workspacePath: '/imports/one', created: 3, skipped: 2, errors: ['APP-9: unavailable'] };
    return undefined;
  });
});

it('connects, clears the key, chooses a folder and imports only selected projects with partial failure reporting', async () => {
  render(<LinearPanel />);
  await waitFor(() => expect(screen.getByLabelText('Personal API key')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'private-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect Linear' }));
  await screen.findByLabelText('One');
  expect(invoke).toHaveBeenCalledWith('linear:connect', { apiKey: 'private-key' });
  expect(screen.getByLabelText('Personal API key')).toHaveValue('');
  fireEvent.click(screen.getByLabelText('One'));
  expect(screen.getByRole('button', { name: 'Import selected projects' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Import selected projects' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Import selected projects' }));
  await screen.findByText('3 tickets imported, 2 already imported');
  expect(invoke).toHaveBeenCalledWith('linear:import-project', { destination: '/imports', projectId: 'p1' });
  expect(screen.getByRole('alert')).toHaveTextContent('APP-9: unavailable');
  fireEvent.click(screen.getByRole('button', { name: 'Open One' }));
  expect(openWorkspace).toHaveBeenCalledWith('/imports/one');
});

it('keeps selections across project pages and never starts imports after a failed connection', async () => {
  invoke.mockImplementation(async (channel: string, args?: { cursor?: string }) => {
    if (channel === 'linear:get-settings') return { hasToken: true };
    if (channel === 'linear:projects') return args?.cursor ? { nodes: [{ id: 'p2', name: 'Two', state: 'planned' }] } : { nodes: [{ id: 'p1', name: 'One', state: 'started' }], nextCursor: 'next' };
    if (channel === 'linear:connect') throw new Error('Linear access denied.');
    return undefined;
  });
  render(<LinearPanel />);
  fireEvent.click(await screen.findByLabelText('One'));
  fireEvent.click(screen.getByRole('button', { name: 'Load more projects' }));
  await screen.findByLabelText('Two');
  expect(screen.getByLabelText('One')).toBeChecked();
  expect(invoke).toHaveBeenCalledWith('linear:projects', { cursor: 'next' });
  fireEvent.change(screen.getByLabelText('Personal API key'), { target: { value: 'bad-key' } });
  fireEvent.click(screen.getByRole('button', { name: 'Connect Linear' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('access denied'));
  expect(invoke.mock.calls.some(call => call[0] === 'linear:import-project')).toBe(false);
});
