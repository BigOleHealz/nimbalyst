import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getWorkflowStatusOptions } from '@nimbalyst/tracker-schema';
import { getRecordStatus } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { getStatusColor } from '@nimbalyst/runtime/plugins/TrackerPlugin/components/trackerColumns';
import type { PlanRow } from './trackerPlan';

export const DAG_NODE_WIDTH = 244;
export const DAG_NODE_HEIGHT = 124;
const COLUMN_GAP = 88;
export const DAG_COLUMN_STRIDE = DAG_NODE_WIDTH + COLUMN_GAP;
const ROW_GAP = 30;
const PADDING = 32;

export interface TicketDagEdge {
  id: string;
  source: string;
  target: string;
  kind: 'dependency' | 'subtask';
}
export interface TicketDagNode {
  id: string;
  row: PlanRow;
  x: number;
  y: number;
  stage: number;
  inCycle: boolean;
  outsidePrerequisiteCount: number;
}
export interface TicketDag {
  nodes: TicketDagNode[];
  edges: TicketDagEdge[];
  cycleEdges: TicketDagEdge[];
  width: number;
  height: number;
}

/** Match configured status colors, falling back to the Tracker's existing palette. */
export function ticketDagStatus(item: TrackerRecord) {
  const value = getRecordStatus(item);
  const option = getWorkflowStatusOptions(item.primaryType).find(candidate => candidate.value === value);
  return { value, label: option?.label ?? (value.replace(/-/g, ' ') || 'No status'), color: option?.color ?? getStatusColor(value, item.primaryType) };
}

/** Iterative Kosaraju keeps malformed cycles from overflowing the stack. */
function stronglyConnected(ids: string[], outgoing: Map<string, string[]>, incoming: Map<string, string[]>) {
  const seen = new Set<string>();
  const finished: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const stack = [{ id, index: 0 }];
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const next = outgoing.get(frame.id) ?? [];
      if (frame.index < next.length) {
        const child = next[frame.index++];
        if (!seen.has(child)) { seen.add(child); stack.push({ id: child, index: 0 }); }
      } else { finished.push(frame.id); stack.pop(); }
    }
  }
  const component = new Map<string, number>();
  const groups: string[][] = [];
  for (const id of finished.reverse()) {
    if (component.has(id)) continue;
    const group: string[] = [];
    const stack = [id];
    component.set(id, groups.length);
    while (stack.length) {
      const current = stack.pop()!;
      group.push(current);
      for (const parent of incoming.get(current) ?? []) if (!component.has(parent)) {
        component.set(parent, groups.length);
        stack.push(parent);
      }
    }
    groups.push(group);
  }
  return { component, groups };
}

/**
 * Arrows point from prerequisites to dependent work, including child -> parent
 * closeout. Stages are computed over the full plan before filtering. Cyclic
 * links are reported separately, preserving an acyclic execution diagram.
 */
export function buildTicketDag(rows: readonly PlanRow[], visibleIds: ReadonlySet<string>): TicketDag {
  const byId = new Map(rows.map(row => [row.item.id, row]));
  const order = new Map(rows.map((row, index) => [row.item.id, index]));
  const ids = [...byId.keys()];
  const outgoing = new Map(ids.map(id => [id, [] as string[]]));
  const incoming = new Map(ids.map(id => [id, [] as string[]]));
  const rawEdges: TicketDagEdge[] = [];
  for (const row of rows) for (const source of new Set(row.prerequisiteIds)) {
    if (!byId.has(source)) continue;
    const target = row.item.id;
    const kind = row.childIds.includes(source) ? 'subtask' : 'dependency';
    rawEdges.push({ id: `${source}:${target}`, source, target, kind });
    outgoing.get(source)!.push(target);
    incoming.get(target)!.push(source);
  }
  const { component, groups } = stronglyConnected(ids, outgoing, incoming);
  const componentTargets = groups.map(() => new Set<number>());
  const indegree = groups.map(() => 0);
  for (const edge of rawEdges) {
    const source = component.get(edge.source)!;
    const target = component.get(edge.target)!;
    if (source !== target && !componentTargets[source].has(target)) {
      componentTargets[source].add(target);
      indegree[target]++;
    }
  }
  const stage = groups.map(() => 0);
  const ready = groups.map((_, index) => index).filter(index => indegree[index] === 0);
  for (let i = 0; i < ready.length; i++) for (const target of componentTargets[ready[i]]) {
    stage[target] = Math.max(stage[target], stage[ready[i]] + 1);
    if (--indegree[target] === 0) ready.push(target);
  }
  const cycleEdges = rawEdges.filter(edge => component.get(edge.source) === component.get(edge.target));
  const cyclicIds = new Set(cycleEdges.flatMap(edge => [edge.source, edge.target]));
  const edges = rawEdges.filter(edge => !cyclicIds.has(edge.source) || component.get(edge.source) !== component.get(edge.target));

  // Keep independent work in separate horizontal lanes, ordered by the plan's deadlines.
  const selected = ids.filter(id => visibleIds.has(id));
  const placed = new Set<string>();
  const nodes: TicketDagNode[] = [];
  let laneY = PADDING + 32;
  for (const root of selected) {
    if (placed.has(root)) continue;
    const connected: string[] = [];
    const stack = [root];
    placed.add(root);
    while (stack.length) {
      const id = stack.pop()!;
      connected.push(id);
      for (const neighbor of [...outgoing.get(id)!, ...incoming.get(id)!]) {
        if (visibleIds.has(neighbor) && !placed.has(neighbor)) { placed.add(neighbor); stack.push(neighbor); }
      }
    }
    connected.sort((a, b) => order.get(a)! - order.get(b)!);
    const layerRows = new Map<number, number>();
    let laneHeight = 0;
    for (const id of connected) {
      const row = byId.get(id)!;
      const column = stage[component.get(id)!];
      const index = layerRows.get(column) ?? 0;
      layerRows.set(column, index + 1);
      laneHeight = Math.max(laneHeight, (index + 1) * (DAG_NODE_HEIGHT + ROW_GAP));
      nodes.push({ id, row, stage: column, x: PADDING + column * DAG_COLUMN_STRIDE, y: laneY + index * (DAG_NODE_HEIGHT + ROW_GAP), inCycle: cyclicIds.has(id), outsidePrerequisiteCount: row.prerequisiteIds.filter(id => !visibleIds.has(id)).length + row.unresolvedIds.length });
    }
    laneY += laneHeight + ROW_GAP;
  }
  return {
    nodes,
    edges: edges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)),
    cycleEdges: cycleEdges.filter(edge => visibleIds.has(edge.source) || visibleIds.has(edge.target)),
    width: Math.max(480, ...nodes.map(node => node.x + DAG_NODE_WIDTH + PADDING)),
    height: Math.max(240, laneY),
  };
}

export function connectedTicketIds(dag: TicketDag, selectedId: string | null | undefined): Set<string> {
  if (!selectedId) return new Set(dag.nodes.map(node => node.id));
  const connected = new Set([selectedId]);
  // Trace ancestors and descendants separately; unrelated siblings stay quiet.
  for (const direction of ['source', 'target'] as const) {
    const stack = [selectedId];
    const seen = new Set(stack);
    while (stack.length) {
      const id = stack.pop()!;
      for (const edge of dag.edges) {
        const next = direction === 'source' ? (edge.target === id ? edge.source : null) : (edge.source === id ? edge.target : null);
        if (next && !seen.has(next)) { seen.add(next); connected.add(next); stack.push(next); }
      }
    }
  }
  return connected;
}
