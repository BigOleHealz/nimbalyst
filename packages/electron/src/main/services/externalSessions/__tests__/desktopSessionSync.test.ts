// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

let projectPath: string;
let workspacePath: string;
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

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); h.enabled = false; h.release = undefined;
  projectPath = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'desktop-sync-')));
  workspacePath = path.join(projectPath, 'worktree');
  await fs.mkdir(workspacePath);
});
afterEach(async () => {
  await (await import('../desktopSessionSync')).stopDesktopSessionSync();
  await fs.rm(projectPath, { recursive: true, force: true });
  vi.useRealTimers();
});

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
  h.get.mockResolvedValue({ id: 's', title: 'Task', provider: 'openai', workspacePath: projectPath, worktreePath: workspacePath, worktreeProjectPath: projectPath, createdAt: 1 });
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
  expect(h.export.mock.calls[0][1]).toMatchObject({ workspacePath, projectPath, messages: [
    { role: 'user', text: 'Hello' }, { role: 'assistant', text: 'Answer' },
  ] });
  await module.stopDesktopSessionSync();
  await expect(module.getDesktopSessionSyncService().sync()).rejects.toThrow(/stopped/);
});

it('skips a session whose worktree no longer exists', async () => {
  const module = await import('../desktopSessionSync');
  await fs.rm(workspacePath, { recursive: true });
  h.list.mockResolvedValueOnce([{ id: 's', updatedAt: 1 }] as never[]);
  h.get.mockResolvedValue({ id: 's', provider: 'openai', workspacePath: projectPath, worktreePath: workspacePath });

  const result = await module.getDesktopSessionSyncService().sync();

  expect(h.events).not.toHaveBeenCalled();
  expect(h.export).not.toHaveBeenCalled();
  expect(h.publish).not.toHaveBeenCalled();
  expect(result).toMatchObject({ codex: { synced: 0, failed: 0 }, claude: { synced: 0, failed: 0 }, errors: [] });
});
