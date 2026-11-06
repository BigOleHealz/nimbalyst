import { randomUUID } from "node:crypto";
import { trackerItemToRecord } from "@nimbalyst/runtime/core/TrackerRecord";
import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import { computeReadiness } from "@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerReadiness";
import { getRecordStatus } from "@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors";
import { getSessionStateManager } from "@nimbalyst/runtime/ai/server/SessionStateManager";
import { documentServices } from "../window/WindowManager";
import { getWorkspaceState, updateWorkspaceState } from "../utils/store";
import { logger } from "../utils/logger";
import { resolveProjectPath } from "../utils/workspaceDetection";
import { getQueuedPromptsStore } from "./RepositoryManager";
import { ensureWorkspaceTrackerSchemasLoaded } from "./TrackerSchemaService";
import { runWithTrackerSchemaWorkspace } from "./tracker/trackerSchemaScope";
import type { AIService } from "./ai/AIService";
import {
  DEPENDENCY_RESUME_PREFIX,
  TrackerDependencyResumeService,
  isDependencyResumeAllowed,
  type DependencySnapshot,
} from "./TrackerDependencyResumeService";

export async function loadDependencySnapshot(
  workspacePath: string
): Promise<DependencySnapshot> {
  // Queue recovery can name a worktree; its tickets live in the parent project.
  // The normal message dispatcher retains the session's worktree as its cwd.
  workspacePath = documentServices.has(workspacePath)
    ? workspacePath
    : resolveProjectPath(workspacePath);
  const source = documentServices.get(workspacePath);
  if (!source) throw new Error(`No open tracker service for ${workspacePath}`);
  const items = (await source.listTrackerItems()).map(trackerItemToRecord);
  ensureWorkspaceTrackerSchemasLoaded(workspacePath);
  const readiness = runWithTrackerSchemaWorkspace(workspacePath, () =>
    computeReadiness(items, getRecordStatus)
  );
  return {
    items,
    readiness,
    sessions: await AISessionsRepository.list(workspacePath),
  };
}

/** The existing queue owns claims, busy/input guards, and deferred delivery. */
export function startTrackerDependencyResumes(ai: AIService): () => void {
  ai.setDependencyResumeGuard(async (id, path) =>
    isDependencyResumeAllowed(await loadDependencySnapshot(path), id)
  );
  const service = new TrackerDependencyResumeService({
    workspaces: () => [...documentServices.keys()],
    loadWorkspace: loadDependencySnapshot,
    readWaits: (path) => getWorkspaceState(path).trackerDependencyWaits ?? {},
    writeWaits: (path, waits) => {
      updateWorkspaceState(path, (state) => {
        state.trackerDependencyWaits = waits;
      });
    },
    liveState: (id) => {
      const state = getSessionStateManager().getSessionState(id);
      return {
        busy: state?.status === "running" || Boolean(state?.isStreaming),
        awaitingInput: state?.status === "waiting_for_input",
      };
    },
    hasPendingPrompts: async (id) =>
      (await getQueuedPromptsStore().listPending(id)).length > 0,
    promptStatus: async (id) =>
      (await getQueuedPromptsStore().get(id))?.status ?? null,
    cancelPrompt: (id) =>
      getQueuedPromptsStore().fail(
        id,
        "Linked ticket or agent no longer needs an automatic dependency resume."
      ),
    queue: async (sessionId, promptId, itemIds) => {
      const queue = getQueuedPromptsStore();
      if (await queue.get(promptId)) return;
      await queue.create({
        id: promptId,
        sessionId,
        prompt: `Continue the authorized work on your linked ticket${
          itemIds.length === 1 ? "" : "s"
        } (${itemIds.join(
          ", "
        )}). Their blocking dependencies have cleared. Read the current tickets and dependency state before continuing. Preserve the session's scope and permissions; do not resume work that is completed, cancelled, or newly blocked.`,
        documentContext: {
          promptOrigin: "tracker_dependency_resume",
          promptProvenance: {
            actor: "system",
            origin: "automation",
            queuedPromptId: promptId,
          },
        },
      });
      logger.main.info("[TrackerDependencies] Queued linked-agent resume", {
        sessionId,
        promptId,
        itemIds,
      });
    },
    drive: async (id, path) => {
      const outcome = await ai.driveQueuedPrompts(id, path, "wakeup");
      if (outcome.kind === "failed")
        throw new Error(`Dependency resume failed: ${outcome.reason}`);
    },
    createId: () => `${DEPENDENCY_RESUME_PREFIX}${randomUUID()}`,
    onError: (path, error) =>
      logger.main.error(
        "[TrackerDependencies] Resume check failed:",
        path,
        error
      ),
  });
  // Catch changes made in any view, by an import, or by collaboration sync.
  // The periodic check also discovers newly opened workspaces and catches wake.
  void service.check();
  const timer = setInterval(() => {
    void service.check();
  }, 5_000);
  timer.unref();
  return () => clearInterval(timer);
}
