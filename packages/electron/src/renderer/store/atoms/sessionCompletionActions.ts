import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';

/** Latest successful turn boundary, cleared when another turn starts or stops unsuccessfully. */
export const sessionSuccessfulCompletionAtom = atomFamily((_sessionId: string) => atom<number | null>(null));

/** Keep Later/accepted choices when switching away from a session and back. */
export const sessionDismissedCompletionAtom = atomFamily((_sessionId: string) => atom<number | null>(null));
