// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteSessionMirror } from '../RemoteSessionMirror';
import type { SessionChange, SyncProvider } from '@nimbalyst/runtime/sync/types';
import { logger } from '../../../utils/logger';

function fixture() {
  const entry = { sessionId: 'remote', hostDeviceId: 'sandbox-1', projectId: '/repo', title: 'Remote test', provider: 'claude-code', messageCount: 0, createdAt: 100, updatedAt: 200, lastMessageAt: 200 };
  let changes: ((change: SessionChange) => void) | undefined;
  let status: (() => void) | undefined;
  let index: ((id: string) => void) | undefined;
  let deletion: ((id: string) => void) | undefined;
  const offChange = vi.fn(); const offStatus = vi.fn();
  let deleted = false;
  const provider = {
    fetchIndex: vi.fn(async () => ({ sessions: deleted ? [] : [entry], projects: [] })),
    getCachedIndexEntry: vi.fn(() => deleted ? undefined : entry),
    getLocalDeviceInfo: () => ({ deviceId: 'desktop' }),
    getConnectedDevices: vi.fn(() => [{ deviceId: 'sandbox-1', isOnline: true }]),
    getStatus: () => ({ connected: true, syncing: false }),
    onIndexDelete: (cb: typeof deletion) => { deletion = cb; return vi.fn(); },
    onIndexChange: (cb: typeof index) => { index = cb; return vi.fn(); },
    onRemoteChange: vi.fn((_id, cb) => { changes = cb; return offChange; }),
    onStatusChange: vi.fn((_id, cb) => { status = cb; return offStatus; }),
    connect: vi.fn(async () => {}), disconnect: vi.fn(),
    pushChange: vi.fn(async (_id: string, change: SessionChange) => {
      if (change.type === 'session_deleted') deleted = true;
      if (change.type === 'metadata_updated') Object.assign(entry, change.metadata);
      return {published: true};
    }), sendSessionControlMessage: vi.fn(async () => {}),
  };
  const deps = { localSessionIds: vi.fn(async () => new Set<string>()), hasLocalSession: vi.fn(async () => false), listChanged: vi.fn() };
  const mirror = new RemoteSessionMirror(deps);
  mirror.setProvider(provider as unknown as SyncProvider);
  return { mirror, entry, deps, provider, offChange, offStatus,
    change: (change: SessionChange) => changes?.(change), status: () => status?.(), index: () => index?.('remote'), deletion: () => deletion?.('remote') };
}

