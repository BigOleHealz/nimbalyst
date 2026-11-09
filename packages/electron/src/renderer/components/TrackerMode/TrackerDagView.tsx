import { clientSessionClass } from '@nimbalyst/runtime/core/clientSessionHighlight';
import React, { useEffect, useId, useMemo, useRef } from 'react';
import { getRecordDisplayTitle as getRecordTitle } from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import type { PlanRow } from './trackerPlan';
import { buildTicketDag, connectedTicketIds, DAG_COLUMN_STRIDE, DAG_NODE_HEIGHT, DAG_NODE_WIDTH, ticketDagStatus } from './trackerDag';
import { useTicketDagViewport } from './useTicketDagViewport';
import './TrackerDagView.css';

interface Props {
  plan: PlanRow[];
  visibleIds: ReadonlySet<string>;
  selectedItemId?: string | null;
  onItemSelect: (id: string) => void;
  onItemClick?: (event: React.MouseEvent, itemId: string) => void;
  onItemContextMenu?: (event: React.MouseEvent, itemId: string) => void;
}
const dateLabel = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

export function TrackerDagView({ plan, visibleIds, selectedItemId, onItemSelect, onItemClick, onItemContextMenu }: Props) {
  const dag = useMemo(() => buildTicketDag(plan, visibleIds), [plan, visibleIds]);
  const nodeById = useMemo(() => new Map(dag.nodes.map(node => [node.id, node])), [dag]);
  const connected = useMemo(() => connectedTicketIds(dag, selectedItemId), [dag, selectedItemId]);
  const legend = useMemo(() => [...new Map(dag.nodes.map(node => {
    const status = ticketDagStatus(node.row.item);
    return [`${status.label}:${status.color}`, status];
  })).values()], [dag]);
  const { viewportRef, sceneRef, percentRef, zoomBy, fit, focus } = useTicketDagViewport(dag.width, dag.height);
  const nextReady = useRef(0);
  const pointerSelection = useRef<string | null>(null);
  const arrowId = `ticket-dag-arrow-${useId().replace(/:/g, '')}`;
  const selectedNode = selectedItemId ? nodeById.get(selectedItemId) : undefined;
  useEffect(() => {
    // Keep pointer-selected nodes stationary so the second click of a double
    // click lands on the same ticket when its right sidebar opens.
    if (selectedNode && pointerSelection.current !== selectedNode.id) focus({ x: selectedNode.x, y: selectedNode.y, width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT });
  }, [focus, selectedNode]);
  const stages = [...new Set(dag.nodes.map(node => node.stage))].sort((a, b) => a - b);

  return <section className="tracker-dag-view" aria-label="Ticket execution DAG">
    <div className="tracker-dag-toolbar">
      <div className="tracker-dag-direction">Complete work from left to right</div>
      <div className="tracker-dag-tools" role="group" aria-label="Graph controls">
        <button type="button" onClick={() => zoomBy(1 / 1.2)} aria-label="Zoom out">−</button>
        <span ref={percentRef} className="tracker-dag-zoom">100%</span>
        <button type="button" onClick={() => zoomBy(1.2)} aria-label="Zoom in">+</button>
        <button type="button" onClick={fit}>Fit all</button>
        <button type="button" disabled={!selectedNode} onClick={() => selectedNode && focus({ x: selectedNode.x, y: selectedNode.y, width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT })}>Focus selected</button>
        <button type="button" disabled={!dag.nodes.some(node => node.row.ready)} onClick={() => {
          const ready = dag.nodes.filter(node => node.row.ready);
          const node = ready[nextReady.current++ % ready.length];
          if (node) { pointerSelection.current = null; focus({ x: node.x, y: node.y, width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT }); onItemSelect(node.id); }
        }}>Next ready ticket</button>
      </div>
    </div>
    <div className="tracker-dag-legend" aria-label="Ticket status colors">
      {legend.map(status => <span key={`${status.label}:${status.color}`}><i style={{ borderColor: status.color }} />{status.label}</span>)}
      <span className="tracker-dag-edge-key">Solid arrow: dependency · Dashed arrow: subtask to parent closeout</span>
    </div>
    {dag.cycleEdges.length > 0 && <div className="tracker-dag-warning select-text" role="status">{dag.cycleEdges.length} cyclic link(s) need attention. Affected tickets stay visible; conflicting arrows are omitted because their execution order cannot be determined.</div>}
    <div className="tracker-dag-viewport" ref={viewportRef} tabIndex={0} aria-label="Ticket dependency graph. Drag or scroll to pan; pinch or use plus and minus to zoom. Arrow keys pan; zero fits all tickets." data-testid="tracker-dag-viewport">
      <svg className="tracker-dag-canvas" width="100%" height="100%" role="group" aria-label="Tickets and prerequisite arrows">
        <defs><marker id={arrowId} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="context-stroke" /></marker></defs>
        <g ref={sceneRef}>
          {stages.map(stage => <text key={stage} className="tracker-dag-stage" x={32 + stage * DAG_COLUMN_STRIDE} y={30}>{stage === 0 ? '1 · Start here' : `${stage + 1} · After prerequisites`}</text>)}
          {dag.edges.map(edge => {
            const source = nodeById.get(edge.source)!;
            const target = nodeById.get(edge.target)!;
            const x1 = source.x + DAG_NODE_WIDTH;
            const y1 = source.y + DAG_NODE_HEIGHT / 2;
            const x2 = target.x;
            const y2 = target.y + DAG_NODE_HEIGHT / 2;
            const mid = (x1 + x2) / 2;
            const highlighted = selectedItemId && connected.has(edge.source) && connected.has(edge.target);
            return <path key={edge.id} className={`tracker-dag-edge ${edge.kind === 'subtask' ? 'tracker-dag-edge-subtask' : ''} ${highlighted ? 'tracker-dag-edge-highlighted' : ''}`} d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`} markerEnd={`url(#${arrowId})`} aria-label={`${getRecordTitle(source.row.item)} must finish before ${getRecordTitle(target.row.item)}`} />;
          })}
          {dag.nodes.map(node => {
            const { row } = node;
            const status = ticketDagStatus(row.item);
            const title = getRecordTitle(row.item);
            return <foreignObject key={node.id} x={node.x} y={node.y} width={DAG_NODE_WIDTH} height={DAG_NODE_HEIGHT} className="tracker-dag-node-container">
              <button type="button" className={`${clientSessionClass(row.item)} tracker-dag-node ${selectedItemId === node.id ? 'tracker-dag-node-selected' : ''} ${selectedItemId && !connected.has(node.id) ? 'tracker-dag-node-muted' : ''}`} style={{ borderColor: status.color }} aria-label={`Open ticket ${title}, ${status.label}`} aria-pressed={selectedItemId === node.id} data-ticket-id={node.id} onClick={event => { pointerSelection.current = event.detail > 0 ? node.id : null; if (onItemClick) onItemClick(event, node.id); else onItemSelect(node.id); }} onContextMenu={event => onItemContextMenu?.(event, node.id)} onDoubleClick={event => onItemContextMenu?.(event, node.id)} onFocus={event => { if (event.currentTarget.matches(':focus-visible')) focus({ x: node.x, y: node.y, width: DAG_NODE_WIDTH, height: DAG_NODE_HEIGHT }); }}>
                <span className="tracker-dag-node-top"><span style={{ color: status.color }}>{status.label}</span><span>{row.effectiveDue ? `${row.due === row.effectiveDue ? 'Due' : 'By'} ${dateLabel(row.effectiveDue)}` : 'Undated'}</span></span>
                <span className="tracker-dag-node-title">{title}</span>
                <span className={`tracker-dag-node-bottom ${row.held || row.conflict ? 'tracker-dag-node-attention' : ''}`}>{row.completed ? 'Completed' : node.inCycle ? 'Dependency cycle' : row.held ? 'Needs attention' : row.ready ? 'Ready now' : row.childIds.length ? 'Parent closeout' : row.prerequisiteIds.length ? 'After prerequisites' : 'Scheduled'}{node.outsidePrerequisiteCount > 0 ? ` · ${node.outsidePrerequisiteCount} outside view` : ''}{row.conflict ? ' · date conflict' : ''}</span>
              </button>
            </foreignObject>;
          })}
        </g>
      </svg>
    </div>
    <p className="tracker-dag-hint select-text">Click a ticket to open its details on the right. Drag empty space or scroll to pan; pinch to zoom. Independent paths can progress in parallel.</p>
  </section>;
}
