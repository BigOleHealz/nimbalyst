import type { DesktopSessionSyncResult, DesktopSyncCounts, ExternalSessionProviderId } from '../../../shared/externalSessions';
import type { DesktopExportResult, DesktopExportSession } from './DesktopSessionExporter';

export interface CodexProjectSession { workspacePath: string; projectPath?: string; sessionId: string; title: string }
interface Dependencies {
  list: () => Promise<Array<{ id: string; updatedAt: number }>>;
  load: (id: string) => Promise<DesktopExportSession | null>;
  isActive: (id: string) => boolean;
  export: (provider: ExternalSessionProviderId, session: DesktopExportSession) => Promise<DesktopExportResult>;
  publishCodex: (sessions: CodexProjectSession[]) => Promise<void>;
  hasProjects?: () => boolean;
}
const counts = (): DesktopSyncCounts => ({ synced: 0, unchanged: 0, unavailable: 0, conflicts: 0, failed: 0 });

export class DesktopSessionSyncService {
  private running?: Promise<DesktopSessionSyncResult>;
  private stopped = false;
  private revisions = new Map<string, number>();
  constructor(private readonly deps: Dependencies) {}

  sync(isEligible: () => boolean = () => true): Promise<DesktopSessionSyncResult> {
    if (this.stopped) return Promise.reject(new Error('Desktop session sync stopped'));
    if (!this.running) this.running = this.run(isEligible).finally(() => { this.running = undefined; });
    return this.running;
  }
  async stop(): Promise<void> { this.stopped = true; await this.running; }

  private async run(isEligible: () => boolean): Promise<DesktopSessionSyncResult> {
    const result: DesktopSessionSyncResult = { codex: counts(), claude: counts(), busy: 0, errors: [] };
    const publish: CodexProjectSession[] = [];
    const codexRevisions: Array<[string, number]> = [];
    for (const candidate of await this.deps.list()) {
      if (this.stopped || !isEligible()) break;
      if (this.deps.isActive(candidate.id)) { result.busy++; continue; }
      let loaded: DesktopExportSession | null | undefined;
      for (const provider of ['openai-codex', 'claude-code'] as const) {
        if (this.stopped || !isEligible() || this.deps.isActive(candidate.id)) break;
        const destination = provider === 'openai-codex' ? result.codex : result.claude;
        const key = `${provider}:${candidate.id}`;
        if (this.revisions.get(key) === candidate.updatedAt) { destination.unchanged++; continue; }
        try {
          if (loaded === undefined) loaded = await this.deps.load(candidate.id);
          if (!loaded?.messages.length) continue;
          if (this.stopped || !isEligible() || this.deps.isActive(candidate.id)) break;
          const exported = await this.deps.export(provider, loaded);
          if (exported.status === 'conflict') destination.conflicts++;
          else destination[exported.status]++;
          if (exported.status !== 'synced' && exported.status !== 'unchanged') continue;
          if (provider === 'openai-codex' && exported.sessionId) {
            publish.push({ workspacePath: loaded.workspacePath, ...(loaded.projectPath ? { projectPath: loaded.projectPath } : {}), sessionId: exported.sessionId, title: loaded.title });
            codexRevisions.push([key, candidate.updatedAt]);
          } else this.revisions.set(key, candidate.updatedAt);
        } catch (error) {
          destination.failed++;
          result.errors.push(`${provider}: ${candidate.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      // Yield between sessions so transcript backfill cannot monopolize the main process.
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if ((publish.length || this.deps.hasProjects?.()) && !this.stopped && isEligible()) {
      try {
        await this.deps.publishCodex(publish);
        for (const [key, revision] of codexRevisions) this.revisions.set(key, revision);
      } catch (error) {
        result.codex.failed += publish.length;
        result.codex.synced = 0;
        result.errors.push(`Codex project registration: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return result;
  }
}
