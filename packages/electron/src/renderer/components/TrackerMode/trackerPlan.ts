import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { globalRegistry, isTerminalStatus } from '@nimbalyst/tracker-schema';
import { normalizeRelationshipValue } from '@nimbalyst/tracker-core';
import { getFieldByRole, getRecordPriority, getRecordStatus, getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { computeReadiness } from '@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerReadiness';

export interface PlanRow {
  item: TrackerRecord;
  parentId?: string;
  childIds: string[];
  prerequisiteIds: string[];
  unresolvedIds: string[];
  due: string | null;
  effectiveDue: string | null;
  deadlineSourceId: string;
  start: string | null;
  depth: number;
  ready: boolean;
  held: boolean;
  conflict: boolean;
}

/** Calendar dates remain calendar dates, including across timezone and DST changes. */
export function planDate(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value);
  if (!match) return null;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? `${match[1]}-${match[2]}-${match[3]}` : null;
}

function relationIds(item: TrackerRecord, key: string): string[] {
  const fields = globalRegistry.get(item.primaryType)?.fields ?? [];
  return fields.filter(field => field.relationshipTypeKey === key)
    .flatMap(field => normalizeRelationshipValue(item.fields[field.name]).map(ref => ref.itemId));
}

/**
 * An execution order, not a duration forecast. A child precedes parent closeout;
 * explicit dependencies precede their dependents. Earlier deadlines propagate
 * backwards so an undated prerequisite can outrank unrelated later work.
 * Read the full corpus before filtering: closed blockers satisfy dependencies,
 * and hidden children must still prevent a parent from appearing ready.
 */
