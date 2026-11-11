import {createReadStream, realpathSync, statSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createInterface} from 'node:readline';
import * as path from 'node:path';
import type {SessionContinuation} from './sessionContinuations.js';
import {confineCheckout} from './repoCheckout.js';
import type {WorkspaceMapping} from './workspaces.js';

/** Re-check the mapped project on every resumed turn, including symlink targets. */
export function confineContinuationWorkspace(workspacePath: string, mapping: WorkspaceMapping, checkoutRoot: string): string {
  const workspace = realpathSync(workspacePath);
  confineCheckout({...mapping, checkoutDir: workspace}, {checkoutRoot: realpathSync(checkoutRoot)});
  const project = realpathSync(mapping.checkoutDir);
  const relative = path.relative(project, workspace);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !statSync(workspace).isDirectory()) {
    throw new Error('Continuation workspace is outside its mapped project.');
  }
  return workspace;
}

export async function validateSessionContinuation(entry: SessionContinuation, mapping: WorkspaceMapping, checkoutRoot: string): Promise<void> {
  confineContinuationWorkspace(entry.remoteWorkspacePath, mapping, checkoutRoot);
  if (!path.isAbsolute(entry.nativeSessionPath) || !entry.nativeSessionPath.endsWith('.jsonl')) throw new Error('Invalid native conversation path.');
  if (!/^[a-f0-9]{64}$/i.test(entry.nativeSessionSha256) || !statSync(entry.nativeSessionPath).isFile()) throw new Error('Invalid native conversation verification data.');
  const hash = createHash('sha256');
  const stream = createReadStream(entry.nativeSessionPath);
  stream.on('data', chunk => hash.update(chunk));
  const lines = createInterface({input: stream, crlfDelay: Infinity});
  let identified = false;
  let inheritedHeader: {id: string; cwd: unknown} | undefined;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as {type?: string; sessionId?: unknown; payload?: {id?: unknown; cwd?: unknown; forked_from_id?: unknown}};
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
    if (!identified || hash.digest('hex').toLowerCase() !== entry.nativeSessionSha256.toLowerCase()) throw new Error(`Native conversation verification failed for ${entry.id}.`);
  } finally {
    lines.close();
    stream.destroy();
  }
}