afterEach(() => vi.useRealTimers());
describe('remote desktop mirrors', () => {

  it('disconnects a watched session on deletion and keeps later unsubscribe harmless', async () => {
    const f = fixture();
    const stop = await f.mirror.watch('remote', '/repo', vi.fn());
    f.deletion();
    expect(f.provider.disconnect).toHaveBeenCalledWith('remote');
    expect(f.offChange).toHaveBeenCalled();
    expect(f.offStatus).toHaveBeenCalled();
    stop();
    expect(f.provider.disconnect).toHaveBeenCalledTimes(1);
  });


  it('does not queue a child while its parent archive is publishing', async () => {
    const f = fixture();
    const entries: any[] = [f.entry, {...f.entry, sessionId: 'child', parentSessionId: 'remote'}];
    f.provider.fetchIndex.mockResolvedValue({sessions: entries, projects: []});
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    f.provider.pushChange.mockImplementation(async (id, change) => {
      if (id === 'remote' && change.type === 'metadata_updated' && change.metadata.isArchived) await gate;
      if (change.type === 'metadata_updated') Object.assign(entries.find(entry => entry.sessionId === id), change.metadata);
      return {published: true};
    });
    const archive = f.mirror.setArchived('remote', '/repo', true);
    await vi.waitFor(() => expect(f.provider.pushChange).toHaveBeenCalledWith('remote', expect.anything()));
    const queued = f.mirror.queue('child', '/repo', 'Do not hide this work').then(() => 'queued', error => error.message);
    release();
    await archive;
    expect(await queued).toMatch(/restore|archived/i);
    expect(entries[1].queuedPrompts).toBeUndefined();
  });




  it.each(['archive', 'delete'] as const)('keeps the session when the server has not confirmed %s', async action => {
    const f = fixture();
    f.provider.pushChange.mockResolvedValue({published: true});
    await expect(action === 'archive' ? f.mirror.setArchived('remote', '/repo', true) : f.mirror.delete('remote', '/repo')).rejects.toThrow(/confirmed/);
    expect((await f.mirror.list('/repo', []))[0].id).toBe('remote');
  });


  it('refreshes other windows when a remote session disappears from the synced index', async () => {
    const f = fixture();
    await f.mirror.list('/repo', []);
    f.provider.getCachedIndexEntry.mockReturnValue(undefined as any);
    f.deletion();
    expect(await f.mirror.list('/repo', [])).toEqual([]);
    expect(f.deps.listChanged).toHaveBeenCalledWith('/repo', 'remote');
  });

  it('leaves normal local lifecycle operations usable while remote sync is offline', async () => {
    const f = fixture();
    f.deps.hasLocalSession.mockResolvedValue(true);
    f.provider.fetchIndex.mockRejectedValue(new Error('offline'));
    expect(await f.mirror.workspaceForSession('local')).toBeUndefined();
    expect(f.provider.fetchIndex).not.toHaveBeenCalled();
  });

  it('keeps a remote session when its transcript cannot connect for deletion', async () => {
    const f = fixture(); f.provider.connect.mockRejectedValue(new Error('transcript unavailable'));
    await expect(f.mirror.delete('remote', '/repo')).rejects.toThrow('transcript unavailable');
    expect(f.provider.pushChange).not.toHaveBeenCalled();
    expect((await f.mirror.list('/repo', []))[0].id).toBe('remote');
  });

  it('refuses deleting a workstream that still contains child sessions', async () => {
    const f = fixture();
    f.provider.fetchIndex.mockResolvedValue({sessions: [f.entry, {...f.entry, sessionId: 'child', parentSessionId: 'remote'}], projects: []} as any);
    await expect(f.mirror.delete('remote', '/repo')).rejects.toThrow(/child sessions/);
    expect(f.provider.pushChange).not.toHaveBeenCalled();
  });


  it('archives and restores remote descendants without requiring desktop execution rows', async () => {
    const f = fixture();
    const entries = [f.entry,
      {...f.entry, sessionId: 'child', parentSessionId: 'remote'},
      {...f.entry, sessionId: 'leaf', parentSessionId: 'child'},
      {...f.entry, sessionId: 'other-workspace', parentSessionId: 'remote', projectId: '/other'},
      {...f.entry, sessionId: 'other-host', parentSessionId: 'remote', hostDeviceId: 'sandbox-2'},
    ];
    f.provider.fetchIndex.mockResolvedValue({sessions: entries, projects: []} as any);
    f.provider.pushChange.mockImplementation(async (id, change) => {
      if (change.type === 'metadata_updated') Object.assign(entries.find(entry => entry.sessionId === id)!, change.metadata);
      return {published: true};
    });
    await f.mirror.setArchived('remote', '/repo', true);
    expect(f.provider.pushChange.mock.calls.map(([id]) => id)).toEqual(['remote', 'child', 'leaf']);
    expect(f.provider.pushChange).toHaveBeenCalledWith('leaf', {type: 'metadata_updated', metadata: {isArchived: true}});
    expect((await f.mirror.list('/repo', [])).filter(row => ['remote', 'child', 'leaf'].includes(row.id)).every(row => row.isArchived)).toBe(true);
    await f.mirror.setArchived('remote', '/repo', false);
    expect(f.provider.pushChange).toHaveBeenLastCalledWith('leaf', {type: 'metadata_updated', metadata: {isArchived: false}});
    expect(f.deps.listChanged).toHaveBeenCalledWith('/repo', 'remote');
  });

  it('keeps a remote conversation visible when lifecycle publication fails', async () => {
    const f = fixture();
    f.provider.pushChange.mockResolvedValue({published: false, reason: 'disconnected'} as any);
    await expect(f.mirror.setArchived('remote', '/repo', true)).rejects.toThrow(/disconnected/);
    expect((await f.mirror.list('/repo', []))[0].isArchived).toBe(false);
    await expect(f.mirror.delete('remote', '/repo')).rejects.toThrow(/disconnected/);
    expect((await f.mirror.list('/repo', []))[0].id).toBe('remote');
  });

  it('deletes the synced remote conversation and removes its cached sidebar entry', async () => {
    const f = fixture();
    await f.mirror.delete('remote', '/repo');
    expect(f.provider.connect).toHaveBeenCalledWith('remote');
    expect(f.provider.pushChange).toHaveBeenCalledWith('remote', {type: 'session_deleted'});
    expect(f.provider.disconnect).toHaveBeenCalledWith('remote');
    expect(await f.mirror.list('/repo', [])).toEqual([]);
    expect(f.deps.listChanged).toHaveBeenCalledWith('/repo', 'remote');
  });

  it.each([{isExecuting: true}, {queuedPrompts: [{id: 'queued', prompt: 'work', timestamp: 1}]}])('refuses to delete or archive remote work that is running or queued: %j', async state => {
    const f = fixture(); Object.assign(f.entry, state);
    await expect(f.mirror.delete('remote', '/repo')).rejects.toThrow(/running|queued/);
    await expect(f.mirror.setArchived('remote', '/repo', true)).rejects.toThrow(/running|queued/);
    expect(f.provider.pushChange).not.toHaveBeenCalled();
  });

  it('rejects lifecycle writes in a different workspace and never touches the local collision', async () => {
    const f = fixture();
    await expect(f.mirror.delete('remote', '/other')).rejects.toThrow(/not available/);
    f.deps.hasLocalSession.mockResolvedValue(true);
    await expect(f.mirror.setArchived('remote', '/repo', true)).rejects.toThrow(/not available/);
    expect(f.provider.pushChange).not.toHaveBeenCalled();
  });

  it('keeps an explicitly migrated local conversation under its original id and routes it remotely', async () => {
    const f = fixture();
    f.entry.title = 'Original task';
    Object.assign(f.deps, {migratedHost: async () => 'sandbox-1'});
    const local = {id: 'remote', title: 'Original task', workspaceId: '/repo', worktreeId: 'old-local-tree'} as any;
    const rows = await f.mirror.list('/repo', [local]);
    expect(rows).toEqual([expect.objectContaining({id: 'remote', title: 'Original task', remoteHostDeviceId: 'sandbox-1', worktreeId: null})]);
  });

  it('uses confirmed remote lifecycle metadata for a retained migration copy', async () => {
    const f = fixture();
    Object.assign(f.deps, {migratedHost: async () => 'sandbox-1'});
    Object.assign(f.entry, {title: 'Updated remotely', isArchived: true, isPinned: true});
    const rows = await f.mirror.list('/repo', [{id: 'remote', title: 'Old local title', isArchived: false, tags: ['keep'], workspaceId: '/repo'} as any]);
    expect(rows).toEqual([expect.objectContaining({id: 'remote', title: 'Updated remotely', isArchived: true, isPinned: true, tags: ['keep']})]);
  });

  it('never exposes migrated history through a different indexed workspace on the same host', async () => {
    const f = fixture();
    const seedMessages = vi.fn(async () => []);
    Object.assign(f.deps, {migratedHost: async () => 'sandbox-1', migratedWorkspace: async () => '/repo', seedMessages});
    f.entry.projectId = '/other';
    expect(await f.mirror.list('/other', [])).toEqual([]);
    await expect(f.mirror.watch('remote', '/other', vi.fn())).rejects.toThrow(/workspace|project/i);
    await expect(f.mirror.get('remote', '/other')).rejects.toThrow(/workspace|project/i);
    await expect(f.mirror.queue('remote', '/other', 'Do not cross projects')).rejects.toThrow(/workspace|project/i);
    expect(seedMessages).not.toHaveBeenCalled();
    expect(f.provider.pushChange).not.toHaveBeenCalled();
  });

  it('does not resurrect a removed remote session from its retained migration copy', async () => {
    const f = fixture();
    Object.assign(f.deps, {migratedHost: async () => 'sandbox-1'});
    f.provider.fetchIndex.mockResolvedValue({sessions: [], projects: [], deletedSessionIds: ['remote']} as any);
    expect(await f.mirror.list('/repo', [{id: 'remote', workspaceId: '/repo'} as any])).toEqual([]);
  });

  it('does not treat an unknown missing index row as deletion of recovery history', async () => {
    const f = fixture();
    Object.assign(f.deps, {migratedHost: async () => 'sandbox-1'});
    f.provider.fetchIndex.mockResolvedValue({sessions: [], projects: []});
    expect(await f.mirror.list('/repo', [{id: 'remote', workspaceId: '/repo'} as any])).toEqual([expect.objectContaining({id: 'remote', remoteHostDeviceId: 'sandbox-1'})]);
  });

  it('rejects loading a confirmed-deleted remote conversation instead of falling back to recovery history', async () => {
    const f = fixture();
    Object.assign(f.deps, {migratedHost: async () => 'sandbox-1'});
    f.provider.fetchIndex.mockResolvedValue({sessions: [], projects: [], deletedSessionIds: ['remote']} as any);
    await expect(f.mirror.get('remote', '/repo')).rejects.toThrow(/removed|deleted/);
  });

  it('retains remote lifecycle ownership when the migrated host is unavailable', async () => {
    const f = fixture();
    Object.assign(f.deps, {migratedHost: async () => 'sandbox-1', migratedWorkspace: async () => '/repo'});
    f.mirror.setProvider(null);
    expect(await f.mirror.workspaceForSession('remote')).toBe('/repo');
    await expect(f.mirror.delete('remote', '/repo')).rejects.toThrow();
  });

  it('discards pending history seeding when its provider changes', async () => {
    const f = fixture();
    let release!: (rows: any[]) => void;
    const seedMessages = vi.fn(() => new Promise<any[]>(resolve => {release = resolve;}));
    Object.assign(f.deps, {migratedHost: async () => 'sandbox-1', seedMessages});
    const pending = f.mirror.watch('remote', '/repo', vi.fn()).then(stop => {stop();});
    await vi.waitFor(() => expect(seedMessages).toHaveBeenCalledTimes(1));
    f.mirror.setProvider(null);release([]);
    await expect(pending).rejects.toThrow(/sync changed/i);
    expect(f.provider.onRemoteChange).not.toHaveBeenCalled();
    expect(f.provider.connect).not.toHaveBeenCalled();
  });

  it('shares asynchronous history initialization between concurrent viewers', async () => {
    const f = fixture();
    let release!: (rows: any[]) => void;
    const seed = new Promise<any[]>(resolve => {release = resolve;});
    const seedMessages = vi.fn(() => seed);
    Object.assign(f.deps, {migratedHost: async () => 'sandbox-1', seedMessages});
    const first = f.mirror.watch('remote', '/repo', vi.fn());
    const second = f.mirror.watch('remote', '/repo', vi.fn());
    await vi.waitFor(() => expect(seedMessages).toHaveBeenCalled());
    release([]);
    const stops = await Promise.all([first, second]);
    for (const stop of stops) stop();
    expect(f.provider.onRemoteChange).toHaveBeenCalledTimes(1);
    expect(f.offChange).toHaveBeenCalledTimes(1);
  });

  it('retains the migrated recovery view when a complete remote index is unavailable', async () => {
    const f = fixture();
    Object.assign(f.deps, {migratedHost: async () => 'sandbox-1'});
    f.provider.fetchIndex.mockRejectedValue(new Error('offline'));
    expect(await f.mirror.list('/repo', [{id: 'remote', workspaceId: '/repo'} as any])).toEqual([expect.objectContaining({id: 'remote', remoteHostDeviceId: 'sandbox-1'})]);
  });

  it('seeds migrated history from the retained local rows and deduplicates server replay', async () => {
    vi.useFakeTimers();
    const f = fixture();
    Object.assign(f.deps, {migratedHost: async () => 'sandbox-1', seedMessages: async () => [{id: 55, sessionId: 'remote', source: 'user', direction: 'input', content: 'Earlier local question', createdAt: new Date(100)}]});
    const received = vi.fn();
    const stop = await f.mirror.watch('remote', '/repo', received);
    await vi.advanceTimersByTimeAsync(200);
    expect(JSON.stringify(received.mock.lastCall![0].session.messages)).toContain('Earlier local question');
    f.change({type: 'message_added', message: {id: 1, sessionId: 'remote', source: 'user', direction: 'input', content: 'Earlier local question', createdAt: new Date(100)}});
    f.change({type: 'message_added', message: {id: 2, sessionId: 'remote', source: 'user', direction: 'input', content: 'New Coder question', createdAt: new Date(200)}});
    await vi.advanceTimersByTimeAsync(200);
    const messages = received.mock.lastCall![0].session.messages;
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).toContain('Earlier local question');
    expect(JSON.stringify(messages)).toContain('New Coder question');
    stop();
  });

  it('refuses a migrated session whose server host does not match its migration record', async () => {
    const f = fixture();
    Object.assign(f.deps, {migratedHost: async () => 'different-host'});
    await expect(f.mirror.queue('remote', '/repo', 'continue')).rejects.toThrow(/host|machine/i);
    expect(f.provider.pushChange).not.toHaveBeenCalled();
  });
  it('counts descendants recursively without crossing workspace or host boundaries', async () => {
    const f = fixture();
    f.provider.fetchIndex.mockResolvedValue({ sessions: [f.entry,
      { ...f.entry, sessionId: 'child', parentSessionId: 'remote' },
      { ...f.entry, sessionId: 'leaf', parentSessionId: 'child' },
      { ...f.entry, sessionId: 'foreign', parentSessionId: 'remote', hostDeviceId: 'sandbox-2' },
    ], projects: [] } as any);
    const rows = await f.mirror.list('/repo', []);
    expect(rows.find(row => row.id === 'remote')).toMatchObject({ childCount: 1, descendantCount: 2 });
    expect(rows.find(row => row.id === 'child')).toMatchObject({ childCount: 1, descendantCount: 1 });
  });
  it.each([true, false])('logs the provider reason and retains the user-facing queue failure (retryable=%s)', async (retryable) => {
    const f = fixture();
    const warn = vi.spyOn(logger.main, 'warn').mockImplementation(() => {});
    try {
      f.provider.pushChange.mockResolvedValueOnce({ published: false, retryable, reason: 'remote queue disconnected' } as never);
      await expect(f.mirror.queue('remote', '/repo', 'prompt')).rejects.toThrow('The prompt could not be sent');
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/session remote: remote queue disconnected/));
    } finally { warn.mockRestore(); }
  });
  it('reconnects an observed transcript before queueing after an idle socket expires', async () => {
    const f = fixture();
    const stop = await f.mirror.watch('remote', '/repo', vi.fn());
    f.provider.getStatus = () => ({connected: false, syncing: false});
    await f.mirror.queue('remote', '/repo', 'first turn after idle');
    expect(f.provider.connect).toHaveBeenCalledTimes(2);
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
    stop();
  });

  it('serializes submissions while the preceding queue publication is in flight', async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>(resolve => {release = resolve;});
    f.provider.pushChange.mockImplementation(async (_id: string, change: any) => {
      await gate;
      Object.assign(f.entry, {queuedPrompts: change.metadata.queuedPrompts});
      return {published: true};
    });
    const first = f.mirror.queue('remote', '/repo', 'first');
    const second = f.mirror.queue('remote', '/repo', 'second');
    await vi.waitFor(() => expect(f.provider.pushChange).toHaveBeenCalled());
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
    release();
    await Promise.all([first, second]);
    expect((f.entry as any).queuedPrompts.map((row: any) => row.prompt)).toEqual(['first', 'second']);
  });

  it('merges remote metadata only in its workspace, with local collisions taking precedence', async () => {
    const f = fixture();
    expect(await f.mirror.list('/other', [])).toEqual([]);
    expect(await f.mirror.list('/repo', [])).toEqual([expect.objectContaining({ id: 'remote', remoteHostDeviceId: 'sandbox-1', workspaceId: '/repo' })]);
    f.deps.hasLocalSession.mockResolvedValue(true);
    f.deps.localSessionIds.mockResolvedValue(new Set(['remote']));
    expect(await f.mirror.list('/repo', [])).toEqual([]);
    expect(await f.mirror.get('remote', '/repo')).toBeNull();
    await expect(f.mirror.watch('remote', '/repo', vi.fn())).rejects.toThrow('not available');
    expect(f.provider.connect).not.toHaveBeenCalled();
  });

  it('subscribes before connect, renders real canonical messages, deduplicates replay and releases the last viewer', async () => {
    vi.useFakeTimers();
    const f = fixture(); const received = vi.fn();
    f.provider.connect.mockImplementation(async () => {
      f.change({ type: 'message_added', message: { id: 1, sessionId: 'remote', source: 'user', direction: 'input', content: 'Read only, please', createdAt: new Date(100) } });
    });
    const stop = await f.mirror.watch('remote', '/repo', received);
    const stop2 = await f.mirror.watch('remote', '/repo', vi.fn());
    f.change({ type: 'message_added', message: { id: 1, sessionId: 'remote', source: 'user', direction: 'input', content: 'duplicate', createdAt: new Date(100) } });
    await vi.advanceTimersByTimeAsync(200);
    expect(received).toHaveBeenCalled();
    const snapshot = received.mock.lastCall![0];
    expect(snapshot.session.messages).toHaveLength(1);
    expect(JSON.stringify(snapshot.session.messages)).toContain('Read only, please');
    expect(f.provider.connect).toHaveBeenCalledTimes(1);
    stop(); expect(f.provider.disconnect).not.toHaveBeenCalled();
    stop2(); expect(f.provider.disconnect).toHaveBeenCalledWith('remote');
    expect(f.offChange).toHaveBeenCalled(); expect(f.offStatus).toHaveBeenCalled();
    f.mirror.setProvider(null);
  });

  it('rejects workspace mismatches and sends queue/cancel only to the owning host', async () => {
    const f = fixture();
    await expect(f.mirror.queue('remote', '/other', 'hello')).rejects.toThrow('not available');
    expect(f.provider.pushChange).not.toHaveBeenCalled();
    Object.assign(f.entry, { queuedPrompts: [{ id: 'existing', prompt: 'first', timestamp: 1 }] });
    const sent = await f.mirror.queue('remote', '/repo', 'second');
    expect(f.provider.pushChange).toHaveBeenCalledWith('remote', { type: 'metadata_updated', metadata: { queuedPrompts: [
      { id: 'existing', prompt: 'first', timestamp: 1 }, expect.objectContaining({ id: sent.promptId, prompt: 'second' }),
    ] } });
    await f.mirror.cancel('remote', '/repo');
    expect(f.provider.sendSessionControlMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'remote', targetDeviceId: 'sandbox-1', type: 'cancel' }));
    f.provider.getConnectedDevices.mockReturnValue([]);
    await expect(f.mirror.queue('remote', '/repo', 'keep this')).rejects.toThrow('offline');
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
  });

  it('publishes encrypted attachments only after encryption and rejects an account change during staging', async () => {
    const f = fixture();
    const key = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
    const encrypted = [{id: 'file', filename: 'f.png', mimeType: 'image/png', encryptedData: 'cipher', iv: 'nonce', size: 5}];
    const encryptAttachments = vi.fn(async () => encrypted);
    Object.assign(f.deps, {encryptAttachments});
    f.mirror.setProvider(f.provider as unknown as SyncProvider, key);
    const attachments = [{id: 'file', filename: 'f.png', filepath: '/staged/f.png', mimeType: 'image/png', size: 5, type: 'image' as const, addedAt: 1}];
    await f.mirror.queue('remote', '/repo', 'read it', attachments);
    expect(encryptAttachments).toHaveBeenCalledWith(attachments, '/repo', key);
    expect(f.provider.pushChange).toHaveBeenCalledWith('remote', expect.objectContaining({metadata: {queuedPrompts: [expect.objectContaining({attachments: encrypted})]}}));
    encryptAttachments.mockImplementation(async () => {f.mirror.setProvider(null); return encrypted;});
    await expect(f.mirror.queue('remote', '/repo', 'retain this', attachments)).rejects.toThrow('sync changed');
    expect(f.provider.pushChange).toHaveBeenCalledTimes(1);
  });

  it('keeps history readable but rejects controls after the ephemeral host restarts', async () => {
    vi.useFakeTimers();
    const f = fixture(); const received = vi.fn();
    f.provider.getConnectedDevices.mockReturnValue([{ deviceId: 'sandbox-1', isOnline: true, type: 'headless', connectedAt: 150 }] as any);
    const stop = await f.mirror.watch('remote', '/repo', received);
    await vi.advanceTimersByTimeAsync(200);
    expect(received.mock.lastCall![0].readOnlyReason).toContain('restarted');
    await expect(f.mirror.queue('remote', '/repo', 'keep this')).rejects.toThrow('restarted');
    await expect(f.mirror.cancel('remote', '/repo')).rejects.toThrow('restarted');
    expect(f.provider.pushChange).not.toHaveBeenCalled();
    expect(f.provider.sendSessionControlMessage).not.toHaveBeenCalled();
    stop();
  });

  it('clears transcript content on account change and rejects a stale in-flight authorization', async () => {
    vi.useFakeTimers();
    const f = fixture(); const received = vi.fn();
    await f.mirror.watch('remote', '/repo', received);
    f.mirror.setProvider(null);
    expect(received).toHaveBeenCalledWith(expect.objectContaining({ connected: false, session: expect.objectContaining({ messages: [] }) }));
    expect(await f.mirror.list('/repo', [])).toEqual([]);
    await expect(f.mirror.queue('remote', '/repo', 'hello')).rejects.toThrow('not available');
    const second = fixture();
    let release!: (value: boolean) => void;
    second.deps.hasLocalSession.mockReturnValueOnce(new Promise(resolve => { release = resolve; }));
    const pending = second.mirror.queue('remote', '/repo', 'must not send');
    await vi.advanceTimersByTimeAsync(0);
    second.mirror.setProvider(null); release(false);
    await expect(pending).rejects.toThrow('sync changed');
    expect(second.provider.pushChange).not.toHaveBeenCalled();
  });
});

