// @vitest-environment node
import { createStore } from 'jotai';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { applySessionApprovalSnapshotAtom, clearSessionApprovalsAtom, sessionAwaitingApprovalAtom } from '../sessionApproval';
import { sessionRegistryAtom, sessionProcessingAtom, sessionHasPendingInteractivePromptAtom, type SessionMeta } from '../sessions';
import { sessionsByPhaseAtom, sessionKanbanFilterAtom, setSessionBoardColumnAtom, observeSessionKanbanStatus, sessionAutomaticBoardStateAtom } from '../sessionKanban';
import { worktreeGitStatusAtom } from '../sessionFiles';
import { findApprovalMessageIndex } from '../../../../shared/approvalMessageTarget';
import { prListAtom } from '../pullRequests';
import { worktreeRecordsAtom } from '../worktrees';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import type { PullRequestRow } from '../../../../main/services/PullRequestsStore';

const session = (id: string, phase?: string, parentSessionId?: string) => ({
  id, phase, parentSessionId, title: id, updatedAt: 1, tags: [], childCount: 0, messageCount: 0,
} as unknown as SessionMeta);

describe('approval display state', () => {
  it.each(['claude-code', 'claude-code-cli', 'openai-codex', 'opencode', 'github-copilot', 'grok-build', 'cursor', 'openai-codex-acp'])(
    'groups questions and approvals as awaiting input for %s without changing workflow phases', provider => {
      const store = createStore();
      store.set(sessionRegistryAtom, new Map([['task', { ...session('task', 'implementing'), provider }]]));
      store.set(sessionProcessingAtom('task'), true);
      store.set(sessionHasPendingInteractivePromptAtom('task'), true);
      expect(store.get(sessionsByPhaseAtom).get('awaiting-input')?.map(s => s.id)).toEqual(['task']);
      store.set(applySessionApprovalSnapshotAtom, { revision: 1, approvals: [
        { sessionId: 'task', requestId: 'tool-1', type: 'permission' },
        { sessionId: 'task', requestId: 'commit-1', type: 'git_commit' },
      ] });
      expect(store.get(sessionsByPhaseAtom).get('awaiting-input')?.map(s => s.id)).toEqual(['task']);
      expect(store.get(sessionsByPhaseAtom).get('implementing')).toEqual([]);
      store.set(applySessionApprovalSnapshotAtom, { revision: 2, approvals: [{ sessionId: 'task', requestId: 'commit-1', type: 'git_commit' }] });
      expect(store.get(sessionAwaitingApprovalAtom('task'))).toBe(true);
      store.set(applySessionApprovalSnapshotAtom, { revision: 3, approvals: [] });
      store.set(sessionHasPendingInteractivePromptAtom('task'), false);
      expect(store.get(sessionsByPhaseAtom).get('implementing')?.map(s => s.id)).toEqual(['task']);
      expect(store.get(sessionRegistryAtom).get('task')?.phase).toBe('implementing');
    });

  it('surfaces an unphased session and a blocked child through its parent, even with completed cards hidden', () => {
    const store = createStore();
    store.set(sessionRegistryAtom, new Map([['parent', session('parent', 'complete')], ['child', session('child', undefined, 'parent')], ['unphased', session('unphased')]]));
    store.set(sessionKanbanFilterAtom, { search: '', tags: [], showComplete: false });
    store.set(applySessionApprovalSnapshotAtom, { revision: 1, approvals: [
      { sessionId: 'child', requestId: 'plan', type: 'plan_approval' },
      { sessionId: 'unphased', requestId: 'tool', type: 'permission' },
    ] });
    expect(store.get(sessionsByPhaseAtom).get('awaiting-input')?.map(s => s.id)).toEqual(['parent', 'unphased']);
  });

  it('clears stopped sessions and ignores replayed or out-of-order snapshots', () => {
    const store = createStore();
    const pending = { revision: 2, approvals: [{ sessionId: 'task', requestId: 'p1', type: 'permission' as const }] };
    store.set(applySessionApprovalSnapshotAtom, pending);
    store.set(clearSessionApprovalsAtom, 'task');
    store.set(applySessionApprovalSnapshotAtom, pending);
    store.set(applySessionApprovalSnapshotAtom, { ...pending, revision: 1 });
    expect(store.get(sessionAwaitingApprovalAtom('task'))).toBe(false);
    store.set(applySessionApprovalSnapshotAtom, { revision: 3, approvals: [{ sessionId: 'task', requestId: 'p2', type: 'permission' }] });
    expect(store.get(sessionAwaitingApprovalAtom('task'))).toBe(true);
  });
});

