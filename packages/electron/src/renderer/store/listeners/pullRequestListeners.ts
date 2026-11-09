/**
 * Pull request review panel listeners.
 *
 * Centralized IPC subscriber that populates the PR atoms. Follows
 * IPC_LISTENERS.md — components never subscribe to IPC directly; this runs
 * once at startup and updates atoms.
 *
 * Responsibilities:
 *   * initial `gh` status probe + `pr:gh-status-changed` -> ghCliStatusAtom
 *   * detect the GitHub remote for the active workspace -> prRemoteAtom,
 *     re-running when the multi-project rail switches the active workspace
 *   * `pr:list-updated` broadcast -> prListUpdatedAtom (request bump the list
 *     view reacts to)
 *
 * Call initPullRequestListeners() once in App.tsx on mount.
 */

import { store } from '@nimbalyst/runtime/store';
import {
  ghCliStatusAtom,
  prRemoteAtom,
  prListUpdatedAtom,
  prListAtom,
  prDeliveryEvidenceAtom,
  prRepositoryPathsAtom,
} from '../atoms/pullRequests';
import { activeWorkspacePathAtom } from '../atoms/openProjects';
import { workspaceRepoPathsAtom } from '../atoms/workspaceRepos';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { getRecordPrReferences } from '@nimbalyst/runtime/plugins/TrackerPlugin/prReferences';
import { getGhCliService } from '../../services/RendererGhCliService';
import { getPullRequestService } from '../../services/RendererPullRequestService';

