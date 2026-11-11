// @vitest-environment node
import {afterEach, expect, it, vi} from 'vitest';
import {mkdtemp, mkdir, writeFile, appendFile, rm, realpath, symlink, unlink} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {spawn} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {importSessionContinuations} from '../serve/sessionContinuations.js';
import {validateSessionContinuation, validateRetainedContinuation} from '../serve/validateSessionContinuation.js';
import {confirmContinuationOwnership, ownsSessionExecution} from '../serve/confirmContinuationOwnership.js';
import {JsonRpcClient} from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/jsonRpcClient';
import {resolveCodexBinaryPath} from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/codexAppServerBinary';

const temporaryDirectories: string[] = [];
afterEach(async () => {for (const directory of temporaryDirectories.splice(0)) await rm(directory, {recursive: true, force: true});});

async function nativeFixture(provider = 'openai-codex', nativeId = 'native-thread') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'continuation-validation-')));
  temporaryDirectories.push(directory);
  const checkout = join(directory, 'project');
  const workspace = join(checkout, 'worktrees', 'existing');
  await mkdir(workspace, {recursive: true});
  execFileSync('git', ['init', '--quiet', checkout]);
  execFileSync('git', ['-C', checkout, 'config', 'remote.origin.url', 'https://example.test/repo.git']);
  const nativeSessionPath = join(directory, 'thread.jsonl');
  const content = JSON.stringify(provider === 'openai-codex'
    ? {type: 'session_meta', payload: {id: nativeId}}
    : {type: 'user', sessionId: nativeId, message: {content: 'history'}}) + '\n';
  await writeFile(nativeSessionPath, content);
  const entry = {...fixture().entry, provider, remoteWorkspacePath: workspace, nativeSessionPath, nativeSessionSha256: createHash('sha256').update(content).digest('hex')};
  return {directory, entry, options: {resolveNativeSession: vi.fn(async () => nativeSessionPath)}, mapping: {projectId: entry.workspaceId, repoUrl: 'https://example.test/repo.git', branch: 'main', checkoutDir: checkout}};
}

function fixture() {
  const entry = {id: 'same-id', workspaceId: '/mac/foss', provider: 'openai-codex', providerSessionId: 'native-thread', title: 'Existing task', remoteWorkspacePath: '/coder/migrated/task', nativeSessionPath: '/coder/.codex/sessions/thread.jsonl', nativeSessionSha256: 'abc', metadata: {phase: 'validating'}};
  const store = {get: vi.fn(async () => null as any), create: vi.fn(async () => {})};
  Object.assign(store, {createIfAbsent: store.create});
  const validate = vi.fn(async () => {});
  return {entry, store, validate, input: {migrationId: 'move-one', entries: [entry], hostDeviceId: 'coder-one', store: store as any, validate, confirm: vi.fn(async (_entry: unknown, verifyLegacy?: () => Promise<void>) => {await verifyLegacy?.();})}};
}

it('imports the original id and native conversation without local worktree ids or a new session', async () => {
  const f = fixture();
  await importSessionContinuations(f.input);
  expect(f.store.create).toHaveBeenCalledWith(expect.objectContaining({id: 'same-id', providerSessionId: 'native-thread', workspaceId: '/mac/foss', metadata: expect.objectContaining({hostDeviceId: 'coder-one', remoteWorkspacePath: '/coder/migrated/task', phase: 'validating', remoteMigration: expect.objectContaining({id: 'move-one'})})}));
});

it('validates the whole batch before writing any sessions', async () => {
  const f = fixture();
  f.input.entries.push({...f.entry, id: 'bad'});
  f.validate.mockRejectedValueOnce(new Error('outside checkout root'));
  await expect(importSessionContinuations(f.input)).rejects.toThrow('outside checkout root');
  expect(f.store.create).not.toHaveBeenCalled();
});

it('refuses an existing session collision without changing its state', async () => {
  const f = fixture(); f.store.get.mockResolvedValue({id: 'same-id', metadata: {}});
  await expect(importSessionContinuations(f.input)).rejects.toThrow(/already exists/);
  expect(f.store.create).not.toHaveBeenCalled();
});

