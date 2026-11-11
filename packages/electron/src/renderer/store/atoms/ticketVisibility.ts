import { atom } from 'jotai';

/** Shared, session-only preference across Agent mode and the Planner. */
export const hideDoneTicketsAtom = atom(false);
