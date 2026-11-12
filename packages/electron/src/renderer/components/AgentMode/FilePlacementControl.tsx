import React, { useEffect, useRef, useState } from "react";
import { FloatingFocusManager, useInteractions, useListNavigation } from "@floating-ui/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  agentFilePlacementAtom,
  agentFilePlacementNoticeAtom,
  type AgentFilePlacement,
} from "../../store/atoms/agentFilePlacement";
import { moveWorkstreamEditorAtom } from "../../store/atoms/agentFileViewer";
import { FloatingPortal, useFloatingMenu } from "../../hooks/useFloatingMenu";

const LAYOUT_OPTIONS = [
  { placement: "right", label: "Side by side", description: "Files on the right of the agent" },
  { placement: "above", label: "Stacked", description: "Files above the agent" },
] as const;

function LayoutIcon({ placement }: { placement: AgentFilePlacement }) {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true" className="shrink-0">
      <rect x="2" y="2" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
      {placement === "right" ? (
        <>
          <path d="M10 2v14" stroke="currentColor" />
          <path d="M11 4h3v10h-3z" fill="currentColor" opacity=".5" />
        </>
      ) : (
        <>
          <path d="M2 9h14" stroke="currentColor" />
          <path d="M4 4h10v3H4z" fill="currentColor" opacity=".5" />
        </>
      )}
    </svg>
  );
}

export function FilePlacementControl({
  workstreamId,
  onBeforeMove,
}: {
  workstreamId: string;
  onBeforeMove?: () => void;
}) {
  const placement = useAtomValue(agentFilePlacementAtom);
  const move = useSetAtom(moveWorkstreamEditorAtom);
  const menu = useFloatingMenu({ placement: "bottom-end" });
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const listRef = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = LAYOUT_OPTIONS.findIndex(option => option.placement === placement);
  const currentLabel = LAYOUT_OPTIONS[selectedIndex].label;
  const navigation = useListNavigation(menu.context, {
    listRef,
    activeIndex,
    selectedIndex,
    onNavigate: setActiveIndex,
    loop: true,
  });
  const { getReferenceProps, getFloatingProps, getItemProps } = useInteractions([navigation]);
  return (
    <>
      <button
        ref={menu.refs.setReference}
        {...getReferenceProps(menu.getReferenceProps())}
        type="button"
        className="file-placement-control shrink-0 h-8 px-2 flex items-center gap-1.5 rounded text-xs text-nim-muted hover:bg-nim-hover hover:text-nim cursor-pointer focus-visible:outline-2 focus-visible:outline-[var(--nim-border-focus)]"
        title="Choose file layout"
        aria-label={`File layout: ${currentLabel}`}
        aria-expanded={menu.isOpen}
        data-testid="agent-file-placement"
        onClick={() => menu.setIsOpen(!menu.isOpen)}
      >
        <LayoutIcon placement={placement} />
        <span className="whitespace-nowrap">{currentLabel}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="m3 4.5 3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {menu.isOpen && (
        <FloatingPortal>
          <FloatingFocusManager context={menu.context} modal={false}>
            <div
              ref={menu.refs.setFloating}
              style={menu.floatingStyles}
              {...getFloatingProps(menu.getFloatingProps())}
              aria-label="File layout"
              className="file-placement-menu z-[2000] min-w-[250px] max-w-[calc(100vw-16px)] rounded-md border border-nim bg-nim p-1 shadow-lg outline-none"
            >
              <div className="file-placement-menu-heading px-2 py-1.5 text-xs font-medium text-nim-muted">File layout</div>
              {LAYOUT_OPTIONS.map((option, index) => (
                <button
                  key={option.placement}
                  ref={element => { listRef.current[index] = element; }}
                  {...getItemProps()}
                  type="button"
                  role="menuitemradio"
                  aria-checked={placement === option.placement}
                  tabIndex={activeIndex === index ? 0 : -1}
                  className="file-placement-menu-option flex w-full items-center gap-2 rounded px-2 py-2 text-left text-nim cursor-pointer hover:bg-nim-hover focus:bg-nim-hover outline-none"
                  onClick={() => {
                    menu.setIsOpen(false);
                    if (option.placement === placement) return;
                    onBeforeMove?.();
                    move({ workstreamId, placement: option.placement });
                  }}
                >
                  <LayoutIcon placement={option.placement} />
                  <span className="flex-1">
                    <span className="block text-xs font-medium">{option.label}</span>
                    <span className="block text-[11px] text-nim-muted">{option.description}</span>
                  </span>
                  {placement === option.placement && (
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="text-nim-primary">
                      <path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </FloatingFocusManager>
        </FloatingPortal>
      )}
    </>
  );
}

export function FilePlacementNotice() {
  const [notice, setNotice] = useAtom(agentFilePlacementNoticeAtom);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice, setNotice]);
  return notice ? (
    <div
      className="file-placement-notice absolute bottom-3 left-3 right-3 z-10 rounded border border-nim bg-nim-secondary px-3 py-2 text-xs text-nim shadow"
      role="status"
    >
      {notice}
    </div>
  ) : null;
}
