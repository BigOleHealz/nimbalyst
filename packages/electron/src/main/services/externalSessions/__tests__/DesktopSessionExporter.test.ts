// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { DesktopSessionExporter, desktopExportId } from '../DesktopSessionExporter';
import { ClaudeCodeSource } from '../ClaudeCodeSource';
import { CodexSource } from '../CodexSource';

let dir: string;
const session = {
  id: 'local-session', title: 'Inspect the project', workspacePath: '/workspace/project',
  createdAt: Date.parse('2026-10-01T12:00:00Z'),
  messages: [{ role: 'user' as const, text: 'Inspect the project', timestamp: '2026-10-01T12:00:00Z' },
    { role: 'assistant' as const, text: 'Found the entry point.', timestamp: '2026-10-01T12:00:01Z' }],
};
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-export-')); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it.each(['claude-code', 'openai-codex'] as const)('skips absent %s data without creating it', async provider => {
  const exporter = new DesktopSessionExporter({ claudeRoot: path.join(dir, 'claude'), codexRoot: path.join(dir, 'codex') });
  expect(await exporter.export(provider, session)).toMatchObject({ status: 'unavailable' });
  expect(await fs.readdir(dir)).toEqual([]);
});

it.each(['claude-code', 'openai-codex'] as const)('exports %s once, appends only new messages, and survives restart', async provider => {
  const root = path.join(dir, provider);
  await fs.mkdir(root);
  const options = { claudeRoot: root, codexRoot: root };
  const result = await new DesktopSessionExporter(options).export(provider, session);
  expect(result).toMatchObject({ status: 'synced', sessionId: desktopExportId(provider, session.id, session.workspacePath) });
  const first = await fs.readFile(result.filePath!, 'utf8');
  expect(first).toContain('Found the entry point.');
  expect(await new DesktopSessionExporter(options).export(provider, session)).toMatchObject({ status: 'unchanged' });
  expect(await fs.readFile(result.filePath!, 'utf8')).toBe(first);
  const updated = { ...session, title: 'New name', messages: [...session.messages, { role: 'user' as const, text: 'Continue', timestamp: '2026-10-01T12:01:00Z' }] };
  expect(await new DesktopSessionExporter(options).export(provider, updated)).toMatchObject({ status: 'synced' });
  const next = await fs.readFile(result.filePath!, 'utf8');
  expect(next.startsWith(first)).toBe(true);
  const messages = next.trim().split('\n').map(line => JSON.parse(line)).filter(row => provider === 'claude-code' ? row.type === 'user' : row.type === 'response_item' && row.payload.role === 'user');
  expect(messages.filter(row => JSON.stringify(row).includes('Continue'))).toHaveLength(1);
  // Our own exports must never feed back into Nimbalyst's external importer.
  const source = provider === 'claude-code' ? new ClaudeCodeSource({ rootDir: path.join(root, 'projects') }) : new CodexSource({ rootDir: path.join(root, 'sessions') });
  try { expect((await source.discoverPage(session.workspacePath)).sessions).toEqual([]); }
  finally { await source.dispose(); }
});

it.each(['claude-code', 'openai-codex'] as const)('preserves %s conversations continued externally or changed at the source', async provider => {
  await fs.mkdir(path.join(dir, provider));
  const exporter = new DesktopSessionExporter({ claudeRoot: path.join(dir, provider), codexRoot: path.join(dir, provider) });
  const result = await exporter.export(provider, session);
  expect(await exporter.export(provider, { ...session, messages: [{ ...session.messages[0], text: 'Rewritten' }] })).toMatchObject({ status: 'conflict' });
  await fs.appendFile(result.filePath!, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Desktop continuation' } }) + '\n');
  const continued = await fs.readFile(result.filePath!, 'utf8');
  expect(await exporter.export(provider, session)).toMatchObject({ status: 'conflict' });
  expect(await fs.readFile(result.filePath!, 'utf8')).toBe(continued);
});

it('refuses symlinked export destinations', async () => {
  const root = path.join(dir, 'claude');
  await fs.mkdir(root);
  await fs.symlink(dir, path.join(root, 'projects'));
  await expect(new DesktopSessionExporter({ claudeRoot: root, codexRoot: dir }).export('claude-code', session)).rejects.toThrow(/symbolic|symlink/i);
});
