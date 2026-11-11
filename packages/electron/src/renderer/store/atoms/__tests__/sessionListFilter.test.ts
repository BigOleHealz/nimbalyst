// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { createStore } from 'jotai';
import { loadBuiltinTrackers } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/ModelLoader';
import { trackerItemsMapAtom } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerDataAtoms';
import { sessionRegistryAtom } from '../sessions';
import { hideDoneTicketsAtom } from '../ticketVisibility';
import { hiddenDoneTicketSessionIdsAtom } from '../sessionKanban';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import {
  isWorkstreamParentSession,
  matchesSessionListTag,
  VIRTUAL_TAG_WORKSTREAMS,
  VIRTUAL_TAG_WORKTREE,
} from '../sessionListFilter';

function session(overrides: Partial<SessionMeta> & Pick<SessionMeta, 'id'>): SessionMeta {
  const { id, ...rest } = overrides;
  return {
    id,
    title: id,
    provider: 'test',
    sessionType: 'session',
    workspaceId: '/workspace',
    worktreeId: null,
    parentSessionId: null,
    childCount: 0,
    uncommittedCount: 0,
    createdAt: 1,
    updatedAt: 1,
    messageCount: 0,
    isArchived: false,
    isPinned: false,
    ...rest,
  };
}

describe('session list virtual tags', () => {
  const workstream = session({
    id: 'workstream',
    sessionType: 'workstream',
    childCount: 1,
  });
  const child = session({ id: 'child', parentSessionId: workstream.id });
  const standalone = session({ id: 'standalone', tags: ['feature'] });
  const worktreeSession = session({ id: 'worktree-session', worktreeId: 'wt-1' });
  const registry = new Map([workstream, child, standalone, worktreeSession].map(s => [s.id, s]));

  it('matches #workstreams for a workstream parent and its children only', () => {
    expect(matchesSessionListTag(workstream, VIRTUAL_TAG_WORKSTREAMS, registry)).toBe(true);
    expect(matchesSessionListTag(child, VIRTUAL_TAG_WORKSTREAMS, registry)).toBe(true);
    expect(matchesSessionListTag(standalone, VIRTUAL_TAG_WORKSTREAMS, registry)).toBe(false);
    expect(matchesSessionListTag(worktreeSession, VIRTUAL_TAG_WORKSTREAMS, registry)).toBe(false);
  });

  it('recognizes legacy child-bearing roots as workstreams without including blitzes', () => {
    expect(isWorkstreamParentSession(session({ id: 'legacy', childCount: 2 }))).toBe(true);
    expect(isWorkstreamParentSession(session({
      id: 'blitz',
      sessionType: 'blitz',
      childCount: 2,
    }))).toBe(false);
  });

  it('preserves the existing #worktree and persisted-tag predicates', () => {
    expect(matchesSessionListTag(worktreeSession, VIRTUAL_TAG_WORKTREE, registry)).toBe(true);
    expect(matchesSessionListTag(standalone, 'feature', registry)).toBe(true);
    expect(matchesSessionListTag(standalone, 'missing', registry)).toBe(false);
  });
});


beforeAll(() => loadBuiltinTrackers());

describe('hide done ticket sessions', () => {
  const ticket = (id: string, status: string, linkedSessions: string[] = []) => ({
    id, primaryType: 'task', fields: { title: id, status }, system: { workspace: '/workspace', linkedSessions },
  } as any);

  it('hides by linked ticket status, keeps unlinked and cancelled work, and reacts to reopening', () => {
    const store = createStore();
    const sessions = [
      session({ id: 'finished', linkedTrackerItemIds: ['done'], phase: 'planning' }),
      session({ id: 'open', linkedTrackerItemIds: ['open'], phase: 'complete' }),
      session({ id: 'unlinked', phase: 'complete' }),
      session({ id: 'cancelled', linkedTrackerItemIds: ['cancelled'] }),
      session({ id: 'reverse' }),
    ];
    const items = [ticket('done', 'done'), ticket('open', 'in-progress'), ticket('cancelled', 'cancelled'), ticket('reverse-ticket', 'done', ['reverse'])];
    store.set(sessionRegistryAtom, new Map(sessions.map(item => [item.id, item])));
    store.set(trackerItemsMapAtom, new Map(items.map(item => [item.id, item])));
    expect([...store.get(hiddenDoneTicketSessionIdsAtom)]).toEqual([]);
    store.set(hideDoneTicketsAtom, true);
    expect([...store.get(hiddenDoneTicketSessionIdsAtom)].sort()).toEqual(['finished', 'reverse']);
    store.set(trackerItemsMapAtom, new Map(items.map(item => [item.id, item.id === 'done' ? ticket('done', 'in-review') : item])));
    expect([...store.get(hiddenDoneTicketSessionIdsAtom)]).toEqual(['reverse']);
    store.set(hideDoneTicketsAtom, false);
    expect([...store.get(hiddenDoneTicketSessionIdsAtom)]).toEqual([]);
  });

  it('keeps containers for unfinished children and hides completed descendants', () => {
    const store = createStore();
    const sessions = [
      session({ id: 'parent', linkedTrackerItemIds: ['done'], childCount: 2 }),
      session({ id: 'inherited', parentSessionId: 'parent' }),
      session({ id: 'open-child', parentSessionId: 'parent', linkedTrackerItemIds: ['open'] }),
      session({ id: 'other-project', workspaceId: '/other', linkedTrackerItemIds: ['done'] }),
    ];
    store.set(sessionRegistryAtom, new Map(sessions.map(item => [item.id, item])));
    store.set(trackerItemsMapAtom, new Map([['done', ticket('done', 'done')], ['open', ticket('open', 'in-progress')]]));
    store.set(hideDoneTicketsAtom, true);
    expect([...store.get(hiddenDoneTicketSessionIdsAtom)]).toEqual(['inherited']);
    store.set(trackerItemsMapAtom, new Map([['done', ticket('done', 'done')], ['open', ticket('open', 'done')]]));
    expect([...store.get(hiddenDoneTicketSessionIdsAtom)].sort()).toEqual(['inherited', 'open-child', 'parent']);
  });

  it('uses schema Done categories and workflow roles for custom ticket types', () => {
    const model = globalRegistry.get('task')!;
    const type = 'visibility-test-task';
    globalRegistry.register({ ...model, type, roles: { ...model.roles, workflowStatus: 'phase' }, fields: model.fields.map(field => field.name === 'status' ? { ...field, name: 'phase', options: [{ value: 'shipped', label: 'Shipped', category: 'done' }] } : field) });
    const store = createStore();
    store.set(sessionRegistryAtom, new Map([['custom', session({ id: 'custom', linkedTrackerItemIds: ['custom-ticket'] })]]));
    store.set(trackerItemsMapAtom, new Map([['custom-ticket', { ...ticket('custom-ticket', ''), primaryType: type, fields: { title: 'Shipped ticket', phase: 'shipped' } }]]));
    store.set(hideDoneTicketsAtom, true);
    expect([...store.get(hiddenDoneTicketSessionIdsAtom)]).toEqual(['custom']);
  });
});
