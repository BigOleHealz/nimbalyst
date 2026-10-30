import React, { useEffect } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  agentModeLayoutAtomFamily, pendingAgentModeRestoresAtom,
  secondarySessionFocusedAtom, updateOpenSessionsAtom,
} from '../../store/atoms/agentMode';
import { sessionRegistryAtom, setActiveSessionAtom, sessionProcessingAtom, sessionHasPendingInteractivePromptAtom } from '../../store/atoms/sessions';
import { sessionAwaitingApprovalAtom } from '../../store/atoms/sessionApproval';
import { AgentSessionPanel } from './AgentSessionPanel';
import { SessionTab } from './WorkstreamSessionTabs';

interface SessionWorkspaceProps {
  workspacePath: string;
  isActive?: boolean;
  activeSessionId: string | null;
  showBoard: boolean;
  onShowBoard: () => void;
  onSelectSession: (id: string) => void;
  onClearSelection: () => void;
  onFileClick?: (path: string) => void;
  board: React.ReactNode;
  children: React.ReactNode;
}

/** The same status projection used by the board, including interactive input. */
function SessionTabStatus({ sessionId }: { sessionId: string }) {
  const running = useAtomValue(sessionProcessingAtom(sessionId));
  const input = useAtomValue(sessionHasPendingInteractivePromptAtom(sessionId));
  const approval = useAtomValue(sessionAwaitingApprovalAtom(sessionId));
  return <span className="session-workspace-tab-status text-xs text-nim-muted" aria-live="polite">
    {input || approval ? 'Waiting for input' : running ? 'Running' : ''}
  </span>;
}

