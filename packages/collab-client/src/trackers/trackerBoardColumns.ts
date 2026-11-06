/**
 * Pure board-column derivation and drop resolution. `none` retains the legacy
 * status board, status columns preserve schema order, and other axes end with
 * an empty bucket that can remove relationship membership.
 */

import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import type { TrackerRelationshipValue } from '@nimbalyst/tracker-schema';
import {
  addRelationshipValue,
  MANUAL_TRACKER_ORDERING,
  normalizeRelationshipValue,
  resolveEmptyTrackerGroup,
  resolveGroupingRelationshipField,
  resolveGroupingRelationshipValues,
  resolveTrackerGroups,
  resolveTrackerOrderingValue,
  serializeRelationshipValue,
  type TrackerGroupBy,
  type TrackerGroupingAxis,
  type TrackerOrdering,
  type TrackerRelationshipGroupingAxis,
  type TrackerRelationshipLabelResolver,
} from './model';
import {
  buildKanbanStatusColumns,
  getRecordSortOrder,
  getRecordStatus,
  resolveRoleFieldName,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { compareCellValues } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerRowData';
import { globalRegistry, isTerminalStatus } from '@nimbalyst/tracker-schema';
import { generateKeyBetween } from '@nimbalyst/runtime/utils/fractionalIndex';
import type { TrackerStatusScope } from './model';
import type { Readiness } from '@nimbalyst/tracker-core';

export interface TrackerBoardColumn {
  /**
   * Stable column key. On the status axis this is the bare status value, so the
   * board's long-standing `tracker-kanban-column-<status>` markers are unchanged;
   * on every other axis it is the grouping resolver's namespaced key.
   */
  key: string;
  /** Stored value this column represents, or null for the trailing empty bucket. */
  value: string | null;
  label: string;
  /** True only for the trailing no-value bucket ("No milestone", "Unassigned"). */
  empty: boolean;
  /**
   * The denormalized relationship value a relationship column was derived from.
   * Carried so a drop rewrites the same `title`/`issueKey` other surfaces already
   * display, rather than a label reconstructed from whatever survived.
   */
  ref?: TrackerRelationshipValue;
  fieldValue?: unknown;
  /** Live dependency lane; never writes a synthetic workflow status. */
  dependency?: boolean;
}

const RELATIONSHIP_AXES: readonly TrackerGroupingAxis[] = ['milestone', 'goal'];

function isRelationshipAxis(axis: TrackerGroupingAxis): axis is TrackerRelationshipGroupingAxis {
  return RELATIONSHIP_AXES.includes(axis);
}

/** The axis the board actually lays out; `none` is a status board. */
export function resolveBoardAxis(groupBy: TrackerGroupBy): TrackerGroupingAxis {
  return groupBy === 'none' ? 'status' : groupBy;
}

/**
 * Which type to resolve a status lane against on the all-types board.
 *
 * A lane there is just a status value, and the same value can be declared by
 * several types. Any type that declares it answers the same way for terminality
 * (that is what a shared value means), so the first item carrying it decides;
 * with no item at all the lane is empty anyway and the fallback is harmless.
 */
function columnOwnerType(status: string, items: TrackerRecord[]): string {
  const match = items.find(item => (getRecordStatus(item) || '').toLowerCase() === status);
  return match?.primaryType ?? '';
}

/** The board's columns, left to right. */
export function buildTrackerBoardColumns(
  groupBy: TrackerGroupBy,
  filterType: string,
  items: TrackerRecord[],
  resolveLabel?: TrackerRelationshipLabelResolver,
  statusScope: TrackerStatusScope = 'all',
  readinessByItemId?: ReadonlyMap<string, Readiness>,
): TrackerBoardColumn[] {
  const columns = buildBaseBoardColumns(groupBy, filterType, items, resolveLabel, statusScope);
  if (!readinessByItemId || statusScope === 'closed') return columns;
  // A schema may already have a manual Blocked status (e.g. Plans). Keep a
  // single lane for it and dependency-blocked work, preserving stored statuses.
  const existing = resolveBoardAxis(groupBy) === 'status' ? columns.findIndex(column => column.key === 'blocked') : -1;
  if (existing >= 0) return columns.map((column, index) => index === existing ? { ...column, dependency: true } : column);
  columns.splice(Math.min(1, columns.length), 0, {
    key: 'dependency:blocked', value: null, label: 'Blocked', empty: false, dependency: true,
  });
  return columns;
}

function buildBaseBoardColumns(
  groupBy: TrackerGroupBy,
  filterType: string,
  items: TrackerRecord[],
  /** Names relationship lanes from the referenced record; see the resolver's docs. */
  resolveLabel?: TrackerRelationshipLabelResolver,
  /**
   * Lifecycle scope. On `open`, terminal lanes are dropped -- the scope has
   * already removed their cards, so leaving the lanes would render a row of
   * permanently empty columns pushing the working ones off screen.
   * `all` and `closed` keep every lane the schema declares.
   */
  statusScope: TrackerStatusScope = 'all',
): TrackerBoardColumn[] {
  const axis = resolveBoardAxis(groupBy);
  if (typeof axis === 'object') {
    const field = globalRegistry.get(filterType)?.fields.find(candidate => candidate.name === axis.fieldId);
    if (!field || field.multiValue || !['select', 'boolean', 'user', 'relationship'].includes(field.type)) return [];
    const columns = new Map<string, TrackerBoardColumn>();
    const options = field.type === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : field.options ?? [];
    for (const option of options) {
      const value = typeof option === 'string' ? option : option.value;
      const label = typeof option === 'string' ? option : option.label;
      const key = `field:${axis.fieldId}:value:${encodeURIComponent(value)}`;
      columns.set(key, { key, value, label, empty: false });
    }
    for (const item of items) for (const group of resolveTrackerGroups(item, axis, resolveLabel)) {
      if (!columns.has(group.key)) columns.set(group.key, { ...group, fieldValue: item.fields[axis.fieldId] });
    }
    return [...columns.values()].filter(column => !column.empty).concat([...columns.values()].filter(column => column.empty));
  }
  if (axis === 'status') {
    const type = filterType === 'all' ? '' : filterType;
    return buildKanbanStatusColumns(filterType, items)
      .filter(column => (
        statusScope !== 'open'
        // In the all-types board no single type owns the lane, so the lane is
        // named by value and resolved against whichever type declares it.
        || !isTerminalStatus(type || columnOwnerType(column.value, items), column.value)
      ))
      .map(column => ({
        key: column.value,
        value: column.value,
        label: column.label,
        empty: false,
      }));
  }

  const byKey = new Map<string, TrackerBoardColumn>();
  for (const item of items) {
    const refs = isRelationshipAxis(axis)
      ? new Map(resolveGroupingRelationshipValues(item, axis).map(ref => [ref.itemId, ref]))
      : null;
    for (const group of resolveTrackerGroups(item, axis, resolveLabel)) {
      if (group.empty || byKey.has(group.key)) continue;
      byKey.set(group.key, {
        key: group.key,
        value: group.value,
        label: group.label,
        empty: false,
        ...(group.value && refs?.get(group.value) ? { ref: refs.get(group.value) } : {}),
      });
    }
  }

  // Alphabetical rather than first-seen: a lane must not jump position because a
  // filter changed which item happened to be scanned first.
  const columns = [...byKey.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));

  const emptyGroup = resolveEmptyTrackerGroup(axis);
  columns.push({ key: emptyGroup.key, value: null, label: emptyGroup.label, empty: true });
  return columns;
}

