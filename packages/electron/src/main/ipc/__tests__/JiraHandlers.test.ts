// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), projects: {} as Record<string, { jql: string; autoSyncMinutes: number }>, read: vi.fn(), save: vi.fn(), saveProject: vi.fn(), query: vi.fn(), state: vi.fn(), sync: vi.fn(), register: vi.fn(), quit: vi.fn() }));
vi.mock('electron', () => ({ app: { once: (_event: string, fn: () => void) => h.quit.mockImplementation(fn) } }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (key: string, fn: (...args: any[]) => any) => h.handlers.set(key, fn) }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({ query: h.query }) }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: () => ({ getSessionState: h.state, getTrackedSessionIds: () => ['s'] }) }));
vi.mock('../../services/tracker/TrackerImporterRegistry', () => ({ getTrackerImporterRegistry: () => ({ registerBuiltin: h.register }) }));
vi.mock('../../services/tracker/TrackerImportService', () => ({ getTrackerImportService: () => ({ importSnapshot: vi.fn() }) }));
vi.mock('../../services/jira/JiraSyncService', () => ({ JiraSyncService: class { sync = h.sync; } }));
vi.mock('../../services/jira/jiraSettings', () => ({
  jiraProjects: () => h.projects,
  jiraProjectSettings: (path: string) => h.projects[path] ?? { jql: 'default', autoSyncMinutes: 0 },
  readJiraCredentials: h.read, saveJiraCredentials: h.save, saveJiraProjectSettings: h.saveProject,
}));
import { jiraTaskHasActiveSession, registerJiraHandlers } from '../JiraHandlers';

describe('Jira IPC and scheduling', () => {
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); h.handlers.clear(); h.projects = {};
    h.read.mockReturnValue({ siteUrl: 'https://team.atlassian.net', email: 'me@example.com', apiToken: 'private-token' });
    h.sync.mockResolvedValue({ created: 1, refreshed: 0, skipped: 0, errors: [] });
    h.state.mockReturnValue(null);
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
  const invoke = (key: string, ...args: unknown[]) => h.handlers.get(key)!(null, ...args);

  it('registers the connector and returns token presence without exposing the token', () => {
    registerJiraHandlers();
    expect(h.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'jira', importsAs: ['task'] }), expect.any(Function));
    expect(invoke('jira:get-settings', '/project')).toMatchObject({ email: 'me@example.com', hasToken: true });
    expect(JSON.stringify(invoke('jira:get-settings', '/project'))).not.toContain('private-token');
    expect(() => invoke('jira:get-settings', '')).toThrow('workspacePath');
  });

  it('preserves a saved token and requires a new token when changing accounts', () => {
    registerJiraHandlers();
    const args = { workspacePath: '/project', settings: { jql: 'mine', autoSyncMinutes: 0 }, credentials: { siteUrl: 'https://team.atlassian.net', email: 'me@example.com', apiToken: '' } };
    invoke('jira:save-settings', args);
    expect(h.save).toHaveBeenCalledWith(expect.objectContaining({ apiToken: 'private-token' }));
    expect(h.saveProject).toHaveBeenCalledWith('/project', args.settings);
    expect(() => invoke('jira:save-settings', { ...args, credentials: { ...args.credentials, email: 'other@example.com' } })).toThrow('API token');
  });

  it('defaults schedules off and runs configured projects independently after their interval', async () => {
    h.projects = { '/a': { jql: 'a', autoSyncMinutes: 1 }, '/b': { jql: 'b', autoSyncMinutes: 2 }, '/off': { jql: 'off', autoSyncMinutes: 0 } };
    registerJiraHandlers();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(h.sync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sync).toHaveBeenCalledTimes(1);
    expect(h.sync.mock.calls[0].slice(0, 2)).toEqual(['/a', 'a']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.sync).toHaveBeenCalledTimes(3);
    expect(h.sync.mock.calls.some(call => call[0] === '/off')).toBe(false);
    h.quit();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(h.sync).toHaveBeenCalledTimes(3);
  });

  it('keeps automatic failures visible in project settings', async () => {
    h.projects = { '/project': { jql: 'mine', autoSyncMinutes: 1 } };
    h.sync.mockRejectedValue(new Error('unsafe detail'));
    registerJiraHandlers();
    await vi.advanceTimersByTimeAsync(60_000);
    const settings = invoke('jira:get-settings', '/project');
    expect(settings.lastResult.errors[0]).toContain('auto-sync failed');
    expect(JSON.stringify(settings)).not.toContain('unsafe detail');
  });

  it.each([false, true])('protects running/waiting session links on both database JSON shapes (string=%s)', async stringJson => {
    const json = (value: unknown) => stringJson ? JSON.stringify(value) : value;
    h.query.mockResolvedValueOnce({ rows: [{ data: json({}) }] }).mockResolvedValueOnce({ rows: [{ id: 's', status: 'waiting_for_input', metadata: json({ linkedTrackerItemIds: ['task'] }) }] });
    expect(await jiraTaskHasActiveSession('/project', 'task')).toBe(true);
    h.query.mockResolvedValueOnce({ rows: [{ data: json({ linkedSessions: ['s'] }) }] }).mockResolvedValueOnce({ rows: [{ id: 's', status: 'running', metadata: json({}) }] });
    expect(await jiraTaskHasActiveSession('/project', 'task')).toBe(true);
    h.query.mockResolvedValueOnce({ rows: [{ data: json({ linkedSessions: ['s'] }) }] }).mockResolvedValueOnce({ rows: [{ id: 's', status: 'idle', metadata: json({}) }] });
    expect(await jiraTaskHasActiveSession('/project', 'task')).toBe(false);
  });
});