it('preserves later continuation state when the runner restarts', async () => {
  const f = fixture();
  f.store.get.mockResolvedValue({id: 'same-id', providerSessionId: 'advanced-thread', workspacePath: '/mac/foss', metadata: {hostDeviceId: 'coder-one', remoteWorkspacePath: '/coder/migrated/task', remoteMigration: {id: 'move-one', originalProvider: 'openai-codex', originalProviderSessionId: 'native-thread'}}});
  expect(await importSessionContinuations(f.input)).toEqual({imported: 0, retained: 1, deleted: 0});
  expect(f.store.create).not.toHaveBeenCalled();
  expect(f.validate).not.toHaveBeenCalled();
});

it('retries ownership confirmation for a retained import before declaring the runner ready', async () => {
  const f = fixture();
  f.store.get.mockResolvedValue({id: 'same-id', workspacePath: f.entry.workspaceId, metadata: {hostDeviceId: 'coder-one', remoteWorkspacePath: f.entry.remoteWorkspacePath, remoteMigration: {id: 'move-one', originalProvider: 'openai-codex', originalProviderSessionId: 'native-thread'}}});
  const confirm = vi.fn(async () => {throw new Error('Index not ready');});
  await expect(importSessionContinuations({...f.input, confirm})).rejects.toThrow('Index not ready');
  expect(confirm).toHaveBeenCalledWith(f.entry);
  expect(f.store.create).not.toHaveBeenCalled();
});

it('rejects two identities that would resume the same native conversation', async () => {
  const f = fixture();
  f.input.entries.push({...f.entry, id: 'other', remoteWorkspacePath: '/coder/other'});
  await expect(importSessionContinuations(f.input)).rejects.toThrow(/native|duplicate|conversation/i);
  expect(f.store.create).not.toHaveBeenCalled();
});

it('requires a collision-safe insertion rather than overwriting a concurrent session', async () => {
  const f = fixture();
  Object.assign(f.store, {createIfAbsent: vi.fn(async () => {throw new Error('Session already exists');})});
  await expect(importSessionContinuations(f.input)).rejects.toThrow(/already exists/);
  expect(f.store.create).not.toHaveBeenCalled();
});

it.each(['openai-codex', 'claude-code'])('checks the actual %s conversation identity inside the verified file', async provider => {
  const f = await nativeFixture(provider, 'different-native-thread');
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, f.options)).rejects.toThrow(/identity|conversation|session/i);
});

it('rejects a different project checkout inside the broad host root', async () => {
  const f = await nativeFixture();
  f.entry.remoteWorkspacePath = join(f.directory, 'other-project');
  await mkdir(f.entry.remoteWorkspacePath);
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, f.options)).rejects.toThrow(/project|mapping|workspace/i);
});

it.each(['openai-codex', 'claude-code'])('accepts a verified %s conversation in the mapped project', async provider => {
  const f = await nativeFixture(provider);
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, f.options)).resolves.toBeUndefined();
});

it('accepts the immediately inherited parent header in a forked Codex rollout', async () => {
  const f = await nativeFixture();
  const content = [
    {type: 'session_meta', payload: {id: 'native-thread', cwd: '/mac/foss', forked_from_id: 'parent-thread'}},
    {type: 'session_meta', payload: {id: 'parent-thread', cwd: '/mac/foss'}},
    {type: 'response_item', payload: {type: 'message', role: 'user', content: []}},
  ].map(row => JSON.stringify(row) + '\n').join('');
  await writeFile(f.entry.nativeSessionPath, content);
  f.entry.nativeSessionSha256 = createHash('sha256').update(content).digest('hex');
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, f.options)).resolves.toBeUndefined();
});

it('rejects an unrelated Git repository nested inside the mapped checkout', async () => {
  const f = await nativeFixture();
  execFileSync('git', ['init', '--quiet', f.entry.remoteWorkspacePath]);
  execFileSync('git', ['-C', f.entry.remoteWorkspacePath, 'config', 'remote.origin.url', 'https://example.test/other.git']);
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, f.options)).rejects.toThrow(/repository|project/);
});

