// @vitest-environment node
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import { computeReadiness } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerReadiness';
import { getRecordStatus } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { TrackerDependencyResumeService, isDependencyResumeAllowed, type DependencyWaits } from '../TrackerDependencyResumeService';

beforeAll(() => loadBuiltinTrackers());
const record = (id: string, fields = {}) => ({ id, primaryType: 'task', typeTags: ['task'], archived: false, source: 'native', syncStatus: 'local', system: { workspace: '/w', createdAt: '2026-11-05', updatedAt: '2026-11-05' }, fields: { title: id, status: 'to-do', ...fields } }) as TrackerRecord;
function harness() {
  let items = [record('blocker'), record('dependent', { status: 'in-progress', dependsOn: [{ itemId: 'blocker' }] })];
  let sessions = [{ id: 'agent', provider: 'openai-codex', hasStarted: true, linkedTrackerItemIds: ['dependent'], workspaceId: '/w' }] as SessionMeta[];
  let waits: DependencyWaits = {};
  const prompts = new Map<string, string>();
  const queue = vi.fn(async (_session: string, id: string) => { if (!prompts.has(id)) prompts.set(id, 'pending'); });
  const drive = vi.fn(async () => undefined);
  const live = { busy: false, awaitingInput: false };
  const snapshot = () => ({ items, sessions, readiness: computeReadiness(items, getRecordStatus) });
  const deps = {
    workspaces: () => ['/w'], loadWorkspace: async () => snapshot(),
    readWaits: () => waits, writeWaits: (_path: string, next: DependencyWaits) => { waits = next; },
    liveState: () => live, hasPendingPrompts: async () => false,
    promptStatus: async (id: string) => prompts.get(id) ?? null,
    cancelPrompt: vi.fn(async (id: string) => { prompts.set(id, 'failed'); }),
    queue, drive, createId: () => `tracker-dependency:${prompts.size + 1}`, onError: vi.fn(),
  };
  return { deps, snapshot, queue, drive, live, prompts, get waits() { return waits; },
    setItems: (next: TrackerRecord[]) => { items = next; }, setSessions: (next: SessionMeta[]) => { sessions = next; },
    clearBlocker: () => { items = [record('blocker', { status: 'done' }), items[1]]; },
    service: new TrackerDependencyResumeService(deps) };
}

