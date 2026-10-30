/**
 * Session Kanban Board Atoms
 *
 * State for the session kanban board view in TrackerMode.
 * Board placement derives from existing operational state. Workflow phases
 * remain independent; manual board overrides live in the same session metadata.
 */

import { atom, type Getter, type createStore } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import type { SessionMeta } from '@nimbalyst/runtime';
import { sessionAwaitingApprovalAtom } from './sessionApproval';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { getRecordPrReferences } from '@nimbalyst/runtime/plugins/TrackerPlugin/prReferences';
import { prListAtom } from './pullRequests';
import { worktreeRecordsAtom } from './worktrees';
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

/** Card type determines visual treatment and whether child run states are shown */
export type KanbanCardType = 'session' | 'workstream' | 'worktree';

/** Summary of child session states for a workstream/worktree card */
export interface ChildRunStateSummary {
  running: number;
  waiting: number;
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
  { value: 'implementing', label: 'Running', color: 'var(--nim-primary)' },
  { value: 'awaiting-input', label: 'Awaiting Input', color: 'var(--nim-warning)' },
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

function ownColumn(get: Getter, meta: SessionMeta): SessionBoardColumn {
  if (meta.isArchived) return 'complete';
  if (get(sessionAwaitingApprovalAtom(meta.id)) || get(sessionHasPendingInteractivePromptAtom(meta.id))) return 'awaiting-input';
  if (get(sessionProcessingAtom(meta.id))) return 'implementing';

  const records = get(trackerItemsMapAtom);
  const references = (meta.linkedTrackerItemIds ?? []).flatMap(id => {
    const record = records.get(id);
    return record ? getRecordPrReferences(record) : [];
  });
  const branch = meta.worktreeId ? get(worktreeRecordsAtom).get(meta.worktreeId)?.branch : undefined;
  const prs = get(prListAtom).filter(pr => pr.workspaceId === meta.workspaceId && (
    (branch && pr.headRef === branch) || references.some(ref => ref.remote === pr.remote.toLowerCase() && ref.number === pr.number)
  ));
  if (prs.some(pr => pr.state === 'open')) return 'validating';
  if (prs.some(pr => pr.state === 'merged')) return 'complete';
  // A completed agent turn is reviewable work, not evidence of a merge.
  return meta.hasStarted || meta.messageCount > 0 || get(sessionHasActivityAtom(meta.id)) ? 'validating' : 'backlog';
}

/** Derived from existing status sources; includes descendants in a grouped card. */
export const sessionAutomaticBoardStateAtom = atom(get => {
  const registry = get(sessionRegistryAtom);
  const own = new Map([...registry].map(([id, meta]) => [id, ownColumn(get, meta)]));
  const result = new Map<string, { column: SessionBoardColumn; status: string }>();
  const priority = ['awaiting-input', 'implementing', 'validating', 'backlog', 'complete'];
  for (const [id, meta] of registry) {
    if (meta.parentSessionId) continue;
    const states = sessionArchiveSubtreeIds(registry, [id]).map(childId => [childId, own.get(childId)!] as [string, SessionBoardColumn]);
    const candidates = states.length > 1 && (meta.sessionType === 'workstream' || meta.sessionType === 'blitz' || own.get(id) === 'backlog')
      ? states.filter(([childId]) => childId !== id) : states;
    const column = meta.isArchived ? 'complete' : [...candidates].sort((a, b) => priority.indexOf(a[1]) - priority.indexOf(b[1]))[0][1];
    result.set(id, { column, status: JSON.stringify(states.sort(([a], [b]) => a.localeCompare(b))) });
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

  const grouped = new Map<SessionPhaseKey, SessionMeta[]>();
  grouped.set('unphased', []);
  for (const col of SESSION_BOARD_COLUMNS) {
    grouped.set(col.value, []);
  }

  for (const [_id, meta] of registry) {
    // Only show root sessions (not children of workstreams)
    if (meta.parentSessionId) continue;

    const state = automatic.get(meta.id)!;
    const override = meta.kanbanOverride;
    const phase = override && override.status === state.status && VALID_COLUMNS.has(override.column)
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
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
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
    if (meta.parentSessionId) continue;
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
      running: 0, waiting: 0, review: 0, idle: 0, done: 0, total: 0,
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

      if (meta.isArchived) {
        summary.done++;
      } else if (get(sessionAwaitingApprovalAtom(meta.id)) || hasPendingPrompt) {
        summary.waiting++;
      } else if (isProcessing) {
        summary.running++;
      } else if (ownColumn(get, meta) === 'complete') {
        summary.done++;
      } else if (ownColumn(get, meta) === 'validating') {
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