it('rejects a verified file when the provider discovers another rollout for that ID', async () => {
  const f = await nativeFixture();
  await writeFile(f.entry.nativeSessionPath + '.other', 'another provider file');
  f.options.resolveNativeSession.mockResolvedValue(f.entry.nativeSessionPath + '.other');
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, f.options)).rejects.toThrow(/discover|native|conversation/i);
});

it('requires the original snapshot digest for fresh and unchanged retained imports', async () => {
  const f = await nativeFixture();
  const invalid = {...f.entry, nativeSessionSha256: undefined};
  await expect(validateSessionContinuation(invalid as any, f.mapping, f.directory, f.options)).rejects.toThrow(/verification/);
  await expect(validateRetainedContinuation(invalid as any, {provider: f.entry.provider, providerSessionId: f.entry.providerSessionId}, f.mapping, f.directory, f.options)).rejects.toThrow(/verification/);
});

it('reads the actual Codex rollout from an isolated provider home without starting a model turn', async () => {
  const f = await nativeFixture();
  const home = join(f.directory, 'codex-home');
  await mkdir(home);
  const environment = {HOME: home, CODEX_HOME: home, PATH: process.env.PATH};
  const child = spawn(resolveCodexBinaryPath(), ['app-server', '--listen', 'stdio://'], {env: environment, cwd: f.entry.remoteWorkspacePath, stdio: ['pipe', 'pipe', 'pipe']});
  child.stderr.resume();
  const client = new JsonRpcClient(child, {defaultTimeoutMs: 10_000, logger: {log() {}, warn() {}}});
  try {
    await client.request('initialize', {clientInfo: {name: 'continuation_test', version: '1'}});
    client.notify('initialized', {});
    const {thread} = await client.request<{thread: {id: string}}>('thread/start', {cwd: f.entry.remoteWorkspacePath, sandbox: 'read-only', approvalPolicy: 'never'});
    await client.request('thread/shellCommand', {threadId: thread.id, command: 'true'});
    const read = await client.request<{thread: {path: string}}>('thread/read', {threadId: thread.id, includeTurns: false});
    f.entry.providerSessionId = thread.id;
    f.entry.nativeSessionPath = read.thread.path;
  } finally {
    const stopped = new Promise<void>(resolve => child.once('close', () => resolve()));
    client.close(); child.stdin.end(); child.kill();
    await stopped;
  }
  f.entry.nativeSessionSha256 = createHash('sha256').update(await readFile(f.entry.nativeSessionPath)).digest('hex');
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, {nativeEnvironment: environment})).resolves.toBeUndefined();
});

it('accepts a copied checkout with the mapped repository origin', async () => {
  const f = await nativeFixture();
  execFileSync('git', ['init', '--quiet', f.entry.remoteWorkspacePath]);
  execFileSync('git', ['-C', f.entry.remoteWorkspacePath, 'config', 'remote.origin.url', 'ssh://git@example.test/repo.git']);
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, f.options)).resolves.toBeUndefined();
});

