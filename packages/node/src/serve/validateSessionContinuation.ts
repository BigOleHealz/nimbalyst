import {createReadStream, realpathSync, statSync, openSync, closeSync, fstatSync, readdirSync, existsSync} from 'node:fs';
import type {Stats} from 'node:fs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import * as path from 'node:path';
import type {SessionContinuation} from './sessionContinuations.js';
import {confineCheckout} from './repoCheckout.js';
import type {WorkspaceMapping} from './workspaces.js';
import {execFileSync} from 'node:child_process';
import {buildCoderServerEnvironment} from '../host/coderGitHubAuth.js';
import {resolveNativeConversation} from './nativeConversation.js';

function repositoryIdentity(directory: string): {root: string; common: string; origin?: string} {
  const git = (...args: string[]) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', directory, ...args], {
    env: buildCoderServerEnvironment(process.env), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000,
  }).trim();
  try {
    const root = realpathSync(git('rev-parse', '--show-toplevel'));
    const common = realpathSync(path.resolve(directory, git('rev-parse', '--git-common-dir')));
    let origin: string | undefined;
    try { origin = normalizeOrigin(git('config', '--get', 'remote.origin.url')); } catch { /* Local-only worktrees share their common dir. */ }
    return {root, common, origin};
  } catch { throw new Error('Continuation workspace does not contain its mapped repository.'); }
}

function normalizeOrigin(value: string): string | undefined {
  const scp = /^([^/@]+@)?([^/:]+):(.+)$/.exec(value);
  try {
    const url = new URL(scp && !value.includes('://') ? `ssh://${scp[2]}/${scp[3]}` : value);
    if (!['https:', 'ssh:'].includes(url.protocol)) return undefined;
    const repository = url.pathname.replace(/\/+$/, '').replace(/\.git$/, '');
    return `${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${url.hostname.toLowerCase() === 'github.com' ? repository.toLowerCase() : repository}`;
  } catch { return undefined; }
}

function assertMappedRepository(directory: string, source: string, repoUrl?: string, requireRoot = false): void {
  const target = repositoryIdentity(directory);
  const mapped = repositoryIdentity(source);
  const expected = repoUrl ? normalizeOrigin(repoUrl) : mapped.origin;
  if (requireRoot && (target.root !== directory || mapped.root !== source)) throw new Error('Continuation is missing a mapped repository checkout.');
  if (target.common !== mapped.common && (!expected || target.origin !== expected)) throw new Error('Continuation repository does not belong to the mapped project.');
}