export function buildTrackerPlan(items: readonly TrackerRecord[], now = new Date()): PlanRow[] {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const byId = new Map(items.map(item => [item.id, item]));
  const readiness = computeReadiness([...items], getRecordStatus);
  const active = items.filter(item => !item.archived && !isTerminalStatus(item.primaryType, getRecordStatus(item)));
  const rows = new Map<string, PlanRow>(active.map(item => {
    const due = planDate(getFieldByRole(item, 'dueDate'));
    return [item.id, {
      item, childIds: [], prerequisiteIds: [], unresolvedIds: [], due,
      effectiveDue: due, deadlineSourceId: item.id,
      start: planDate(item.fields.scheduledDate ?? item.fields.startDate),
      depth: 0, ready: false, held: false, conflict: false,
    }];
  }));

  // Explicit child-side parent is authoritative; inverse-only legacy links work too.
  const parents = new Map<string, string>();
  for (const item of items) {
    const parent = relationIds(item, 'child-of')[0];
    if (parent) parents.set(item.id, parent);
  }
  for (const item of items) {
    for (const child of relationIds(item, 'parent-of')) {
      if (!parents.has(child)) parents.set(child, item.id);
    }
  }
  for (const row of rows.values()) {
    const parentId = parents.get(row.item.id);
    row.parentId = parentId;
    const seen = new Set([row.item.id]);
    let ancestor = parentId;
    while (ancestor && !seen.has(ancestor)) {
      seen.add(ancestor);
      row.depth++;
      const parent = byId.get(ancestor);
      const due = parent && planDate(getFieldByRole(parent, 'dueDate'));
      if (due && (!row.effectiveDue || due < row.effectiveDue)) {
        row.effectiveDue = due;
        row.deadlineSourceId = ancestor;
      }
      ancestor = parents.get(ancestor);
    }
    if (ancestor) row.held = true;
    const parent = parentId && rows.get(parentId);
    if (parent) parent.childIds.push(row.item.id);
    const state = readiness.get(row.item.id);
    row.prerequisiteIds = [...new Set([...(state?.blockedBy.map(ref => ref.itemId) ?? [])])];
    row.unresolvedIds = [...(state?.unresolvedBlockerIds ?? [])];
    if (parentId && !byId.has(parentId)) row.unresolvedIds.push(parentId);
  }
  for (const row of rows.values()) {
    // Archiving is not completion: an archived unfinished child still gates closeout.
    for (const [childId, parentId] of parents) {
      const child = byId.get(childId);
      if (parentId === row.item.id && child?.archived && !isTerminalStatus(child.primaryType, getRecordStatus(child))) row.childIds.push(childId);
    }
    row.prerequisiteIds = [...new Set([...row.prerequisiteIds, ...row.childIds])];
    // A missing referenced child is unfinished work of unknown status.
    for (const child of relationIds(row.item, 'parent-of')) {
      if (!byId.has(child)) row.unresolvedIds.push(child);
    }
  }

  const dependents = new Map<string, string[]>();
  for (const row of rows.values()) for (const id of row.prerequisiteIds) {
    dependents.set(id, [...(dependents.get(id) ?? []), row.item.id]);
  }
  // Monotone relaxation terminates even on malformed cyclic relationships.
  const deadlines = [...rows.values()];
  for (let i = 0; i < deadlines.length; i++) {
    const row = deadlines[i];
    if (!row.effectiveDue) continue;
    for (const id of row.prerequisiteIds) {
      const prerequisite = rows.get(id);
      if (prerequisite && (!prerequisite.effectiveDue || row.effectiveDue < prerequisite.effectiveDue)) {
        prerequisite.effectiveDue = row.effectiveDue;
        prerequisite.deadlineSourceId = row.deadlineSourceId;
        deadlines.push(prerequisite);
      }
    }
  }
  const priority: Record<string, number> = { critical: 0, urgent: 0, high: 1, medium: 2, low: 3 };
  const compare = (a: PlanRow, b: PlanRow) =>
    (a.effectiveDue ?? '9999').localeCompare(b.effectiveDue ?? '9999')
    || (priority[getRecordPriority(a.item)] ?? 4) - (priority[getRecordPriority(b.item)] ?? 4)
    || getRecordTitle(a.item).localeCompare(getRecordTitle(b.item)) || a.item.id.localeCompare(b.item.id);
  const remaining = new Map([...rows].map(([id, row]) => [id, row.prerequisiteIds.length]));
  const available = [...rows.values()].filter(row => !remaining.get(row.item.id) && !row.unresolvedIds.length && !row.held);
  for (const row of available) row.ready = !row.start || row.start <= today;
  const ordered: PlanRow[] = [];
  while (available.length) {
    available.sort(compare);
    const row = available.shift()!;
    ordered.push(row);
    for (const id of dependents.get(row.item.id) ?? []) {
      remaining.set(id, remaining.get(id)! - 1);
      const next = rows.get(id)!;
      if (!remaining.get(id) && !next.unresolvedIds.length && !next.held) available.push(next);
    }
  }
  const emitted = new Set(ordered.map(row => row.item.id));
  const held = [...rows.values()].filter(row => !emitted.has(row.item.id)).sort(compare);
  for (const row of held) row.held = true;
  for (const row of rows.values()) {
    row.conflict = Boolean((row.due && row.effectiveDue && row.due > row.effectiveDue)
      || (row.start && row.effectiveDue && row.start > row.effectiveDue));
  }
  return [...ordered, ...held];
}

export function planHierarchy(rows: readonly PlanRow[], collapsed: ReadonlySet<string>): PlanRow[] {
  const ids = new Set(rows.map(row => row.item.id));
  const children = new Map<string, PlanRow[]>();
  for (const row of rows) if (row.parentId && ids.has(row.parentId)) {
    children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
  }
  const roots = rows.filter(row => !row.parentId || !ids.has(row.parentId));
  const result: PlanRow[] = [];
  const visited = new Set<string>();
  const walk = (root: PlanRow) => {
    const stack = [root];
    while (stack.length) {
      const row = stack.pop()!;
      if (visited.has(row.item.id)) continue;
      visited.add(row.item.id);
      result.push(row);
      if (!collapsed.has(row.item.id)) stack.push(...[...(children.get(row.item.id) ?? [])].reverse());
    }
  };
  roots.forEach(walk);
  // A hierarchy cycle has no root. Surface it instead of dropping its tickets.
  for (const row of rows) if (!visited.has(row.item.id)) {
    let ancestor = row.parentId;
    const seen = new Set<string>();
    let hidden = false;
    while (ancestor && ids.has(ancestor) && !seen.has(ancestor)) {
      if (collapsed.has(ancestor)) { hidden = true; break; }
      seen.add(ancestor);
      ancestor = rows.find(candidate => candidate.item.id === ancestor)?.parentId;
    }
    if (!hidden) walk(row);
  }
  return result;
}
