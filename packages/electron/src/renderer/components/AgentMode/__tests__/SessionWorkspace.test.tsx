import React, { useLayoutEffect, useState } from 'react';
import '@testing-library/jest-dom/vitest';
import { Provider } from 'jotai';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { SessionWorkspace } from '../SessionWorkspace';
import { AgentSessionPanel } from '../AgentSessionPanel';
import { agentModeLayoutAtomFamily, mergeWithDefaults, pendingAgentModeRestoresAtom, secondarySessionFocusedAtom } from '../../../store/atoms/agentMode';
import {
  sessionRegistryAtom, sessionProcessingAtom, sessionHasPendingInteractivePromptAtom,
  sessionDraftInputAtom, activeSessionIdAtom,
} from '../../../store/atoms/sessions';

vi.mock('../../../store', async () => {
  const sessions = await import('../../../store/atoms/sessions');
  const { atom } = await import('jotai');
  return { ...sessions, createChildSessionAtom: atom(null, () => {}) };
});
vi.mock('../../AgenticCoding/SessionContextMenu', () => ({ SessionContextMenu: () => null }));
vi.mock('../../UnifiedAI/SessionTranscript', async () => {
  const { useAtom } = await import('jotai');
  const { sessionDraftInputAtom } = await import('../../../store/atoms/sessions');
  // Exercise real panel/session-ID wiring with a narrow transcript transport stub.
  return { SessionTranscript: ({ sessionId }: { sessionId: string }) => {
    const [draft, setDraft] = useAtom(sessionDraftInputAtom(sessionId));
    return <div>
      <textarea aria-label={`Message ${sessionId}`} value={draft} onChange={event => setDraft(event.target.value)} />
      <button onClick={() => window.electronAPI.invoke('ai:sendMessage', draft, {}, sessionId, '/project')}>Send {sessionId}</button>
    </div>;
  } };
});

const workspacePath = '/project';
let invoke: ReturnType<typeof vi.fn>;
function Harness({ initial = 'one' }: { initial?: string }) {
  const [active, setActive] = useState<string | null>(initial);
  const [board, setBoard] = useState(false);
  return <><button onClick={() => { setActive('two'); setBoard(false); }}>Open session two</button>
    <button onClick={() => { setActive('three'); setBoard(false); }}>Open session three</button>
    <SessionWorkspace workspacePath={workspacePath} activeSessionId={active}
    showBoard={board} board={<div>Board content</div>} onShowBoard={() => setBoard(true)}
    onSelectSession={id => { setActive(id); setBoard(false); }} onClearSelection={() => setActive(null)}>
    {active && <AgentSessionPanel key={active} sessionId={active} workspacePath={workspacePath} />}
  </SessionWorkspace></>;
}

function renderWorkspace() { return render(<Provider store={store}><Harness /></Provider>); }

beforeEach(() => {
  vi.useFakeTimers();
  invoke = vi.fn(async () => ({ success: true }));
  Object.assign(window, { electronAPI: { invoke } });
  store.set(agentModeLayoutAtomFamily(workspacePath), mergeWithDefaults({ openSessionIds: ['one', 'two', 'three'] }));
  store.set(secondarySessionFocusedAtom(workspacePath), false);
  store.set(pendingAgentModeRestoresAtom(workspacePath), 0);
  store.set(sessionRegistryAtom, new Map(['one', 'two', 'three'].map(id => [id, {
    id, title: id, workspaceId: workspacePath, provider: 'claude-code',
  } as SessionMeta])));
  for (const id of ['one', 'two', 'three']) {
    store.set(sessionProcessingAtom(id), true);
    store.set(sessionDraftInputAtom(id), '');
    store.set(sessionHasPendingInteractivePromptAtom(id), false);
  }
});
afterEach(() => { cleanup(); vi.clearAllTimers(); vi.useRealTimers(); });