it('preserves supported multi-repository continuation containers', async () => {
  const f = await nativeFixture();
  const repositoryPaths: string[] = [];
  for (const name of ['app', 'website']) {
    const source = join(f.mapping.checkoutDir, name);
    const target = join(f.entry.remoteWorkspacePath, name);
    for (const directory of [source, target]) {
      await mkdir(directory);
      execFileSync('git', ['init', '--quiet', directory]);
      execFileSync('git', ['-C', directory, 'config', 'remote.origin.url', `https://example.test/${name}.git`]);
    }
    repositoryPaths.push(source);
  }
  const mapping = {...f.mapping, repositoryPaths};
  await expect(validateSessionContinuation(f.entry as any, mapping, f.directory, f.options)).resolves.toBeUndefined();
  await expect(validateSessionContinuation({...f.entry, remoteWorkspacePath: f.mapping.checkoutDir} as any, mapping, f.directory, f.options)).resolves.toBeUndefined();
  // Existing conversations retain the repositories they originally isolated;
  // adding another repository to the project must not invalidate their cwd.
  const laterSource = join(f.mapping.checkoutDir, 'later-added');
  await mkdir(laterSource);
  execFileSync('git', ['init', '--quiet', laterSource]);
  execFileSync('git', ['-C', laterSource, 'config', 'remote.origin.url', 'https://example.test/later-added.git']);
  await expect(validateSessionContinuation(f.entry as any, {...mapping, repositoryPaths: [...repositoryPaths, laterSource]}, f.directory, f.options)).resolves.toBeUndefined();
  const single = {...f.entry, remoteWorkspacePath: join(f.entry.remoteWorkspacePath, 'app')};
  await expect(validateSessionContinuation(single as any, mapping, f.directory, f.options)).resolves.toBeUndefined();
  const foreign = join(f.entry.remoteWorkspacePath, 'foreign-repo');
  await mkdir(foreign);
  execFileSync('git', ['init', '--quiet', foreign]);
  await expect(validateSessionContinuation(f.entry as any, mapping, f.directory, f.options)).rejects.toThrow(/repository|project/);
  await rm(foreign, {recursive: true});
  execFileSync('git', ['-C', join(f.entry.remoteWorkspacePath, 'website'), 'config', 'remote.origin.url', 'https://example.test/unrelated.git']);
  await expect(validateSessionContinuation(f.entry as any, mapping, f.directory, f.options)).rejects.toThrow(/repository|project/);
  const empty = join(f.mapping.checkoutDir, 'empty-container');
  await mkdir(empty);
  await expect(validateSessionContinuation({...f.entry, remoteWorkspacePath: empty} as any, mapping, f.directory, f.options)).rejects.toThrow(/repository/);
});

it('rejects a verified Codex file outside the running provider state', async () => {
  const f = await nativeFixture();
  const home = join(f.directory, 'empty-provider-home');
  await mkdir(home);
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, {
    nativeEnvironment: {HOME: home, CODEX_HOME: home, PATH: process.env.PATH},
  })).rejects.toThrow(/discover|native|conversation/i);
});

it.each(['at-root', 'ancestor'])('rejects an unmapped effective Git root for a repository container (%s)', async location => {
  const f = await nativeFixture();
  const repositoryPaths = ['app', 'website'].map(name => join(f.mapping.checkoutDir, name));
  for (const source of repositoryPaths) {
    await mkdir(source);
    execFileSync('git', ['init', '--quiet', source]);
    execFileSync('git', ['-C', source, 'config', 'remote.origin.url', `https://example.test/${source.split('/').pop()}.git`]);
  }
  const foreign = location === 'at-root' ? f.entry.remoteWorkspacePath : join(f.mapping.checkoutDir, 'worktrees');
  execFileSync('git', ['init', '--quiet', foreign]);
  execFileSync('git', ['-C', foreign, 'config', 'remote.origin.url', 'https://example.test/foreign.git']);
  const validChild = join(f.entry.remoteWorkspacePath, 'app');
  await mkdir(validChild);
  execFileSync('git', ['init', '--quiet', validChild]);
  execFileSync('git', ['-C', validChild, 'config', 'remote.origin.url', 'https://example.test/app.git']);
  await expect(validateSessionContinuation(f.entry as any, {...f.mapping, repositoryPaths}, f.directory, f.options)).rejects.toThrow(/repository|project/);
});

it('requires a unique Claude UUID file in the effective runner projects store', async () => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const f = await nativeFixture('claude-code', id);
  f.entry.providerSessionId = id;
  const home = join(f.directory, 'claude-home');
  const project = join(home, '.claude', 'projects', '-migrated-project');
  await mkdir(project, {recursive: true});
  const nativeEnvironment = {HOME: home};
  const content = await readFile(f.entry.nativeSessionPath);
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, {nativeEnvironment})).rejects.toThrow(/missing|discover/);
  f.entry.nativeSessionPath = join(project, `${id}.jsonl`);
  await writeFile(f.entry.nativeSessionPath, content);
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, {nativeEnvironment})).resolves.toBeUndefined();
  const duplicate = join(home, '.claude', 'projects', '-other-project');
  await mkdir(duplicate);
  await writeFile(join(duplicate, `${id}.jsonl`), content);
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, {nativeEnvironment})).rejects.toThrow(/ambiguous/);
});

