// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { sessionKanbanActiveAtom, sessionRegistryAtom } from '../../atoms/sessions';
import { sessionListMetadata } from '../../atoms/sessionListMetadata';
import { worktreeRecordsAtom } from '../../atoms/worktrees';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { prListAtom, prDeliveryEvidenceAtom, prRepositoryPathsAtom } from '../../atoms/pullRequests';
import { workspaceRepoPathsAtom } from '../../atoms/workspaceRepos';
import { initWorktreeListeners } from '../worktreeListeners';
import { initPullRequestListeners } from '../pullRequestListeners';
import { sessionAutomaticBoardStateAtom } from '../../atoms/sessionKanban';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';

const api = vi.hoisted(() => ({ loadGit: vi.fn().mockResolvedValue(undefined), startPolling: vi.fn().mockResolvedValue(undefined), stopPolling: vi.fn().mockResolvedValue(undefined), list: vi.fn(), detectRemote: vi.fn(), onListUpdated: vi.fn(() => () => {}), getStatus: vi.fn().mockResolvedValue({ installed: false, authed: false }), onStatusChanged: vi.fn(() => () => {}) }));
vi.mock('../fileStateListeners', () => ({ loadInitialWorktreeState: api.loadGit }));
vi.mock('../../../services/RendererPullRequestService', () => ({ getPullRequestService: () => api }));
vi.mock('../../../services/RendererGhCliService', () => ({ getGhCliService: () => api }));

afterEach(() => { store.set(sessionKanbanActiveAtom, false); store.set(sessionRegistryAtom, new Map()); store.set(worktreeRecordsAtom, new Map()); store.set(activeWorkspacePathAtom, null); store.set(workspaceRepoPathsAtom, []); store.set(prListAtom, []); store.set(prDeliveryEvidenceAtom, []); store.set(prRepositoryPathsAtom, new Map()); store.set(trackerItemsMapAtom, new Map()); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('hydrates delivery PRs from an attached repository when the workspace root is not Git, without opening the PR pane', async () => {
  vi.stubGlobal('window', { electronAPI: {} });
  store.set(activeWorkspacePathAtom, '/documents');
  api.detectRemote.mockImplementation(async (path: string) => path === '/documents/app' ? { remote: 'owner/app', host: 'github.com' } : null);
  const merged = { id: 'delivered', workspaceId: '/documents', remote: 'owner/app', number: 1, state: 'merged', raw: { merge_commit_sha: 'squash' } };
  api.list.mockResolvedValue([merged]);
  const stop = initPullRequestListeners();
  // Repository discovery may finish after the session list is already visible.
  store.set(workspaceRepoPathsAtom, ['/documents/app']);
  try {
    await vi.waitFor(() => expect(store.get(prListAtom)).toEqual([merged]));
    expect(api.startPolling).toHaveBeenCalledWith('/documents/app', '/documents', 'owner/app');
    expect(store.get(prRepositoryPathsAtom).get('owner/app')).toEqual(['/documents/app']);
    expect(store.get(sessionKanbanActiveAtom)).toBe(false);
    store.set(sessionRegistryAtom, new Map([['delivery', sessionListMetadata({ id: 'delivery', createdAt: 1, updatedAt: 1, linkedTrackerItemIds: ['implementation'] }, '/documents')]]));
    store.set(trackerItemsMapAtom, new Map([['implementation', { id: 'implementation', primaryType: 'task', fields: {}, system: { workspace: '/documents', linkedCommitSha: 'squash' } }]] as any));
    expect(store.get(sessionAutomaticBoardStateAtom).get('delivery')?.column).toBe('complete');
    // The PR pane's Open filter must not erase the board's merge evidence.
    store.set(prListAtom, []);
    expect(store.get(sessionAutomaticBoardStateAtom).get('delivery')?.column).toBe('complete');
  } finally { stop(); }
});

it('combines independent repository refreshes instead of replacing one delivery cache with another', async () => {
  vi.stubGlobal('window', { electronAPI: {} });
  store.set(activeWorkspacePathAtom, '/documents');
  store.set(workspaceRepoPathsAtom, ['/documents/a', '/documents/b']);
  api.detectRemote.mockImplementation(async (path: string) => path === '/documents' ? null : { remote: `owner/${path.split('/').pop()}`, host: 'github.com' });
  api.list.mockImplementation(async (workspaceId: string, remote: string) => [{ id: remote, workspaceId, remote, number: 1, state: 'merged' }]);
  const stop = initPullRequestListeners();
  try {
    await vi.waitFor(() => expect(store.get(prListAtom).map(pr => pr.remote).sort()).toEqual(['owner/a', 'owner/b']));
  } finally { stop(); }
});

it('resolves session branches in one existing worktree batch without mounting the sidebar', async () => {
  const invoke = vi.fn().mockResolvedValue({ success: true, worktrees: { wt: { id: 'wt', name: 'work', path: '/wt', branch: 'codex/test', isPinned: false } } });
  vi.stubGlobal('window', { electronAPI: { invoke, on: () => () => {} } });
  const session = sessionListMetadata({ id: 'a', createdAt: 1, updatedAt: 1, worktreeId: 'wt' }, '/repo');
  store.set(sessionRegistryAtom, new Map([['a', session], ['b', { ...session, id: 'b' }]]));
  const stop = initWorktreeListeners();
  await vi.waitFor(() => expect(store.get(worktreeRecordsAtom).get('wt')?.branch).toBe('codex/test'));
  expect(invoke).toHaveBeenCalledExactlyOnceWith('worktree:get-batch', ['wt']);
  expect(api.loadGit).not.toHaveBeenCalled();
  store.set(sessionKanbanActiveAtom, true);
  await vi.waitFor(() => expect(api.loadGit).toHaveBeenCalledExactlyOnceWith('wt', '/wt'));
  stop();
});

it('loads all PR states for the board and ignores a result from a project the user left', async () => {
  vi.stubGlobal('window', { electronAPI: {} });
  store.set(activeWorkspacePathAtom, '/repo');
  api.detectRemote.mockResolvedValue({ remote: 'owner/repo', host: 'github.com' });
  let resolve!: (rows: unknown[]) => void;
  api.list.mockReturnValue(new Promise(done => { resolve = done; }));
  const stop = initPullRequestListeners();
  await vi.waitFor(() => expect(api.list).toHaveBeenCalledWith('/repo', 'owner/repo', { state: 'all' }));
  expect(api.startPolling).toHaveBeenCalledWith('/repo', '/repo', 'owner/repo');
  store.set(activeWorkspacePathAtom, null);
  resolve([{ id: 'old', workspaceId: '/repo', state: 'merged' }]);
  await Promise.resolve();
  expect(store.get(prListAtom)).toEqual([]);
  stop();
});
