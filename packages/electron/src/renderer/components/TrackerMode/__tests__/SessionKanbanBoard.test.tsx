import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { SessionKanbanBoard } from '../SessionKanbanBoard';
import { sessionRegistryAtom, sessionProcessingAtom, sessionHasPendingInteractivePromptAtom, sessionStoreAtom, sessionListWorkspaceAtom, refreshSessionListAtom, trackerSessionMetricsActiveAtom } from '../../../store/atoms/sessions';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { trackerCompletionMetricsAtom } from '../../../store/atoms/completionMetrics';
import { TrackerCompletionMetrics } from '../CompletionMetrics';
import { observeSessionKanbanStatus } from '../../../store/atoms/sessionKanban';

vi.mock('posthog-js/react', () => ({ usePostHog: () => undefined }));
vi.mock('../../AgenticCoding/SessionContextMenu', () => ({ SessionContextMenu: () => null }));
vi.mock('../../AgenticCoding/SessionTranscriptPeek', () => ({ SessionTranscriptPeek: () => null }));
vi.mock('../../AgenticCoding/SessionRelativeTime', () => ({ SessionRelativeTime: () => 'Just now' }));
vi.mock('../../AgentMode/ArchiveWorktreeDialog', () => ({ ArchiveWorktreeDialog: () => null }));
vi.mock('../../../hooks/useArchiveWorktreeDialog', () => ({ useArchiveWorktreeDialog: () => ({ dialogState: null }) }));

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

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
  expect(cards('complete')).toEqual(['three']);
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
    createdAt: 1, updatedAt: 900000, messageCount: 0, isArchived: true, isPinned: false,
  };
  const child: SessionMeta = { ...root, id: 'metrics-child', parentSessionId: root.id, childCount: 0,
    sessionType: 'session', hasStarted: true,
    completionMetrics: { totalTokens: 12500, startedAt: 1000, endedAt: 151000, costUSD: 0.25 },
  };
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