describe('automatic session kanban', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('moves three sessions independently through backlog, running, input, review and done', () => {
    const store = createStore();
    store.set(sessionRegistryAtom, new Map(['a', 'b', 'c'].map(id => [id, session(id)])));
    const ids = (column: string) => store.get(sessionsByPhaseAtom).get(column as never)?.map(s => s.id);
    expect(ids('backlog')).toEqual(['a', 'b', 'c']);
    store.set(sessionProcessingAtom('a'), true);
    store.set(sessionProcessingAtom('b'), true);
    store.set(sessionHasPendingInteractivePromptAtom('b'), true);
    expect(ids('implementing')).toEqual(['a']);
    expect(ids('awaiting-input')).toEqual(['b']);
    expect(ids('backlog')).toEqual(['c']);
    store.set(sessionHasPendingInteractivePromptAtom('b'), false);
    expect(ids('implementing')).toEqual(['a', 'b']);
    store.set(sessionRegistryAtom, new Map([['a', { ...session('a'), messageCount: 3 }], ['b', session('b')], ['c', session('c')]]));
    store.set(sessionProcessingAtom('a'), false);
    expect(ids('validating')).toEqual(['a']);
    store.set(sessionRegistryAtom, new Map([['a', { ...session('a'), isArchived: true }], ['b', session('b')], ['c', session('c')]]));
    expect(ids('complete')).toEqual([]);
  });

  it('keeps a drag through activity updates, expires it on status change, and never resurrects it', async () => {
    vi.stubGlobal('window', { electronAPI: { invoke: vi.fn().mockResolvedValue({ success: true }) } });
    const store = createStore();
    store.set(sessionRegistryAtom, new Map([['a', session('a', 'planning')]]));
    const stop = observeSessionKanbanStatus(store);
    await store.set(setSessionBoardColumnAtom, { sessionId: 'a', phase: 'validating' });
    expect(store.get(sessionsByPhaseAtom).get('validating')?.map(s => s.id)).toEqual(['a']);
    expect(store.get(sessionRegistryAtom).get('a')?.phase).toBe('planning');
    store.set(sessionRegistryAtom, new Map([['a', { ...store.get(sessionRegistryAtom).get('a')!, updatedAt: 200 }]]));
    expect(store.get(sessionsByPhaseAtom).get('validating')?.map(s => s.id)).toEqual(['a']);
    store.set(sessionProcessingAtom('a'), true);
    expect(store.get(sessionsByPhaseAtom).get('implementing')?.map(s => s.id)).toEqual(['a']);
    store.set(sessionProcessingAtom('a'), false);
    expect(store.get(sessionsByPhaseAtom).get('backlog')?.map(s => s.id)).toEqual(['a']);
    expect(store.get(sessionRegistryAtom).get('a')?.kanbanOverride).toBeUndefined();
    stop();
  });

  it('rolls up questions and does not treat archived sessions as merged', () => {
    const store = createStore();
    store.set(sessionRegistryAtom, new Map([
      ['root', session('root')], ['child', session('child', undefined, 'root')],
      ['leaf', { ...session('leaf', undefined, 'child'), worktreeId: 'isolated-worker' }], ['archived', { ...session('archived'), isArchived: true }],
    ]));
    store.set(sessionHasPendingInteractivePromptAtom('leaf'), true);
    store.set(sessionHasPendingInteractivePromptAtom('archived'), true);
    expect(store.get(sessionsByPhaseAtom).get('awaiting-input')?.map(s => s.id)).toEqual(['root']);
    expect(store.get(sessionsByPhaseAtom).get('complete')).toEqual([]);
    expect(store.get(sessionsByPhaseAtom).get('backlog')?.map(s => s.id)).toEqual(['archived']);
  });

  it('uses branch and explicit tracker references for PR review and merge, scoped to the workspace', () => {
    const store = createStore();
    const task = { ...session('task'), workspaceId: '/repo', worktreeId: 'wt', linkedTrackerItemIds: ['jira'] };
    store.set(sessionRegistryAtom, new Map([['task', task]]));
    store.set(worktreeRecordsAtom, new Map([['wt', { id: 'wt', name: 'wt', path: '/wt', branch: 'feature', isPinned: false }]]));
    const pr = { id: 'pr', workspaceId: '/other', remote: 'owner/repo', number: 1, headRef: 'feature', state: 'open' } as PullRequestRow;
    store.set(prListAtom, [pr]);
    expect(store.get(sessionsByPhaseAtom).get('backlog')?.map(s => s.id)).toEqual(['task']);
    store.set(prListAtom, [{ ...pr, workspaceId: '/repo' }]);
    expect(store.get(sessionsByPhaseAtom).get('validating')?.map(s => s.id)).toEqual(['task']);
    store.set(prListAtom, [{ ...pr, workspaceId: '/repo', state: 'merged' }]);
    expect(store.get(sessionsByPhaseAtom).get('complete')?.map(s => s.id)).toEqual(['task']);
    store.set(worktreeRecordsAtom, new Map());
    store.set(trackerItemsMapAtom, new Map([['jira', {
      id: 'jira', primaryType: 'task', typeTags: [], source: 'import', archived: false, syncStatus: 'local', fields: { title: 'Jira title' },
      system: { workspace: '/repo', createdAt: '', updatedAt: '', linkedPullRequests: [{ remote: 'owner/repo', number: 1 }] },
    }]]));
    expect(store.get(sessionsByPhaseAtom).get('complete')?.map(s => s.id)).toEqual(['task']);
  });

  it('rehydrates a matching manual placement and rolls back a failed drag without losing concurrent title changes', async () => {
    const invoke = vi.fn();
    let respond!: (value: unknown) => void;
    invoke.mockReturnValue(new Promise(resolve => { respond = resolve; }));
    vi.stubGlobal('window', { electronAPI: { invoke } });
    const store = createStore();
    const kanbanOverride = { column: 'validating' as const, status: '[["a","backlog"]]' };
    store.set(sessionRegistryAtom, new Map([['a', { ...session('a'), kanbanOverride }]]));
    expect(store.get(sessionsByPhaseAtom).get('validating')?.map(s => s.id)).toEqual(['a']);
    const pending = store.set(setSessionBoardColumnAtom, { sessionId: 'a', phase: 'implementing' });
    store.set(sessionRegistryAtom, new Map([['a', { ...store.get(sessionRegistryAtom).get('a')!, title: 'Renamed' }]]));
    respond({ success: false, error: 'disk full' });
    await pending;
    expect(store.get(sessionRegistryAtom).get('a')).toMatchObject({ title: 'Renamed', kanbanOverride });
  });

  it('derives Git stages from dirty files and upstream, then completes only on merge', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true });
    vi.stubGlobal('window', { electronAPI: { invoke } });
    const store = createStore();
    const task = { ...session('task', 'complete'), hasStarted: true, workspaceId: '/repo', worktreeId: 'wt' };
    store.set(sessionRegistryAtom, new Map([['task', task]]));
    store.set(worktreeRecordsAtom, new Map([['wt', { id: 'wt', name: 'wt', path: '/wt', branch: 'feature', isPinned: false }]]));
    const status = { ahead: 2, behind: 0, hasUncommittedChanges: true, hasUpstream: false, unpushedCommits: 0, headSha: 'head' };
    const state = () => store.get(sessionAutomaticBoardStateAtom).get('task');
    store.set(worktreeGitStatusAtom('wt'), status);
    expect(state()).toMatchObject({ column: 'git', gitStage: 'ready-for-commit' });
    store.set(worktreeGitStatusAtom('wt'), { ...status, hasUncommittedChanges: false });
    expect(state()).toMatchObject({ column: 'git', gitStage: 'ready-for-push' });
    store.set(worktreeGitStatusAtom('wt'), { ...status, hasUncommittedChanges: false, hasUpstream: true });
    expect(state()).toMatchObject({ column: 'git', gitStage: 'ready-for-pr' });
    await store.set(setSessionBoardColumnAtom, { sessionId: 'task', phase: 'complete' });
    expect(invoke).not.toHaveBeenCalled();
    expect(store.get(sessionsByPhaseAtom).get('complete')).toEqual([]);
    const pr = { id: 'pr', workspaceId: '/repo', remote: 'owner/repo', number: 1, headRef: 'feature', headSha: 'head', state: 'open' } as PullRequestRow;
    store.set(prListAtom, [pr]);
    expect(state()?.column).toBe('validating');
    store.set(prListAtom, [{ ...pr, state: 'closed' }]);
    expect(state()?.column).toBe('git');
    store.set(prListAtom, [{ ...pr, state: 'merged' }]);
    expect(state()?.column).toBe('complete');
    store.set(worktreeGitStatusAtom('wt'), { ...status, hasUncommittedChanges: false, hasUpstream: true, headSha: 'new-work' });
    expect(state()?.column).toBe('git');
    store.set(sessionProcessingAtom('task'), true);
    expect(state()?.column).toBe('implementing');
  });

  it('ignores persisted Done overrides without merge evidence and blocks parent completion for unfinished children', () => {
    const store = createStore();
    store.set(sessionRegistryAtom, new Map([
      ['root', { ...session('root'), sessionType: 'workstream', kanbanOverride: { column: 'complete', status: '[["child","backlog"],["root","backlog"]]' } }],
      ['child', session('child', 'complete', 'root')],
    ]));
    expect(store.get(sessionsByPhaseAtom).get('complete')).toEqual([]);
  });
});

it('locates approval widgets by request/proposal IDs and Codex aliases', () => {
  const messages = [
    { toolCall: { id: 'nimtc|call_permission|1000|0', arguments: {} } },
    { toolCall: { id: 'tool-2', arguments: { proposalId: 'commit-1' } } },
    { toolCall: { id: 'tool-3', arguments: { requestId: 'plan-1' } } },
  ];
  expect(findApprovalMessageIndex(messages, 'call_permission')).toBe(0);
  expect(findApprovalMessageIndex(messages, 'commit-1')).toBe(1);
  expect(findApprovalMessageIndex(messages, 'plan-1')).toBe(2);
  expect(findApprovalMessageIndex(messages, 'resolved-request')).toBe(-1);
  expect(findApprovalMessageIndex([...messages, { toolCall: { id: 'nimtc|call_permission|2000|0', arguments: {} } }], 'call_permission')).toBe(3);
});
