// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { JsonRpcClient } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/jsonRpcClient';
import { resolveCodexBinaryPath } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/codexAppServerBinary';
import { DesktopSessionExporter } from '../DesktopSessionExporter';
import { publishCodexProjects } from '../publishCodexProjects';

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-native-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
const conversation = [{ role: 'user' as const, text: 'Find the entry point.', timestamp: '2026-10-01T12:00:00Z' }, { role: 'assistant' as const, text: 'The entry point is main.ts.', timestamp: '2026-10-01T12:00:01Z' }];

it('Codex lists and reads both roles, keeps project membership, and finds appended history after restart without any model call', async () => {
  const root = path.join(dir, 'codex');
  await fs.mkdir(root);
  const session = { id: 's', title: 'Entry point', workspacePath: dir, createdAt: Date.parse(conversation[0].timestamp), messages: conversation };
  const exporter = new DesktopSessionExporter({ codexRoot: root, claudeRoot: '' });
  const exported = await exporter.export('openai-codex', session);
  const member = { sessionId: exported.sessionId!, workspacePath: dir, title: session.title };
  const alias = path.join(dir, 'codex-home-link');
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await publishCodexProjects([member], alias);
  const read = async () => {
    const child = spawn(resolveCodexBinaryPath(), ['app-server', '--listen', 'stdio://'], { env: { PATH: process.env.PATH, HOME: dir, CODEX_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.resume();
    const client = new JsonRpcClient(child, { defaultTimeoutMs: 5000 });
    try {
      await client.request('initialize', { clientInfo: { name: 'nimbalyst_test', version: '1' }, capabilities: { experimentalApi: true } });
      client.notify('initialized', {});
      const projects = await client.request<any>('project/list', {});
      expect(projects.data).toHaveLength(1);
      const threads = await client.request<any>('thread/list', { projectId: projects.data[0].id });
      expect(threads.data.map((thread: any) => thread.id)).toContain(exported.sessionId);
      return await client.request<any>('thread/read', { threadId: exported.sessionId, includeTurns: true });
    } finally { client.close(); child.stdin.end(); child.kill(); }
  };
  let native = await read();
  expect(native.thread.turns.flatMap((turn: any) => turn.items).map((item: any) => item.type)).toEqual(['userMessage', 'agentMessage']);
  const next = { ...session, title: 'Renamed', messages: [...conversation, { role: 'user' as const, text: 'Continue.', timestamp: '2026-10-01T12:01:00Z' }] };
  await exporter.export('openai-codex', next);
  await publishCodexProjects([{ ...member, title: next.title }], root);
  native = await read();
  expect(JSON.stringify(native.thread.turns)).toContain('Continue.');
  expect(native.thread.name).toBe('Renamed (Nimbalyst)');
});

it('Claude native /resume discovery and its conversation reader accept the exported parent chain', async () => {
  const root = path.join(dir, 'claude');
  await fs.mkdir(root);
  const session = { id: 's', title: 'Entry point', workspacePath: dir, createdAt: Date.parse(conversation[0].timestamp), messages: conversation };
  const exporter = new DesktopSessionExporter({ codexRoot: '', claudeRoot: root });
  const exported = await exporter.export('claude-code', session);
  await exporter.export('claude-code', { ...session, title: 'Renamed', messages: [...conversation, { role: 'user', text: 'Continue.', timestamp: '2026-10-01T12:01:00Z' }] });
  const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  const script = `const sdk = await import(${JSON.stringify(sdk)}); console.log(JSON.stringify({sessions:await sdk.listSessions({dir:${JSON.stringify(dir)},includeProgrammatic:false}),messages:await sdk.getSessionMessages(${JSON.stringify(exported.sessionId)},{dir:${JSON.stringify(dir)}})}));`;
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, HOME: dir, CLAUDE_CONFIG_DIR: root } });
  const native = JSON.parse(stdout);
  expect(native.sessions).toHaveLength(1);
  expect(native.sessions[0].customTitle).toBe('Renamed (Nimbalyst)');
  expect(native.messages.map((message: any) => message.type)).toEqual(['user', 'assistant', 'user']);
  expect(native.messages[1].message.content).toEqual([{ type: 'text', text: conversation[1].text }]);
  expect(native.messages[2].message.content).toBe('Continue.');
});
