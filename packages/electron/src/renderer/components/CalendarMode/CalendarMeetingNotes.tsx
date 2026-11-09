import React, { useRef, useState } from 'react';
import { useSetAtom } from 'jotai';
import type { CalendarMeetingNote, CalendarMeetingReference } from '../../../shared/calendarImports';
import { addCalendarMeetingNoteAtom } from '../../store/atoms/calendarImports';

export function CalendarMeetingNotes({ meeting, notes }: { meeting: CalendarMeetingReference; notes: CalendarMeetingNote[] }): React.JSX.Element {
  const addNote = useSetAtom(addCalendarMeetingNoteAtom);
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const retry = useRef<{ text: string; id: string } | null>(null);
  const pending = useRef(false);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current || !text.trim()) return;
    const note = text.trim();
    if (retry.current?.text !== note) retry.current = { text: note, id: crypto.randomUUID() };
    pending.current = true;
    setSaving(true); setError(''); setSaved(false);
    try {
      await addNote({ ...meeting, text: note, clientMutationId: retry.current.id });
      setText(''); retry.current = null; setSaved(true);
    } catch {
      setError('The note could not be saved. Your draft is still here; retry to save it.');
    } finally { pending.current = false; setSaving(false); }
  };

  return <section className="calendar-meeting-notes space-y-2 border-t border-nim pt-3" aria-label="Meeting notes">
    <h5 className="text-sm font-semibold">Meeting notes</h5>
    <p className="text-xs text-nim-muted">Private in Nimbalyst. Add notes here or ask in the prompt.</p>
    {notes.length > 0 && <ul className="space-y-2">{notes.map(note => <li key={note.id} className="whitespace-pre-wrap break-words rounded border border-nim p-2 text-sm">{note.text}</li>)}</ul>}
    <form className="calendar-meeting-note-form space-y-2" onSubmit={event => void save(event)}>
      <label className="block text-xs" htmlFor="calendar-meeting-note">Add a note</label>
      <textarea id="calendar-meeting-note" className="w-full rounded border border-nim bg-nim p-2 text-sm" rows={3} maxLength={50_000} value={text} disabled={saving} onChange={event => { setText(event.target.value); setSaved(false); }} />
      <button className="calendar-mode-control" type="submit" disabled={saving || !text.trim()}>{saving ? 'Saving…' : 'Add note'}</button>
    </form>
    {error && <p className="text-xs text-nim-error" role="alert">{error}</p>}
    {saved && <p className="text-xs text-nim-muted" role="status">Note saved.</p>}
  </section>;
}