it.each(['metadata-only', 'sidechain'])('rejects a %s Claude journal that the native SDK cannot resume', async kind => {
  const id = '12345678-1234-1234-1234-123456789abc';
  const f = await nativeFixture('claude-code', id);
  f.entry.providerSessionId = id;
  const home = join(f.directory, 'claude-home');
  const project = join(home, '.claude', 'projects', '-migrated-project');
  await mkdir(project, {recursive: true});
  f.entry.nativeSessionPath = join(project, `${id}.jsonl`);
  const content = JSON.stringify(kind === 'metadata-only'
    ? {type: 'queue-operation', sessionId: id}
    : {type: 'user', sessionId: id, isSidechain: true, uuid: '12345678-1234-1234-1234-123456789def', parentUuid: null, message: {role: 'user', content: 'sidechain history'}}) + '\n';
  await writeFile(f.entry.nativeSessionPath, content);
  f.entry.nativeSessionSha256 = createHash('sha256').update(content).digest('hex');
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, {nativeEnvironment: {HOME: home}})).rejects.toThrow(/native|conversation/);
});

it('upgrades a legacy marker after append-only history growth without overwriting live state', async () => {
  const f = await nativeFixture();
  await appendFile(f.entry.nativeSessionPath, JSON.stringify({type: 'response_item', payload: {type: 'message', role: 'assistant', content: []}}) + '\n');
  const source = fixture();
  source.store.get.mockResolvedValue({id: f.entry.id, provider: f.entry.provider, providerSessionId: f.entry.providerSessionId,
    workspacePath: f.entry.workspaceId, metadata: {hostDeviceId: 'coder-one', remoteWorkspacePath: f.entry.remoteWorkspacePath, remoteMigration: {id: 'move-one'}}});
  const verifyContinuationIdentity = vi.fn(async () => {});
  await expect(importSessionContinuations({...source.input, entries: [f.entry], store: {...source.store, verifyContinuationIdentity} as any,
    validate: (entry, options) => validateSessionContinuation(entry, f.mapping, f.directory, {...f.options, ...options}),
  })).resolves.toEqual({imported: 0, retained: 1, deleted: 0});
  expect(verifyContinuationIdentity).toHaveBeenCalledWith(f.entry.id, 'move-one', f.entry.provider, f.entry.providerSessionId);
  expect(source.store.create).not.toHaveBeenCalled();
});

it('never accepts a rewritten legacy history as append-only growth', async () => {
  const f = await nativeFixture();
  await writeFile(f.entry.nativeSessionPath, JSON.stringify({type: 'session_meta', payload: {id: f.entry.providerSessionId, cwd: '/rewritten'}}) + '\n');
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, {...f.options, allowAppendedHistory: true})).rejects.toThrow(/verification/);
});

it('rejects retargeting the verified history symlink during native discovery', async () => {
  const f = await nativeFixture();
  const original = f.entry.nativeSessionPath;
  const other = original + '.other';
  await writeFile(other, JSON.stringify({type: 'session_meta', payload: {id: f.entry.providerSessionId, cwd: '/other'}}) + '\n');
  const link = join(f.directory, 'verified.jsonl');
  await symlink(original, link);
  f.entry.nativeSessionPath = link;
  const resolveNativeSession = async () => {await unlink(link); await symlink(other, link); return other;};
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, {resolveNativeSession})).rejects.toThrow(/native|conversation|changed/);
});

it('reports malformed native JSON without echoing private transcript text', async () => {
  const f = await nativeFixture();
  const privateFixture = 'private-fixture-transcript-content';
  await writeFile(f.entry.nativeSessionPath, privateFixture);
  f.entry.nativeSessionSha256 = createHash('sha256').update(privateFixture).digest('hex');
  const failure = await validateSessionContinuation(f.entry as any, f.mapping, f.directory, f.options).catch(error => error);
  expect(failure).toBeInstanceOf(Error);
  expect(failure.message).toBe('Invalid native conversation JSON.');
  expect(failure.stack).not.toContain(privateFixture);
});

