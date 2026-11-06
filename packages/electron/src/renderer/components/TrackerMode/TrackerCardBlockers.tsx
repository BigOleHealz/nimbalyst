import React from "react";
import type { Readiness } from "@nimbalyst/tracker-core";
import {
  describeUnresolvedBlockers,
  isOutOfScopeBlocker,
  projectBlockedBy,
  type BlockerVisibilityScope,
} from "@nimbalyst/runtime/plugins/TrackerPlugin/models/trackerBlockerVisibility";

/** Keep the reason visible on the card, including when its blocker is filtered out. */
export function TrackerCardBlockers({
  readiness,
  scope = {},
  onOpenItem,
}: {
  readiness?: Readiness;
  scope?: BlockerVisibilityScope;
  onOpenItem?: (id: string) => void;
}) {
  if (!readiness || readiness.state === "closed") return null;
  const blockers = projectBlockedBy(readiness.blockedBy, scope);
  if (!blockers.length && !readiness.unresolvedBlockerIds.length) return null;
  return (
    <div
      className="tracker-card-blockers w-full border-t border-nim pt-1.5 text-[11px] text-nim-muted select-text"
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      {blockers.length > 0 && (
        <>
          <div className="font-semibold text-[var(--nim-warning)]">
            Blocked by
          </div>
          <ul className="m-0 mt-1 flex list-none flex-col gap-1 p-0">
            {blockers.map((blocker) => (
              <li key={blocker.itemId}>
                {isOutOfScopeBlocker(blocker) ? (
                  <span>
                    A {blocker.type} outside this view · {blocker.status}
                  </span>
                ) : (
                  <button
                    type="button"
                    className="tracker-card-blocker-link w-full text-left hover:underline"
                    draggable={false}
                    onClick={() => onOpenItem?.(blocker.itemId)}
                    disabled={!onOpenItem}
                    aria-label={`Open blocker ${blocker.ref}: ${
                      blocker.title ?? "Untitled"
                    }`}
                  >
                    <span className="font-mono">{blocker.ref}</span> ·{" "}
                    {blocker.title ?? "Untitled"}{" "}
                    <span className="text-nim-faint">({blocker.status})</span>
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {readiness.inCycle && (
        <p className="m-0 mt-1 text-[var(--nim-warning)]">
          Dependency cycle: change a dependency to unblock this work.
        </p>
      )}
      {readiness.unresolvedBlockerIds.length > 0 && (
        <p className="m-0 mt-1">
          {describeUnresolvedBlockers(readiness.unresolvedBlockerIds.length)}
        </p>
      )}
    </div>
  );
}