/** Open views contain IDs only. Transcripts, drafts, and runners remain session-owned. */
export function SessionWorkspace({
  workspacePath, isActive = true, activeSessionId, showBoard, onShowBoard, onSelectSession,
  onClearSelection, onFileClick, board, children,
}: SessionWorkspaceProps) {
  const layout = useAtomValue(agentModeLayoutAtomFamily(workspacePath));
  const pendingRestores = useAtomValue(pendingAgentModeRestoresAtom(workspacePath));
  const registry = useAtomValue(sessionRegistryAtom);
  const update = useSetAtom(updateOpenSessionsAtom);
  const setSecondaryFocused = useSetAtom(secondarySessionFocusedAtom(workspacePath));
  const secondaryFocused = useAtomValue(secondarySessionFocusedAtom(workspacePath));
  const setActiveSession = useSetAtom(setActiveSessionAtom);

  // Track navigation from every existing entry point, including child tabs,
  // notifications and quick-open. Do not write defaults over an in-flight restore.
  useEffect(() => {
    if (!activeSessionId || pendingRestores || store.get(pendingAgentModeRestoresAtom(workspacePath))) return;
    const current = store.get(agentModeLayoutAtomFamily(workspacePath));
    if (!current.openSessionIds.includes(activeSessionId)) {
      update({ workspacePath, openSessionIds: [...current.openSessionIds, activeSessionId] });
    }
  }, [workspacePath, activeSessionId, pendingRestores, update]);

  const openIds = layout.openSessionIds.filter(id => {
    const meta = registry.get(id);
    return meta && !meta.isArchived && (!meta.workspaceId || meta.workspaceId === workspacePath);
  });
  const secondaryId = layout.secondarySessionId && openIds.includes(layout.secondarySessionId)
    && layout.secondarySessionId !== activeSessionId ? layout.secondarySessionId : null;

  useEffect(() => { setSecondaryFocused(false); }, [activeSessionId, secondaryId, showBoard, setSecondaryFocused]);

  useEffect(() => {
    if (!isActive || showBoard || !secondaryFocused || !secondaryId) return;
    const find = () => window.dispatchEvent(new CustomEvent('transcript:find', { detail: { sessionId: secondaryId } }));
    const next = () => window.dispatchEvent(new CustomEvent('transcript:find-next', { detail: { sessionId: secondaryId } }));
    window.addEventListener('menu:find', find);
    window.addEventListener('menu:find-next', next);
    return () => { window.removeEventListener('menu:find', find); window.removeEventListener('menu:find-next', next); };
  }, [isActive, showBoard, secondaryFocused, secondaryId]);

  const select = (id: string) => {
    // Selecting the right-hand session swaps it with the left, avoiding two
    // mounted inputs (and editor hosts) for the same session.
    if (id === layout.secondarySessionId) {
      update({ workspacePath, secondarySessionId: activeSessionId });
    }
    setSecondaryFocused(false);
    onSelectSession(id);
  };

  const close = (id: string) => {
    const remaining = layout.openSessionIds.filter(openId => openId !== id);
    update({ workspacePath, openSessionIds: remaining,
      secondarySessionId: layout.secondarySessionId === id ? null : layout.secondarySessionId });
    if (id === activeSessionId) {
      const next = openIds.filter(openId => openId !== id).at(-1);
      if (next) select(next);
      else { onClearSelection(); onShowBoard(); }
    }
  };

  const splitCandidate = openIds.find(id => id !== activeSessionId);

  return (
    <div className="session-workspace flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
      <div className="session-workspace-tabs flex items-center gap-1 px-2 py-1 border-b border-nim bg-nim-secondary shrink-0">
        <button className="session-workspace-board nim-btn-icon-sm" onClick={onShowBoard}
          aria-label="Session board" aria-pressed={showBoard} title="Session board">
          <MaterialSymbol icon="view_kanban" size={18} />
        </button>
        <div className="session-workspace-tab-scroll flex flex-1 min-w-0 gap-1 overflow-x-auto">
          {openIds.map(id => (
            <div key={id} className="session-workspace-tab flex shrink-0 items-center gap-1">
              <SessionTab sessionId={id} isActive={!showBoard && id === activeSessionId}
                onClick={() => select(id)} onClose={() => close(id)} />
              <SessionTabStatus sessionId={id} />
              <button className="session-workspace-split-tab nim-btn-icon-sm"
                disabled={!activeSessionId || id === activeSessionId}
                aria-label={`Open ${registry.get(id)?.title || 'Untitled'} side by side`}
                title="Open side by side"
                onClick={() => { if (activeSessionId) { update({ workspacePath, secondarySessionId: id }); onSelectSession(activeSessionId); } }}>
                <MaterialSymbol icon="vertical_split" size={14} />
              </button>
            </div>
          ))}
        </div>
        <button className="session-workspace-toggle-split nim-btn-icon-sm"
          aria-label={secondaryId ? 'Close split pane' : 'Split sessions side by side'}
          title={secondaryId ? 'Close split pane (agent keeps running)' : 'Split sessions side by side'}
          disabled={!secondaryId && (!splitCandidate || !activeSessionId)}
          onClick={() => {
            update({ workspacePath, secondarySessionId: secondaryId ? null : splitCandidate });
            setSecondaryFocused(false);
            if (activeSessionId) onSelectSession(activeSessionId);
          }}>
          <MaterialSymbol icon={secondaryId ? 'close_fullscreen' : 'vertical_split'} size={18} />
        </button>
      </div>
      {showBoard ? board : (
        <div className="session-workspace-panes flex flex-1 min-h-0 min-w-0 overflow-hidden">
          <div className="session-workspace-primary flex flex-col flex-1 min-w-0 overflow-hidden"
            onFocusCapture={() => { setSecondaryFocused(false); if (activeSessionId) setActiveSession(activeSessionId); }}>
            {children}
          </div>
          {secondaryId && (
            <div className="session-workspace-secondary flex flex-col flex-1 min-w-0 border-l border-nim overflow-hidden"
              onFocusCapture={() => { setSecondaryFocused(true); setActiveSession(secondaryId); }}>
              <div className="session-workspace-secondary-header flex items-center gap-2 px-3 py-1 border-b border-nim">
                <span className="session-workspace-secondary-title flex-1 truncate text-sm select-text">{registry.get(secondaryId)?.title}</span>
                <SessionTabStatus sessionId={secondaryId} />
              </div>
              <AgentSessionPanel key={secondaryId} sessionId={secondaryId}
                workspacePath={workspacePath} onFileClick={onFileClick} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
