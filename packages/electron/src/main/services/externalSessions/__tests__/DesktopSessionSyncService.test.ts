// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { DesktopSessionSyncService } from '../DesktopSessionSyncService';
import type { DesktopExportSession } from '../DesktopSessionExporter';

function harness() {
  const candidate = { id: 's1', updatedAt: 1 };
  const session = { id: 's1', title: 'Task', workspacePath: '/project', createdAt: 1, messages: [{ role: 'user' as const, text: 'Hello', timestamp: new Date(1).toISOString() }] };
  const deps = {
    list: vi.fn(async () => [candidate]),
    load: vi.fn(async () => session),
    isActive: vi.fn(() => false),
    export: vi.fn(async (_provider: string, _session: DesktopExportSession) => ({ status: 'synced' as const, sessionId: 'exported' })),
    publishCodex: vi.fn(async () => {}),
  };
  return { deps, service: new DesktopSessionSyncService(deps) };
}
it('syncs every provider to both native destinations and reuses successful revisions', async () => {
  const { service, deps } = harness();
  expect(await service.sync()).toMatchObject({ codex: { synced: 1 }, claude: { synced: 1 } });
  expect(deps.export.mock.calls.map(call => call[0])).toEqual(['openai-codex', 'claude-code']);
  expect(deps.publishCodex).toHaveBeenCalledWith([{ workspacePath: '/project', sessionId: 'exported', title: 'Task' }]);
  await service.sync();
  expect(deps.load).toHaveBeenCalledTimes(1);
});
it('does not export active sessions and retries unavailable installations on the next sync', async () => {
  const { service, deps } = harness();
  deps.isActive.mockReturnValue(true);
  await service.sync();
  expect(deps.load).not.toHaveBeenCalled();
  deps.isActive.mockReturnValue(false);
  deps.export.mockResolvedValueOnce({ status: 'unavailable' } as any);
  await service.sync();
  await service.sync();
  expect(deps.export).toHaveBeenCalledTimes(3);
});
it('reports partial failures and preserves conflicts without publishing them', async () => {
  const { service, deps } = harness();
  deps.export.mockResolvedValueOnce({ status: 'conflict' } as any).mockRejectedValueOnce(new Error('disk full'));
  expect(await service.sync()).toMatchObject({ codex: { conflicts: 1 }, claude: { failed: 1 }, errors: [expect.stringContaining('disk full')] });
  expect(deps.publishCodex).not.toHaveBeenCalled();
});
it('serializes concurrent sync and stops outstanding work before shutdown', async () => {
  const { service, deps } = harness();
  let release!: () => void;
  deps.list.mockImplementationOnce(() => new Promise(resolve => { release = () => resolve([{ id: 's1', updatedAt: 1 }]); }));
  const first = service.sync();
  expect(service.sync()).toBe(first);
  const stopping = service.stop();
  release();
  await stopping;
  expect(deps.export).not.toHaveBeenCalled();
  await expect(service.sync()).rejects.toThrow(/stopped/);
});
