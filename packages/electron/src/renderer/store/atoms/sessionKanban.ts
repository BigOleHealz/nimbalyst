/**
 * Session Kanban Board Atoms
 *
 * State for the session kanban board view in TrackerMode.
 * Board placement derives from existing operational state. Workflow phases
 * remain independent; manual board overrides live in the same session metadata.
 */

import { atom, type Getter, type createStore } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { sessionAwaitingApprovalAtom } from './sessionApproval';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { getRecordPrReferences } from '@nimbalyst/runtime/plugins/TrackerPlugin/prReferences';
import { computeReadiness } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerReadiness';
import { getRecordStatus } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { prListAtom } from './pullRequests';
import { worktreeRecordsAtom } from './worktrees';
import { worktreeGitStatusAtom, sessionGitStatusAtom } from './sessionFiles';
import { gitStatusAtom } from './gitOperations';
import { activeWorkspacePathAtom } from './openProjects';
import { sessionArchiveSubtreeIds } from '../../components/AgenticCoding/sessionArchiveSelection';
import {
  sessionRegistryAtom,
  sessionProcessingAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionLastActivityAtom,
} from './sessions';

// ============================================================
// Types
// ============================================================

/** Phase columns on the kanban board */
export type SessionPhase = 'backlog' | 'planning' | 'implementing' | 'validating' | 'complete';
export type SessionBoardColumn = NonNullable<SessionMeta['kanbanOverride']>['column'];
export type SessionGitStage = 'ready-for-commit' | 'ready-for-push' | 'ready-for-pr';
export const SESSION_GIT_STAGES: { value: SessionGitStage; label: string }[] = [
  { value: 'ready-for-commit', label: 'Ready for commit' },
  { value: 'ready-for-push', label: 'Ready for push' },
  { value: 'ready-for-pr', label: 'Ready for PR' },
];

/** Card type determines visual treatment and whether child run states are shown */
export type KanbanCardType = 'session' | 'workstream' | 'worktree';

/** Summary of child session states for a workstream/worktree card */
export interface ChildRunStateSummary {
  running: number;
  waiting: number;
  blocked: number;
  review: number;
  idle: number;
  done: number;
  total: number;
}

// ============================================================
// Phase Column Definitions
// ============================================================

export const SESSION_PHASE_COLUMNS: { value: SessionPhase; label: string; color: string }[] = [
  { value: 'backlog', label: 'Backlog', color: '#6b7280' },
  { value: 'planning', label: 'Planning', color: '#60a5fa' },
  { value: 'implementing', label: 'Implementing', color: '#eab308' },
  { value: 'validating', label: 'Validating', color: '#a78bfa' },
  { value: 'complete', label: 'Complete', color: '#4ade80' },
];

export const SESSION_BOARD_COLUMNS: { value: SessionBoardColumn; label: string; color: string }[] = [
  { value: 'backlog', label: 'Backlog', color: 'var(--nim-text-muted)' },
  { value: 'blocked', label: 'Blocked', color: 'var(--nim-error)' },
  { value: 'implementing', label: 'Running', color: 'var(--nim-primary)' },
  { value: 'awaiting-input', label: 'Awaiting Input', color: 'var(--nim-warning)' },
  { value: 'git', label: 'Git status', color: 'color-mix(in srgb, var(--nim-success) 70%, var(--nim-info))' },
  { value: 'validating', label: 'Review', color: 'var(--nim-warning)' },
  { value: 'complete', label: 'Done', color: 'var(--nim-success)' },
];

const VALID_COLUMNS = new Set<string>(SESSION_BOARD_COLUMNS.map(c => c.value));

// ============================================================
// Helpers
// ============================================================

/** Derive the card type from session metadata */
export function getCardType(meta: SessionMeta | undefined): KanbanCardType {
  if (!meta) return 'session';
  if (meta.worktreeId) return 'worktree';
  if (meta.sessionType === 'workstream' || meta.childCount > 0) return 'workstream';
  return 'session';
}

const sessionHasActivityAtom = atomFamily((id: string) => atom(get => get(sessionLastActivityAtom(id)) > 0));

