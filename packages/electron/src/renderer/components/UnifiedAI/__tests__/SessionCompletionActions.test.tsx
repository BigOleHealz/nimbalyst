// @vitest-environment jsdom
import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionCompletionActions } from '../SessionCompletionActions';
import { sessionSuccessfulCompletionAtom } from '../../../store/atoms/sessionCompletionActions';
import { sessionGitStatusAtom } from '../../../store/atoms/sessionFiles';
import { sessionRegistryAtom } from '../../../store/atoms/sessions';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';

afterEach(cleanup);
const context = { success: true, scenario: 'single', files: [{ path: 'src/task.ts', status: 'modified' }] };

function setup(options: { completion?: number | null; available?: boolean; provider?: string; worktreeId?: string; worktreePath?: string; getContext?: () => unknown; send?: () => unknown } = {}) {
  const state = createStore();
  state.set(sessionSuccessfulCompletionAtom('task'), options.completion === undefined ? 1 : options.completion);
  const invoke = vi.fn(async (channel: string, ..._args: unknown[]) => channel === 'git:get-commit-context' ? (options.getContext?.() ?? context) : options.send?.());
  (window as any).electronAPI = { invoke };
  const props = { sessionId: 'task', workspacePath: '/repo', available: options.available ?? true, provider: options.provider, worktreeId: options.worktreeId, worktreePath: options.worktreePath };
  const view = render(<Provider store={state}><SessionCompletionActions {...props} /></Provider>);
  return { state, invoke, view, props };
}

describe('session completion actions', () => {
  it('uses the linked ticket title for PR creation, keeping one canonical ID prefix', async () => {
    const {state,invoke}=setup();
    act(()=>{
      state.set(sessionRegistryAtom,new Map([['task',{id:'task',workspaceId:'/repo',title:'Short session',linkedTrackerItemIds:['ticket']} as any]]));
      state.set(trackerItemsMapAtom,new Map([['ticket',{id:'ticket',primaryType:'task',issueKey:'DES-79',fields:{title:'DES-79 Lesson navigation'},system:{workspace:'/repo'}} as any]]));
    });
    fireEvent.click(await screen.findByRole('button',{name:'Commit, Push & Open PR'}));
    await waitFor(()=>expect(invoke).toHaveBeenCalledWith('ai:sendMessage',expect.stringContaining('Use this exact pull request title: "DES-79: Lesson navigation"'),{mode:'agent',inputType:'user'},'task','/repo'));
  });
  it.each([
    ['Commit', 'Commit only. Do not push or open a pull request.'],
    ['Commit & Push', 'After the commit succeeds, push the task branch. Do not open a pull request.'],
    ['Commit, Push & Open PR', 'Reuse an existing pull request for this branch'],
  ])('sends %s through the existing commit proposal flow without modifying the draft', async (label, instruction) => {
    const { invoke } = setup();
    fireEvent.click(await screen.findByRole('button', { name: label }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:sendMessage', expect.stringContaining(instruction), { mode: 'agent', inputType: 'user' }, 'task', '/repo'));
    const sent = invoke.mock.calls.find(call => call[0] === 'ai:sendMessage')!;
    expect(sent[1]).toContain('developer_git_commit_proposal');
    expect(sent[1]).toContain('- src/task.ts (modified)');
    expect(sent[1]).toContain('if approval is cancelled or the commit fails, stop');
    expect(invoke.mock.calls.some(call => call[0] === 'git:commit')).toBe(false);
  });

  it.each([{ completion: null }, { available: false }, { getContext: () => ({ ...context, files: [] }) }, { getContext: () => ({ success: false, files: [] }) }])('does not offer commits without eligible completed work: %j', async options => {
    const { invoke } = setup(options);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull();
    expect(invoke.mock.calls.some(call => call[0].startsWith('ai:'))).toBe(false);
  });

  it('dismisses this completion and offers the next successful turn', async () => {
    const { state, invoke } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
    expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull();
    act(() => state.set(sessionSuccessfulCompletionAtom('task'), 2));
    await screen.findByRole('button', { name: 'Commit' });
    expect(invoke.mock.calls.some(call => call[0].startsWith('ai:'))).toBe(false);
  });

  it('uses the worktree for context and queues terminal-backed CLI requests', async () => {
    const { invoke } = setup({ provider: 'claude-code-cli', worktreeId: 'wt', worktreePath: '/repo/worktrees/task' });
    fireEvent.click(await screen.findByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('ai:createQueuedPrompt', 'task', expect.stringContaining('Commit only.'), [], { mode: 'agent', inputType: 'user' }));
    expect(invoke).toHaveBeenCalledWith('git:get-commit-context', '/repo/worktrees/task', 'task', undefined, true);
    expect(invoke.mock.calls.some(call => call[0] === 'ai:sendMessage')).toBe(false);
  });

  it('prevents duplicate requests and allows retry after a send failure', async () => {
    let reject!: (error: Error) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; })).mockResolvedValue(undefined);
    const { invoke } = setup({ send });
    const commit = await screen.findByRole('button', { name: 'Commit' });
    fireEvent.click(commit);
    fireEvent.click(commit);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await act(async () => reject(new Error('Agent unavailable')));
    expect((await screen.findByRole('alert')).textContent).toBe('Agent unavailable');
    fireEvent.click(commit);
    await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(invoke.mock.calls.filter(call => call[0] === 'ai:sendMessage')).toHaveLength(2);
  });

  it('refreshes Git state and skips a request if a manual commit removed the changes', async () => {
    let calls = 0;
    const { invoke } = setup({ getContext: () => ++calls === 1 ? context : { ...context, files: [] } });
    fireEvent.click(await screen.findByRole('button', { name: 'Commit' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull());
    expect(invoke.mock.calls.some(call => call[0].startsWith('ai:'))).toBe(false);
  });

  it('hides the actions when live Git status becomes clean', async () => {
    let current = context;
    const { state } = setup({ getContext: () => current });
    await screen.findByRole('button', { name: 'Commit' });
    current = { ...context, files: [] };
    act(() => state.set(sessionGitStatusAtom('task'), {}));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull());
  });

  it('does not send after a new turn begins while refreshing the commit context', async () => {
    let resolve!: (value: unknown) => void;
    let calls = 0;
    const { state, invoke } = setup({ getContext: () => ++calls === 1 ? context : new Promise(done => { resolve = done; }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Commit' }));
    act(() => state.set(sessionSuccessfulCompletionAtom('task'), null));
    await act(async () => resolve(context));
    expect(invoke.mock.calls.some(call => call[0].startsWith('ai:'))).toBe(false);
  });

  it('retains Later across transcript unmounts', async () => {
    const { state, props, view } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
    view.unmount();
    render(<Provider store={state}><SessionCompletionActions {...props} /></Provider>);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: 'Commit' })).toBeNull();
  });
});
