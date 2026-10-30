import { composeNotificationTitle } from '../../shared/notificationTitle';
import { isSessionReviewNotificationsEnabled } from '../utils/store';
import { notificationService } from './NotificationService';
import { isDesktopTrulyAway } from './SyncManager';
import { requestMobilePush } from './ai/mobilePushRequest';

/** Shared by completed turns and explicit, idle kanban review transitions. */
export async function notifySessionReview(
  sessionId: string,
  sessionName: string,
  workspacePath: string,
  body = 'Ready for your review',
  reason = 'session_complete',
): Promise<void> {
  if (!isSessionReviewNotificationsEnabled()) return;

  // Keep the existing mobile presence policy: completion alerts go to the
  // phone when the desktop is locked/idle, avoiding Continuity duplicates.
  // Push acknowledgement must not delay finishing the agent's turn. The
  // existing push helper catches and reports transport failures itself.
  if (isDesktopTrulyAway()) {
    void requestMobilePush(sessionId, sessionName, body, { reason });
  }
  await notificationService.showNotification({
    title: composeNotificationTitle(sessionName, 'Ready for Review'),
    body,
    kind: 'agent-complete',
    sessionId,
    workspacePath,
    sourceLabel: sessionName,
  });
}
