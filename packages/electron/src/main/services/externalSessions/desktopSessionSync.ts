import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { TranscriptMigrationRepository } from '@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { resolveClaudeConfigDir } from '@nimbalyst/runtime/ai/server/providers/claudeCode/claudeConfigDir';
import { getAllSessionsForSync } from '../PGLiteSessionStore';
import { getRecentItems } from '../../utils/store';
import { getSettingsService } from '../SettingsService';
import { whenFirstUsable } from '../startupMaintenanceGate';
import { logger } from '../../utils/logger';
import { DesktopSessionExporter, type DesktopMessage } from './DesktopSessionExporter';
import { DesktopSessionSyncService } from './DesktopSessionSyncService';
import { publishCodexProjects } from './publishCodexProjects';

const ENABLED = 'app.desktopSessionSyncEnabled';
let service: DesktopSessionSyncService | undefined;
let unsubscribe: (() => void) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let stopped = false;

export function getDesktopSessionSyncService(): DesktopSessionSyncService {
  if (!service) {
    const codexRoot = path.resolve(process.env.CODEX_HOME || path.join(homedir(), '.codex'));
    const exporter = new DesktopSessionExporter({ codexRoot, claudeRoot: path.resolve(resolveClaudeConfigDir()) });
    const localProjects = () => getRecentItems('workspaces').map(item => item.path).filter(path.isAbsolute);
    service = new DesktopSessionSyncService({
      list: () => getAllSessionsForSync(false),
      isActive: id => {
        const state = getSessionStateManager().getSessionState(id);
        return !!state && (state.isStreaming || !['idle', 'error'].includes(state.status));
      },
      load: async id => {
        const session = await AISessionsRepository.get(id);
        if (!session || session.metadata?.remoteHostDeviceId) return null;
        let workspacePath = session.worktreePath ?? session.workspacePath;
        if (!workspacePath || !path.isAbsolute(workspacePath)) return null;
        try { if (!(await fs.stat(workspacePath)).isDirectory()) return null; workspacePath = await fs.realpath(workspacePath); }
        catch (error: any) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
        const events = await TranscriptMigrationRepository.getService().getCanonicalEvents(id, session.provider);
        const messages: DesktopMessage[] = events.flatMap(event => {
          // Transfer visible conversation, never hidden reasoning, system instructions or tool capabilities.
          if (event.parentEventId !== null || event.subagentId || event.payload.inputType === 'system_message' || !['user_message', 'assistant_message'].includes(event.eventType) || !event.searchableText?.trim()) return [];
          return [{ role: event.eventType === 'user_message' ? 'user' as const : 'assistant' as const, text: event.searchableText, timestamp: new Date(event.createdAt).toISOString() }];
        });
        return { id, title: session.title ?? 'Untitled', workspacePath, projectPath: session.worktreeProjectPath ?? session.workspacePath, createdAt: session.createdAt, messages };
      },
      export: (provider, session) => exporter.export(provider, session),
      hasProjects: () => localProjects().length > 0,
      publishCodex: async sessions => {
        const projects: string[] = [];
        for (const candidate of localProjects()) {
          try { if ((await fs.stat(candidate)).isDirectory()) projects.push(candidate); }
          catch (error: any) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
        }
        await publishCodexProjects(sessions, codexRoot, projects);
      },
    });
  }
  return service;
}

export function initializeDesktopSessionSync(): void {
  if (unsubscribe || stopped) return;
  const settings = getSettingsService();
  const eligible = () => !stopped && settings.get(ENABLED) === true;
  const sync = () => {
    void whenFirstUsable().then(async () => {
      if (!eligible()) return;
      const result = await getDesktopSessionSyncService().sync(eligible);
      if (result.errors.length) logger.main.warn('[DesktopSessionSync] Sync incomplete', result.errors);
    }).catch(error => logger.main.warn('[DesktopSessionSync] Sync failed', error));
  };
  const reconcile = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (!eligible()) return;
    sync();
    timer = setInterval(sync, 60_000);
    timer.unref?.();
  };
  unsubscribe = settings.subscribe(key => { if (key === ENABLED) reconcile(); });
  reconcile();
}

export async function stopDesktopSessionSync(): Promise<void> {
  stopped = true;
  unsubscribe?.();
  if (timer) clearInterval(timer);
  await service?.stop();
}
