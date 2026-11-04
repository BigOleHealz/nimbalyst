// @vitest-environment jsdom
import {it, expect, vi} from 'vitest';
import {createNewSessionActionAtom} from '../actions/sessionHistoryActions';
import {activeWorkspacePathAtom} from '../atoms/openProjects';
import {activeFileRepoPathAtom} from '../atoms/workspaceRepos';
import {defaultAgentModelAtom, worktreesFeatureAvailableAtom} from '../atoms/appSettings';
import {selectedMachineAtom} from '../atoms/remoteMachines';

it('uses the host default for New Session while preserving an explicitly requested model', async () => {
  const invoke = vi.fn(async (_channel: string, ..._args: unknown[]) => 'remote-new');
  (window as any).electronAPI = {invoke};
  const get = ((key: unknown) => key === activeWorkspacePathAtom || key === activeFileRepoPathAtom ? '/repo' : key === worktreesFeatureAvailableAtom ? true : key === defaultAgentModelAtom ? 'openai-codex:gpt-6-astra' : key === selectedMachineAtom('/repo') ? 'sandbox-one' : undefined) as any;
  await createNewSessionActionAtom.write(get, vi.fn(), {selectSession: false});
  expect(invoke).toHaveBeenCalledWith('ai:createRemoteSession', '/repo', 'sandbox-one', {model: undefined});
  await createNewSessionActionAtom.write(get, vi.fn(), {selectSession: false, model: 'openai-codex:gpt-6-astra'});
  expect(invoke).toHaveBeenLastCalledWith('ai:createRemoteSession', '/repo', 'sandbox-one', {model: 'openai-codex:gpt-6-astra'});
  expect(invoke.mock.calls.every(([channel]) => channel === 'ai:createRemoteSession')).toBe(true);
});

it.each([
  { isRepo: true, launchSource: 'new_session_button', useCurrentCheckout: false, worktreeId: 'wt-1' },
  { isRepo: false, launchSource: 'new_session_button', useCurrentCheckout: false, worktreeId: undefined },
  { isRepo: true, launchSource: 'commit_flow', useCurrentCheckout: true, worktreeId: undefined },
] as const)('creates a session for $launchSource with worktree $worktreeId', async ({ isRepo, launchSource, useCurrentCheckout, worktreeId }) => {
  const invoke = vi.fn(async (channel: string, ..._args: unknown[]) => {
    if (channel === 'git:is-repo') return { success: true, isRepo };
    if (channel === 'worktree:create') return { success: true, worktree: { id: 'wt-1' } };
    if (channel === 'sessions:create') return { success: true, id: 'test-session' };
    throw new Error('Unexpected IPC channel: ' + channel);
  });
  (window as any).electronAPI = { invoke };
  const get = ((key: unknown) => key === activeWorkspacePathAtom ? '/repo'
    : key === activeFileRepoPathAtom ? '/repo/attached'
    : key === worktreesFeatureAvailableAtom ? true : undefined) as any;

  const result = await createNewSessionActionAtom.write(get, vi.fn(), {
    sessionId: 'test-session',
    model: 'openai-codex:gpt-6-astra',
    initialDraft: 'Implement the ticket',
    selectSession: false,
    launchSource,
    useCurrentCheckout,
  });

  expect(result).toBe('test-session');
  if (worktreeId) {
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual([
      'git:is-repo', 'worktree:create', 'sessions:create',
    ]);
    expect(invoke).toHaveBeenCalledWith('git:is-repo', '/repo/attached');
    expect(invoke).toHaveBeenCalledWith('worktree:create', '/repo', { sourceFolderPath: '/repo/attached' });
  } else {
    expect(invoke.mock.calls.some(([channel]) => channel === 'worktree:create')).toBe(false);
  }
  expect(invoke).toHaveBeenCalledWith('sessions:create', expect.objectContaining({
    workspaceId: '/repo',
    launchSource,
    hadPrefilledPrompt: true,
    session: expect.objectContaining({ id: 'test-session', model: 'openai-codex:gpt-6-astra', worktreeId }),
  }));
});

it('does not launch in the current checkout when worktree creation fails', async () => {
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'git:is-repo') return { success: true, isRepo: true };
    if (channel === 'worktree:create') return { success: false, error: 'Git worktree add failed' };
    throw new Error('Unexpected IPC channel: ' + channel);
  });
  (window as any).electronAPI = { invoke };
  const get = ((key: unknown) => key === activeWorkspacePathAtom ? '/repo'
    : key === worktreesFeatureAvailableAtom ? true : undefined) as any;

  expect(await createNewSessionActionAtom.write(get, vi.fn())).toBeUndefined();
  expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['git:is-repo', 'worktree:create']);
});
