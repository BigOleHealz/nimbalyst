// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WorktreeBaseBranchPicker } from '../WorktreeBaseBranchPicker';
import { buildTrackerLaunchContext } from '../../TrackerMode/trackerSessionLaunch';

const BRANCHES = [
  'main',
  'feature/login',
  'feature/logout',
  'hotfix/crash',
  'remotes/origin/feature/login',
  'remotes/origin/release',
];

function renderPicker() {
  return render(
    <WorktreeBaseBranchPicker
      isOpen
      repoPath="/workspace"
      onCreate={vi.fn().mockResolvedValue(undefined)}
      onCancel={vi.fn()}
    />,
  );
}

function typeQuery(value: string) {
  fireEvent.change(screen.getByTestId('worktree-base-branch-search'), { target: { value } });
}

describe('WorktreeBaseBranchPicker branch search', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        invoke: vi.fn(async (channel: string) => {
          if (channel === 'git:branches') return { branches: BRANCHES, current: 'main' };
          return undefined;
        }),
      },
    });
  });

  afterEach(cleanup);

  it.each([undefined, 'my-custom-worktree'])('submits the ticket default or user override (%s)', async (override) => {
    const initialName = buildTrackerLaunchContext('tsk_mvv2bro7k9rwsi', {
      id: 'tsk_mvv2bro7k9rwsi',
      primaryType: 'task',
      typeTags: ['task'],
      source: 'native',
      archived: false,
      syncStatus: 'local',
      fields: { title: 'Jira to Dev Account' },
      system: { workspace: '/workspace', createdAt: '', updatedAt: '' },
    }).worktreeName;
    const onCreate = vi.fn().mockResolvedValue(undefined);
    render(<WorktreeBaseBranchPicker isOpen repoPath="/workspace" initialName={initialName} onCreate={onCreate} onCancel={vi.fn()} />);
    await screen.findByTestId('worktree-base-branch-item-main');

    expect((screen.getByTestId('worktree-name-input') as HTMLInputElement).value)
      .toBe('jira-to-dev-account-tsk_mvv2bro7k9rwsi');
    if (override) fireEvent.change(screen.getByTestId('worktree-name-input'), { target: { value: override } });
    fireEvent.click(screen.getByTestId('worktree-base-branch-create'));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({
      baseBranch: 'main', name: override ?? 'jira-to-dev-account-tsk_mvv2bro7k9rwsi',
    }));
  });

  it('filters local and remote branches in the same pass', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeQuery('feature');

    await waitFor(() => {
      expect(screen.queryByTestId('worktree-base-branch-item-main')).toBeNull();
    });
    screen.getByTestId('worktree-base-branch-item-feature/login');
    screen.getByTestId('worktree-base-branch-item-feature/logout');
    screen.getByTestId('worktree-base-branch-item-origin/feature/login');
    expect(screen.queryByTestId('worktree-base-branch-item-hotfix/crash')).toBeNull();
    expect(screen.queryByTestId('worktree-base-branch-item-origin/release')).toBeNull();
  });

  it('matches case-insensitively', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeQuery('FEATURE');

    await waitFor(() => {
      screen.getByTestId('worktree-base-branch-item-feature/login');
    });
    screen.getByTestId('worktree-base-branch-item-origin/feature/login');
  });

  it('shows an empty state naming the query when nothing matches', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeQuery('nothing-matches-this');

    const empty = await screen.findByTestId('worktree-base-branch-no-matches');
    expect(empty.textContent).toContain('nothing-matches-this');
  });

  it('restores the full list when the query is cleared', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeQuery('hotfix');
    await waitFor(() => {
      expect(screen.queryByTestId('worktree-base-branch-item-main')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('worktree-base-branch-search-clear'));

    await waitFor(() => {
      screen.getByTestId('worktree-base-branch-item-main');
    });
    screen.getByTestId('worktree-base-branch-item-origin/release');
  });

  it('keeps the selected base branch visible in the preview while it is filtered out', async () => {
    renderPicker();
    await screen.findByTestId('worktree-base-branch-item-main');

    typeQuery('hotfix');

    await waitFor(() => {
      expect(screen.queryByTestId('worktree-base-branch-item-main')).toBeNull();
    });
    expect(screen.getByTestId('worktree-branch-preview').textContent).toContain('from main');
  });
});