it('omits stale unrelated desktops while retaining remote project history and excluding locally owned history', async () => {
  const f = fixture();
  f.provider.getConnectedDevices.mockReturnValue([
    {deviceId: 'old-desktop', name: 'This Mac before rename', type: 'desktop', isOnline: false},
    {deviceId: 'other-live', name: 'Second directory', type: 'desktop'},
    {deviceId: 'sandbox-1', name: 'Sandbox', type: 'headless', isOnline: false},
  ] as any);
  expect((await f.mirror.hosts('/repo')).map(d => d.deviceId)).toEqual(['other-live', 'sandbox-1']);
  f.deps.hasLocalSession.mockResolvedValue(true);
    f.deps.localSessionIds.mockResolvedValue(new Set(['remote']));
  expect((await f.mirror.hosts('/repo')).map(d => d.deviceId)).toEqual(['other-live']);
});

it('keeps a configured sleeping sandbox but suppresses hidden history without making it locally executable', async () => {
  const f = fixture();
  Object.assign(f.deps, {configuredHostIds: () => new Set(['sandbox-1'])});
  f.provider.getConnectedDevices.mockReturnValue([{deviceId: 'sandbox-1', type: 'headless', isOnline: false, inventoryHidden: false}] as any);
  expect((await f.mirror.hosts('/unrelated')).map(d => d.deviceId)).toEqual(['sandbox-1']);
  f.provider.getConnectedDevices.mockReturnValue([{deviceId: 'sandbox-1', type: 'headless', isOnline: false, inventoryHidden: true}] as any);
  expect(await f.mirror.hosts('/repo')).toEqual([]);
  expect(await f.mirror.list('/repo', [])).toHaveLength(1);
  await expect(f.mirror.assertLocalExecution('remote')).rejects.toThrow('host');
});

