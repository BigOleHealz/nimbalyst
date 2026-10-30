// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { sessionRegistryAtom } from '../../atoms/sessions';
import { sessionListMetadata } from '../../atoms/sessionListMetadata';
import { worktreeRecordsAtom } from '../../atoms/worktrees';
import { activeWorkspacePathAtom } from '../../atoms/openProjects';
import { prListAtom } from '../../atoms/pullRequests';
import { initWorktreeListeners } from '../worktreeListeners';
import { initPullRequestListeners } from '../pullRequestListeners';

const api = vi.hoisted(() => ({ list: vi.fn(), detectRemote: vi.fn(), onListUpdated: vi.fn(() => () => {}), getStatus: vi.fn().mockResolvedValue({ installed: false, authed: false }), onStatusChanged: vi.fn(() => () => {}) }));
vi.mock('../../../services/RendererPullRequestService', () => ({ getPullRequestService: () => api }));
vi.mock('../../../services/RendererGhCliService', () => ({ getGhCliService: () => api }));

afterEach(() => { store.set(sessionRegistryAtom, new Map()); store.set(worktreeRecordsAtom, new Map()); store.set(activeWorkspacePathAtom, null); store.set(prListAtom, []); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('resolves session branches in one existing worktree batch without mounting the sidebar', async () => {
  const invoke = vi.fn().mockResolvedValue({ success: true, worktrees: { wt: { id: 'wt', name: 'work', path: '/wt', branch: 'codex/test', isPinned: false } } });
  vi.stubGlobal('window', { electronAPI: { invoke, on: () => () => {} } });
  const session = sessionListMetadata({ id: 'a', createdAt: 1, updatedAt: 1, worktreeId: 'wt' }, '/repo');
  store.set(sessionRegistryAtom, new Map([['a', session], ['b', { ...session, id: 'b' }]]));
  const stop = initWorktreeListeners();
  await vi.waitFor(() => expect(store.get(worktreeRecordsAtom).get('wt')?.branch).toBe('codex/test'));
  expect(invoke).toHaveBeenCalledExactlyOnceWith('worktree:get-batch', ['wt']);
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
  store.set(activeWorkspacePathAtom, null);
  resolve([{ id: 'old', workspaceId: '/repo', state: 'merged' }]);
  await Promise.resolve();
  expect(store.get(prListAtom)).toEqual([]);
  stop();
});
