// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';

import {
  assertTrackerItemInWorkspace,
  buildTrackerLaunchContext,
  createTrackerWorktreeSession,
  deriveTrackerWorktreeName,
  isTrackerLaunchForWorkspace,
  prepareTrackerLaunchContext,
  createTrackerSession,
} from '../trackerSessionLaunch';

function makeTrackerRecord(overrides: Partial<TrackerRecord> = {}): TrackerRecord {
  return {
    id: 'feature_1624',
    primaryType: 'feature',
    typeTags: ['feature'],
    issueKey: 'NIM-1624',
    source: 'native',
    archived: false,
    syncStatus: 'local',
    fields: {
      title: 'Launch a Worktree from a Tracker',
      status: 'in-progress',
      priority: 'high',
      description: 'Create an isolated session with the tracker context pre-filled.',
    },
    system: {
      workspace: '/repo',
      createdAt: '2026-07-16T12:00:00.000Z',
      updatedAt: '2026-07-16T12:00:00.000Z',
    },
    ...overrides,
  };
}

describe('buildTrackerLaunchContext', () => {
  it('builds the native tracker link, shared draft, and worktree name', () => {
    const context = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());

    expect(context).toEqual({
      workspacePath: '/repo',
      trackerLinkId: 'feature_1624',
      draftInput: [
        'implement tracker item NIM-1624: Launch a Worktree from a Tracker',
        'type: feature, status: in-progress, priority: high',
        '',
        'Create an isolated session with the tracker context pre-filled.',
        '',
        'Update this tracker item\'s status when done using tracker_update with id "NIM-1624".',
      ].join('\n'),
      worktreeName: 'launch-a-worktree-from-a-tracker-feature_1624',
    });
  });

  it('uses the file tracker link and includes the document source', () => {
    const trackerItem = makeTrackerRecord({
      id: 'plan-branching',
      issueKey: undefined,
      primaryType: 'plan',
      typeTags: ['plan'],
      source: 'frontmatter',
      fields: {
        title: 'Branching Plan',
        status: 'to-do',
      },
      system: {
        workspace: '/repo',
        documentPath: 'nimbalyst-local/plans/branching.md',
        createdAt: '2026-07-16T12:00:00.000Z',
        updatedAt: '2026-07-16T12:00:00.000Z',
      },
    });

    const context = buildTrackerLaunchContext('plan-branching', trackerItem);

    expect(context.trackerLinkId).toBe('file:nimbalyst-local/plans/branching.md');
    expect(context.draftInput).toContain('implement tracker item plan-branching: Branching Plan');
    expect(context.draftInput).toContain('Source: @nimbalyst-local/plans/branching.md');
    expect(context.worktreeName).toBe('branching-plan-plan-branching');
  });
});

describe('assertTrackerItemInWorkspace', () => {
  it('accepts an item that belongs to the board project', () => {
    expect(() => assertTrackerItemInWorkspace(makeTrackerRecord(), '/repo')).not.toThrow();
  });

  // A board showing another project's items (#1822) must not start an agent
  // in the board's folder with a prompt about the other project.
  it('refuses an item from another project', () => {
    expect(() => assertTrackerItemInWorkspace(makeTrackerRecord(), '/other-repo'))
      .toThrow('/repo');
  });

  it('refuses an item that is not loaded', () => {
    expect(() => assertTrackerItemInWorkspace(undefined, '/repo')).toThrow();
  });
});

describe('isTrackerLaunchForWorkspace', () => {
  it('keeps a pending launch only while its own project is on screen', () => {
    const pending = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());

    expect(isTrackerLaunchForWorkspace(pending, '/repo')).toBe(true);
    expect(isTrackerLaunchForWorkspace(pending, '/other-repo')).toBe(false);
    expect(isTrackerLaunchForWorkspace({ ...pending, workspacePath: undefined }, undefined)).toBe(false);
  });
});

describe('createTrackerWorktreeSession', () => {
  it('rechecks the workspace after asynchronous Jira preparation', async () => {
    const pending = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());
    const createSession = vi.fn();
    let workspace = '/repo';
    await expect(createTrackerWorktreeSession(pending, '/repo', { baseBranch: 'main' }, createSession, async () => {
      workspace = '/different';
      return { ...pending, draftInput: 'full context' };
    }, () => workspace)).rejects.toThrow('project changed');
    expect(createSession).not.toHaveBeenCalled();
  });
  it('refuses a pending launch after the active project changes without creating a session', async () => {
    const pending = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());
    const createSession = vi.fn(async () => 'session');

    await expect(createTrackerWorktreeSession(pending, '/other-repo', { baseBranch: 'main' }, createSession))
      .rejects.toThrow(/project changed/i);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('passes the original draft and branch to creation in the originating project', async () => {
    const pending = buildTrackerLaunchContext('feature_1624', makeTrackerRecord());
    const createSession = vi.fn(async () => 'session');

    await expect(createTrackerWorktreeSession(pending, '/repo', { baseBranch: 'main' }, createSession))
      .resolves.toBe('session');
    expect(createSession).toHaveBeenCalledWith({ baseBranch: 'main', initialDraft: pending.draftInput });
  });
});

