import { safeHandle } from '../utils/ipcRegistry';
import { getWorkspaceState, updateWorkspaceState } from '../utils/store';
import { isReminderTime, taskReminderPreferences, type TaskReminderPreferences } from '../../shared/taskReminderPreferences';
import { checkTaskReminders } from '../services/taskReminderRuntime';

function requireWorkspace(workspacePath: unknown): asserts workspacePath is string {
  if (typeof workspacePath !== 'string' || !workspacePath.trim()) throw new Error('Task reminders require workspacePath');
}
export function registerTaskReminderHandlers(): void {
  safeHandle('task-reminders:get', async (_event, workspacePath: string) => {
    requireWorkspace(workspacePath);
    return taskReminderPreferences(getWorkspaceState(workspacePath).taskReminders);
  });
  safeHandle('task-reminders:set', async (_event, workspacePath: string, options: TaskReminderPreferences) => {
    requireWorkspace(workspacePath);
    if (typeof options?.enabled !== 'boolean') throw new Error('enabled must be a boolean');
    if (!Array.isArray(options.times) || options.times.length < 1 || options.times.length > 8 || !options.times.every(isReminderTime)) throw new Error('times must contain 1 to 8 HH:mm values in local time');
    if (typeof options.notifyOnStartup !== 'boolean') throw new Error('notifyOnStartup must be a boolean');
    const preferences = taskReminderPreferences(options);
    updateWorkspaceState(workspacePath, state => {
      state.taskReminders = { ...state.taskReminders, ...preferences };
      delete state.taskReminders.time;
    });
    void checkTaskReminders();
    return preferences;
  });
}
