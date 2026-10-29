/**
 * TrackerImporterRegistry — the host side of the tracker-importer contract.
 *
 * Resolves importer contributions from installed extensions and invokes their
 * `importer.*` RPC methods, which run inside the extension's backend module
 * (utility-process). The registry owns starting the module (which raises the
 * first-use consent prompt) before dispatching a request, and resolving the
 * local tracker item for an external URN.
 *
 * Importer methods need no host-brokered permission (they use ambient Node
 * capabilities like spawning `gh`), so requests pass `requiredPermission: null`.
 * Granting the backend module itself is the consent gate.
 */

import { getDatabase } from '../../database/initialize';
import { getPrivilegedExtensionHost } from '../../extensions/PrivilegedExtensionHost';
import {
  TRACKER_IMPORTER_RPC_METHODS,
  type ImporterBinding,
  type ImporterListFilter,
  type ImporterListPage,
  type TrackerImporterContribution,
  type TrackerSnapshot,
  type ImporterMethods,
} from '@nimbalyst/extension-sdk';
import {
  discoverImporters,
  findImporter,
  type ResolvedImporter,
} from './trackerImporterDiscovery';

/** Public summary of an importer for UI / MCP. */
export interface ImporterSummary {
  id: string;
  displayName: string;
  icon: string;
  urnScheme: string;
  importsAs?: string[];
  settingsPanelId?: string;
}

class TrackerImporterRegistry {
  private builtins = new Map<string, { contribution: TrackerImporterContribution; methods: (workspacePath: string) => ImporterMethods }>();

  /** Host connectors share the same importer contract and native task pipeline as extensions. */
  registerBuiltin(contribution: TrackerImporterContribution, methods: (workspacePath: string) => ImporterMethods): void {
    this.builtins.set(contribution.id, { contribution, methods });
  }
  /**
   * Ensure the importer's backend module is running, raising the consent
   * prompt on first use. Throws a user-meaningful error if the module did not
   * reach `running` (declined, untrusted workspace, crash).
   */
  private async ensureRunning(
    importer: ResolvedImporter,
    workspacePath: string
  ): Promise<void> {
    const host = getPrivilegedExtensionHost();
    const handle = await host.startModule({
      extensionId: importer.extensionId,
      extensionName: importer.extensionName,
      extensionPath: importer.extensionPath,
      module: importer.module,
      workspacePath,
    });
    if (handle.state.status !== 'running') {
      const state = handle.state;
      const status = state.status;
      const detail =
        status === 'awaiting-consent' || status === 'denied'
          ? 'Enable the importer when prompted to continue.'
          : status === 'awaiting-trust'
            ? 'Trust this workspace to use importers.'
            : status === 'crashed'
              ? `Importer backend crashed${state.exitCode !== null ? ` (exit code ${state.exitCode})` : ''}${state.error ? `: ${state.error.message}` : '.'}`
              : `Importer backend is ${status}.`;
      throw new Error(
        `Importer '${importer.contribution.displayName}' is not ready (${status}). ${detail}`
      );
    }
  }

  private async call<T>(
    importer: ResolvedImporter,
    workspacePath: string,
    method: string,
    params?: unknown
  ): Promise<T> {
    await this.ensureRunning(importer, workspacePath);
    return getPrivilegedExtensionHost().request<T>({
      extensionId: importer.extensionId,
      moduleId: importer.module.id,
      workspacePath,
      method,
      params,
      requiredPermission: null,
    });
  }

  /**
   * List installed importers (discovery only — does NOT start backend modules
   * or probe auth, so merely opening the import menu never triggers a consent
   * prompt). Auth is checked lazily when the user actually imports.
   */
  async listImporters(_workspacePath: string): Promise<ImporterSummary[]> {
    const importers = await discoverImporters();
    return [...this.builtins.values()].map(({ contribution }) => contribution).concat(importers.map(imp => imp.contribution)).map((contribution) => ({
      id: contribution.id,
      displayName: contribution.displayName,
      icon: contribution.icon,
      urnScheme: contribution.urnScheme,
      importsAs: contribution.importsAs,
      settingsPanelId: contribution.settingsPanelId,
    }));
  }


  async getContribution(providerId: string): Promise<TrackerImporterContribution | null> {
    const builtin = this.builtins.get(providerId);
    if (builtin) return builtin.contribution;
    return (await findImporter(providerId))?.contribution ?? null;
  }

  async isAuthenticated(workspacePath: string, providerId: string): Promise<boolean> {
    const builtin = this.builtins.get(providerId);
    if (builtin) return builtin.methods(workspacePath).isAuthenticated();
    const imp = await this.requireImporter(providerId);
    return this.call<boolean>(imp, workspacePath, TRACKER_IMPORTER_RPC_METHODS.isAuthenticated);
  }

  async listBindings(workspacePath: string, providerId: string): Promise<ImporterBinding[]> {
    const builtin = this.builtins.get(providerId);
    if (builtin) return builtin.methods(workspacePath).listBindings();
    const imp = await this.requireImporter(providerId);
    return this.call<ImporterBinding[]>(
      imp,
      workspacePath,
      TRACKER_IMPORTER_RPC_METHODS.listBindings
    );
  }

  async listItems(
    workspacePath: string,
    providerId: string,
    binding: ImporterBinding,
    filters: ImporterListFilter
  ): Promise<ImporterListPage> {
    const builtin = this.builtins.get(providerId);
    if (builtin) return builtin.methods(workspacePath).list({ binding, filters });
    const imp = await this.requireImporter(providerId);
    return this.call<ImporterListPage>(imp, workspacePath, TRACKER_IMPORTER_RPC_METHODS.list, {
      binding,
      filters,
    });
  }

  async fetchSnapshot(
    workspacePath: string,
    providerId: string,
    externalId: string
  ): Promise<TrackerSnapshot> {
    const builtin = this.builtins.get(providerId);
    if (builtin) return builtin.methods(workspacePath).fetch({ externalId });
    const imp = await this.requireImporter(providerId);
    return this.call<TrackerSnapshot>(imp, workspacePath, TRACKER_IMPORTER_RPC_METHODS.fetch, {
      externalId,
    });
  }

  async openExternal(
    workspacePath: string,
    providerId: string,
    externalId: string
  ): Promise<void> {
    const imp = await this.requireImporter(providerId);
    if (!imp.module) return;
    await this.call<void>(imp, workspacePath, TRACKER_IMPORTER_RPC_METHODS.openExternal, {
      externalId,
    });
  }

  /**
   * Resolve the local tracker item id for an external URN, or null. Uses the
   * `data.origin.external.urn` expression index (see migration 0010 / worker.js)
   * so the lookup is a single indexed probe on both backends.
   */
  async findLocalIdByUrn(workspacePath: string, urn: string): Promise<string | null> {
    const db = getDatabase();
    const result = await db.query<{ id: string }>(
      `SELECT id FROM tracker_items
        WHERE workspace = $1
          AND data->'origin'->'external'->>'urn' = $2
        LIMIT 1`,
      [workspacePath, urn]
    );
    return result.rows[0]?.id ?? null;
  }

  private async requireImporter(providerId: string): Promise<ResolvedImporter> {
    const imp = await findImporter(providerId);
    if (!imp) {
      throw new Error(`No tracker importer registered for provider '${providerId}'.`);
    }
    return imp;
  }
}

let singleton: TrackerImporterRegistry | null = null;
export function getTrackerImporterRegistry(): TrackerImporterRegistry {
  if (!singleton) singleton = new TrackerImporterRegistry();
  return singleton;
}