describe('dependency agent resumption', () => {
  it('persists a wait, then queues and drives exactly one continuation after the last blocker clears', async () => {
    const h = harness();
    await h.service.check();
    expect(h.waits.agent.itemIds).toEqual(['dependent']);
    expect(h.queue).not.toHaveBeenCalled();
    h.clearBlocker();
    // Recreating the service uses the same durable ledger after an app restart.
    const restarted = new TrackerDependencyResumeService(h.deps);
    await restarted.check();
    await restarted.check();
    expect(h.queue).toHaveBeenCalledTimes(1);
    expect(h.drive).toHaveBeenCalledWith('agent', '/w');
    h.prompts.set(h.waits.agent.promptId, 'completed');
    await restarted.check();
    expect(h.waits).toEqual({});
    await restarted.check();
    expect(h.queue).toHaveBeenCalledTimes(1);
  });

  it('waits for every linked ticket and every blocker, including blockers outside the board', async () => {
    const h = harness();
    h.setItems([record('one'), record('two'), record('dependent', { dependsOn: [{ itemId: 'one' }, { itemId: 'two' }] })]);
    await h.service.check();
    h.setItems([record('one', { status: 'done' }), record('two'), record('dependent', { dependsOn: [{ itemId: 'one' }, { itemId: 'two' }] })]);
    await h.service.check();
    expect(h.queue).not.toHaveBeenCalled();
    expect(isDependencyResumeAllowed(h.snapshot(), 'agent')).toBe(false);
  });

  it('never bypasses unanswered prompts, duplicates a running turn, or starts an unstarted agent', async () => {
    const h = harness();
    await h.service.check();
    h.clearBlocker();
    h.live.awaitingInput = true;
    await h.service.check();
    expect(h.queue).not.toHaveBeenCalled();
    h.live.awaitingInput = false;
    h.live.busy = true;
    await h.service.check();
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.waits).toEqual({});
    h.setSessions([{ ...h.snapshot().sessions[0], hasStarted: false, messageCount: 0 }]);
    expect(isDependencyResumeAllowed(h.snapshot(), 'agent')).toBe(false);
  });

  it('holds a queued resume when a blocker reopens and does not queue another copy', async () => {
    const h = harness();
    await h.service.check();
    h.clearBlocker();
    await h.service.check();
    h.drive.mockClear();
    h.setItems([record('blocker'), record('dependent', { dependsOn: [{ itemId: 'blocker' }] })]);
    await h.service.check();
    expect(isDependencyResumeAllowed(h.snapshot(), 'agent')).toBe(false);
    expect(h.drive).not.toHaveBeenCalled();
    h.clearBlocker();
    await h.service.check();
    expect(h.queue).toHaveBeenCalledTimes(1);
    expect(h.drive).toHaveBeenCalledOnce();
  });

  it.each([{ isArchived: true }, { phase: 'complete' }, { remoteHostDeviceId: 'other-device' }])('does not resume an unavailable or finished agent: %o', async changes => {
    const h = harness();
    await h.service.check();
    h.clearBlocker();
    h.setSessions([{ ...h.snapshot().sessions[0], ...changes }]);
    await h.service.check();
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('does not resume against an incomplete corpus, a missing dependency, or a cycle', async () => {
    const h = harness();
    await h.service.check();
    for (const items of [[], [record('dependent', { dependsOn: [{ itemId: 'missing' }] })], [record('dependent', { dependsOn: [{ itemId: 'dependent' }] })]]) {
      h.setItems(items);
      await h.service.check();
      expect(isDependencyResumeAllowed(h.snapshot(), 'agent')).toBe(false);
    }
    expect(h.queue).not.toHaveBeenCalled();
  });

  it('retries delivery without duplicating an already persisted prompt', async () => {
    const h = harness();
    await h.service.check();
    h.clearBlocker();
    h.drive.mockRejectedValueOnce(new Error('temporarily unavailable'));
    await h.service.check();
    await h.service.check();
    expect(h.deps.onError).toHaveBeenCalledOnce();
    expect(h.queue).toHaveBeenCalledOnce();
    expect(h.drive).toHaveBeenCalledTimes(2);
  });

  it('retires a pending automatic resume if its ticket closes before delivery', async () => {
    const h = harness();
    await h.service.check();
    h.clearBlocker();
    await h.service.check();
    const promptId = h.waits.agent.promptId;
    h.setItems([record('blocker', { status: 'done' }), record('dependent', { status: 'done' })]);
    await h.service.check();
    expect(h.deps.cancelPrompt).toHaveBeenCalledWith(promptId);
    expect(h.waits).toEqual({});
  });

  it('uses already queued instructions instead of adding a second continuation', async () => {
    const h = harness();
    await h.service.check();
    h.clearBlocker();
    h.deps.hasPendingPrompts = async () => true;
    await h.service.check();
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.drive).toHaveBeenCalledWith('agent', '/w');
    expect(h.waits).toEqual({});
  });

  it('does not transfer a wait when the agent is relinked to another ticket', async () => {
    const h = harness();
    await h.service.check();
    h.setItems([...h.snapshot().items, record('unrelated')]);
    h.setSessions([{ ...h.snapshot().sessions[0], linkedTrackerItemIds: ['unrelated'] }]);
    await h.service.check();
    expect(h.queue).not.toHaveBeenCalled();
    expect(h.waits).toEqual({});
  });

  it('does not resume while a different ticket linked to the same agent remains blocked', async () => {
    const h = harness();
    h.setItems([...h.snapshot().items, record('second-blocker'), record('second', { dependsOn: [{ itemId: 'second-blocker' }] })]);
    h.setSessions([{ ...h.snapshot().sessions[0], linkedTrackerItemIds: ['dependent', 'second'] }]);
    await h.service.check();
    h.setItems(h.snapshot().items.map(item => item.id === 'blocker' ? record('blocker', { status: 'done' }) : item));
    await h.service.check();
    expect(h.queue).not.toHaveBeenCalled();
    expect(isDependencyResumeAllowed(h.snapshot(), 'agent')).toBe(false);
  });
});
