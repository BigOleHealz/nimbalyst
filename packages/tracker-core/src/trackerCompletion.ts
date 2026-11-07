import type { TrackerCoreContext } from './context.js';
import { getWorkflowStatusFieldName, isDoneStatus } from './trackerStatusCategory.js';

/** Completion belongs to the current Done interval, rather than the last edit. */
export function trackerCompletionUpdate(
  ctx: TrackerCoreContext,
  type: string,
  previous: Record<string, unknown> | undefined,
  next: Record<string, unknown>,
  now: string = new Date().toISOString(),
): { completedAt?: string | null } {
  const field = getWorkflowStatusFieldName(ctx, type);
  const done = (fields: Record<string, unknown>) =>
    isDoneStatus(ctx, type, typeof fields[field] === 'string' ? fields[field] : undefined);
  if (done(next)) {
    if (!previous) {
      return { completedAt: typeof next.completedAt === 'string' && Number.isFinite(Date.parse(next.completedAt)) ? next.completedAt : now };
    }
    if (!done(previous)) return { completedAt: now };
    // Legacy Done items have no known completion date. Never invent one on edit.
    return previous.completedAt !== undefined
      ? { completedAt: previous.completedAt as string | null }
      : {};
  }
  return previous && done(previous) && previous.completedAt != null ? { completedAt: null } : {};
}
