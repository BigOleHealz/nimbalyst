import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { JsonRpcClient } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/jsonRpcClient';
import { resolveCodexBinaryPath, getCodexVendorPathEntries } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/codexAppServerBinary';
import { resolvePackagedCodexBinaryPath } from '@nimbalyst/runtime/ai/server/providers/codex/codexBinaryPath';
import { desktopExportId } from './DesktopSessionExporter';
import type { CodexProjectSession } from './DesktopSessionSyncService';

interface CodexProject { id: string; roots: Array<{ path: string }> }
interface ProjectPage { data: CodexProject[]; nextCursor: string | null }

/** Use Codex's native API; never write its SQLite database or desktop state JSON. No model turn is started. */
export async function publishCodexProjects(sessions: CodexProjectSession[], codexRoot: string, projectPaths: string[] = []): Promise<void> {
  try { codexRoot = await fs.realpath(codexRoot); if (!(await fs.lstat(codexRoot)).isDirectory()) return; }
  catch (error: any) { if (error.code === 'ENOENT') return; throw error; }
  const binary = resolveCodexBinaryPath(() => resolvePackagedCodexBinaryPath());
  const platformEnv = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
  const child = spawn(binary, ['app-server', '--listen', 'stdio://'], {
    env: { ...platformEnv, CODEX_HOME: codexRoot, PATH: [...getCodexVendorPathEntries(binary), process.env.PATH ?? ''].join(path.delimiter) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const client = new JsonRpcClient(child, { defaultTimeoutMs: 15_000 });
  try {
    await client.request('initialize', { clientInfo: { name: 'nimbalyst_desktop_sync', version: '1' }, capabilities: { experimentalApi: true } });
    client.notify('initialized', {});
    const projects: CodexProject[] = [];
    let cursor: string | null = null;
    do {
      const page: ProjectPage = await client.request<ProjectPage>('project/list', { cursor, limit: 100 });
      projects.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    for (const workspacePath of new Set([...projectPaths, ...sessions.map(session => session.projectPath ?? session.workspacePath)])) {
      const members = sessions.filter(session => (session.projectPath ?? session.workspacePath) === workspacePath);
      const matches = projects.filter(project => project.roots.some(root => path.resolve(root.path) === path.resolve(workspacePath)));
      if (matches.length > 1) throw new Error('Multiple Codex projects own the same workspace');
      const project = matches[0] ?? (await client.request<{ project: (typeof projects)[number] }>('project/create', {
        name: path.basename(workspacePath), roots: [{ path: workspacePath }],
        idempotencyKey: desktopExportId('project', workspacePath, workspacePath), metadata: { source: 'nimbalyst' },
      })).project;
      for (const session of members) {
        await client.request('thread/read', { threadId: session.sessionId, includeTurns: false });
        await client.request('thread/metadata/update', { threadId: session.sessionId, projectId: project.id });
        await client.request('thread/name/set', { threadId: session.sessionId, name: `${session.title} (Nimbalyst)` });
      }
    }
  } finally { client.close(); child.stdin.end(); child.kill(); }
}