it('keeps desktop history readable after its presence record expires and inventory metadata survives', async () => {
  const f = fixture();
  f.entry.hostDeviceId = 'retired-desktop';
  f.provider.getConnectedDevices.mockReturnValue([{deviceId: 'retired-desktop', name: 'Previous installation', type: 'unknown', isOnline: false, inventoryHidden: true}] as any);
  expect(await f.mirror.list('/repo', [])).toHaveLength(1);
  expect(await f.mirror.hosts('/repo')).toEqual([]);
  f.provider.getConnectedDevices.mockReturnValue([{deviceId: 'retired-desktop', name: 'Previous installation', type: 'unknown', isOnline: false, inventoryHidden: false}] as any);
  expect((await f.mirror.hosts('/repo')).map(d => d.deviceId)).toEqual(['retired-desktop']);
  await expect(f.mirror.assertLocalExecution('remote')).rejects.toThrow('host');
});


it('preserves Codex provider selection when dispatching to Coder', async () => {
  const f = fixture(); let answer: ((response: any) => void) | undefined;
  const sendCreateSessionRequest = vi.fn(async (request: any) => {answer?.({requestId: request.requestId, success: true, sessionId: 'coder-session'});});
  Object.assign(f.provider, {onCreateSessionResponse: (cb: any) => {answer = cb; return () => {};}, sendCreateSessionRequest});
  await expect(f.mirror.create('/repo', 'sandbox-1', {model: 'openai-codex:gpt-6.1-sol'})).resolves.toBe('coder-session');
  expect(sendCreateSessionRequest).toHaveBeenCalledWith(expect.objectContaining({targetDeviceId: 'sandbox-1', provider: 'openai-codex', model: 'openai-codex:gpt-6.1-sol'}));
});

