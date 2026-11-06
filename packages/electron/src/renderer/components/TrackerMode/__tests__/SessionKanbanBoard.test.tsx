import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { SessionKanbanBoard } from '../SessionKanbanBoard';
import { sessionRegistryAtom, sessionProcessingAtom, sessionHasPendingInteractivePromptAtom, sessionStoreAtom, sessionListWorkspaceAtom, refreshSessionListAtom, trackerSessionMetricsActiveAtom, updateSessionStoreAtom } from '../../../store/atoms/sessions';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { trackerCompletionMetricsAtom } from '../../../store/atoms/completionMetrics';
import { TrackerCompletionMetrics } from '../CompletionMetrics';
import { worktreeRecordsAtom } from '../../../store/atoms/worktrees';
import { worktreeGitStatusAtom } from '../../../store/atoms/sessionFiles';
import { prListAtom } from '../../../store/atoms/pullRequests';
import { observeSessionKanbanStatus, sessionKanbanTagsAtom, sessionKanbanTotalCountAtom, setSessionBoardColumnAtom } from '../../../store/atoms/sessionKanban';

vi.mock('posthog-js/react', () => ({ usePostHog: () => undefined }));
vi.mock('../../AgenticCoding/SessionContextMenu', () => ({ SessionContextMenu: () => null }));
vi.mock('../../AgenticCoding/SessionTranscriptPeek', () => ({ SessionTranscriptPeek: () => null }));
vi.mock('../../AgenticCoding/SessionRelativeTime', () => ({ SessionRelativeTime: () => 'Just now' }));
vi.mock('../../AgentMode/ArchiveWorktreeDialog', () => ({ ArchiveWorktreeDialog: () => null }));
vi.mock('../../../hooks/useArchiveWorktreeDialog', () => ({ useArchiveWorktreeDialog: () => ({ dialogState: null }) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
beforeAll(() => loadBuiltinTrackers());

const blockedTestSession = (id: string, overrides: Partial<SessionMeta> = {}): SessionMeta => ({
  id, title: id, provider: 'openai-codex', workspaceId: '/repo', sessionType: 'session',
  worktreeId: null, parentSessionId: null, childCount: 0, uncommittedCount: 0,
  createdAt: 1, updatedAt: 1, messageCount: 1, hasStarted: true, isArchived: false, isPinned: false,
  ...overrides,
});
const dependencyTicket = (id: string, fields: Record<string, unknown> = {}, linkedSessions: string[] = []): TrackerRecord => ({
  id, primaryType: 'task', typeTags: ['task'], source: 'native', archived: false, syncStatus: 'local',
  system: { workspace: '/repo', createdAt: '2026-11-05', updatedAt: '2026-11-05', linkedSessions },
  fields: { title: id, status: 'to-do', ...fields },
} as TrackerRecord);

it('keeps linked work blocked until every dependency clears, then restores its Git lane without changing ticket status', async () => {
  const store = createStore();
  const session = blockedTestSession('waiting-work', { linkedTrackerItemIds: ['dependent'], uncommittedCount: 1 });
  const dependent = dependencyTicket('dependent', { status: 'in-progress', dependsOn: [{ itemId: 'first' }, { itemId: 'second' }] });
  const update = (first: string, second: string) => store.set(trackerItemsMapAtom, new Map([
    dependent, dependencyTicket('first', { status: first }), dependencyTicket('second', { status: second }),
  ].map(item => [item.id, item])));
  update('to-do', 'to-do');
  store.set(sessionRegistryAtom, new Map([[session.id, session]]));
  const view = render(<Provider store={store}><SessionKanbanBoard /></Provider>);
  const cards = (column: string) => within(view.container.querySelector(`[data-phase="${column}"]`)! as HTMLElement)
    .queryAllByTestId('session-kanban-card').map(card => card.dataset.sessionId);
  expect(cards('blocked')).toEqual([session.id]);
  expect(screen.getByText('blocked').textContent).toContain('blocked');
  await act(async () => { await store.set(setSessionBoardColumnAtom, { sessionId: session.id, phase: 'validating' }); });
  expect(cards('blocked')).toEqual([session.id]);
  act(() => update('done', 'to-do'));
  expect(cards('blocked')).toEqual([session.id]);
  act(() => update('done', 'done'));
  expect(cards('blocked')).toEqual([]);
  expect(cards('git')).toEqual([session.id]);
  act(() => update('to-do', 'done'));
  expect(cards('blocked')).toEqual([session.id]);
  act(() => store.set(sessionProcessingAtom(session.id), true));
  expect(cards('blocked')).toEqual([session.id]);
  act(() => store.set(sessionHasPendingInteractivePromptAtom(session.id), true));
  expect(cards('blocked')).toEqual([session.id]);
  act(() => update('done', 'done'));
  expect(cards('awaiting-input')).toEqual([session.id]);
  expect(dependent.fields.status).toBe('in-progress');
});

it('surfaces a blocked child through its workstream using reverse ticket links and clears it when the ticket closes', () => {
  const store = createStore();
  const parent = blockedTestSession('workstream', { sessionType: 'workstream', childCount: 1 });
  const child = blockedTestSession('blocked-child', { parentSessionId: parent.id });
  const blocker = dependencyTicket('prerequisite');
  const ticket = dependencyTicket('child-ticket', { dependsOn: [{ itemId: blocker.id }] }, [child.id]);
  store.set(sessionRegistryAtom, new Map([parent, child].map(session => [session.id, session])));
  store.set(trackerItemsMapAtom, new Map([blocker, ticket].map(item => [item.id, item])));
  const view = render(<Provider store={store}><SessionKanbanBoard /></Provider>);
  const lane = (name: string) => view.container.querySelector(`[data-phase="${name}"]`)! as HTMLElement;
  expect(within(lane('blocked')).getAllByTestId('session-kanban-card').map(card => card.dataset.sessionId)).toEqual([parent.id]);
  expect(within(lane('blocked')).getByText('1 blocked').textContent).toBe('1 blocked');
  act(() => store.set(trackerItemsMapAtom, new Map([blocker, { ...ticket, fields: { ...ticket.fields, status: 'done' } }].map(item => [item.id, item]))));
  expect(within(lane('blocked')).queryAllByTestId('session-kanban-card')).toHaveLength(0);
  expect(within(lane('validating')).getAllByTestId('session-kanban-card')).toHaveLength(1);
});

it('allows a manual Blocked placement until the session operational state changes', async () => {
  const invoke = vi.fn().mockResolvedValue({ success: true });
  vi.stubGlobal('window', Object.assign(window, { electronAPI: { invoke } }));
  const store = createStore();
  const session = blockedTestSession('manual-block');
  store.set(sessionRegistryAtom, new Map([[session.id, session]]));
  const stop = observeSessionKanbanStatus(store);
  const view = render(<Provider store={store}><SessionKanbanBoard /></Provider>);
  await act(async () => { await store.set(setSessionBoardColumnAtom, { sessionId: session.id, phase: 'blocked' }); });
  const blocked = view.container.querySelector('[data-phase="blocked"]')! as HTMLElement;
  expect(within(blocked).getAllByTestId('session-kanban-card')).toHaveLength(1);
  expect(invoke).toHaveBeenCalledWith('sessions:update-session-metadata', session.id, {
    kanbanOverride: expect.objectContaining({ column: 'blocked' }),
  });
  act(() => store.set(sessionProcessingAtom(session.id), true));
  expect(within(blocked).queryAllByTestId('session-kanban-card')).toHaveLength(0);
  expect(store.get(sessionRegistryAtom).get(session.id)?.kanbanOverride).toBeUndefined();
  stop();
});

it('recognizes a linked manual Blocked status without blocking archived or foreign-workspace tickets', () => {
  const store = createStore();
  const sessions = ['manual-status', 'archived-ticket', 'other-workspace'].map(id => blockedTestSession(id, { linkedTrackerItemIds: [id] }));
  const manual = dependencyTicket('manual-status', { status: 'blocked' });
  const archived = { ...dependencyTicket('archived-ticket', { status: 'blocked' }), archived: true };
  const foreign = dependencyTicket('other-workspace', { status: 'blocked' });
  foreign.system.workspace = '/another-project';
  store.set(sessionRegistryAtom, new Map(sessions.map(session => [session.id, session])));
  store.set(trackerItemsMapAtom, new Map([manual, archived, foreign].map(item => [item.id, item])));
  const view = render(<Provider store={store}><SessionKanbanBoard /></Provider>);
  const blocked = view.container.querySelector('[data-phase="blocked"]')! as HTMLElement;
  expect(within(blocked).getAllByTestId('session-kanban-card').map(card => card.dataset.sessionId)).toEqual(['manual-status']);
});

it.each(['running', 'input'] as const)('keeps a blocked ticket’s agent in Blocked while it is %s and restores its lane when unblocked', activity => {
  const store = createStore();
  const session = blockedTestSession('access-agent', { linkedTrackerItemIds: ['access-ticket'] });
  const ticket = dependencyTicket('access-ticket', { status: 'blocked' });
  store.set(sessionRegistryAtom, new Map([[session.id, session]]));
  store.set(trackerItemsMapAtom, new Map([[ticket.id, ticket]]));
  store.set(sessionProcessingAtom(session.id), true);
  store.set(sessionHasPendingInteractivePromptAtom(session.id), activity === 'input');
  const view = render(<Provider store={store}><SessionKanbanBoard /></Provider>);
  const cards = (column: string) => within(view.container.querySelector(`[data-phase="${column}"]`)! as HTMLElement)
    .queryAllByTestId('session-kanban-card').map(card => card.dataset.sessionId);
  expect(cards('blocked')).toEqual([session.id]);
  expect(screen.getByText('blocked').textContent).toContain('blocked');
  expect(cards('implementing')).toEqual([]);
  expect(cards('awaiting-input')).toEqual([]);
  act(() => store.set(trackerItemsMapAtom, new Map([[ticket.id, { ...ticket, fields: { ...ticket.fields, status: 'in-progress' } }]])));
  expect(cards('blocked')).toEqual([]);
  expect(cards(activity === 'input' ? 'awaiting-input' : 'implementing')).toEqual([session.id]);
});

it('surfaces a blocked descendant ahead of running siblings in its workstream', () => {
  const store = createStore();
  const parent = blockedTestSession('parent', { sessionType: 'workstream', childCount: 2 });
  const blocked = blockedTestSession('blocked-child', { parentSessionId: parent.id, linkedTrackerItemIds: ['ticket'] });
  const running = blockedTestSession('running-child', { parentSessionId: parent.id });
  store.set(sessionRegistryAtom, new Map([parent, blocked, running].map(session => [session.id, session])));
  store.set(trackerItemsMapAtom, new Map([['ticket', dependencyTicket('ticket', { status: 'blocked' })]]));
  store.set(sessionProcessingAtom(blocked.id), true);
  store.set(sessionProcessingAtom(running.id), true);
  const view = render(<Provider store={store}><SessionKanbanBoard /></Provider>);
  const lane = within(view.container.querySelector('[data-phase="blocked"]')! as HTMLElement);
  expect(lane.getAllByTestId('session-kanban-card').map(card => card.dataset.sessionId)).toEqual([parent.id]);
  expect(lane.getByText('1 blocked').textContent).toBe('1 blocked');
});

it('routes a clicked card and moves three sessions and counts through a question, resume, finish and manual drag', async () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  vi.stubGlobal('window', Object.assign(window, { electronAPI: { invoke: vi.fn().mockResolvedValue({ success: true }) } }));
  const store = createStore();
  const sessions = ['one', 'two', 'three'].map(id => ({
    id, title: id, provider: 'openai-codex', workspaceId: '/repo', sessionType: 'session',
    worktreeId: null, parentSessionId: null, childCount: 0, uncommittedCount: 0,
    createdAt: 1, updatedAt: 1, messageCount: 0, isArchived: false, isPinned: false,
  } satisfies SessionMeta));
  store.set(sessionRegistryAtom, new Map(sessions.map(s => [s.id, s])));
  store.set(sessionProcessingAtom('one'), true);
  store.set(sessionProcessingAtom('two'), true);
  const stop = observeSessionKanbanStatus(store);
  const open = vi.fn();
  const view = render(<Provider store={store}><SessionKanbanBoard onSessionOpen={open} /></Provider>);
  const column = (key: string) => view.container.querySelector(`[data-phase="${key}"]`)! as HTMLElement;
  const cards = (key: string) => within(column(key)).queryAllByTestId('session-kanban-card').map(c => c.dataset.sessionId);
  expect(cards('implementing')).toEqual(['one', 'two']);
  expect(cards('backlog')).toEqual(['three']);
  fireEvent.click(screen.getByText('one'));
  expect(open).toHaveBeenCalledWith('one');
  act(() => store.set(sessionHasPendingInteractivePromptAtom('two'), true));
  expect(cards('awaiting-input')).toEqual(['two']);
  expect(cards('implementing')).toEqual(['one']);
  expect(within(column('awaiting-input')).getByText('1').textContent).toBe('1');
  expect(within(column('awaiting-input')).getByText('needs input').textContent).toContain('needs input');
  act(() => store.set(sessionHasPendingInteractivePromptAtom('two'), false));
  expect(cards('implementing')).toEqual(['one', 'two']);
  act(() => {
    store.set(sessionRegistryAtom, new Map(store.get(sessionRegistryAtom)).set('one', { ...sessions[0], hasStarted: true }));
    store.set(sessionProcessingAtom('one'), false);
  });
  expect(cards('validating')).toEqual(['one']);
  await act(async () => {
    fireEvent.drop(column('complete').querySelector('[data-testid="session-kanban-column-dropzone"]') ?? column('complete').lastElementChild!, {
      dataTransfer: { getData: () => JSON.stringify(['three']) },
    });
  });
  expect(cards('complete')).toEqual([]);
  expect(cards('backlog')).toEqual(['three']);
  act(() => store.set(sessionProcessingAtom('three'), true));
  expect(cards('implementing')).toContain('three');
  stop();
});


it('shows recorded metrics only in Done, includes descendants once and responds to live usage', () => {
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  const store = createStore();
  const root: SessionMeta = {
    id: 'metrics-root', title: 'Resolved ticket', provider: 'openai-codex', workspaceId: '/repo', sessionType: 'workstream',
    worktreeId: null, parentSessionId: null, childCount: 1, uncommittedCount: 0,
    createdAt: 1, updatedAt: 900000, messageCount: 0, isArchived: false, isPinned: false,
  };
  const child: SessionMeta = { ...root, id: 'metrics-child', parentSessionId: root.id, childCount: 0,
    sessionType: 'session', hasStarted: true, isArchived: true,
    completionMetrics: { totalTokens: 12500, startedAt: 1000, endedAt: 151000, costUSD: 0.25 },
  };
  root.worktreeId = 'metrics-wt';
  child.worktreeId = 'metrics-wt';
  store.set(worktreeRecordsAtom, new Map([['metrics-wt', { id: 'metrics-wt', name: 'metrics', path: '/wt', branch: 'metrics', isPinned: false }]]));
  store.set(prListAtom, [{ workspaceId: '/repo', remote: 'owner/repo', number: 1, headRef: 'metrics', state: 'merged' } as any]);
  store.set(sessionRegistryAtom, new Map([[root.id, root], [child.id, child]]));
  const view = render(<Provider store={store}><SessionKanbanBoard /></Provider>);
  const card = screen.getByTestId('session-kanban-card');
  expect(within(card).getByText('12.5K tokens').textContent).toBe('12.5K tokens');
  expect(within(card).getByText('2m 30s elapsed').textContent).toBe('2m 30s elapsed');
  expect(within(card).getByText('$0.25').textContent).toBe('$0.25');
  act(() => store.set(sessionStoreAtom(child.id), {
    id: child.id, provider: 'openai-codex', messages: [], createdAt: 1, updatedAt: 151000,
    tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
  }));
  expect(within(card).getByText('12.5K tokens').textContent).toBe('12.5K tokens');
  act(() => store.set(sessionStoreAtom(child.id), {
    ...store.get(sessionStoreAtom(child.id))!,
    tokenUsage: { inputTokens: 20000, outputTokens: 5000, totalTokens: 25000 },
  }));
  expect(within(card).getByText('25K tokens').textContent).toBe('25K tokens');
  act(() => store.set(updateSessionStoreAtom, { sessionId: root.id, updates: { isArchived: true } }));
  expect(screen.queryAllByTestId('session-kanban-card')).toHaveLength(0);
  act(() => {
    store.set(sessionRegistryAtom, new Map([[root.id, { ...root, isArchived: false }], [child.id, { ...child, isArchived: false }]]));
    store.set(sessionProcessingAtom(root.id), true);
  });
  expect(view.container.querySelector('.completion-metrics')).toBeNull();
});

it('deduplicates forward/reverse tracker links and descendants and identifies partial usage', () => {
  const store = createStore();
  const base = { title: 'Session', provider: 'openai-codex', workspaceId: '/repo', sessionType: 'session' as const,
    worktreeId: null, childCount: 0, uncommittedCount: 0, createdAt: 1, updatedAt: 2,
    messageCount: 1, isArchived: true, isPinned: false };
  const parent = { ...base, id: 'parent', parentSessionId: null, childCount: 1, linkedTrackerItemIds: ['ticket'],
    completionMetrics: { totalTokens: 100, startedAt: 1000, endedAt: 5000 } };
  const child = { ...base, id: 'child', parentSessionId: 'parent', linkedTrackerItemIds: ['ticket'],
    completionMetrics: { totalTokens: 200, startedAt: 2000, endedAt: 4000 } };
  const unknown = { ...base, id: 'unknown', parentSessionId: null, linkedTrackerItemIds: ['ticket'] };
  store.set(sessionRegistryAtom, new Map([parent, child, unknown].map(s => [s.id, s])));
  const item = { id: 'ticket', primaryType: 'task', typeTags: ['task'], fields: { title: 'Done ticket', status: 'done' },
    system: { linkedSessions: ['parent', 'child'] } } as any;
  store.set(trackerItemsMapAtom, new Map([[item.id, item]]));
  expect(store.get(trackerCompletionMetricsAtom(item.id))).toMatchObject({ sessionCount: 3, totalTokens: 300,
    elapsedMs: 4000, partialTokens: true, partialTime: true });
  const view = render(<Provider store={store}><TrackerCompletionMetrics item={item} /></Provider>);
  expect(screen.getByText('300 tokens (partial)').textContent).toBe('300 tokens (partial)');
  act(() => store.set(trackerItemsMapAtom, new Map([[item.id, {
    ...item, system: { linkedSessions: ['parent', 'child', 'missing-session'] },
  }]])));
  expect(store.get(trackerCompletionMetricsAtom(item.id))).toMatchObject({ sessionCount: 4, totalTokens: 300, partialTokens: true });
  view.rerender(<Provider store={store}><TrackerCompletionMetrics item={{ ...item, fields: { status: 'in-progress' } }} /></Provider>);
  expect(view.container.querySelector('.completion-metrics')).toBeNull();
});

it('includes archived sessions for tracker metrics while preserving the sidebar archive preference', async () => {
  const invoke = vi.fn().mockResolvedValue({ success: true, sessions: [] });
  vi.stubGlobal('window', Object.assign(window, { electronAPI: { invoke } }));
  const store = createStore();
  store.set(sessionListWorkspaceAtom, '/repo');
  store.set(trackerSessionMetricsActiveAtom, true);
  await store.set(refreshSessionListAtom);
  expect(invoke).toHaveBeenLastCalledWith('sessions:list', '/repo', { includeArchived: true });
  store.set(trackerSessionMetricsActiveAtom, false);
  await store.set(refreshSessionListAtom);
  expect(invoke).toHaveBeenLastCalledWith('sessions:list', '/repo', { includeArchived: false });
});


it('renders all three Git sub-rows and moves a card as upstream status changes', () => {
  const store = createStore();
  const session = { id: 'git-task', title: 'Git task', workspaceId: '/repo', provider: 'openai-codex', worktreeId: 'wt',
    sessionType: 'session', childCount: 0, uncommittedCount: 0, messageCount: 1, hasStarted: true, createdAt: 1, updatedAt: 1 } as SessionMeta;
  store.set(sessionRegistryAtom, new Map([[session.id, session]]));
  const status = { ahead: 1, behind: 0, hasUncommittedChanges: true, hasUpstream: true, unpushedCommits: 0 };
  store.set(worktreeGitStatusAtom('wt'), status);
  const view = render(<Provider store={store}><SessionKanbanBoard /></Provider>);
  const row = (stage: string) => view.container.querySelector(`[data-git-stage="${stage}"]`)! as HTMLElement;
  expect(within(row('ready-for-commit')).getByText('Git task').textContent).toBe('Git task');
  expect(within(row('ready-for-push')).queryAllByTestId('session-kanban-card')).toHaveLength(0);
  expect(within(row('ready-for-pr')).queryAllByTestId('session-kanban-card')).toHaveLength(0);
  act(() => store.set(worktreeGitStatusAtom('wt'), { ...status, hasUncommittedChanges: false, unpushedCommits: 1 }));
  expect(within(row('ready-for-push')).getByText('Git task').textContent).toBe('Git task');
  act(() => store.set(worktreeGitStatusAtom('wt'), { ...status, hasUncommittedChanges: false }));
  expect(within(row('ready-for-pr')).getByText('Git task').textContent).toBe('Git task');
});


it('removes archived cards and counts immediately and restores them on unarchive', () => {
  const store = createStore();
  const active: SessionMeta = {
    id: 'archive-card', title: 'Archive this session', provider: 'openai-codex', workspaceId: '/repo', sessionType: 'session',
    worktreeId: null, parentSessionId: null, childCount: 0, uncommittedCount: 0,
    createdAt: 1, updatedAt: 1, messageCount: 1, isArchived: false, isPinned: false, tags: ['archive-test'],
  };
  store.set(sessionRegistryAtom, new Map([[active.id, active]]));
  render(<Provider store={store}><SessionKanbanBoard /></Provider>);
  expect(screen.getAllByTestId('session-kanban-card').map(card => card.dataset.sessionId)).toEqual([active.id]);
  expect(store.get(sessionKanbanTotalCountAtom)).toBe(1);
  act(() => store.set(updateSessionStoreAtom, { sessionId: active.id, updates: { isArchived: true } }));
  expect(screen.queryAllByTestId('session-kanban-card')).toHaveLength(0);
  expect(store.get(sessionKanbanTotalCountAtom)).toBe(0);
  expect(store.get(sessionKanbanTagsAtom)).toEqual([]);
  expect(store.get(sessionRegistryAtom).get(active.id)?.isArchived).toBe(true);
  act(() => store.set(updateSessionStoreAtom, { sessionId: active.id, updates: { isArchived: false } }));
  expect(screen.getAllByTestId('session-kanban-card').map(card => card.dataset.sessionId)).toEqual([active.id]);
  expect(store.get(sessionKanbanTotalCountAtom)).toBe(1);
  expect(store.get(sessionKanbanTagsAtom)).toEqual([{ name: 'archive-test', count: 1 }]);
});
