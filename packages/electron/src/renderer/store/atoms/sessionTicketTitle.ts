import { atom } from 'jotai';
import { isDoneStatus } from '@nimbalyst/tracker-schema';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { sessionRegistryAtom } from './sessions';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { formatTicketTitle, getRecordPullRequestTitle, getRecordTicketKey, getTitleTicketKey, getRecordDisplayTitle, getRecordStatus, getStatusOptions } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';

/** Resolve both durable link directions once for the whole registry. */
const linkedTicketsAtom = atom(get => {
  const registry = get(sessionRegistryAtom);
  const records = get(trackerItemsMapAtom);
  const linked = new Map<string, TrackerRecord>();
  const link = (sessionId: string, itemId: string) => {
    if (linked.has(sessionId)) return;
    const session = registry.get(sessionId);
    const item = records.get(itemId);
    if (session && item && (!item.system.workspace || item.system.workspace === session.workspaceId)) linked.set(sessionId, item);
  };
  for (const session of registry.values()) {
    for (const itemId of session.linkedTrackerItemIds ?? []) link(session.id, itemId);
  }
  for (const item of records.values()) {
    for (const sessionId of item.system.linkedSessions ?? []) link(sessionId, item.id);
  }
  return linked;
});

/** Own ticket first, then the containing session; grouped roots include child links. */
const sessionTicketAtom = atomFamily((id: string) => atom(get => {
  const registry = get(sessionRegistryAtom);
  const session = registry.get(id);
  if (!session) return undefined;
  const linked = get(linkedTicketsAtom);
  if (linked.has(id)) return linked.get(id);
  const seen = new Set([id]);
  let parent = session.parentSessionId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const meta = registry.get(parent);
    if (!meta || meta.workspaceId !== session.workspaceId) break;
    if (linked.has(parent)) return linked.get(parent);
    parent = meta.parentSessionId;
  }
  if (!session.parentSessionId) {
    for (const meta of registry.values()) {
      if (!linked.has(meta.id) || meta.workspaceId !== session.workspaceId) continue;
      let ancestor: string | null | undefined = meta.parentSessionId;
      const visited = new Set<string>();
      while (ancestor && !visited.has(ancestor)) {
        if (ancestor === id) return linked.get(meta.id);
        visited.add(ancestor);
        ancestor = registry.get(ancestor)?.parentSessionId;
      }
    }
  }
  return undefined;
}));

export const sessionTicketKeyAtom = atomFamily((id: string) => atom(get => {
  const item = get(sessionTicketAtom(id));
  return item ? getRecordTicketKey(item) : undefined;
}));

export const sessionTicketDoneAtom = atomFamily((id: string) => atom(get => {
  const item = get(sessionTicketAtom(id));
  return !!item && isDoneStatus(item.primaryType, getRecordStatus(item));
}));

/** Keep meaningful session names; use the ticket description while naming is pending. */
export function formatSessionDisplayTitle(title: string, key?: string, ticketTitle?: string): string {
  const formatted = formatTicketTitle(title, key);
  const brief = key ? formatted.slice(key.length).replace(/^:\s*/, '') : formatted;
  if (ticketTitle?.trim() && /^(?:new conversation|new session|untitled(?: session| conversation)?)?$/i.test(brief.trim())) {
    return formatTicketTitle(ticketTitle, key);
  }
  return formatted || 'Untitled Session';
}

export const sessionTicketDescriptionAtom = atomFamily((id: string) => atom(get => {
  const item = get(sessionTicketAtom(id));
  return item ? getRecordDisplayTitle(item) : undefined;
}));

export const sessionTicketStatusLabelAtom = atomFamily((id: string) => atom(get => {
  const item = get(sessionTicketAtom(id));
  if (!item) return undefined;
  const status = getRecordStatus(item);
  if (!status) return undefined;
  return getStatusOptions(item.primaryType).find(option => option.value === status)?.label
    || status.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
}));

export const sessionDisplayTitleAtom = atomFamily((id: string) => atom(get => {
  const title = get(sessionRegistryAtom).get(id)?.title || 'Untitled Session';
  return formatSessionDisplayTitle(title, get(sessionTicketKeyAtom(id)) || getTitleTicketKey(title), get(sessionTicketDescriptionAtom(id)));
}));

export const sessionPullRequestTitleAtom = atomFamily((id: string) => atom(get => {
  const item = get(sessionTicketAtom(id));
  return item ? getRecordPullRequestTitle(item) : undefined;
}));
