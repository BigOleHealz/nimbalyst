import React, { useEffect, useState } from 'react';
import type { TaskReminderPreferences } from '../../../shared/taskReminderPreferences';

export function TaskReminderSettings({ workspacePath }: { workspacePath: string }) {
  const [preferences, setPreferences] = useState<TaskReminderPreferences | null>(null);
  const [notificationsEnabled, setNotificationsEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    let active = true;
    setPreferences(null);
    setError('');
    setSaved(false);
    void Promise.all([
      window.electronAPI.invoke('task-reminders:get', workspacePath),
      window.electronAPI.invoke('notifications:get-enabled'),
    ]).then(([settings, enabled]) => {
      if (active) { setPreferences(settings); setNotificationsEnabled(enabled); }
    }).catch(() => { if (active) setError('Unable to load reminder settings.'); });
    return () => { active = false; };
  }, [workspacePath]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!preferences || saving) return;
    setSaving(true); setError(''); setSaved(false);
    try {
      await window.electronAPI.invoke('task-reminders:set', workspacePath, preferences);
      setSaved(true);
    } catch { setError('Unable to save reminder settings.'); }
    finally { setSaving(false); }
  };
  const enableNotifications = async () => {
    setError('');
    try {
      const result = await window.electronAPI.invoke('notifications:set-enabled', true);
      if (!result.success) throw new Error('Unable to enable notifications');
      setNotificationsEnabled(true);
      await window.electronAPI.invoke('notifications:show-test');
    } catch { setError('Unable to enable desktop notifications. Check system notification settings.'); }
  };
  return <form onSubmit={save} className="task-reminder-settings shrink-0 border-b border-nim bg-nim-secondary px-3 py-2 text-xs">
    {preferences && <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2"><input type="checkbox" checked={preferences.enabled} onChange={event => { setPreferences({ ...preferences, enabled: event.target.checked }); setSaved(false); }} />Task reminders</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={preferences.notifyOnStartup} onChange={event => { setPreferences({ ...preferences, notifyOnStartup: event.target.checked }); setSaved(false); }} />Notify when app starts</label>
      {preferences.times.map((time, index) => <div key={index} className="flex items-center gap-1">
        <label className="flex items-center gap-1">{index === 0 ? 'Daily at' : 'and'} <input aria-label={`Daily reminder time ${index + 1}`} type="time" required value={time} onChange={event => { setPreferences({ ...preferences, times: preferences.times.map((value, position) => position === index ? event.target.value : value) }); setSaved(false); }} className="rounded border border-nim bg-nim px-1" /></label>
        {preferences.times.length > 1 && <button type="button" aria-label={`Remove reminder time ${index + 1}`} onClick={() => { setPreferences({ ...preferences, times: preferences.times.filter((_, position) => position !== index) }); setSaved(false); }}>×</button>}
      </div>)}
      {preferences.times.length < 8 && <button type="button" className="rounded border border-nim px-2 py-1" onClick={() => { setPreferences({ ...preferences, times: [...preferences.times, '12:00'] }); setSaved(false); }}>Add time</button>}
      <span className="text-nim-muted">local time</span>
      <button type="submit" disabled={saving} className="rounded border border-nim px-2 py-1 disabled:opacity-50">{saving ? 'Saving…' : 'Save reminders'}</button>
      {saved && <span role="status">Saved</span>}
      {!notificationsEnabled && <button type="button" onClick={() => { void enableNotifications(); }} className="rounded border border-nim px-2 py-1">Enable desktop notifications</button>}
      <button type="button" onClick={() => { void window.electronAPI.invoke('notifications:open-system-settings').catch(() => setError('Unable to open system settings.')); }} className="text-nim-muted underline">System notification settings</button>
    </div>}
    <p className="select-text mt-1 text-nim-muted">Startup and daily reminders include all active tasks in this workspace scheduled today, due today, or overdue. Nimbalyst must be running; system notification permissions apply.</p>
    {error && <p role="alert" className="select-text mt-1 text-nim-error">{error}</p>}
  </form>;
}
