import { atom } from 'jotai';
import { sessionRegistryAtom } from './sessions';
import { sessionTicketDoneAtom } from './sessionTicketTitle';

/** Shared, session-only preference across Agent mode and the Planner. */
export const hideDoneTicketsAtom = atom(false);

const NO_HIDDEN_SESSIONS: ReadonlySet<string> = new Set();

export const hiddenDoneTicketSessionIdsAtom = atom<ReadonlySet<string>>(get => {
  if (!get(hideDoneTicketsAtom)) return NO_HIDDEN_SESSIONS;
  const registry = get(sessionRegistryAtom);
  const hidden = new Set<string>();
  for (const session of registry.values()) {
    if (get(sessionTicketDoneAtom(session.id))) hidden.add(session.id);
  }
  // Keep ancestors as navigation containers when unfinished descendants remain.
  for (const session of registry.values()) {
    if (session.isArchived || hidden.has(session.id)) continue;
    const seen = new Set([session.id]);
    let parent = session.parentSessionId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const ancestor = registry.get(parent);
      if (!ancestor || ancestor.workspaceId !== session.workspaceId) break;
      hidden.delete(parent);
      parent = ancestor.parentSessionId;
    }
  }
  return hidden;
});
