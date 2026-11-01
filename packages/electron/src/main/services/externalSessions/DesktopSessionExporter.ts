import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { ExternalSessionProviderId } from '../../../shared/externalSessions';

export interface DesktopMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
}
export interface DesktopExportSession {
  id: string;
  title: string;
  workspacePath: string;
  projectPath?: string;
  createdAt: number;
  messages: DesktopMessage[];
}
export interface DesktopExportResult {
  status: 'synced' | 'unchanged' | 'unavailable' | 'conflict';
  sessionId?: string;
  filePath?: string;
}

/** Separate identities keep a portable conversation from changing the original provider thread. */
export function desktopExportId(provider: string, id: string, workspace: string): string {
  const hash = createHash('sha256').update(JSON.stringify(['nimbalyst-desktop-v1', provider, workspace, id])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
const hashMessages = (messages: DesktopMessage[]) => createHash('sha256').update(JSON.stringify(messages.map(({ role, text }) => [role, text]))).digest('hex');
const MAX_EXPORT_BYTES = 32 * 1024 * 1024;

/** Only append to our own unchanged prefix. A desktop continuation permanently takes ownership. */
export class DesktopSessionExporter {
  constructor(private readonly roots: { claudeRoot: string; codexRoot: string }) {}

  async export(provider: ExternalSessionProviderId, input: DesktopExportSession): Promise<DesktopExportResult> {
    if (!path.isAbsolute(input.workspacePath) || !Number.isFinite(input.createdAt)) throw new Error('Invalid desktop export workspace or date');
    let workspacePath = input.workspacePath;
    try { workspacePath = await fs.realpath(workspacePath); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    const session = { ...input, workspacePath };
    let root = provider === 'claude-code' ? this.roots.claudeRoot : this.roots.codexRoot;
    try { root = await fs.realpath(root); if (!(await fs.lstat(root)).isDirectory()) return { status: 'unavailable' }; }
    catch (error: any) { if (error.code === 'ENOENT') return { status: 'unavailable' }; throw error; }
    const sessionId = desktopExportId(provider, session.id, session.workspacePath);
    const date = new Date(session.createdAt).toISOString();
    const directory = provider === 'claude-code'
      ? path.join(root, 'projects', session.workspacePath.replace(/[^a-zA-Z0-9]/g, '-'))
      : path.join(root, 'sessions', ...date.slice(0, 10).split('-'));
    await this.directory(root, directory);
    const filePath = path.join(directory, provider === 'claude-code' ? `${sessionId}.jsonl` : `rollout-${date.slice(0, 19).replace(/:/g, '-')}-${sessionId}.jsonl`);
    const identity = { sessionId, filePath };
    const owner = desktopExportId('owner', session.id, session.workspacePath);
    let existing = '';
    let previousCount = 0;
    let previousTitle: string | undefined;
    let handle: fs.FileHandle;
    try { handle = await fs.open(filePath, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_APPEND, 0o600); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      handle = await fs.open(filePath, constants.O_RDWR | constants.O_APPEND | constants.O_NOFOLLOW);
    }
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_EXPORT_BYTES) throw new Error('Desktop export exceeds the supported file size');
      existing = await handle.readFile('utf8');
      if (existing) {
        try {
          if (!existing.endsWith('\n')) return { status: 'conflict', ...identity };
          const records = existing.trimEnd().split('\n').map(line => JSON.parse(line));
          if (records.some(row => row.nimbalystExport?.owner !== owner)) return { status: 'conflict', ...identity };
          const last = records.at(-1).nimbalystExport;
          const saved: DesktopMessage[] = records.flatMap(row => {
            const message = provider === 'claude-code' ? row.message : row.type === 'response_item' ? row.payload : null;
            if (!message || !['user', 'assistant'].includes(message.role)) return [];
            const text = typeof message.content === 'string' ? message.content : message.content.map((block: { text: string }) => block.text).join('');
            return [{ role: message.role, text, timestamp: '' }];
          });
          previousCount = last.count;
          previousTitle = last.title;
          if (!Number.isSafeInteger(previousCount) || previousCount < 0 || previousCount !== saved.length || previousCount > session.messages.length || last.hash !== hashMessages(saved) || last.hash !== hashMessages(session.messages.slice(0, previousCount))) return { status: 'conflict', ...identity };
        } catch { return { status: 'conflict', ...identity }; }
      }
      if (existing && previousCount === session.messages.length && previousTitle === session.title) return { status: 'unchanged', ...identity };
      const marker = { version: 1, owner, count: session.messages.length, hash: hashMessages(session.messages), title: session.title };
      const records: Record<string, unknown>[] = [];
      if (!existing && provider === 'openai-codex') records.push({
        timestamp: date, type: 'session_meta', payload: { id: sessionId, timestamp: date, cwd: session.workspacePath, originator: 'nimbalyst', cli_version: '0.0.0', source: 'cli', model_provider: 'openai', base_instructions: null },
      });
      let parentUuid: string | null = previousCount ? desktopExportId(provider, `${session.id}:${previousCount - 1}`, session.workspacePath) : null;
      for (let index = previousCount; index < session.messages.length; index++) {
        const message = session.messages[index];
        const uuid = desktopExportId(provider, `${session.id}:${index}`, session.workspacePath);
        if (provider === 'claude-code') {
          records.push({ type: message.role, uuid, parentUuid, sessionId, cwd: session.workspacePath, timestamp: message.timestamp, isSidechain: false, userType: 'external', version: '2.1.0',
            message: message.role === 'user' ? { role: 'user', content: message.text } : { id: uuid, type: 'message', role: 'assistant', model: '<synthetic>', content: [{ type: 'text', text: message.text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
          });
        } else {
          if (message.role === 'user') records.push({ timestamp: message.timestamp, type: 'event_msg', payload: { type: 'user_message', message: message.text, images: [], local_images: [], text_elements: [] } });
          records.push({ timestamp: message.timestamp, type: 'response_item', payload: { type: 'message', role: message.role, content: [{ type: message.role === 'user' ? 'input_text' : 'output_text', text: message.text }], ...(message.role === 'assistant' ? { phase: 'final_answer' } : {}) } });
          if (message.role === 'assistant') records.push({ timestamp: message.timestamp, type: 'event_msg', payload: { type: 'agent_message', message: message.text, phase: 'final_answer' } });
        }
        parentUuid = uuid;
      }
      if (provider === 'claude-code') records.push({ type: 'custom-title', customTitle: `${session.title} (Nimbalyst)`, sessionId });
      else records.push({ timestamp: date, type: 'event_msg', payload: { type: 'task_complete', turn_id: sessionId, last_agent_message: null } });
      const added = records.map(record => JSON.stringify({ ...record, nimbalystExport: marker }) + '\n').join('');
      if (Buffer.byteLength(existing) + Buffer.byteLength(added) > MAX_EXPORT_BYTES) throw new Error('Desktop export exceeds the supported file size');
      const currentPath = await fs.lstat(filePath);
      if (currentPath.isSymbolicLink() || currentPath.ino !== before.ino || (await handle.stat()).size !== before.size) return { status: 'conflict', ...identity };
      await handle.writeFile(added);
      await handle.sync();
    } finally { await handle.close(); }
    return { status: 'synced', ...identity };
  }

  private async directory(root: string, target: string): Promise<void> {
    let current = root;
    for (const part of path.relative(root, target).split(path.sep)) {
      current = path.join(current, part);
      try { await fs.mkdir(current, { mode: 0o700 }); }
      catch (error: any) { if (error.code !== 'EEXIST') throw error; }
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Refusing symbolic link in desktop export path');
    }
  }
}