it('allows a durable Coder session to continue after the runner process restarts', async () => {
  const f = fixture(); f.provider.getConnectedDevices.mockReturnValue([{deviceId:'sandbox-1', type:'headless', isOnline:true, connectedAt:500, persistentWorkspaces:true}] as any);
  await expect(f.mirror.queue('remote', '/repo', 'continue')).resolves.toHaveProperty('promptId');
});

// Sidebar activity must come from the index without opening transcript watches.
it.each([false, true])('lists indexed execution for remote sessions (retained migration: %s)', async migrated => {
  const f = fixture();
  Object.assign(f.entry, {isExecuting: true});
  const local = migrated ? [{id: 'remote', workspaceId: '/repo', title: 'Retained'} as any] : [];
  if (migrated) Object.assign(f.deps, {migratedHost: async () => 'sandbox-1'});
  expect((await f.mirror.list('/repo', local))[0]).toMatchObject({remoteHostDeviceId: 'sandbox-1', remoteIsExecuting: true});
  expect(f.provider.connect).not.toHaveBeenCalled();
  Object.assign(f.entry, {isExecuting: false});
  f.index();
  expect(f.deps.listChanged).toHaveBeenCalledWith('/repo', 'remote');
  expect((await f.mirror.list('/repo', local))[0].remoteIsExecuting).toBe(false);
  expect(f.provider.connect).not.toHaveBeenCalled();
});

it('does not use execution from an index entry on the wrong migration host', async () => {
  const f = fixture();
  Object.assign(f.entry, {isExecuting: true});
  Object.assign(f.deps, {migratedHost: async () => 'other-host'});
  const rows = await f.mirror.list('/repo', [{id: 'remote', workspaceId: '/repo'} as any]);
  expect(rows[0].remoteIsExecuting).toBe(false);
});