/** Use the full ticket corpus so hidden prerequisites still hold linked work. */
const trackerBlockedSessionsAtom = atom(get => {
  const records = get(trackerItemsMapAtom);
  const registry = get(sessionRegistryAtom);
  const readiness = computeReadiness([...records.values()], getRecordStatus);
  const blockedItems = new Set([...records.values()].filter(item => {
    const state = readiness.get(item.id);
    return !item.archived && state?.state !== 'closed'
      && (state?.state === 'blocked' || state?.inCycle || getRecordStatus(item).toLowerCase() === 'blocked');
  }).map(item => item.id));
  const blocked = new Set<string>();
  const matchesWorkspace = (sessionId: string, itemId: string) => {
    const session = registry.get(sessionId);
    const item = records.get(itemId);
    return session && item && (!item.system.workspace || item.system.workspace === session.workspaceId);
  };
  for (const session of registry.values()) {
    if (session.linkedTrackerItemIds?.some(id => blockedItems.has(id) && matchesWorkspace(session.id, id))) blocked.add(session.id);
  }
  // Either end of a durable link may arrive first during hydration/sync.
  for (const id of blockedItems) {
    for (const sessionId of records.get(id)?.system.linkedSessions ?? []) {
      if (matchesWorkspace(sessionId, id)) blocked.add(sessionId);
    }
  }
  return blocked;
});

function ownState(get: Getter, meta: SessionMeta): { column: SessionBoardColumn; gitStage?: SessionGitStage } {
  if (!meta.isArchived && get(trackerBlockedSessionsAtom).has(meta.id)) return { column: 'blocked' };
  if (!meta.isArchived && (get(sessionAwaitingApprovalAtom(meta.id)) || get(sessionHasPendingInteractivePromptAtom(meta.id)))) return { column: 'awaiting-input' };
  if (!meta.isArchived && get(sessionProcessingAtom(meta.id))) return { column: 'implementing' };

  const workspaceGit = meta.workspaceId === get(activeWorkspacePathAtom) ? get(gitStatusAtom) : null;
  const worktreeGit = meta.worktreeId ? get(worktreeGitStatusAtom(meta.worktreeId)) : null;
  const dirty = meta.worktreeId ? worktreeGit?.hasUncommittedChanges ?? meta.uncommittedCount > 0
    : Object.values(get(sessionGitStatusAtom(meta.id))).some(file => file.status !== 'unchanged') || meta.uncommittedCount > 0;
  if (dirty) return { column: 'git', gitStage: 'ready-for-commit' };
  // Worktree ahead counts compare with the base; only unpushedCommits compares with upstream.
  if (worktreeGit && ((worktreeGit.unpushedCommits ?? 0) > 0 || (worktreeGit.hasUpstream === false && worktreeGit.ahead > 0))) {
    return { column: 'git', gitStage: 'ready-for-push' };
  }
  if (!meta.worktreeId && workspaceGit && meta.hasStarted && workspaceGit.ahead > 0) return { column: 'git', gitStage: 'ready-for-push' };

  const records = get(trackerItemsMapAtom);
  const references = (meta.linkedTrackerItemIds ?? []).flatMap(id => {
    const record = records.get(id);
    return record ? getRecordPrReferences(record) : [];
  });
  const branch = meta.worktreeId ? get(worktreeRecordsAtom).get(meta.worktreeId)?.branch : workspaceGit?.branch;
  const prs = get(prListAtom).filter(pr => pr.workspaceId === meta.workspaceId && (
    (branch && pr.headRef === branch) || references.some(ref => ref.remote === pr.remote.toLowerCase() && ref.number === pr.number)
  ));
  if (prs.some(pr => pr.state === 'open')) return { column: 'validating' };
  const latestPr = [...prs].sort((a, b) => (b.updatedAt - a.updatedAt) || b.number - a.number)[0];
  const allReferencesMerged = references.every(ref => prs.some(pr => pr.remote.toLowerCase() === ref.remote && pr.number === ref.number && pr.state === 'merged'));
  if (latestPr?.state === 'merged' && allReferencesMerged && (!worktreeGit?.headSha || latestPr.headSha === worktreeGit.headSha)) return { column: 'complete' };
  if (worktreeGit?.hasUpstream && worktreeGit.unpushedCommits === 0 && worktreeGit.ahead > 0) return { column: 'git', gitStage: 'ready-for-pr' };
  // A completed agent turn is reviewable work, not evidence of a merge.
  return { column: meta.hasStarted || meta.messageCount > 0 || get(sessionHasActivityAtom(meta.id)) ? 'validating' : 'backlog' };
}