it('talks to two sessions, switches to the board and a third tab, and leaves every runner active', async () => {
  renderWorkspace();
  fireEvent.click(screen.getByRole('button', { name: 'Split sessions side by side' }));
  fireEvent.change(screen.getByLabelText('Message one'), { target: { value: 'first prompt' } });
  fireEvent.change(screen.getByLabelText('Message two'), { target: { value: 'second prompt' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send one' }));
  fireEvent.click(screen.getByRole('button', { name: 'Send two' }));
  expect(invoke).toHaveBeenCalledWith('ai:sendMessage', 'first prompt', {}, 'one', workspacePath);
  expect(invoke).toHaveBeenCalledWith('ai:sendMessage', 'second prompt', {}, 'two', workspacePath);
  fireEvent.focus(screen.getByLabelText('Message two'));
  expect(store.get(activeSessionIdAtom)).toBe('two');
  expect(store.get(secondarySessionFocusedAtom(workspacePath))).toBe(true);

  fireEvent.click(screen.getByRole('button', { name: 'Session board' }));
  expect(screen.getByText('Board content')).toBeVisible();
  expect(screen.queryByLabelText('Message one')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'three' }));
  expect(screen.getByLabelText('Message three')).toBeVisible();
  expect(screen.getByLabelText('Message two')).toHaveValue('second prompt');
  fireEvent.click(screen.getByRole('button', { name: 'one' }));
  expect(screen.getByLabelText('Message one')).toHaveValue('first prompt');
  for (const id of ['one', 'two', 'three']) expect(store.get(sessionProcessingAtom(id))).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(invoke.mock.calls.every(([channel]) => ['ai:sendMessage', 'workspace:update-state', 'ai:updateSessionMetadata'].includes(channel))).toBe(true);
});

it('swaps the right-hand tab into the main pane without mounting duplicate inputs', () => {
  renderWorkspace();
  fireEvent.click(screen.getByRole('button', { name: 'Split sessions side by side' }));
  fireEvent.click(screen.getByRole('button', { name: 'two' }));
  expect(store.get(agentModeLayoutAtomFamily(workspacePath)).secondarySessionId).toBe('one');
  expect(screen.getAllByLabelText('Message one')).toHaveLength(1);
  expect(screen.getAllByLabelText('Message two')).toHaveLength(1);
});

it('adds sessions opened through existing navigation and persists the ordered tabs and split', async () => {
  store.set(agentModeLayoutAtomFamily(workspacePath), mergeWithDefaults(undefined));
  renderWorkspace();
  fireEvent.click(screen.getByRole('button', { name: 'Open session two' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open session three' }));
  fireEvent.click(screen.getByRole('button', { name: 'Open two side by side' }));
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(invoke).toHaveBeenCalledWith('workspace:update-state', workspacePath, {
    agenticCodingWindowState: expect.objectContaining({ openSessionIds: ['one', 'two', 'three'], secondarySessionId: 'two' }),
  });
});

it('does not record the initial selection before a parent layout effect starts restoring saved tabs', () => {
  store.set(agentModeLayoutAtomFamily(workspacePath), mergeWithDefaults(undefined));
  function RestoringParent() {
    useLayoutEffect(() => { store.set(pendingAgentModeRestoresAtom(workspacePath), 1); }, []);
    return <Harness />;
  }
  render(<Provider store={store}><RestoringParent /></Provider>);
  expect(store.get(agentModeLayoutAtomFamily(workspacePath)).openSessionIds).toEqual([]);
  act(() => {
    store.set(agentModeLayoutAtomFamily(workspacePath), mergeWithDefaults({ openSessionIds: ['two', 'three'] }));
    store.set(pendingAgentModeRestoresAtom(workspacePath), 0);
  });
  expect(store.get(agentModeLayoutAtomFamily(workspacePath)).openSessionIds).toEqual(['two', 'three', 'one']);
});

it('routes Find to the focused right-hand session and releases focus when that pane closes', () => {
  renderWorkspace();
  const find = vi.fn();
  window.addEventListener('transcript:find', find);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Split sessions side by side' }));
    fireEvent.focus(screen.getByLabelText('Message two'));
    act(() => { window.dispatchEvent(new Event('menu:find')); });
    expect(find).toHaveBeenCalledWith(expect.objectContaining({ detail: { sessionId: 'two' } }));
    fireEvent.click(screen.getByRole('button', { name: 'Close split pane' }));
    expect(store.get(secondarySessionFocusedAtom(workspacePath))).toBe(false);
    find.mockClear();
    act(() => { window.dispatchEvent(new Event('menu:find')); });
    expect(find).not.toHaveBeenCalled();
  } finally { window.removeEventListener('transcript:find', find); }
});

it('closes views without archiving, cancelling or re-opening the active tab', async () => {
  renderWorkspace();
  fireEvent.click(screen.getByRole('button', { name: 'Split sessions side by side' }));
  fireEvent.click(screen.getByRole('button', { name: 'Close two tab' }));
  expect(screen.queryByLabelText('Message two')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Close one tab' }));
  expect(screen.getByLabelText('Message three')).toBeVisible();
  expect(store.get(agentModeLayoutAtomFamily(workspacePath)).openSessionIds).toEqual(['three']);
  fireEvent.click(screen.getByRole('button', { name: 'Close three tab' }));
  expect(screen.getByText('Board content')).toBeVisible();
  await act(async () => { await vi.advanceTimersByTimeAsync(500); });
  expect(store.get(agentModeLayoutAtomFamily(workspacePath)).openSessionIds).toEqual([]);
  for (const id of ['one', 'two', 'three']) expect(store.get(sessionProcessingAtom(id))).toBe(true);
  expect(invoke.mock.calls.some(([channel]) => /cancel|archive|delete/i.test(channel))).toBe(false);
});

it('shows live input-waiting status and hides unavailable saved sessions', () => {
  store.set(sessionHasPendingInteractivePromptAtom('two'), true);
  store.set(agentModeLayoutAtomFamily(workspacePath), mergeWithDefaults({ openSessionIds: ['one', 'two', 'deleted'] }));
  const view = renderWorkspace();
  const tab = screen.getByRole('button', { name: 'two' }).closest('.session-workspace-tab') as HTMLElement;
  expect(within(tab).getByText('Waiting for input')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'deleted' })).toBeNull();
  act(() => { store.set(sessionHasPendingInteractivePromptAtom('two'), false); });
  expect(within(tab).getByText('Running')).toBeVisible();
  view.unmount();
});
