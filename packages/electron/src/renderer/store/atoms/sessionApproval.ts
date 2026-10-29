import { atom } from 'jotai';
import { atomFamily } from '../debug/atomFamilyRegistry';
import type { SessionApprovalSnapshot } from '../../../shared/sessionApproval';

/** Main owns request identity; snapshots also recover renderer reloads and missed events. */
export const sessionApprovalSnapshotAtom = atom<SessionApprovalSnapshot>({ revision: -1, approvals: [] });
export const applySessionApprovalSnapshotAtom = atom(null, (get, set, snapshot: SessionApprovalSnapshot | undefined) => {
  if (snapshot && snapshot.revision > get(sessionApprovalSnapshotAtom).revision) {
    set(sessionApprovalSnapshotAtom, snapshot);
  }
});

export const clearSessionApprovalsAtom = atom(null, (get, set, sessionId: string) => {
  const snapshot = get(sessionApprovalSnapshotAtom);
  if (snapshot.approvals.some(approval => approval.sessionId === sessionId)) {
    set(sessionApprovalSnapshotAtom, { ...snapshot, approvals: snapshot.approvals.filter(approval => approval.sessionId !== sessionId) });
  }
});

export const sessionAwaitingApprovalAtom = atomFamily((sessionId: string) => atom(get =>
  get(sessionApprovalSnapshotAtom).approvals.some(approval => approval.sessionId === sessionId)));