/** Derived from existing status sources; includes descendants in a grouped card. */
export const sessionAutomaticBoardStateAtom = atom(get => {
  const registry = get(sessionRegistryAtom);
  const own = new Map([...registry].map(([id, meta]) => [id, ownState(get, meta)]));
  const result = new Map<string, { column: SessionBoardColumn; status: string; gitStage?: SessionGitStage }>();
  const priority = ['blocked', 'awaiting-input', 'implementing', 'git', 'validating', 'backlog', 'complete'];
  for (const [id, meta] of registry) {
    if (meta.parentSessionId) continue;
    const states = sessionArchiveSubtreeIds(registry, [id]).map(childId => ({ id: childId, ...own.get(childId)! }));
    // An empty workstream shell does not block its children from completing.
    const candidates = states.length > 1 && own.get(id)?.column === 'backlog' ? states.filter(s => s.id !== id) : states;
    const state = [...candidates].sort((a, b) => priority.indexOf(a.column) - priority.indexOf(b.column)
      || SESSION_GIT_STAGES.findIndex(s => s.value === a.gitStage) - SESSION_GIT_STAGES.findIndex(s => s.value === b.gitStage))[0];
    result.set(id, { column: state.column, gitStage: state.gitStage,
      status: JSON.stringify(states.sort((a, b) => a.id.localeCompare(b.id)).map(s => [s.id, s.gitStage ? `git:${s.gitStage}` : s.column])) });
  }
  return result;
});

// ============================================================
// Filter State
// ============================================================

export interface SessionKanbanFilter {
  search: string;
  tags: string[];
  showComplete: boolean;
}

/** Filter state for the kanban board */
export const sessionKanbanFilterAtom = atom<SessionKanbanFilter>({
  search: '',
  tags: [],
  showComplete: true,
});

export type SessionKanbanActivityRange = 'hour' | 'day' | 'all';
export const sessionKanbanActivityRangeAtom = atom<SessionKanbanActivityRange>('all');

// Only mounted while a time filter is visible. Refresh on mount and every minute
// so quiet sessions age out even when no new activity arrives.
const sessionKanbanNowAtom = atom(0);
sessionKanbanNowAtom.onMount = (setNow) => {
  setNow(Date.now());
  const timer = setInterval(() => setNow(Date.now()), 60_000);
  return () => clearInterval(timer);
};

const sessionKanbanRecentRootsAtom = atom(get => {
  const range = get(sessionKanbanActivityRangeAtom);
  if (range === 'all') return null;
  const cutoff = (get(sessionKanbanNowAtom) || Date.now()) - (range === 'hour' ? 3_600_000 : 86_400_000);
  const registry = get(sessionRegistryAtom);
  const recent = new Set<string>();
  for (const meta of registry.values()) {
    if (meta.isArchived) continue;
    const liveActivity = get(sessionLastActivityAtom(meta.id));
    if ((liveActivity > 0 ? liveActivity : meta.updatedAt) < cutoff) continue;
    // A grouped card represents activity throughout its session tree.
    let current: SessionMeta | undefined = meta;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      if (!current.parentSessionId) recent.add(current.id);
      current = current.parentSessionId ? registry.get(current.parentSessionId) : undefined;
    }
  }
  return recent;
});

// ============================================================
// Derived Atoms
// ============================================================

/** Key type for the grouped map - includes 'unphased' for sessions without a phase */
export type SessionPhaseKey = SessionBoardColumn | 'unphased';

