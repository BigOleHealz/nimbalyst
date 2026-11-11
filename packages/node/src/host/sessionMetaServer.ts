import { createServer } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SessionStore } from '@nimbalyst/runtime/ai/adapters/sessionStore';

const phases = ['backlog', 'planning', 'implementing', 'validating', 'complete'];
const schema = {
  name: 'update_session_meta',
  description: 'Update this session’s phase and tags as work progresses. Set planning for exploration, implementing for coding, validating for testing or review. Set complete only after the user approves or commits the work. Do not rename an already named session.',
  inputSchema: { type: 'object', properties: {
    name: { type: 'string', description: 'Concise initial session name; existing names are preserved.' },
    phase: { type: 'string', enum: phases },
    add: { type: 'array', items: { type: 'string' } },
    remove: { type: 'array', items: { type: 'string' } },
  }, additionalProperties: false },
  _meta: { 'anthropic/alwaysLoad': true },
};

/** Native headless core: metadata writes must pass through the decorated store. */
export async function createSessionMetaServer(store: Pick<SessionStore, 'get' | 'updateMetadata'>) {
  const secret = randomBytes(32);
  const credentials = new Map<string, { sessionId: string; workspacePath: string }>();
  const tokenForSession = (sessionId: string, workspacePath: string) => {
    const token = createHmac('sha256', secret).update(JSON.stringify([sessionId, workspacePath])).digest('hex');
    credentials.set(token, { sessionId, workspacePath });
    return token;
  };
  const queues = new Map<string, Promise<unknown>>();
  const server = createServer(async (req, res) => {
    const reply = (status: number, body?: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(body === undefined ? '' : JSON.stringify(body)); };
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://127.0.0.1'); }
    catch { return reply(400, { error: 'Invalid request target' }); }
    if (url.pathname !== '/mcp/core') return reply(404, { error: 'Not found' });
    const header = req.headers.authorization ?? '';
    const credential = header.startsWith('Bearer ') ? header.slice(7) : '';
    const scope = credentials.get(credential);
    if (!scope) return reply(401, { error: 'Unauthorized' });
    const actual = Buffer.from(credential); const expected = Buffer.from(tokenForSession(scope.sessionId, scope.workspacePath));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401, { error: 'Unauthorized' });
    const sessionId = url.searchParams.get('sessionId');
    const workspacePath = url.searchParams.get('workspacePath');
    if (sessionId !== scope.sessionId || workspacePath !== scope.workspacePath) return reply(403, { error: 'Session context unavailable' });
    if (req.method === 'DELETE') return reply(200, {});
    if (req.method !== 'POST') return reply(405, { error: 'POST required' });
    let rpc: any;
    try {
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 65536) throw new Error('oversized'); chunks.push(chunk); }
      rpc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch { return reply(400, { error: 'Invalid request' }); }
    const id = rpc?.id ?? null;
    const error = (code: number, message: string) => reply(200, { jsonrpc: '2.0', id, error: { code, message } });
    if (!rpc || Array.isArray(rpc) || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') return error(-32600, 'Invalid request');
    try {
      const session = sessionId ? await store.get(sessionId) : null;
      if (!session || !workspacePath || workspacePath !== (session.metadata?.remoteWorkspacePath ?? session.workspacePath)) return reply(403, { error: 'Session context unavailable' });
      if (rpc.id === undefined) return reply(202);
      const result = (value: unknown) => reply(200, { jsonrpc: '2.0', id, result: value });
      if (rpc.method === 'initialize') return result({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(rpc.params?.protocolVersion) ? rpc.params.protocolVersion : '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'nimbalyst-headless-core', version: '1.0.0' } });
      if (rpc.method === 'ping') return result({});
      if (rpc.method === 'tools/list') return result({ tools: [schema] });
      if (rpc.method !== 'tools/call' || rpc.params?.name !== 'update_session_meta') return error(-32601, 'Unknown tool');
      // Serialize read/merge/write so concurrent tag changes cannot lose each other.
      const previous = queues.get(session.id) ?? Promise.resolve();
      const operation = previous.catch(() => {}).then(() => update(store, session.id, rpc.params.arguments));
      queues.set(session.id, operation);
      try { return result(await operation); }
      finally { if (queues.get(session.id) === operation) queues.delete(session.id); }
    } catch {
      console.error('[session-meta] Metadata operation failed');
      return error(-32000, 'Session metadata could not be updated');
    }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as { port: number }).port;
  return { port, tokenForSession, close: async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); } };
}

async function update(store: Pick<SessionStore, 'get' | 'updateMetadata'>, id: string, args: unknown) {
  const invalid = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });
  if (!args || typeof args !== 'object' || Array.isArray(args)) return invalid('Provide session metadata fields.');
  const input = args as Record<string, unknown>;
  if (Object.keys(input).some(key => !['name', 'phase', 'add', 'remove'].includes(key))) return invalid('Unsupported metadata field.');
  if (input.phase !== undefined && (typeof input.phase !== 'string' || !phases.includes(input.phase))) return invalid('Invalid session phase.');
  if (input.name !== undefined && (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 100)) return invalid('Invalid session name.');
  for (const key of ['add', 'remove']) {
    if (input[key] !== undefined && (!Array.isArray(input[key]) || !(input[key] as unknown[]).every(tag => typeof tag === 'string' && tag.length > 0 && tag.length <= 100))) return invalid('Tags must be nonempty strings.');
  }
  if (!Object.keys(input).length) return invalid('Provide session metadata fields.');
  const session = await store.get(id);
  if (!session) return invalid('Session not found.');
  const before = { name: session.title ?? null, tags: session.metadata?.tags ?? [], phase: session.metadata?.phase ?? null };
  const metadata: Record<string, unknown> = {};
  if (input.phase !== undefined) metadata.phase = input.phase;
  if (input.add !== undefined || input.remove !== undefined) {
    const current = Array.isArray(session.metadata?.tags) ? session.metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [];
    const removed = new Set((input.remove ?? []) as string[]);
    metadata.tags = [...new Set([...current.filter(tag => !removed.has(tag)), ...((input.add ?? []) as string[])])];
  }
  await store.updateMetadata(id, { metadata, ...(input.name && !session.hasBeenNamed ? { title: input.name as string, hasBeenNamed: true } : {}) });
  const after = await store.get(id);
  return { isError: false, content: [{ type: 'text', text: JSON.stringify({ before, after: { name: after?.title ?? null, tags: after?.metadata?.tags ?? [], phase: after?.metadata?.phase ?? null } }) }] };
}
