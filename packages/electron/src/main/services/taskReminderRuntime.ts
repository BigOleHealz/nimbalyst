import { basename } from 'path';
import { isActiveCalendarTask } from '@nimbalyst/tracker-core';
import { globalRegistry } from '@nimbalyst/tracker-schema';
import { trackerItemToRecord } from '@nimbalyst/runtime/core/TrackerRecord';
import { documentServices } from '../window/WindowManager';
import { getWorkspaceState, updateWorkspaceState } from '../utils/store';
import { logger } from '../utils/logger';
import { notificationService } from './NotificationService';
import { DEFAULT_TASK_REMINDERS, TaskReminderService } from './TaskReminderService';
import { ensureWorkspaceTrackerSchemasLoaded } from './TrackerSchemaService';

const service = new TaskReminderService({
  workspaces: () => [...documentServices.keys()],
  readState: workspacePath => getWorkspaceState(workspacePath).taskReminders ?? DEFAULT_TASK_REMINDERS,
  writeState: (workspacePath, next) => { updateWorkspaceState(workspacePath, state => { state.taskReminders = next; }); },
  listTasks: async workspacePath => {
    const source = documentServices.get(workspacePath);
    if (!source) return [];
    const items = await source.listTrackerItems();
    ensureWorkspaceTrackerSchemasLoaded(workspacePath);
    return items.map(trackerItemToRecord);
  },
  isActiveTask: (workspacePath, item) => isActiveCalendarTask(item, { getTypeModel: type => globalRegistry.getForWorkspace(workspacePath, type) }),
  notify: async (workspacePath, title, body) => {
    const result = await notificationService.showNotificationWithResult({
      workspacePath, title: `${basename(workspacePath)} · ${title}`, body,
      bypassFocusCheck: true,
    });
    if (result.error) logger.main.warn('[TaskReminders] Notification delivery failed:', result.error);
    return result.shown;
  },
  onError: (workspacePath, error) => logger.main.error('[TaskReminders] Reminder check failed:', workspacePath, error),
});

export const checkTaskReminders = () => service.check();

/** Runs independently of the current renderer mode and never opens a database itself. */
export function startTaskReminders(): () => void {
  void checkTaskReminders();
  const timer = setInterval(() => { void checkTaskReminders(); }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
