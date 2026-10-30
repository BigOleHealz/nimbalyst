import type { ChatSession, SessionStore } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import { logger } from '../utils/logger';

function isReviewOverride(value: unknown): boolean {
  return !!value && typeof value === 'object' && 'column' in value && value.column === 'validating';
}

/** Observe committed phase transitions without introducing another phase store. */
export function createReviewNotifyingSessionStore(
  base: SessionStore,
  notify: (session: ChatSession) => Promise<void>,
  isActive: (sessionId: string) => boolean,
): SessionStore {
  const phaseWrites = new Map<string, Promise<void>>();
  return {
    ...base,
    async updateMetadata(sessionId, update) {
      const overridesColumn = Object.hasOwn(update.metadata ?? {}, 'kanbanOverride');
      if (!Object.hasOwn(update.metadata ?? {}, 'phase') && !overridesColumn) {
        return base.updateMetadata(sessionId, update);
      }
      // Two simultaneous writes of validating are one entry, not two alerts.
      // Serialize phase writes only; token usage and other metadata stay fast.
      const write = (phaseWrites.get(sessionId) ?? Promise.resolve()).catch(() => {}).then(async () => {
        let previous: ChatSession | null = null;
        const entersReview = overridesColumn
          ? isReviewOverride(update.metadata?.kanbanOverride)
          : update.metadata?.phase === 'validating';
        if (entersReview) {
          try {
            previous = await base.get(sessionId);
          } catch (error) {
            logger.main.warn('[ReviewNotifyingSessionStore] Failed to read prior phase:', sessionId, error);
          }
        }
        await base.updateMetadata(sessionId, update);
        const wasReview = overridesColumn
          ? isReviewOverride(previous?.metadata?.kanbanOverride)
          : previous?.metadata?.phase === 'validating';
        if (
          !previous || wasReview || (update.isArchived ?? previous.isArchived) ||
          (update.metadata?.hasPendingPrompt ?? previous.metadata?.hasPendingPrompt) || isActive(sessionId)
        ) return;
        try {
          await notify(previous);
        } catch (error) {
          logger.main.warn('[ReviewNotifyingSessionStore] Failed to notify review:', sessionId, error);
        }
      });
      phaseWrites.set(sessionId, write);
      try {
        await write;
      } finally {
        if (phaseWrites.get(sessionId) === write) phaseWrites.delete(sessionId);
      }
    },
  };
}