export function initPullRequestListeners(): () => void {
  const cleanups: Array<() => void> = [];
  let disposed = false;
  let listUpdatedVersion = 0;

  const ghService = getGhCliService();
  const prService = getPullRequestService();
  const pollingWorkspaces = new Map<string, string>();
  let listRequest = 0;
  let generation = 0;
  const listRequests = new Map<string, number>();
  let discovered = new Map<string, string[]>();
  const refreshList = async (workspacePath: string, remote: string, epoch = generation) => {
    const request = ++listRequest;
    listRequests.set(remote, request);
    try {
      const rows = await prService.list(workspacePath, remote, { state: 'all' });
      if (!disposed && epoch === generation && request === listRequests.get(remote) && store.get(activeWorkspacePathAtom) === workspacePath) {
        const others = store.get(prListAtom).filter(row => row.workspaceId === workspacePath && row.remote.toLowerCase() !== remote);
        store.set(prListAtom, [...others, ...rows]);
        const otherEvidence = store.get(prDeliveryEvidenceAtom).filter(row => row.workspaceId === workspacePath && row.remote.toLowerCase() !== remote);
        store.set(prDeliveryEvidenceAtom, [...otherEvidence, ...rows]);
      }
    } catch (error) {
      console.error('[pullRequestListeners] Failed to refresh PR status:', error);
    }
  };

  // Initial gh status probe so the onboarding banner reflects reality on
  // first paint instead of waiting for a change event that may never come.
  ghService
    .getStatus()
    .then((status) => {
      if (!disposed) store.set(ghCliStatusAtom, status);
    })
    .catch(() => {
      if (!disposed) store.set(ghCliStatusAtom, { installed: false, authed: false });
    });

  // gh status changes (install / login transitions detected by the main
  // process cache eviction).
  cleanups.push(ghService.onStatusChanged((status) => {
    if (!disposed) store.set(ghCliStatusAtom, status);
  }));

  // pr:list-updated -> bump the request atom; the list view re-reads cache.
  cleanups.push(
    prService.onListUpdated((payload) => {
      if (disposed) return;
      listUpdatedVersion += 1;
      store.set(prListUpdatedAtom, { version: listUpdatedVersion, payload });
      const active = store.get(activeWorkspacePathAtom);
      if (active && (active === payload.workspacePath || pollingWorkspaces.get(payload.workspacePath) === active)) {
        // A cloud-only reference can share the workspace's existing poll clock.
        for (const remote of discovered.keys()) void refreshList(active, remote);
      }
    }),
  );

  // Detect the GitHub remote for a workspace and publish it to prRemoteAtom.
  const detectRemoteFor = async (workspacePath: string | null): Promise<void> => {
    const epoch = ++generation;
    listRequests.clear();
    store.set(prListAtom, store.get(prListAtom).filter(row => row.workspaceId === workspacePath));
    store.set(prDeliveryEvidenceAtom, store.get(prDeliveryEvidenceAtom).filter(row => row.workspaceId === workspacePath));
    discovered = new Map();
    store.set(prRepositoryPathsAtom, new Map());
    if (!workspacePath) {
      store.set(prRemoteAtom, null);
      return;
    }
    try {
      const paths = [...new Set([workspacePath, ...store.get(workspaceRepoPathsAtom)])];
      const results = await Promise.all(paths.map(async path => ({ path, result: await prService.detectRemote(path).catch(() => null) })));
      if (disposed || epoch !== generation) return;
      // Guard against a stale resolve after the user switched projects.
      if (store.get(activeWorkspacePathAtom) !== workspacePath) return;
      const primary = results.find(result => result.path === workspacePath)?.result;
      store.set(prRemoteAtom, primary ? { workspacePath, ...primary } : null);
      const remotes = new Map<string, string[]>();
      for (const { path, result } of results) {
        if (!result) continue;
        const remote = result.remote.toLowerCase();
        remotes.set(remote, [...(remotes.get(remote) ?? []), path]);
      }
      for (const record of store.get(trackerItemsMapAtom).values()) {
        if (record.system.workspace !== workspacePath) continue;
        for (const ref of getRecordPrReferences(record)) if (!remotes.has(ref.remote)) remotes.set(ref.remote, []);
      }
      discovered = remotes;
      store.set(prRepositoryPathsAtom, new Map(remotes));
      const wantedPaths = new Set([...remotes.values()].map(paths => paths[0] ?? workspacePath));
      for (const path of pollingWorkspaces.keys()) {
        if (!wantedPaths.has(path) || pollingWorkspaces.get(path) !== workspacePath) {
          pollingWorkspaces.delete(path);
          void prService.stopPolling(path).catch(error => console.error('[pullRequestListeners] Failed to stop polling:', error));
        }
      }
      const started = new Set<string>();
      for (const [remote, repoPaths] of remotes) {
        if (disposed || epoch !== generation || store.get(activeWorkspacePathAtom) !== workspacePath) return;
        const sourcePath = repoPaths[0] ?? workspacePath;
        void refreshList(workspacePath, remote, epoch);
        if (started.has(sourcePath)) continue;
        started.add(sourcePath);
        pollingWorkspaces.set(sourcePath, workspacePath);
        await prService.startPolling(sourcePath, workspacePath, remote)
          .catch(error => console.error('[pullRequestListeners] Failed to start polling:', error));
        if (disposed) { await prService.stopPolling(sourcePath); return; }
      }
    } catch {
      if (!disposed) store.set(prRemoteAtom, null);
    }
  };

  // Initial detection + re-detect on project switch.
  void detectRemoteFor(store.get(activeWorkspacePathAtom));
  const unsubscribeActivePath = store.sub(activeWorkspacePathAtom, () => {
    if (disposed) return;
    void detectRemoteFor(store.get(activeWorkspacePathAtom));
  });
  cleanups.push(unsubscribeActivePath);
  cleanups.push(store.sub(workspaceRepoPathsAtom, () => { void detectRemoteFor(store.get(activeWorkspacePathAtom)); }));
  let referenceRemotes = '';
  cleanups.push(store.sub(trackerItemsMapAtom, () => {
    const workspacePath = store.get(activeWorkspacePathAtom);
    const next = [...new Set([...store.get(trackerItemsMapAtom).values()]
      .filter(record => record.system.workspace === workspacePath).flatMap(getRecordPrReferences).map(ref => ref.remote))].sort().join(',');
    if (next === referenceRemotes) return;
    referenceRemotes = next;
    void detectRemoteFor(workspacePath);
  }));

  return () => {
    disposed = true;
    cleanups.forEach((cleanup) => cleanup());
    for (const workspacePath of pollingWorkspaces.keys()) {
      void prService.stopPolling(workspacePath).catch(error => console.error('[pullRequestListeners] Failed to stop polling:', error));
    }
  };
}
