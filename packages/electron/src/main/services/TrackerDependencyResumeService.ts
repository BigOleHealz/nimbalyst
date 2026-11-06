import type { TrackerRecord } from "@nimbalyst/runtime/core/TrackerRecord";
import type { SessionMeta } from "@nimbalyst/runtime/ai/adapters/sessionStore";
import { isAgentProvider } from "@nimbalyst/runtime/ai/server/types";
import type { Readiness } from "@nimbalyst/tracker-core";

export const DEPENDENCY_RESUME_PREFIX = "tracker-dependency:";
export interface DependencyWait {
  promptId: string;
  itemIds: string[];
  queued?: boolean;
}
export type DependencyWaits = Record<string, DependencyWait>;
export interface DependencySnapshot {
  items: TrackerRecord[];
  sessions: SessionMeta[];
  readiness: ReadonlyMap<string, Readiness>;
}
interface Dependencies {
  workspaces(): string[];
  loadWorkspace(path: string): Promise<DependencySnapshot>;
  readWaits(path: string): DependencyWaits;
  writeWaits(path: string, waits: DependencyWaits): void;
  liveState(sessionId: string): { busy: boolean; awaitingInput: boolean };
  hasPendingPrompts(sessionId: string): Promise<boolean>;
  promptStatus(promptId: string): Promise<string | null>;
  cancelPrompt(promptId: string): Promise<void>;
  /** Idempotent on promptId, including after a process restart. */
  queue(sessionId: string, promptId: string, itemIds: string[]): Promise<void>;
  drive(sessionId: string, workspacePath: string): Promise<void>;
  createId(): string;
  onError(workspacePath: string, error: unknown): void;
}

function eligible(session: SessionMeta): boolean {
  return (
    !session.isArchived &&
    !session.remoteHostDeviceId &&
    !session.externalSource &&
    isAgentProvider(session.provider) &&
    Boolean(session.hasStarted || session.messageCount > 0) &&
    !["complete", "completed", "cancelled"].includes(session.phase ?? "")
  );
}

function activeLinkedItems(
  snapshot: DependencySnapshot,
  session: SessionMeta
): TrackerRecord[] {
  const linked = new Set(session.linkedTrackerItemIds ?? []);
  return snapshot.items.filter(
    (item) =>
      linked.has(item.id) &&
      !item.archived &&
      snapshot.readiness.get(item.id)?.state !== "closed"
  );
}

/** Rechecked at dispatch, so a reopened blocker also holds a persisted resume. */
export function isDependencyResumeAllowed(
  snapshot: DependencySnapshot,
  sessionId: string
): boolean {
  const session = snapshot.sessions.find(
    (candidate) => candidate.id === sessionId
  );
  if (!session || !eligible(session)) return false;
  const byId = new Set(snapshot.items.map((item) => item.id));
  if (session.linkedTrackerItemIds?.some((id) => !byId.has(id))) return false;
  const items = activeLinkedItems(snapshot, session);
  return (
    items.length > 0 &&
    items.every((item) => {
      const readiness = snapshot.readiness.get(item.id);
      return (
        readiness?.state === "ready" &&
        !readiness.inCycle &&
        readiness.unresolvedBlockerIds.length === 0
      );
    })
  );
}

/** Runs in main regardless of which workspace view is visible. */
export class TrackerDependencyResumeService {
  private checking = false;
  constructor(private readonly deps: Dependencies) {}

  async check(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      for (const path of new Set(this.deps.workspaces())) {
        try {
          const snapshot = await this.deps.loadWorkspace(path);
          // A partially hydrated/failed workspace read must not release a wait.
          if (!snapshot.items.length) continue;
          const waits = { ...this.deps.readWaits(path) };
          // Archiving or deleting a session must also retire its pending resume.
          for (const id of Object.keys(waits))
            if (!snapshot.sessions.some((session) => session.id === id)) {
              await this.retire(waits[id]);
              delete waits[id];
              this.deps.writeWaits(path, { ...waits });
            }
          for (const session of snapshot.sessions) {
            try {
              let wait = waits[session.id];
              if (!eligible(session)) {
                if (wait) {
                  await this.retire(wait);
                  delete waits[session.id];
                  this.deps.writeWaits(path, { ...waits });
                }
                continue;
              }
              const active = activeLinkedItems(snapshot, session);
              if (
                wait &&
                active.length &&
                !active.some((item) => wait.itemIds.includes(item.id))
              ) {
                // Relinking an agent to unrelated work does not transfer its wait.
                await this.retire(wait);
                delete waits[session.id];
                this.deps.writeWaits(path, { ...waits });
                continue;
              }
              if (
                wait &&
                !active.length &&
                (session.linkedTrackerItemIds ?? []).every((id) =>
                  snapshot.items.some((item) => item.id === id)
                )
              ) {
                await this.retire(wait);
                delete waits[session.id];
                this.deps.writeWaits(path, { ...waits });
                continue;
              }
              const blocked = active.some(
                (item) => snapshot.readiness.get(item.id)?.state === "blocked"
              );
              if (!wait && blocked) {
                wait = {
                  promptId: this.deps.createId(),
                  itemIds: active.map((item) => item.id),
                };
                waits[session.id] = wait;
                this.deps.writeWaits(path, { ...waits });
              }
              if (!wait) continue;
              if (wait.queued) {
                const status = await this.deps.promptStatus(wait.promptId);
                if (!status || status === "completed" || status === "failed") {
                  delete waits[session.id];
                  this.deps.writeWaits(path, { ...waits });
                } else if (
                  status === "pending" &&
                  isDependencyResumeAllowed(snapshot, session.id)
                ) {
                  await this.deps.drive(session.id, path);
                }
                continue;
              }
              if (blocked || !isDependencyResumeAllowed(snapshot, session.id))
                continue;
              const live = this.deps.liveState(session.id);
              if (live.awaitingInput || session.hasPendingInteractivePrompt)
                continue;
              if (live.busy) {
                // It is already moving; don't append a redundant continuation.
                delete waits[session.id];
                this.deps.writeWaits(path, { ...waits });
                continue;
              }
              if (await this.deps.hasPendingPrompts(session.id)) {
                // Existing user/agent instructions take precedence over "continue".
                await this.deps.drive(session.id, path);
                delete waits[session.id];
                this.deps.writeWaits(path, { ...waits });
                continue;
              }
              await this.deps.queue(
                session.id,
                wait.promptId,
                active.map((item) => item.id)
              );
              waits[session.id] = { ...wait, queued: true };
              this.deps.writeWaits(path, { ...waits });
              await this.deps.drive(session.id, path);
            } catch (error) {
              this.deps.onError(path, error);
            }
          }
        } catch (error) {
          this.deps.onError(path, error);
        }
      }
    } finally {
      this.checking = false;
    }
  }

  private async retire(wait: DependencyWait): Promise<void> {
    if (
      wait.queued &&
      (await this.deps.promptStatus(wait.promptId)) === "pending"
    )
      await this.deps.cancelPrompt(wait.promptId);
  }
}
