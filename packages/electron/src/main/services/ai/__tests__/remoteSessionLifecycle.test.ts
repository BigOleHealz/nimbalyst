// @vitest-environment node
import {describe, expect, it, vi} from 'vitest';
import {tryRemoteSessionLifecycle} from '../remoteSessionLifecycle';

function fixture(workspace: string | undefined = '/repo') {
  return {workspaceForSession: vi.fn(async (): Promise<string | undefined> => workspace), delete: vi.fn(async () => {}), setArchived: vi.fn(async () => {})};
}

describe('remote lifecycle routing', () => {
  it('routes delete and archive to the selected remote workspace', async () => {
    const remote = fixture();
    expect(await tryRemoteSessionLifecycle(remote, 'session', '/repo', {type: 'delete'})).toBe(true);
    expect(remote.delete).toHaveBeenCalledWith('session', '/repo');
    expect(await tryRemoteSessionLifecycle(remote, 'session', '/repo', {type: 'archive', isArchived: false})).toBe(true);
    expect(remote.setArchived).toHaveBeenCalledWith('session', '/repo', false);
  });

  it('leaves local sessions to the existing handler', async () => {
    const remote = fixture(undefined);
    remote.workspaceForSession.mockResolvedValue(undefined);
    expect(await tryRemoteSessionLifecycle(remote, 'local', '/repo', {type: 'delete'})).toBe(false);
    expect(remote.delete).not.toHaveBeenCalled();
  });

  it.each([undefined, '/other'])('refuses a remote write without its selected workspace: %s', async workspace => {
    const remote = fixture();
    await expect(tryRemoteSessionLifecycle(remote, 'session', workspace, {type: 'delete'})).rejects.toThrow(/workspace/);
    expect(remote.delete).not.toHaveBeenCalled();
  });

  it('propagates a failed remote write rather than falling back to local success', async () => {
    const remote = fixture();
    remote.delete.mockRejectedValue(new Error('Sync disconnected'));
    await expect(tryRemoteSessionLifecycle(remote, 'session', '/repo', {type: 'delete'})).rejects.toThrow('Sync disconnected');
  });
});
