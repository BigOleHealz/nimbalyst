import type { TrackerRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import {
  getRecordFieldStr,
  getRecordPriority,
  getRecordStatus,
  getRecordTitle,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';

const MAX_WORKTREE_NAME_LENGTH = 64;

export interface TrackerLaunchContext {
  trackerLinkId: string;
  draftInput: string;
  worktreeName: string;
}

function slugifyWorktreeName(value: string): string {
  return value
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function deriveTrackerWorktreeName(itemId: string, title: string): string {
  const itemSlug = slugifyWorktreeName(itemId) || 'tracker-item';
  const titleSlug = slugifyWorktreeName(title);
  const combined = titleSlug && titleSlug !== itemSlug
    ? `${itemSlug}-${titleSlug}`
    : itemSlug;

  return combined
    .slice(0, MAX_WORKTREE_NAME_LENGTH)
    .replace(/-+$/g, '');
}

/**
 * Refuse a launch whose item belongs to another project. A board that shows
 * another project's items (#1822) would otherwise start the agent in the
 * board's folder with a prompt about the other project.
 */
export function assertTrackerItemInWorkspace(
  trackerItem: TrackerRecord | undefined,
  workspacePath: string | null | undefined,
): asserts trackerItem is TrackerRecord {
  if (!trackerItem) {
    throw new Error('The tracker item is not loaded in this project.');
  }
  if (trackerItem.system.workspace !== workspacePath) {
    throw new Error(
      `This item belongs to ${trackerItem.system.workspace}, not ${workspacePath ?? 'this project'}.`,
    );
  }
}

export function buildTrackerLaunchContext(
  trackerItemId: string,
  trackerItem?: TrackerRecord,
): TrackerLaunchContext {
  const title = trackerItem ? getRecordTitle(trackerItem) : trackerItemId;
  const itemId = trackerItem?.issueKey || trackerItemId;
  const lines: string[] = [`implement tracker item ${itemId}: ${title}`];

  if (trackerItem) {
    const status = getRecordStatus(trackerItem);
    const priority = getRecordPriority(trackerItem);
    const description = getRecordFieldStr(trackerItem, 'description');
    const meta: string[] = [];
    if (trackerItem.primaryType) meta.push(`type: ${trackerItem.primaryType}`);
    if (status) meta.push(`status: ${status}`);
    if (priority) meta.push(`priority: ${priority}`);
    if (meta.length > 0) lines.push(meta.join(', '));
    if (description) lines.push(`\n${description}`);
    if (trackerItem.system.documentPath) {
      lines.push(`\nSource: @${trackerItem.system.documentPath}`);
    }
  }

  lines.push(`\nUpdate this tracker item's status when done using tracker_update with id "${itemId}".`);

  return {
    trackerLinkId: trackerItem?.system.documentPath
      ? `file:${trackerItem.system.documentPath}`
      : trackerItemId,
    draftInput: lines.join('\n'),
    worktreeName: deriveTrackerWorktreeName(itemId, title),
  };
}