it('verifies a retained live native conversation before confirming existing ownership', async () => {
  const f = fixture();
  const provider = {fetchIndex: async () => ({sessions: [{sessionId: f.entry.id, projectId: f.entry.workspaceId, hostDeviceId: 'coder-one'}]}), pushChange: vi.fn()} as any;
  const verifyNative = vi.fn(async () => {throw new Error('Live native conversation is unavailable');});
  await expect(confirmContinuationOwnership(provider, f.entry, 'coder-one', f.entry.provider, verifyNative)).rejects.toThrow('Live native conversation is unavailable');
  expect(verifyNative).toHaveBeenCalledOnce();
  expect(provider.pushChange).not.toHaveBeenCalled();
});

it('checks advanced retained native state without reverting it to the original snapshot', async () => {
  const f = await nativeFixture();
  const advancedPath = join(f.directory, 'advanced.jsonl');
  await writeFile(advancedPath, JSON.stringify({type: 'session_meta', payload: {id: 'advanced-thread'}}) + '\n');
  const current = {provider: f.entry.provider, providerSessionId: 'advanced-thread'};
  const resolveNativeSession = vi.fn(async () => advancedPath);
  await expect(validateRetainedContinuation(f.entry as any, current, f.mapping, f.directory, {resolveNativeSession})).resolves.toBeUndefined();
  expect(resolveNativeSession).toHaveBeenCalledWith(expect.objectContaining({providerSessionId: 'advanced-thread'}));
  expect(current.providerSessionId).toBe('advanced-thread');
  await expect(validateRetainedContinuation(f.entry as any, current, f.mapping, f.directory, {resolveNativeSession: async () => f.entry.nativeSessionPath})).rejects.toThrow(/identity/);
});

it('keeps deleted retained conversations inactive even when their native file is gone', async () => {
  const f = fixture();
  const verifyNative = vi.fn(async () => {throw new Error('Native file is gone');});
  const provider = {fetchIndex: async () => ({sessions: [], deletedSessionIds: [f.entry.id]}), pushChange: vi.fn()} as any;
  await expect(confirmContinuationOwnership(provider, f.entry, 'coder-one', f.entry.provider, verifyNative)).resolves.toBe('deleted');
  expect(verifyNative).not.toHaveBeenCalled();
  expect(provider.pushChange).not.toHaveBeenCalled();
});

it('checks the tombstone before validating or upgrading a legacy retained history', async () => {
  const f = fixture();
  f.store.get.mockResolvedValue({id: f.entry.id, provider: f.entry.provider, providerSessionId: f.entry.providerSessionId,
    workspacePath: f.entry.workspaceId, metadata: {hostDeviceId: 'coder-one', remoteWorkspacePath: f.entry.remoteWorkspacePath, remoteMigration: {id: 'move-one'}}});
  const verifyContinuationIdentity = vi.fn(async () => {});
  f.validate.mockRejectedValue(new Error('Native history is gone'));
  const confirm = vi.fn(async () => 'deleted' as const);
  await expect(importSessionContinuations({...f.input, store: {...f.store, verifyContinuationIdentity} as any, confirm})).resolves.toEqual({imported: 0, retained: 1, deleted: 1});
  expect(confirm).toHaveBeenCalledOnce();
  expect(f.validate).not.toHaveBeenCalled();
  expect(verifyContinuationIdentity).not.toHaveBeenCalled();
});

it('never transfers ownership if native verification fails before handoff', async () => {
  const f = fixture();
  const provider = {fetchIndex: async () => ({sessions: [{sessionId: f.entry.id, projectId: f.entry.workspaceId}]}), pushChange: vi.fn()} as any;
  await expect(confirmContinuationOwnership(provider, f.entry, 'coder-one', f.entry.provider, async () => {throw new Error('Native file is gone');})).rejects.toThrow('Native file is gone');
  expect(provider.pushChange).not.toHaveBeenCalled();
});

