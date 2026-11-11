// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { request as httpRequest } from 'node:http';
import { createSessionMetaServer } from '../host/sessionMetaServer.js';
import { createSyncedSessionStore } from '@nimbalyst/runtime/sync/SyncedSessionStore';
import { withHostAttribution } from '../serve/hostAttributionStore.js';

const servers: Awaited<ReturnType<typeof createSessionMetaServer>>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())); });
async function fixture() {
  const session: any = { id: 'one', title: 'Existing name', hasBeenNamed: true, workspacePath: '/mac/foss', metadata: { remoteWorkspacePath: '/coder/task', hostDeviceId: 'coder-foss', tags: ['keep'] } };
  const otherSession: any = { ...session, id: 'two', title: 'Other session', metadata: { ...session.metadata } };
  const updateMetadata = vi.fn(async (id, update) => { const target = id === 'two' ? otherSession : session; Object.assign(target, { ...update, metadata: { ...target.metadata, ...update.metadata } }); });
  const pushChange = vi.fn(async () => ({ published: true }));
  const store = withHostAttribution(createSyncedSessionStore({ get: async (id: string) => id === 'one' ? session : id === 'two' ? otherSession : null, updateMetadata } as any, {
    isConnected: () => true, getStatus: () => ({ connected: true }), onStatusChange: () => () => {}, onRemoteChange: () => () => {}, pushChange,
  } as any), 'coder-foss');
  const server = await createSessionMetaServer(store); servers.push(server);
  const call = async (method: string, params?: unknown, token = server.tokenForSession('one', '/coder/task'), query = 'sessionId=one&workspacePath=%2Fcoder%2Ftask') => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp/core?${query}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return { status: res.status, body: await res.json() };
  };
  return { call, session, otherSession, updateMetadata, pushChange, server };
}
it('writes the phase and merged tags through the synchronized store, preserving execution ownership and title', async () => {
  const f = await fixture();
  expect((await f.call('tools/list')).body.result.tools.map((t: any) => t.name)).toEqual(['update_session_meta']);
  const response = await f.call('tools/call', { name: 'update_session_meta', arguments: { phase: 'validating', add: ['testing'] } });
  expect(response.body.result.isError).toBe(false);
  expect(f.session.metadata).toMatchObject({ phase: 'validating', tags: ['keep', 'testing'], hostDeviceId: 'coder-foss' });
  expect(f.session.title).toBe('Existing name');
  expect(f.pushChange).toHaveBeenCalledWith('one', expect.objectContaining({ type: 'metadata_updated', metadata: expect.objectContaining({ phase: 'validating', tags: ['keep', 'testing'], hostDeviceId: 'coder-foss' }) }));
});
it('rejects unauthorized callers, unknown sessions, wrong workspaces and invalid phase values without writing', async () => {
  const f = await fixture();
  expect((await f.call('tools/list', {}, 'wrong')).status).toBe(401);
  expect((await f.call('tools/list', {}, undefined, 'sessionId=missing&workspacePath=%2Fcoder%2Ftask')).status).toBe(403);
  expect((await f.call('tools/list', {}, undefined, 'sessionId=one&workspacePath=%2Fother')).status).toBe(403);
  const response = await f.call('tools/call', { name: 'update_session_meta', arguments: { phase: 'finished' } });
  expect(response.body.result.isError).toBe(true);
  expect(f.updateMetadata).not.toHaveBeenCalled();
});


it('does not let one session credential update a different valid session in the same workspace', async () => {
  const f = await fixture();
  const response = await f.call('tools/call', { name: 'update_session_meta', arguments: { phase: 'complete' } }, undefined, 'sessionId=two&workspacePath=%2Fcoder%2Ftask');
  expect(response.status).toBe(403);
  expect(f.updateMetadata).not.toHaveBeenCalled();
  expect(f.otherSession.metadata.phase).toBeUndefined();
});

it('rejects malformed request targets before authentication and remains available', async () => {
  const f = await fixture();
  const status = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port: f.server.port, path: '//127.0.0.1:bad/mcp/core', method: 'POST' }, response => {
      response.resume(); response.once('end', () => resolve(response.statusCode));
    });
    request.on('error', reject); request.setTimeout(1000, () => request.destroy(new Error('Malformed request timed out'))); request.end();
  });
  expect(status).toBe(400);
  expect((await f.call('ping')).body.result).toEqual({});
});


it('accepts the other session’s own credential without changing the first session', async () => {
  const f = await fixture();
  const token = f.server.tokenForSession('two', '/coder/task');
  const response = await f.call('tools/call', { name: 'update_session_meta', arguments: { phase: 'validating' } }, token, 'sessionId=two&workspacePath=%2Fcoder%2Ftask');
  expect(response.body.result.isError).toBe(false);
  expect(f.otherSession.metadata.phase).toBe('validating');
  expect(f.session.metadata.phase).toBeUndefined();
});
