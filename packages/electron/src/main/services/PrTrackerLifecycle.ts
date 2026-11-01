/**
 * PR → tracker lifecycle writes after a confirmed merge.
 *
 * Reference-based and type-agnostic: applies to every non-archived tracker
 * item referencing the merged PR (url-field match or explicit
 * linkedPullRequests entry). Behavior per item:
 *
 *   - Schema declares the `prMergedStatus` role → transition workflow status
 *     to that value (the maintainer clicked Merge; this is their action, not
 *     an agent's) and record a comment.
 *   - No role declared → record a comment only; never invent status
 *     semantics for a type that didn't opt in.
 *
 * Polling also reconciles task completion for externally merged PRs. Other
 * types keep their opt-in lifecycle for merges performed in the PR view.
 */

import log from 'electron-log/main';
import { dbRowToRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { getRecordPrReferences } from '@nimbalyst/runtime/plugins/TrackerPlugin/prReferences';
import { globalRegistry, getRoleField } from '@nimbalyst/runtime/plugins/TrackerPlugin/models';
import {
  getRecordStatus,
  resolveRoleFieldName,
} from '@nimbalyst/runtime/plugins/TrackerPlugin/trackerRecordAccessors';
import { getDatabase } from '../database/initialize';
import { ElectronDocumentService } from './ElectronDocumentService';
import { handleTrackerAddComment } from '../mcp/tools/trackerToolHandlers';
import { getDoneStatusValue, isTerminalStatus } from '@nimbalyst/tracker-schema';
import { parseJsonObjectColumn } from '../utils/jsonColumn';
import { createGit } from './gitClient';
import { sanitizeGitRepositoryEnv } from './gitRepositoryEnv';

const logger = log.scope('PrTrackerLifecycle');

export async function applyPrMergeToTrackers(
  workspacePath: string,
  remote: string,
  prNumber: number,
  options: { headRef?: string; headSha?: string; automatic?: boolean } = {},
): Promise<void> {
  const db = getDatabase();
  const wanted = remote.toLowerCase();

  const result = await db.query<any>(
    `SELECT * FROM tracker_items WHERE workspace = $1 AND archived IS NOT TRUE`,
    [workspacePath],
  );

  const linkedTaskIds = new Set<string>();
  if (options.headRef && options.headSha) {
    const sessions = await db.query<any>(
      `SELECT s.metadata, w.path FROM ai_sessions s JOIN worktrees w ON s.worktree_id = w.id
       WHERE s.workspace_id = $1 AND w.workspace_id = $1 AND w.branch = $2`,
      [workspacePath, options.headRef],
    );
    for (const row of sessions.rows) {
      const ids = parseJsonObjectColumn(row.metadata).linkedTrackerItemIds;
      if (!Array.isArray(ids) || !ids.length) continue;
      // Branch names can be reused after a merge. Only associate this task if
      // its clean local HEAD is still the head that GitHub actually merged.
      try {
        const git = createGit(row.path, {}, sanitizeGitRepositoryEnv(process.env));
        const [head, status] = await Promise.all([git.revparse(['HEAD']), git.status()]);
        if (head.trim() !== options.headSha || !status.isClean()) continue;
        for (const id of ids) if (typeof id === 'string') linkedTaskIds.add(id);
      } catch (error) {
        logger.warn('Unable to confirm merged session branch', { path: row.path, error });
      }
    }
  }
  const referencing = result.rows
    .map((row: any) => dbRowToRecord(row))
    .filter((record) =>
      getRecordPrReferences(record).some((ref) => ref.remote === wanted && ref.number === prNumber)
        || (record.primaryType === 'task' && linkedTaskIds.has(record.id)),
    );

  if (referencing.length === 0) return;

  const docService = new ElectronDocumentService(workspacePath);

  for (const record of referencing) {
    try {
      if (options.automatic && record.primaryType !== 'task') continue;
      if (isTerminalStatus(record.primaryType, getRecordStatus(record))) continue;
      const model = globalRegistry.get(record.primaryType);
      const mergedStatus = (model ? getRoleField(model, 'prMergedStatus') : undefined)
        ?? (record.primaryType === 'task' ? getDoneStatusValue('task') : undefined);

      // A task referencing several PRs remains open until every one is merged.
      const others = getRecordPrReferences(record).filter(ref => ref.remote !== wanted || ref.number !== prNumber);
      if (record.primaryType === 'task' && others.length) {
        const cached = await db.query<any>('SELECT remote, number, state FROM pull_requests WHERE workspace_id = $1', [workspacePath]);
        if (others.some(ref => !cached.rows.some((pr: any) => pr.remote.toLowerCase() === ref.remote && pr.number === ref.number && pr.state === 'merged'))) continue;
      }

      if (mergedStatus && getRecordStatus(record) !== mergedStatus) {
        const statusFieldName = resolveRoleFieldName(record.primaryType, 'workflowStatus');
        await docService.updateTrackerItem(record.id, { [statusFieldName]: mergedStatus });
        logger.info('PR merge → tracker status transition', {
          itemId: record.id,
          prNumber,
          status: mergedStatus,
        });
      }

      await handleTrackerAddComment(
        {
          trackerId: record.id,
          body: `PR #${prNumber} merged (${new Date().toISOString().slice(0, 10)}).`,
        },
        workspacePath,
      );
    } catch (err) {
      logger.error('Failed to apply PR merge to tracker item', {
        itemId: record.id,
        prNumber,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
