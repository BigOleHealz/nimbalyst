// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  enabled: false,
  change: undefined as ((key: string) => void) | undefined,
  release: undefined as (() => void) | undefined,
  list: vi.fn(async () => []),
  get: vi.fn(), events: vi.fn(), export: vi.fn(), publish: vi.fn(), unsubscribe: vi.fn(),
}));
vi.mock('../../PGLiteSessionStore', () => ({ getAllSessionsForSync: h.list }));
vi.mock('../../SettingsService', () => ({ getSettingsService: () => ({ get: () => h.enabled, subscribe: (fn: (key: string) => void) => { h.change = fn; return h.unsubscribe; } }) }));
vi.mock('../../startupMaintenanceGate', () => ({ whenFirstUsable: () => new Promise<void>(resolve => { h.release = resolve; }) }));
vi.mock('../../../utils/store', () => ({ getRecentItems: () => [] }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: h.get } }));
vi.mock('@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository', () => ({ TranscriptMigrationRepository: { getService: () => ({ getCanonicalEvents: h.events }) } }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: () => ({ getSessionState: () => null }) }));
vi.mock('../DesktopSessionExporter', () => ({ DesktopSessionExporter: class { export = h.export; } }));
vi.mock('../publishCodexProjects', () => ({ publishCodexProjects: h.publish }));

beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); h.enabled = false; h.release = undefined; });
afterEach(() => { vi.useRealTimers(); });

it('does no automatic work by default and cancels an enable before first usable', async () => {
  const module = await import('../desktopSessionSync');
  module.initializeDesktopSessionSync();
  expect(h.release).toBeUndefined();
  expect(h.list).not.toHaveBeenCalled();
  h.enabled = true; h.change!('app.desktopSessionSyncEnabled');
  h.enabled = false; h.change!('app.desktopSessionSyncEnabled');
  h.release!();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(h.list).not.toHaveBeenCalled();
  await module.stopDesktopSessionSync();
  expect(h.unsubscribe).toHaveBeenCalledOnce();
});

it('runs after first usable, stops on shutdown, and extracts only visible top-level conversation', async () => {
  const module = await import('../desktopSessionSync');
  h.enabled = true;
  h.list.mockResolvedValueOnce([{ id: 's', updatedAt: 1 }] as never[]);
  h.get.mockResolvedValue({ id: 's', title: 'Task', provider: 'openai', workspacePath: '/private/tmp', worktreePath: '/private/tmp', worktreeProjectPath: '/private', createdAt: 1 });
  const event = { parentEventId: null, subagentId: null, createdAt: new Date(1), payload: {} };
  h.events.mockResolvedValue([
    { ...event, eventType: 'user_message', searchableText: 'Hello' },
    { ...event, eventType: 'assistant_message', searchableText: 'Answer', payload: { thinking: 'Private reasoning' } },
    { ...event, eventType: 'tool_call', searchableText: 'Tool input' },
    { ...event, eventType: 'user_message', searchableText: 'Hidden instruction', payload: { inputType: 'system_message' } },
    { ...event, eventType: 'assistant_message', searchableText: 'Child answer', subagentId: 'child' },
  ]);
  h.export.mockResolvedValue({ status: 'synced', sessionId: 'exported' });
  module.initializeDesktopSessionSync();
  expect(h.list).not.toHaveBeenCalled();
  h.release!();
  await vi.waitFor(() => expect(h.export).toHaveBeenCalledTimes(2));
  expect(h.export.mock.calls[0][1]).toMatchObject({ projectPath: '/private', messages: [
    { role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Answer' },
  ] });
  await module.stopDesktopSessionSync();
  await expect(module.getDesktopSessionSyncService().sync()).rejects.toThrow(/stopped/);
});