/** Derived: sessions grouped by phase for the kanban board */
export const sessionsByPhaseAtom = atom((get) => {
  const registry = get(sessionRegistryAtom);
  const filter = get(sessionKanbanFilterAtom);
  const automatic = get(sessionAutomaticBoardStateAtom);
  const recentRoots = get(sessionKanbanRecentRootsAtom);

  const grouped = new Map<SessionPhaseKey, SessionMeta[]>();
  grouped.set('unphased', []);
  for (const col of SESSION_BOARD_COLUMNS) {
    grouped.set(col.value, []);
  }

  for (const [_id, meta] of registry) {
    // Only show active root sessions (not children of workstreams).
    if (meta.isArchived || meta.parentSessionId) continue;
    if (recentRoots && !recentRoots.has(meta.id)) continue;

    const state = automatic.get(meta.id)!;
    const override = meta.kanbanOverride;
    const phase = override && override.status === state.status && VALID_COLUMNS.has(override.column)
      && (override.column !== 'complete' || state.column === 'complete')
      && (override.column !== 'git' || state.column === 'git')
      && (state.column !== 'blocked' || override.column === 'blocked')
      ? override.column : state.column;

    // Skip complete if filter says hide
    if (!filter.showComplete && phase === 'complete') continue;

    // Apply search filter
    if (filter.search) {
      const q = filter.search.toLowerCase();
      const records = get(trackerItemsMapAtom);
      const linkedText = (meta.linkedTrackerItemIds ?? []).map(id => {
        const item = records.get(id);
        return item ? `${item.issueKey ?? ''} ${item.fields.title ?? ''} ${item.system.origin?.kind === 'external' ? item.system.origin.external?.externalId ?? '' : ''}` : '';
      }).join(' ');
      if (!`${meta.title} ${linkedText}`.toLowerCase().includes(q)) continue;
    }

    // Apply tag filter
    if (filter.tags.length > 0) {
      const sessionTags = meta.tags || [];
      if (!filter.tags.some(t => sessionTags.includes(t))) continue;
    }

    grouped.get(phase)!.push(meta);
  }

  // Sort each column by updatedAt desc
  for (const [_phase, sessions] of grouped) {
    sessions.sort((a, b) => (_phase === 'git' ? SESSION_GIT_STAGES.findIndex(s => s.value === automatic.get(a.id)?.gitStage)
      - SESSION_GIT_STAGES.findIndex(s => s.value === automatic.get(b.id)?.gitStage) : 0) || b.updatedAt - a.updatedAt);
  }

  return grouped;
});

/** Derived: total count of sessions on the board (with a phase) */
export const sessionKanbanTotalCountAtom = atom((get) => {
  const grouped = get(sessionsByPhaseAtom);
  let total = 0;
  for (const sessions of grouped.values()) {
    total += sessions.length;
  }
  return total;
});

