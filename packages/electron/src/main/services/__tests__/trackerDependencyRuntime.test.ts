// @vitest-environment node
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { trackerRecordToItem } from '@nimbalyst/runtime/core/TrackerRecord';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import type { AIService } from '../ai/AIService';
import { loadDependencySnapshot, startTrackerDependencyResumes } from '../trackerDependencyRuntime';

const h = vi.hoisted(() => ({
  services: new Map(), state: { trackerDependencyWaits: {} }, items: [] as unknown[],
  listSessions: vi.fn(), queued: new Map<string, { status: string }>(),
  getPrompt: vi.fn(), createPrompt: vi.fn(), listPending: vi.fn(), fail: vi.fn(),
  scope: vi.fn(), schemas: vi.fn(), logError: vi.fn(),
}));
vi.mock('../../window/WindowManager', () => ({ documentServices: h.services }));
vi.mock('../../utils/store', () => ({ getWorkspaceState: () => h.state, updateWorkspaceState: (_path: string, update: (state: typeof h.state) => void) => update(h.state) }));
vi.mock('../../utils/logger', () => ({ logger: { main: { info: vi.fn(), error: h.logError } } }));
vi.mock('../../utils/workspaceDetection', () => ({ resolveProjectPath: () => '/w' }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { list: h.listSessions } }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: () => ({ getSessionState: () => null }) }));
vi.mock('../RepositoryManager', () => ({ getQueuedPromptsStore: () => ({ get: h.getPrompt, create: h.createPrompt, listPending: h.listPending, fail: h.fail }) }));
vi.mock('../TrackerSchemaService', () => ({ ensureWorkspaceTrackerSchemasLoaded: h.schemas }));
vi.mock('../tracker/trackerSchemaScope', () => ({ runWithTrackerSchemaWorkspace: h.scope }));

beforeAll(() => loadBuiltinTrackers());
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers();
  h.state.trackerDependencyWaits = {}; h.queued.clear(); h.services.clear();
  h.services.set('/w', { listTrackerItems: async () => h.items });
  h.listSessions.mockResolvedValue([{ id: 'agent', provider: 'openai-codex', hasStarted: true, linkedTrackerItemIds: ['dependent'] }]);
  h.scope.mockImplementation((_path: string, fn: () => unknown) => fn());
  h.getPrompt.mockImplementation(async (id: string) => h.queued.get(id) ?? null);
  h.createPrompt.mockImplementation(async (input: { id: string }) => { h.queued.set(input.id, { status: 'pending' }); });
  h.listPending.mockResolvedValue([]);
  setBlocker('in-progress');
});
afterEach(() => vi.useRealTimers());

function setBlocker(status: string) {
  const record = (id: string, fields: Record<string, unknown>) => ({ id, primaryType: 'task', typeTags: ['task'], source: 'native', archived: false, syncStatus: 'local', system: { workspace: '/w', createdAt: '2026-11-05', updatedAt: '2026-11-05' }, fields: { title: id, ...fields } }) as TrackerRecord;
  h.items = [record('blocker', { status }), record('dependent', { status: 'in-progress', dependsOn: [{ itemId: 'blocker' }] })].map(trackerRecordToItem);
}

describe('main dependency runtime wiring', () => {
  it('resolves recovered worktree queues against the parent workspace and its schemas', async () => {
    const snapshot = await loadDependencySnapshot('/w/worktrees/agent');
    expect(h.listSessions).toHaveBeenCalledWith('/w');
    expect(h.scope).toHaveBeenCalledWith('/w', expect.any(Function));
    expect(snapshot.readiness.get('dependent')?.blockedBy.map(blocker => blocker.itemId)).toEqual(['blocker']);
  });

  it('persists a wait, creates one real queue entry, drives it, and guards reopened blockers', async () => {
    const setDependencyResumeGuard = vi.fn();
    const driveQueuedPrompts = vi.fn().mockResolvedValue({ kind: 'deferred', reason: 'no-window' });
    const stop = startTrackerDependencyResumes({ setDependencyResumeGuard, driveQueuedPrompts } as unknown as AIService);
    try {
      await vi.advanceTimersByTimeAsync(1);
      expect(Object.keys(h.state.trackerDependencyWaits)).toEqual(['agent']);
      expect(h.createPrompt).not.toHaveBeenCalled();
      setBlocker('done');
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.createPrompt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: 'agent', id: expect.stringMatching(/^tracker-dependency:/), documentContext: expect.objectContaining({ promptOrigin: 'tracker_dependency_resume' }) }));
      expect(driveQueuedPrompts).toHaveBeenCalledWith('agent', '/w', 'wakeup');
      const guard = setDependencyResumeGuard.mock.calls[0][0];
      expect(await guard('agent', '/w/worktrees/agent')).toBe(true);
      setBlocker('in-progress');
      expect(await guard('agent', '/w/worktrees/agent')).toBe(false);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(h.createPrompt).toHaveBeenCalledOnce();
      expect(h.logError).not.toHaveBeenCalled();
    } finally { stop(); }
  });
});