it.each(['unrelated', 'late', 'foreign-cwd'])('rejects %s inherited metadata in a Codex fork', async kind => {
  const f = await nativeFixture();
  const header = {type: 'session_meta', payload: {id: 'native-thread', cwd: '/mac/foss', forked_from_id: 'parent'}};
  const parent = {type: 'session_meta', payload: {id: kind === 'unrelated' ? 'stranger' : 'parent', cwd: kind === 'foreign-cwd' ? '/foreign' : '/mac/foss'}};
  const body = {type: 'response_item', payload: {type: 'message', role: 'user', content: []}};
  const content = (kind === 'late' ? [header, body, parent] : [header, parent, body]).map(row => JSON.stringify(row) + '\n').join('');
  await writeFile(f.entry.nativeSessionPath, content);
  f.entry.nativeSessionSha256 = createHash('sha256').update(content).digest('hex');
  await expect(validateSessionContinuation(f.entry as any, f.mapping, f.directory, f.options)).rejects.toThrow(/identity/);
});

it('confirms ownership again after a restart without rewriting advanced native state', async () => {
  const f = fixture();
  const row = {sessionId: f.entry.id, projectId: f.entry.workspaceId, hostDeviceId: 'old-desktop', title: 'Edited remotely', isArchived: true};
  const pushChange = vi.fn(async (_id, change) => {Object.assign(row, change.metadata);return {published: true};});
  const provider = {fetchIndex: vi.fn(async () => ({sessions: [row]})), getCachedIndexEntry: () => row, pushChange} as any;
  await confirmContinuationOwnership(provider, {...f.entry, sourceHostDeviceId: 'old-desktop'}, 'coder-one');
  expect(pushChange).toHaveBeenCalledWith(f.entry.id, {type: 'metadata_updated', metadata: {hostDeviceId: 'coder-one', workspaceId: f.entry.workspaceId}}, {isCurrent: expect.any(Function)});
  expect(row).toMatchObject({title: 'Edited remotely', isArchived: true});
  pushChange.mockClear();
  await confirmContinuationOwnership(provider, f.entry, 'coder-one');
  expect(pushChange).not.toHaveBeenCalled();
});

it.each([{deletedSessionIds: []}, {deletedSessionIds: ['same-id']}])('never recreates an absent or deleted index row during import recovery (%j)', async ({deletedSessionIds}) => {
  const f = fixture();
  const pushChange = vi.fn();
  const confirmation = confirmContinuationOwnership({fetchIndex: async () => ({sessions: [], deletedSessionIds}), pushChange} as any, f.entry, 'coder-one');
  if (deletedSessionIds.length) await expect(confirmation).resolves.toBe('deleted');
  else await expect(confirmation).rejects.toThrow();
  expect(pushChange).not.toHaveBeenCalled();
});

it('rejects a changed manifest identity after an interrupted first handoff', async () => {
  const f = fixture();
  f.store.get.mockResolvedValue({id: f.entry.id, provider: 'openai-codex', providerSessionId: 'native-thread', workspacePath: f.entry.workspaceId,
    metadata: {hostDeviceId: 'coder-one', remoteWorkspacePath: f.entry.remoteWorkspacePath, remoteMigration: {id: 'move-one', originalProvider: 'openai-codex', originalProviderSessionId: 'native-thread'}}});
  f.input.entries[0] = {...f.entry, provider: 'claude-code', providerSessionId: 'different-thread'};
  await expect(importSessionContinuations(f.input)).rejects.toThrow(/identity|conversation|migration/i);
  expect(f.input.confirm).not.toHaveBeenCalled();
});

it.each([{isExecuting: true}, {queuedPromptCount: 1}, {pendingExecution: {messageId: 'pending'}}])('rejects a source that becomes busy while ownership publication is pending (%j)', async busy => {
  const f = fixture();
  const row = {sessionId: f.entry.id, projectId: f.entry.workspaceId};
  const provider = {fetchIndex: async () => ({sessions: [row]}), getCachedIndexEntry: () => row,
    pushChange: async (_id, _change, options) => {Object.assign(row, busy);const published = options.isCurrent();if (published) Object.assign(row, {hostDeviceId: 'coder-one'});return {published};}} as any;
  await expect(confirmContinuationOwnership(provider, f.entry, 'coder-one')).rejects.toThrow(/not published/);
});

