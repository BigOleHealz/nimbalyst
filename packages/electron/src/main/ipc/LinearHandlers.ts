import { BrowserWindow, dialog } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';
import { addToRecentItems } from '../utils/store';
import { getDialogDefaultPath, rememberDialogSelection } from '../utils/dialogPaths';
import { getTrackerImporterRegistry } from '../services/tracker/TrackerImporterRegistry';
import { getTrackerImportService } from '../services/tracker/TrackerImportService';
import { LinearClient } from '../services/linear/LinearClient';
import { LinearProjectImportService } from '../services/linear/LinearProjectImportService';
import { readLinearKey, saveLinearKey } from '../services/linear/linearSettings';

export function registerLinearHandlers(): void {
  const client = () => new LinearClient(readLinearKey() ?? '');
  getTrackerImporterRegistry().registerBuiltin({
    id: 'linear', displayName: 'Linear', icon: 'cloud_download', urnScheme: 'linear', backendModuleId: 'host-linear', importsAs: ['task'],
  }, () => ({
    isAuthenticated: async () => {
      if (!readLinearKey()) return false;
      await client().viewer();
      return true;
    },
    listBindings: async () => {
      const linear = client();
      const bindings = [{ id: 'all', label: 'All accessible tickets' }];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const page = await linear.projects(cursor);
        bindings.push(...page.nodes.map(project => ({ id: project.id, label: project.name })));
        cursor = page.nextCursor;
        if (cursor) {
          if (seen.has(cursor)) throw new Error('Linear repeated a project cursor. Retry.');
          seen.add(cursor);
        }
      } while (cursor);
      return bindings;
    },
    list: async ({ binding, filters }) => {
      const page = await client().issues({ projectId: binding.id === 'all' ? undefined : binding.id, cursor: filters.cursor, search: filters.search, state: filters.state, limit: filters.limit });
      return {
        items: page.nodes.map(issue => ({ externalId: issue.id, urn: `linear://issue/${issue.id}`, url: issue.url, title: `${issue.identifier} ${issue.title}`, state: issue.state.name, updatedAt: issue.updatedAt })),
        nextCursor: page.nextCursor,
      };
    },
    fetch: ({ externalId }) => client().snapshot(externalId),
  }));

  // These are deliberately app-global: they create independent new workspaces.
  safeHandle('linear:get-settings', () => ({ hasToken: Boolean(readLinearKey()) }));
  safeHandle('linear:connect', async (_event, args: { apiKey?: string }) => {
    const key = typeof args?.apiKey === 'string' && args.apiKey.trim() ? args.apiKey.trim() : readLinearKey();
    const viewer = await new LinearClient(key ?? '').viewer();
    if (args?.apiKey?.trim()) saveLinearKey(key!);
    return { name: viewer.name };
  });
  safeHandle('linear:projects', (_event, args?: { cursor?: string }) => client().projects(args?.cursor));
  safeHandle('linear:choose-destination', async event => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { title: 'Choose a folder for Linear workspaces', defaultPath: getDialogDefaultPath(), properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'> };
    const result = await (window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options));
    if (result.canceled || !result.filePaths[0]) return null;
    rememberDialogSelection(result.filePaths[0], 'directory');
    return result.filePaths[0];
  });
  const pending = new Map<string, Promise<unknown>>();
  safeHandle('linear:import-project', async (_event, args: { destination: string; projectId: string }) => {
    if (!args || typeof args.destination !== 'string' || typeof args.projectId !== 'string') throw new Error('A destination and Linear project ID are required.');
    const key = `${args.destination}\n${args.projectId}`;
    if (pending.has(key)) throw new Error('This Linear project is already being imported.');
    const service = new LinearProjectImportService(client(),
      (workspacePath, externalId) => getTrackerImportService().runImport({ workspacePath, externalId, providerId: 'linear', primaryType: 'task' }),
      (workspacePath, name) => addToRecentItems('workspaces', workspacePath, name));
    const run = service.importProject(args.destination, args.projectId);
    pending.set(key, run);
    try { return await run; } finally { pending.delete(key); }
  });
}
