import type { TrackerSnapshot } from '@nimbalyst/extension-sdk';
import { JiraError, type JiraClient, type JiraSyncResult } from '@nimbalyst/runtime/integrations/jira';

/** One sync per project; manual and scheduled calls share the same in-flight operation. */
export class JiraSyncService {
  private running = new Map<string, Promise<JiraSyncResult>>();

  sync(workspacePath: string, jql: string, client: JiraClient, importSnapshot: (snapshot: TrackerSnapshot) => Promise<{ created: boolean; skipped?: boolean }>): Promise<JiraSyncResult> {
    const active = this.running.get(workspacePath);
    if (active) return active;
    const run = this.perform(jql, client, importSnapshot).finally(() => this.running.delete(workspacePath));
    this.running.set(workspacePath, run);
    return run;
  }

  private async perform(jql: string, client: JiraClient, importSnapshot: (snapshot: TrackerSnapshot) => Promise<{ created: boolean; skipped?: boolean }>): Promise<JiraSyncResult> {
    const result: JiraSyncResult = { created: 0, refreshed: 0, skipped: 0, errors: [] };
    try {
      for await (const issue of client.search(jql)) {
        try {
          const imported = await importSnapshot(await client.snapshot(issue));
          if (imported.skipped) result.skipped++;
          else if (imported.created) result.created++;
          else result.refreshed++;
        } catch (error) {
          // Never surface raw network/parser errors, which may contain credentials or upstream content.
          const key = /^[A-Z][A-Z0-9_]*-\d+$/i.test(issue?.key) ? issue.key : 'Invalid issue';
          result.errors.push(`${key}: ${error instanceof JiraError ? error.message : 'Could not import this issue. Check access and retry.'}`);
        }
      }
    } catch (error) {
      // JiraClient only emits sanitized, actionable errors.
      result.errors.push(error instanceof Error ? error.message : 'Jira sync failed.');
    }
    return result;
  }
}