/** Re-check the mapped project on every resumed turn, including symlink targets. */
export function confineContinuationWorkspace(workspacePath: string, mapping: WorkspaceMapping, checkoutRoot: string): string {
  const workspace = realpathSync(workspacePath);
  confineCheckout({...mapping, checkoutDir: workspace}, {checkoutRoot: realpathSync(checkoutRoot)});
  const project = realpathSync(mapping.checkoutDir);
  const relative = path.relative(project, workspace);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !statSync(workspace).isDirectory()) {
    throw new Error('Continuation workspace is outside its mapped project.');
  }
  if (mapping.repositoryPaths) {
    if (!mapping.repositoryPaths.length || new Set(mapping.repositoryPaths.map(source => path.basename(source))).size !== mapping.repositoryPaths.length) throw new Error('Invalid mapped project repositories.');
    const sources = mapping.repositoryPaths.map(source => {
      const canonical = realpathSync(source);
      const sourceRelative = path.relative(project, canonical);
      if (sourceRelative === '..' || sourceRelative.startsWith(`..${path.sep}`) || path.isAbsolute(sourceRelative)) throw new Error('Mapped repository is outside its project.');
      return {source, canonical};
    });
    // Some existing sessions execute inside one repository's worktree rather
    // than the multi-repository container. Preserve that exact execution cwd.
    let workspaceRepository: ReturnType<typeof repositoryIdentity> | undefined;
    try { workspaceRepository = repositoryIdentity(workspace); } catch { /* Container root. */ }
    const matchesMappedRepository = workspaceRepository && sources.some(({canonical}) => {
      const mapped = repositoryIdentity(canonical);
      return workspaceRepository!.common === mapped.common || (!!mapped.origin && workspaceRepository!.origin === mapped.origin);
    });
    if (workspaceRepository?.root === workspace) {
      if (matchesMappedRepository) return workspace;
      if (workspace !== project) throw new Error('Continuation repository does not belong to the mapped project.');
    }
    if (workspaceRepository && !matchesMappedRepository) {
      let projectRepository: ReturnType<typeof repositoryIdentity> | undefined;
      try {projectRepository = repositoryIdentity(project);} catch { /* Non-Git project container. */ }
      if (workspaceRepository.common !== projectRepository?.common) throw new Error('Continuation container is inside an unmapped repository.');
    }
    const byName = new Map(sources.map(source => [path.basename(source.source), source]));
    const repositories = readdirSync(workspace).filter(name => byName.has(name) || existsSync(path.join(workspace, name, '.git')));
    if (!repositories.length) throw new Error('Continuation workspace has no mapped repository checkouts.');
    for (const name of repositories) {
      const source = byName.get(name);
      if (!source) throw new Error('Continuation repository does not belong to the mapped project.');
      const target = realpathSync(path.join(workspace, name));
      const targetRelative = path.relative(workspace, target);
      if (targetRelative === '..' || targetRelative.startsWith(`..${path.sep}`) || path.isAbsolute(targetRelative)) throw new Error('Continuation repository is outside its workspace.');
      assertMappedRepository(target, source.canonical, undefined, true);
    }
  } else assertMappedRepository(workspace, project, mapping.repoUrl);
  return workspace;
}

export interface ContinuationValidationOptions {
  allowAppendedHistory?: boolean;
  nativeEnvironment?: NodeJS.ProcessEnv;
  resolveNativeSession?(entry: SessionContinuation): Promise<string>;
}

export async function validateSessionContinuation(entry: SessionContinuation, mapping: WorkspaceMapping, checkoutRoot: string, options: ContinuationValidationOptions = {}): Promise<void> {
  confineContinuationWorkspace(entry.remoteWorkspacePath, mapping, checkoutRoot);
  if (typeof entry.nativeSessionSha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.nativeSessionSha256)) throw new Error('Invalid native conversation verification data.');
  await validateNativeHistory(entry, options, entry.nativeSessionSha256);
}

/** A retained row may have advanced to a new native thread. Inspect that live
 * identity without overwriting it or comparing it to an obsolete snapshot. */
export async function validateRetainedContinuation(entry: SessionContinuation, current: {
  provider: string; providerSessionId?: string | null;
}, mapping: WorkspaceMapping, checkoutRoot: string, options: ContinuationValidationOptions = {}): Promise<void> {
  confineContinuationWorkspace(entry.remoteWorkspacePath, mapping, checkoutRoot);
  if (!['openai-codex', 'claude-code'].includes(current.provider) || !current.providerSessionId) throw new Error('The retained native conversation identity is unavailable.');
  if (current.provider === entry.provider && current.providerSessionId === entry.providerSessionId) {
    await validateSessionContinuation(entry, mapping, checkoutRoot, {...options, allowAppendedHistory: true});
  } else {
    const live = {...entry, provider: current.provider, providerSessionId: current.providerSessionId};
    const nativeSessionPath = await (options.resolveNativeSession?.(live) ?? resolveNativeConversation(live, options.nativeEnvironment));
    await validateNativeHistory({...live, nativeSessionPath}, {...options, resolveNativeSession: async () => nativeSessionPath});
  }
}

