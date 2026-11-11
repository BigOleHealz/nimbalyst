import React from 'react';
import { useAtom } from 'jotai';
import { hideDoneTicketsAtom } from '../../store/atoms/ticketVisibility';

export function HideDoneTicketsCheckbox() {
  const [hideDone, setHideDone] = useAtom(hideDoneTicketsAtom);
  return (
    <label className="hide-done-tickets-filter inline-flex items-center gap-1 whitespace-nowrap cursor-pointer text-[11px] text-[var(--nim-text-muted)]" title="Hide tickets whose workflow status is Done">
      <input type="checkbox" className="m-0 accent-[var(--nim-primary)]" checked={hideDone} onChange={event => setHideDone(event.target.checked)} />
      Hide done tickets
    </label>
  );
}
