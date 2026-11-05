export interface TaskReminderPreferences {
  enabled: boolean;
  times: string[];
  notifyOnStartup: boolean;
}

export const DEFAULT_TASK_REMINDERS: TaskReminderPreferences = {
  enabled: true,
  times: ['05:00', '08:00'],
  notifyOnStartup: true,
};

export function isReminderTime(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Upgrade the former 9am default while retaining explicitly customized legacy times. */
export function taskReminderPreferences(stored?: Partial<TaskReminderPreferences> & { time?: string }): TaskReminderPreferences {
  const configured = stored?.times ?? (stored?.time && stored.time !== '09:00' ? [stored.time] : DEFAULT_TASK_REMINDERS.times);
  const times = [...new Set(configured.filter(isReminderTime))].sort();
  return {
    enabled: stored?.enabled ?? DEFAULT_TASK_REMINDERS.enabled,
    times: times.length ? times : [...DEFAULT_TASK_REMINDERS.times],
    notifyOnStartup: stored?.notifyOnStartup ?? DEFAULT_TASK_REMINDERS.notifyOnStartup,
  };
}