describe('Jira context in both launch modes', () => {
  const jira = () => makeTrackerRecord({ system: { ...makeTrackerRecord().system, origin: { kind: 'external', external: { providerId: 'jira', externalId: 'APP-1', urn: 'jira://team.atlassian.net/APP-1', url: 'https://team.atlassian.net/browse/APP-1', titleSnapshot: 'APP-1', importedAt: 'then', lastSyncedAt: 'then' } } } });
  it('uses canonical main-process evidence instead of the preview for Launch Session', async () => {
    const invoke = vi.fn(async () => ({ draftInput: 'Full description, criteria, comments and clarification instructions' }));
    const context = await prepareTrackerLaunchContext('feature_1624', jira(), invoke);
    expect(invoke).toHaveBeenCalledWith('jira:prepare-launch', { workspacePath: '/repo', itemId: 'feature_1624' });
    expect(context.draftInput).toBe('Full description, criteria, comments and clarification instructions');
    expect(context.trackerLinkId).toBe('feature_1624');
    expect(context.workspacePath).toBe('/repo');
  });
  it('submits the same prepared context with the selected base branch in Launch Worktree', async () => {
    const item = jira();
    const base = buildTrackerLaunchContext(item.id, item);
    const create = vi.fn(async () => 'new-session');
    await createTrackerWorktreeSession(base, '/repo', { baseBranch: 'release', name: 'ticket' }, create,
      () => prepareTrackerLaunchContext(item.id, item, async () => ({ draftInput: 'Full context' })), () => '/repo');
    expect(create).toHaveBeenCalledWith({ baseBranch: 'release', name: 'ticket', initialDraft: 'Full context' });
  });
  it('does not create a worktree when Jira context preparation fails', async () => {
    const item = jira();
    const create = vi.fn();
    await expect(createTrackerWorktreeSession(buildTrackerLaunchContext(item.id, item), '/repo', { baseBranch: 'main' }, create,
      () => prepareTrackerLaunchContext(item.id, item, async () => { throw new Error('not available'); }), () => '/repo')).rejects.toThrow('not available');
    expect(create).not.toHaveBeenCalled();
  });
  it('preserves the existing non-Jira launch draft without calling Jira', async () => {
    const invoke = vi.fn();
    const context = await prepareTrackerLaunchContext('feature_1624', makeTrackerRecord(), invoke);
    expect(context).toEqual(buildTrackerLaunchContext('feature_1624', makeTrackerRecord()));
    expect(invoke).not.toHaveBeenCalled();
  });
  it.each(['claude-code:sonnet', 'openai-codex:gpt-6-astra'])('retains %s, the workspace and durable tracker link without submitting execution', async model => {
    const item = jira();
    const context = await prepareTrackerLaunchContext(item.id, item, async () => ({ draftInput: 'Full Jira evidence' }));
    const invoke = vi.fn(async () => ({ success: true, id: 'new-session' }));
    expect(await createTrackerSession(context, model, () => '/repo', invoke)).toBe('new-session');
    expect(invoke.mock.calls).toEqual([
      ['sessions:create', { session: { id: expect.any(String), provider: model.split(':')[0], model, title: 'New Session' }, workspaceId: '/repo' }],
      ['tracker:link-session', { trackerId: item.id, sessionId: 'new-session' }],
      ['ai:saveDraftInput', 'new-session', 'Full Jira evidence', '/repo'],
    ]);
  });
  it('cannot create a normal session after a project switch during context preparation', async () => {
    const context = await prepareTrackerLaunchContext('feature_1624', jira(), async () => ({ draftInput: 'Full context' }));
    const invoke = vi.fn();
    await expect(createTrackerSession(context, 'openai-codex:gpt-6-astra', () => '/other', invoke)).rejects.toThrow('project changed');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('deriveTrackerWorktreeName', () => {
  it('defaults to the lowercase ticket title followed by its stable tracker id', () => {
    expect(deriveTrackerWorktreeName('tsk_mvv2bro7k9rwsi', 'Jira to Dev Account'))
      .toBe('jira-to-dev-account-tsk_mvv2bro7k9rwsi');
  });

  it('uses the id alone when the title has no usable characters or matches the id', () => {
    expect(deriveTrackerWorktreeName('NIM-1624', '?!')).toBe('nim-1624');
    expect(deriveTrackerWorktreeName('NIM-1624', 'NIM-1624')).toBe('nim-1624');
  });

  it('produces a bounded branch-safe slug', () => {
    const name = deriveTrackerWorktreeName(
      'NIM-1624',
      'Launch worktree: preserve SAME tracker context?! with a deliberately long title',
    );

    expect(name).toMatch(/^[a-z0-9-]+-nim-1624$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).not.toMatch(/-$/);
  });

  it('reserves room for the complete tracker id when shortening a long title', () => {
    const id = 'tsk_mvv2bro7k9rwsi';
    const name = deriveTrackerWorktreeName(id, 'Long ticket title '.repeat(20));
    expect(name).toHaveLength(64);
    expect(name).toMatch(/^[a-z0-9-]+-tsk_mvv2bro7k9rwsi$/);
  });
});