async function validateNativeHistory(entry: SessionContinuation, options: ContinuationValidationOptions, checksum?: string): Promise<void> {
  if (!path.isAbsolute(entry.nativeSessionPath) || !entry.nativeSessionPath.endsWith('.jsonl')) throw new Error('Invalid native conversation path.');
  if (checksum !== undefined && !/^[a-f0-9]{64}$/i.test(checksum)) throw new Error('Invalid native conversation verification data.');
  const nativePath = realpathSync(entry.nativeSessionPath);
  const snapshot = statSync(nativePath);
  if (!snapshot.isFile()) throw new Error('Invalid native conversation verification data.');
  const discovered = await (options.resolveNativeSession?.(entry) ?? resolveNativeConversation(entry, options.nativeEnvironment));
  if (realpathSync(discovered) !== nativePath || realpathSync(entry.nativeSessionPath) !== nativePath) throw new Error('The provider discovers a different native conversation file.');
  const unchanged = (state: Stats) => state.dev === snapshot.dev && state.ino === snapshot.ino && state.size === snapshot.size && state.mtimeMs === snapshot.mtimeMs && state.ctimeMs === snapshot.ctimeMs;
  const fd = openSync(nativePath, 'r');
  if (!unchanged(fstatSync(fd))) {closeSync(fd); throw new Error('The native conversation changed during verification.');}
  const hash = createHash('sha256');
  let verifiedPrefix = false;
  const stream = createReadStream(nativePath, {fd, autoClose: false});
  stream.on('data', chunk => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    let offset = 0;
    if (checksum && options.allowAppendedHistory && !verifiedPrefix) {
      for (let end = bytes.indexOf(10); end !== -1; end = bytes.indexOf(10, offset)) {
        hash.update(bytes.subarray(offset, end + 1));
        offset = end + 1;
        if (hash.copy().digest('hex').toLowerCase() === checksum.toLowerCase()) {verifiedPrefix = true; break;}
      }
    }
    hash.update(bytes.subarray(offset));
  });
  const lines = createInterface({input: stream, crlfDelay: Infinity});
  let identified = false;
  let inheritedHeader: {id: string; cwd: unknown} | undefined;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row: {type?: string; sessionId?: unknown; payload?: {id?: unknown; cwd?: unknown; forked_from_id?: unknown}};
      try {
        row = JSON.parse(line);
        if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
      } catch { throw new Error('Invalid native conversation JSON.'); }
      if (entry.provider === 'openai-codex') {
        if (!identified) {
          if (row.type !== 'session_meta' || !row.payload || row.payload.id !== entry.providerSessionId) throw new Error('Native conversation identity does not match the continuation.');
          identified = true;
          if (typeof row.payload.forked_from_id === 'string' && row.payload.forked_from_id) inheritedHeader = {id: row.payload.forked_from_id, cwd: row.payload.cwd};
          continue;
        }
        if (row.type === 'session_meta' && row.payload?.id !== entry.providerSessionId &&
          !(inheritedHeader && row.payload?.id === inheritedHeader.id && row.payload.cwd === inheritedHeader.cwd)) throw new Error('Native conversation identity changed inside the rollout.');
        inheritedHeader = undefined;
        continue;
      }
      const nativeId = row.sessionId;
      if (nativeId !== undefined) {
        if (nativeId !== entry.providerSessionId) throw new Error('Native conversation identity does not match the continuation.');
        identified = true;
      }
    }
    if (!identified || (checksum && !verifiedPrefix && hash.digest('hex').toLowerCase() !== checksum.toLowerCase())) throw new Error(`Native conversation verification failed for ${entry.id}.`);
    if (!unchanged(fstatSync(fd)) || !unchanged(statSync(nativePath)) || realpathSync(entry.nativeSessionPath) !== nativePath) throw new Error('The native conversation changed during verification.');
  } finally {
    lines.close();
    // ReadStream owns the descriptor after construction, including when its
    // async iterator destroys it on a parse error. Wait for that single close.
    await new Promise<void>(resolve => stream.close(() => resolve()));
  }
}