/**
 * Distribute items into columns, sorted within each.
 *
 * A multi-value axis (tags, and an item in several milestones) intentionally
 * places the same card in every column it belongs to.
 */
export function groupItemsIntoBoardColumns(
  items: TrackerRecord[],
  columns: TrackerBoardColumn[],
  axis: TrackerGroupingAxis,
  ordering: TrackerOrdering,
  readinessByItemId?: ReadonlyMap<string, Readiness>,
): Record<string, TrackerRecord[]> {
  const grouped: Record<string, TrackerRecord[]> = {};
  for (const column of columns) grouped[column.key] = [];
  const blockedColumn = columns.find(column => column.dependency);

  for (const item of items) {
    if (blockedColumn && readinessByItemId?.get(item.id)?.state === 'blocked') {
      grouped[blockedColumn.key].push(item);
      continue;
    }
    if (axis === 'status') {
      // Preserved from the status-only board: an item whose status has no column
      // lands in the first one rather than disappearing off the board.
      const status = (getRecordStatus(item) || 'to-do').toLowerCase();
      const key = grouped[status] ? status : (columns.find(column => !column.dependency)?.key ?? 'to-do');
      (grouped[key] ??= []).push(item);
      continue;
    }
    for (const group of resolveTrackerGroups(item, axis)) {
      (grouped[group.key] ??= []).push(item);
    }
  }

  for (const key of Object.keys(grouped)) {
    grouped[key] = sortBoardColumnItems(grouped[key], ordering);
  }
  return grouped;
}

