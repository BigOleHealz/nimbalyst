// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const h = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => any>(), read: vi.fn(), save: vi.fn(), viewer: vi.fn(), project: vi.fn(), projects: vi.fn(), issues: vi.fn(), snapshot: vi.fn(), register: vi.fn(), runImport: vi.fn() }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (key: string, fn: (...args: any[]) => any) => h.handlers.set(key, fn) }));
vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null }, dialog: { showOpenDialog: vi.fn() } }));
vi.mock('../../utils/dialogPaths', () => ({ getDialogDefaultPath: vi.fn(), rememberDialogSelection: vi.fn() }));
vi.mock('../../utils/store', () => ({ addToRecentItems: vi.fn() }));
vi.mock('../../services/linear/linearSettings', () => ({ readLinearKey: h.read, saveLinearKey: h.save }));
vi.mock('../../services/linear/LinearClient', () => ({ LinearClient: class { viewer = h.viewer; project = h.project; projects = h.projects; issues = h.issues; snapshot = h.snapshot; } }));
vi.mock('../../services/tracker/TrackerImporterRegistry', () => ({ getTrackerImporterRegistry: () => ({ registerBuiltin: h.register }) }));
vi.mock('../../services/tracker/TrackerImportService', () => ({ getTrackerImportService: () => ({ runImport: h.runImport }) }));
import { registerLinearHandlers } from '../LinearHandlers';
const invoke = (key: string, ...args: unknown[]) => h.handlers.get(key)!(null, ...args);
beforeEach(() => { vi.clearAllMocks(); h.handlers.clear(); h.read.mockReturnValue('saved-key'); h.viewer.mockResolvedValue({ name: 'Pat' }); registerLinearHandlers(); });

it('returns key presence only and validates before saving a replacement', async () => {
  expect(invoke('linear:get-settings')).toEqual({ hasToken: true });
  expect(await invoke('linear:connect', { apiKey: 'new-key' })).toEqual({ name: 'Pat' });
  expect(h.save).toHaveBeenCalledWith('new-key');
  h.save.mockClear(); h.viewer.mockRejectedValue(new Error('Linear access denied'));
  await expect(invoke('linear:connect', { apiKey: 'bad-key' })).rejects.toThrow('access denied');
  expect(h.save).not.toHaveBeenCalled();
});

it('routes a project import to its new workspace through the native importer and permits a safe retry', async () => {
  const destination = await realpath(await mkdtemp(join(tmpdir(), 'linear-ipc-')));
  const projectId = '11111111-1111-4111-8111-111111111111';
  h.project.mockResolvedValue({ id: projectId, name: 'One', url: 'https://linear.app/project' });
  h.issues.mockResolvedValue({ nodes: [{ id: 'issue-id', identifier: 'APP-1' }] });
  h.runImport.mockResolvedValue({ created: true });
  try {
    const result = await invoke('linear:import-project', { destination, projectId });
    expect(result).toMatchObject({ created: 1, errors: [] });
    expect(h.runImport).toHaveBeenCalledWith({ workspacePath: result.workspacePath, externalId: 'issue-id', providerId: 'linear', primaryType: 'task' });
    h.runImport.mockResolvedValue({ created: false });
    expect(await invoke('linear:import-project', { destination, projectId })).toMatchObject({ workspacePath: result.workspacePath, created: 0, skipped: 1 });
    await expect(invoke('linear:import-project', { destination })).rejects.toThrow('required');
  } finally { await rm(destination, { recursive: true, force: true }); }
});

it('registers a native importer and enumerates every project binding including unprojected tickets', async () => {
  expect(h.register).toHaveBeenCalledWith(expect.objectContaining({ id: 'linear', importsAs: ['task'] }), expect.any(Function));
  const factory = h.register.mock.calls[0][1];
  h.projects.mockResolvedValueOnce({ nodes: [{ id: 'p1', name: 'One' }], nextCursor: 'next' }).mockResolvedValueOnce({ nodes: [{ id: 'p2', name: 'Two' }] });
  expect(await factory('/project').listBindings()).toEqual([{ id: 'all', label: 'All accessible tickets' }, { id: 'p1', label: 'One' }, { id: 'p2', label: 'Two' }]);
  h.issues.mockResolvedValue({ nodes: [{ id: 'uuid', identifier: 'A-1', title: 'Title', state: { name: 'Todo' }, url: 'https://linear.app/issue', updatedAt: 'date' }], nextCursor: 'next' });
  expect(await factory('/project').list({ binding: { id: 'all' }, filters: { cursor: 'c', state: 'all' } })).toMatchObject({ items: [{ externalId: 'uuid', urn: 'linear://issue/uuid' }], nextCursor: 'next' });
  expect(h.issues).toHaveBeenCalledWith(expect.objectContaining({ projectId: undefined, cursor: 'c', state: 'all' }));
});
