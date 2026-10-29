// @vitest-environment node
import { createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { applySessionApprovalSnapshotAtom, clearSessionApprovalsAtom, sessionAwaitingApprovalAtom } from '../sessionApproval';
import { sessionRegistryAtom, sessionProcessingAtom, sessionHasPendingInteractivePromptAtom, type SessionMeta } from '../sessions';
import { sessionsByPhaseAtom, sessionKanbanFilterAtom } from '../sessionKanban';
import { findApprovalMessageIndex } from '../../../../shared/approvalMessageTarget';

const session = (id: string, phase?: string, parentSessionId?: string) => ({
  id, phase, parentSessionId, title: id, updatedAt: 1, tags: [], childCount: parentSessionId ? 0 : 1,
} as unknown as SessionMeta);

describe('approval display state', () => {
  it.each(['claude-code', 'claude-code-cli', 'openai-codex', 'opencode', 'github-copilot', 'grok-build', 'cursor', 'openai-codex-acp'])(
    'overlays workflow phases for %s while excluding ordinary questions', provider => {
      const store = createStore();
      store.set(sessionRegistryAtom, new Map([['task', { ...session('task', 'implementing'), provider }]]));
      store.set(sessionProcessingAtom('task'), true);
      store.set(sessionHasPendingInteractivePromptAtom('task'), true);
      expect(store.get(sessionsByPhaseAtom).get('implementing')?.map(s => s.id)).toEqual(['task']);
      store.set(applySessionApprovalSnapshotAtom, { revision: 1, approvals: [
        { sessionId: 'task', requestId: 'tool-1', type: 'permission' },
        { sessionId: 'task', requestId: 'commit-1', type: 'git_commit' },
      ] });
      expect(store.get(sessionsByPhaseAtom).get('awaiting-approval')?.map(s => s.id)).toEqual(['task']);
      expect(store.get(sessionsByPhaseAtom).get('implementing')).toEqual([]);
      store.set(applySessionApprovalSnapshotAtom, { revision: 2, approvals: [{ sessionId: 'task', requestId: 'commit-1', type: 'git_commit' }] });
      expect(store.get(sessionAwaitingApprovalAtom('task'))).toBe(true);
      store.set(applySessionApprovalSnapshotAtom, { revision: 3, approvals: [] });
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
    expect(store.get(sessionsByPhaseAtom).get('awaiting-approval')?.map(s => s.id)).toEqual(['parent', 'unphased']);
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