/** Order one column's cards by the view's ordering. */
export function sortBoardColumnItems(
  items: TrackerRecord[],
  ordering: TrackerOrdering,
): TrackerRecord[] {
  if (items.length <= 1) return items;
  const sorted = [...items];
  if (ordering === MANUAL_TRACKER_ORDERING) {
    sorted.sort((a, b) => {
      // Raw comparison, not localeCompare -- fractional indexing keys are built
      // to sort by character code order (0-9, A-Z, a-z).
      const aKey = getRecordSortOrder(a) ?? '';
      const bKey = getRecordSortOrder(b) ?? '';
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
    return sorted;
  }
  sorted.sort((a, b) => compareCellValues(
    resolveTrackerOrderingValue(a, ordering),
    resolveTrackerOrderingValue(b, ordering),
  ));
  return sorted;
}

export interface BoardDropRequest {
  item: TrackerRecord;
  axis: TrackerGroupingAxis;
  /**
   * Key of the column the drag started in, or `null` when the caller cannot say.
   *
   * A multi-value axis renders the same card in every lane it belongs to, so
   * "is the card already in the target column?" does not answer "did this drag
   * cross lanes?" -- a card in Alpha and Beta is in Beta both before and after
   * you drag its Alpha copy there, and reading that as "stayed put" makes the
   * drag a no-op that leaves Alpha behind. Only the source key separates a
   * reorder within one lane from a reassignment between two lanes the card
   * already occupies. `null` falls back to the membership test, which is right
   * for every single-value axis.
   */
  sourceColumnKey: string | null;
  targetColumn: TrackerBoardColumn;
  /** The target column's cards as rendered, including the dragged one. */
  columnItems: TrackerRecord[];
  /** Insertion index measured against `columnItems`; null means "at the end". */
  dropIndex: number | null;
  readinessByItemId?: ReadonlyMap<string, Readiness>;
}

/**
 * Everything one drop writes: the new `kanbanSortOrder`, plus the axis field
 * when the card crossed columns. `null` means the drop writes nothing -- the
 * axis is not draggable, so moving the card there would change nothing a
 * reader could see.
 */
export function resolveBoardDrop(request: BoardDropRequest): Record<string, unknown> | null {
  const { item, axis, sourceColumnKey, targetColumn, columnItems, dropIndex } = request;
  // Dependency membership changes with the graph, not with a drag. Reordering
  // within Blocked is fine; dragging never clears a relationship or invents a status.
  if (sourceColumnKey !== targetColumn.key && (targetColumn.dependency || request.readinessByItemId?.get(item.id)?.state === 'blocked')) return null;
  // Two different questions. `renderedInTarget` is about the list the drop index
  // was measured against; `stayedPut` is about whether the axis field changed.
  const renderedInTarget = columnItems.some(candidate => candidate.id === item.id);
  const stayedPut = sourceColumnKey === null
    ? renderedInTarget
    : sourceColumnKey === targetColumn.key;

  const axisWrite = stayedPut ? {} : resolveBoardColumnWrite(item, axis, targetColumn);
  if (!axisWrite) return null;

  const neighbors = columnItems.filter(candidate => candidate.id !== item.id);
  // The drop index was measured against the rendered cards, which still include
  // the dragged one; drop it out and the index shifts by one when the card
  // started above the insertion point.
  let index = dropIndex ?? neighbors.length;
  if (renderedInTarget) {
    const originalIndex = columnItems.findIndex(candidate => candidate.id === item.id);
    if (originalIndex >= 0 && originalIndex < index) index--;
  }
  index = Math.max(0, Math.min(index, neighbors.length));

  const previous = index > 0 ? getRecordSortOrder(neighbors[index - 1]) ?? null : null;
  const next = index < neighbors.length ? getRecordSortOrder(neighbors[index]) ?? null : null;

  return { ...axisWrite, kanbanSortOrder: generateKeyBetween(previous, next) };
}

/**
 * The field updates a drop into `target` must write, or `null` when the axis
 * cannot be reassigned by dragging.
 *
 * `type`, `tag`, and `assignee` return null: a lane's key for those is a derived
 * or lossy form (a lowercased identity, one of several tags), and writing it
 * back would be a guess. Grouping by them still works -- a card just cannot be
 * dragged out of its lane. Dropping into a scalar axis's empty bucket is a
 * no-op for the same reason; only the relationship axes have a defined
 * "belongs to nothing".
 */
export function resolveBoardColumnWrite(
  item: TrackerRecord,
  axis: TrackerGroupingAxis,
  target: TrackerBoardColumn,
): Record<string, unknown> | null {
  if (typeof axis === 'object') {
    const field = globalRegistry.get(item.primaryType)?.fields.find(candidate => candidate.name === axis.fieldId);
    if (!field || field.multiValue) return null;
    if (field.type === 'boolean') return { [field.name]: target.value === null ? null : target.value === 'true' };
    if (field.type === 'select') {
      if (target.value !== null && !field.options?.some(option => (typeof option === 'string' ? option : option.value) === target.value)) return null;
      return { [field.name]: target.value };
    }
    if (field.type === 'user') return target.empty ? { [field.name]: null } : target.fieldValue === undefined ? null : { [field.name]: target.fieldValue };
    if (field.type === 'relationship') {
      const refs = normalizeRelationshipValue(target.fieldValue);
      return target.empty ? { [field.name]: serializeRelationshipValue(field, []) } : refs.length === 1 ? { [field.name]: serializeRelationshipValue(field, refs) } : null;
    }
    return null;
  }
  switch (axis) {
    case 'status':
      return target.value === null
        ? null
        : { [resolveRoleFieldName(item.primaryType, 'workflowStatus')]: target.value };
    case 'priority':
      return target.value === null
        ? null
        : { [resolveRoleFieldName(item.primaryType, 'priority')]: target.value };
    case 'milestone':
    case 'goal':
      return resolveRelationshipWrite(item, axis, target);
    default:
      return null;
  }
}

/**
 * Milestone and goal membership are multi-value relationships, but a board drag
 * REASSIGNS rather than adds: a card sits in exactly the lane you dropped it in,
 * or the lanes it had before the drag would still show it and the board would
 * lie about where the work is. Memberships this axis does not represent --
 * `collection` also holds releases -- are preserved.
 */
function resolveRelationshipWrite(
  item: TrackerRecord,
  axis: TrackerRelationshipGroupingAxis,
  target: TrackerBoardColumn,
): Record<string, unknown> | null {
  const field = resolveGroupingRelationshipField(item.primaryType, axis);
  if (!field) return null;

  const onAxis = new Set(resolveGroupingRelationshipValues(item, axis).map(value => value.itemId));
  const kept = normalizeRelationshipValue(item.fields[field.name])
    .filter(value => !onAxis.has(value.itemId));

  if (target.value === null) return { [field.name]: serializeRelationshipValue(field, kept) };

  // `trackerType` is stamped rather than trusted: a legacy value stored without
  // one still groups here, and rewriting it untyped would keep it ambiguous.
  const next = addRelationshipValue(field, kept, {
    ...(target.ref ?? { title: target.label }),
    itemId: target.value,
    trackerType: axis,
  });
  return { [field.name]: serializeRelationshipValue(field, next) };
}
