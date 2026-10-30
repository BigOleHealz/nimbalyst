import React from 'react';
import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { JiraPanel } from '../JiraPanel';
import { DEFAULT_JIRA_JQL } from '@nimbalyst/runtime/integrations/jira';

const invoke = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'jira:get-settings') return { siteUrl: 'https://team.atlassian.net', email: 'me@example.com', hasToken: true, jql: DEFAULT_JIRA_JQL, autoSyncMinutes: 0 };
    if (channel === 'jira:sync') return { created: 4, refreshed: 2, skipped: 1, errors: ['APP-9: Jira permission denied.'] };
    return undefined;
  });
});

it('saves project settings before syncing, clears the token field, and reports partial failures', async () => {
  render(<JiraPanel workspacePath="/project" />);
  await waitFor(() => expect(screen.getByLabelText('Email')).toHaveValue('me@example.com'));
  expect(screen.getByLabelText('API token')).toHaveValue('');
  fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'new-token' } });
  fireEvent.change(screen.getByLabelText('JQL'), { target: { value: 'project = APP' } });
  fireEvent.change(screen.getByLabelText('Acceptance criteria field IDs (optional)'), { target: { value: 'customfield_77, customfield_88' } });
  fireEvent.click(screen.getByRole('button', { name: 'Sync Jira' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledWith('jira:sync', '/project'));
  expect(invoke).toHaveBeenCalledWith('jira:save-settings', expect.objectContaining({ workspacePath: '/project', credentials: expect.objectContaining({ apiToken: 'new-token' }), settings: { jql: 'project = APP', autoSyncMinutes: 0, acceptanceCriteriaFieldIds: ['customfield_77', 'customfield_88'] } }));
  expect(screen.getByLabelText('API token')).toHaveValue('');
  expect(screen.getByRole('status')).toHaveTextContent('4 imported, 2 refreshed, 1 skipped');
  expect(screen.getByRole('alert')).toHaveTextContent('APP-9: Jira permission denied.');
});

it('does not start sync when credentials cannot be saved', async () => {
  invoke.mockImplementation(async (channel: string) => {
    if (channel === 'jira:get-settings') return { siteUrl: '', email: '', hasToken: false, jql: DEFAULT_JIRA_JQL, autoSyncMinutes: 0 };
    throw new Error('Secure credential storage is unavailable.');
  });
  render(<JiraPanel workspacePath="/project" />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Sync Jira' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Sync Jira' }));
  await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Secure credential storage is unavailable.'));
  expect(invoke.mock.calls.some(call => call[0] === 'jira:sync')).toBe(false);
});
