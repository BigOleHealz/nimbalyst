import { isActiveCalendarTask, localCalendarDay, taskCalendarEntries, type TrackerRecord } from '@nimbalyst/tracker-core';
import { taskReminderPreferences } from '../../shared/taskReminderPreferences';
export { DEFAULT_TASK_REMINDERS, isReminderTime } from '../../shared/taskReminderPreferences';

export interface TaskReminderState {
  enabled: boolean;
  /** Legacy single-time setting, retained when reading older preferences. */
  time?: string;
  times?: string[];
  notifyOnStartup?: boolean;
  delivered?: { day: string; keys: string[] };
}

interface TaskReminderDependencies {
  workspaces: () => string[];
  readState: (workspacePath: string) => TaskReminderState;
  writeState: (workspacePath: string, state: TaskReminderState) => void;
  listTasks: (workspacePath: string) => Promise<TrackerRecord[]>;
  isActiveTask?: (workspacePath: string, item: TrackerRecord) => boolean;
  notify: (workspacePath: string, title: string, body: string) => Promise<boolean>;
  onError: (workspacePath: string, error: unknown) => void;
}

/** Main-process polling also catches up after sleep or a late app launch. */
export class TaskReminderService {
  private checking = false;
  private startupDelivered = new Set<string>();
  constructor(private readonly deps: TaskReminderDependencies) {}

  async check(now = new Date()): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const day = localCalendarDay(now);
      const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      for (const workspacePath of new Set(this.deps.workspaces())) {
        try {
          const state = this.deps.readState(workspacePath);
          const preferences = taskReminderPreferences(state);
          if (!preferences.enabled) continue;
          const startup = preferences.notifyOnStartup && !this.startupDelivered.has(workspacePath);
          // Only the latest elapsed slot catches up after sleep or a late launch.
          const slot = preferences.times.filter(scheduled => scheduled <= time).at(-1);
          if (!startup && !slot) continue;
          const delivered = new Set(state.delivered?.day === day ? state.delivered.keys : []);
          const deliveryKey = (entryKey: string) => JSON.stringify([slot, entryKey]);
          const entries = taskCalendarEntries((await this.deps.listTasks(workspacePath)).filter(item => this.deps.isActiveTask?.(workspacePath, item) ?? isActiveCalendarTask(item)))
            .filter(entry => (entry.kind === 'on' ? entry.date === day : entry.date <= day) && (startup || !delivered.has(deliveryKey(entry.key))));
          if (!entries.length) continue;
          const count = new Set(entries.map(entry => entry.item.id)).size;
          const lines = entries.slice(0, 8).map(entry => `${entry.date < day ? 'OVERDUE ' : ''}${entry.kind.toUpperCase()} ${entry.date}: ${String(entry.item.fields.title).replace(/[\r\n]+/g, ' ')}`);
          if (entries.length > 8) lines.push(`And ${entries.length - 8} more dates. Open the task calendar to see all.`);
          if (await this.deps.notify(workspacePath, `${count} task${count === 1 ? ' needs' : 's need'} your attention today`, lines.join('\n'))) {
            if (startup) this.startupDelivered.add(workspacePath);
            // Read again so changing preferences while notification delivery waits cannot revert them.
            this.deps.writeState(workspacePath, {
              ...this.deps.readState(workspacePath),
              // Startup also satisfies the current elapsed slot, preventing a
              // second, identical notification on the next timer tick.
              delivered: { day, keys: [...new Set([...delivered, ...(slot ? entries.map(entry => deliveryKey(entry.key)) : [])])] },
            });
          }
        } catch (error) {
          this.deps.onError(workspacePath, error);
        }
      }
    } finally {
      this.checking = false;
    }
  }
}