it('rejects a handoff whose server read-back does not confirm ownership', async () => {
  const f = fixture();
  const row = {sessionId: f.entry.id, projectId: f.entry.workspaceId};
  await expect(confirmContinuationOwnership({fetchIndex: async () => ({sessions: [row]}), pushChange: async () => ({published: true})} as any, f.entry, 'coder-one')).rejects.toThrow(/not confirmed/);
});

it('cancels an ownership handoff when a tombstone arrives during publication', async () => {
  const f = fixture();
  const row = {sessionId: f.entry.id, projectId: f.entry.workspaceId};
  let remove!: (id: string) => void;
  const provider = {
    fetchIndex: async () => ({sessions: [row]}),
    onIndexDelete: callback => {remove = callback;return () => {};},
    pushChange: async (_id, _change, options) => {remove(f.entry.id);return {published: options.isCurrent()};},
  } as any;
  await expect(confirmContinuationOwnership(provider, f.entry, 'coder-one')).resolves.toBe('deleted');
});

it('keeps a deleted migration inactive while confirming the other conversations on restart', async () => {
  const f = fixture();
  const other = {...f.entry, id: 'other', providerSessionId: 'other-native-thread'};
  f.input.entries.push(other);
  const confirm = vi.fn(async entry => entry.id === 'same-id' ? 'deleted' as const : 'confirmed' as const);
  await expect(importSessionContinuations({...f.input, confirm})).resolves.toEqual({imported: 2, retained: 0, deleted: 1});
  expect(confirm).toHaveBeenCalledWith(other);
});

it('refuses ownership when the index advertises a different provider', async () => {
  const f = fixture();
  const provider = {fetchIndex: async () => ({sessions: [{sessionId: f.entry.id, projectId: f.entry.workspaceId, hostDeviceId: 'coder-one', provider: 'claude-code'}]}), pushChange: vi.fn()} as any;
  await expect(confirmContinuationOwnership(provider, f.entry, 'coder-one')).rejects.toThrow(/provider/);
  expect(provider.pushChange).not.toHaveBeenCalled();
});

it.each([
  {hostDeviceId: 'coder-one', expected: true},
  {hostDeviceId: 'previous-host', expected: false},
  {hostDeviceId: undefined, expected: false},
  {hostDeviceId: 'coder-one', isArchived: true, expected: false},
])('requires positive current execution ownership (%j)', async ({expected, ...state}) => {
  const row = {sessionId: 'same-id', projectId: '/project', ...state};
  const provider = {getVerifiedSessionOwnership: () => row, isIndexReady: () => true, getCachedIndexEntry: () => row} as any;
  expect(await ownsSessionExecution(provider, 'same-id', '/project', 'coder-one')).toBe(expected);
});

it('does not authorize a turn from a stale index cache after reconnect', async () => {
  let generation = 1;
  const provider = {isIndexReady: () => true, getConnectionGeneration: () => generation, getVerifiedSessionOwnership: () => {generation++;return {projectId: '/project', hostDeviceId: 'coder-one'};}} as any;
  expect(await ownsSessionExecution(provider, 'same-id', '/project', 'coder-one')).toBe(false);
});

it.each([false, undefined])('never authorizes a turn from an unverified cache (ready=%s)', async ready => {
  const provider = {isIndexReady: () => ready, getCachedIndexEntry: () => ({sessionId: 'same-id', projectId: '/project', hostDeviceId: 'coder-one'})} as any;
  expect(await ownsSessionExecution(provider, 'same-id', '/project', 'coder-one')).toBe(false);
});

it.each([{hostDeviceId: 'unexpected'}, {isExecuting: true}, {queuedPrompts: [{id: 'queued'}]}])('refuses an unsafe source handoff (%j)', async extra => {
  const f = fixture();
  const pushChange = vi.fn();
  const provider = {fetchIndex: async () => ({sessions: [{sessionId: f.entry.id, projectId: f.entry.workspaceId, ...extra}]}), pushChange} as any;
  await expect(confirmContinuationOwnership(provider, f.entry, 'coder-one')).rejects.toThrow();
  expect(pushChange).not.toHaveBeenCalled();
});
