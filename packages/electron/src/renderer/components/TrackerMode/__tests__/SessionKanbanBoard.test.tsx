import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { SessionKanbanBoard } from '../SessionKanbanBoard';
import { sessionRegistryAtom, sessionProcessingAtom, sessionHasPendingInteractivePromptAtom } from '../../../store/atoms/sessions';
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