/** Derived: all unique tags from root sessions (with counts) */
export const sessionKanbanTagsAtom = atom((get) => {
  const registry = get(sessionRegistryAtom);
  const tagCounts = new Map<string, number>();

  for (const [_id, meta] of registry) {
    if (meta.isArchived || meta.parentSessionId) continue;
    if (meta.tags) {
      for (const tag of meta.tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }

  return Array.from(tagCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);
});

// ============================================================
// Child Run State Atoms
// ============================================================

/** Derive child run state summary for a workstream/worktree card */
export const childRunStatesAtom = atomFamily((sessionId: string) =>
  atom((get): ChildRunStateSummary => {
    const registry = get(sessionRegistryAtom);
    const summary: ChildRunStateSummary = {
      running: 0, waiting: 0, blocked: 0, review: 0, idle: 0, done: 0, total: 0,
    };

    for (const [_id, meta] of registry) {
      const seen = new Set<string>();
      let parent: string | null | undefined = meta.parentSessionId;
      while (parent && parent !== sessionId && !seen.has(parent)) {
        seen.add(parent);
        parent = registry.get(parent)?.parentSessionId;
      }
      if (parent !== sessionId) continue;
      summary.total++;

      const isProcessing = get(sessionProcessingAtom(meta.id));
      const hasPendingPrompt = get(sessionHasPendingInteractivePromptAtom(meta.id));

      if (ownState(get, meta).column === 'blocked') {
        summary.blocked++;
      } else if (!meta.isArchived && (get(sessionAwaitingApprovalAtom(meta.id)) || hasPendingPrompt)) {
        summary.waiting++;
      } else if (!meta.isArchived && isProcessing) {
        summary.running++;
      } else if (ownState(get, meta).column === 'complete') {
        summary.done++;
      } else if (['validating', 'git'].includes(ownState(get, meta).column)) {
        summary.review++;
      } else {
        summary.idle++;
      }
    }

    return summary;
  })
);

// ============================================================
// Action Atoms
// ============================================================

/** Board drags do not change the agent's workflow phase or resolve its prompts. */
export const setSessionBoardColumnAtom = atom(null, async (get, set, { sessionId, phase }: {
  sessionId: string; phase: SessionBoardColumn | null;
}) => {
  const meta = get(sessionRegistryAtom).get(sessionId);
  const state = get(sessionAutomaticBoardStateAtom).get(sessionId);
  if (!meta || !state) return;
  if ((phase === 'complete' || phase === 'git') && state.column !== phase) return;
  if (state.column === 'blocked' && phase !== 'blocked') return;
  const kanbanOverride = phase ? { column: phase, status: state.status } : undefined;
  set(sessionRegistryAtom, new Map(get(sessionRegistryAtom)).set(sessionId, { ...meta, kanbanOverride }));
  try {
    const result = await window.electronAPI.invoke('sessions:update-session-metadata', sessionId, { kanbanOverride: kanbanOverride ?? null });
    if (result?.success === false) throw new Error(result.error || 'Unable to save board placement');
  } catch (error) {
    const current = get(sessionRegistryAtom).get(sessionId);
    if (current && current.kanbanOverride === kanbanOverride) {
      set(sessionRegistryAtom, new Map(get(sessionRegistryAtom)).set(sessionId, { ...current, kanbanOverride: meta.kanbanOverride }));
    }
    console.error('[sessionKanban] Failed to save board placement:', error);
  }
});

/** Install with the central session listeners so overrides expire even off-board. */
export function observeSessionKanbanStatus(store: ReturnType<typeof createStore>): () => void {
  const expire = () => {
    const automatic = store.get(sessionAutomaticBoardStateAtom);
    const registry = store.get(sessionRegistryAtom);
    const expired = [...registry.values()].filter(meta => meta.kanbanOverride && automatic.has(meta.id)
      && meta.kanbanOverride.status !== automatic.get(meta.id)!.status);
    if (!expired.length) return;
    const next = new Map(registry);
    for (const meta of expired) next.set(meta.id, { ...meta, kanbanOverride: undefined });
    store.set(sessionRegistryAtom, next);
    for (const meta of expired) {
      void window.electronAPI.invoke('sessions:update-session-metadata', meta.id, { kanbanOverride: null })
        .catch(error => console.error('[sessionKanban] Failed to expire board placement:', error));
    }
  };
  const stop = store.sub(sessionAutomaticBoardStateAtom, expire);
  expire();
  return stop;
}

/** Set the phase of a session (writes to metadata JSONB via IPC) */
export const setSessionPhaseAtom = atom(
  null,
  async (get, set, payload: { sessionId: string; phase: SessionPhase | null }) => {
    const { sessionId, phase } = payload;

    // Optimistic update in registry
    const registry = new Map(get(sessionRegistryAtom));
    const meta = registry.get(sessionId);
    if (meta) {
      registry.set(sessionId, { ...meta, phase: phase ?? undefined });
      set(sessionRegistryAtom, registry);
    }

    // Persist to database via existing IPC handler
    try {
      await window.electronAPI.invoke('sessions:update-session-metadata', sessionId, { phase: phase ?? null });
    } catch (error) {
      console.error('[sessionKanban] Failed to set phase:', error);
      // Revert optimistic update on failure
      if (meta) {
        const revertRegistry = new Map(get(sessionRegistryAtom));
        revertRegistry.set(sessionId, meta);
        set(sessionRegistryAtom, revertRegistry);
      }
    }
  }
);

/** Set tags on a session (writes to metadata JSONB via IPC) */
export const setSessionTagsAtom = atom(
  null,
  async (get, set, payload: { sessionId: string; tags: string[] }) => {
    const { sessionId, tags } = payload;

    // Optimistic update in registry
    const registry = new Map(get(sessionRegistryAtom));
    const meta = registry.get(sessionId);
    if (meta) {
      registry.set(sessionId, { ...meta, tags });
      set(sessionRegistryAtom, registry);
    }

    // Persist to database
    try {
      await window.electronAPI.invoke('sessions:update-session-metadata', sessionId, { tags });
    } catch (error) {
      console.error('[sessionKanban] Failed to set tags:', error);
      if (meta) {
        const revertRegistry = new Map(get(sessionRegistryAtom));
        revertRegistry.set(sessionId, meta);
        set(sessionRegistryAtom, revertRegistry);
      }
    }
  }
);
