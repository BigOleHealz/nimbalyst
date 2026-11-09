import { atom } from "jotai";
import { atomFamily } from "../debug/atomFamilyRegistry";

export const EXECUTION_MACHINE_LOADING = 'pending:execution-machine';

/** Empty host explicitly means this desktop. Loading/errors must never fall back to local execution. */
export const selectedMachineAtom = atomFamily((workspace: string) => {
  const value = atom<string>(EXECUTION_MACHINE_LOADING);
  let revision = 0;
  value.onMount = set => {
    const startedAt = revision;
    let disposed = false;
    void window.electronAPI.invoke('workspace:get-state', workspace).then(state => {
      if (!disposed && revision === startedAt) set(typeof state?.executionMachineId === 'string' ? state.executionMachineId : '');
    }).catch(error => {
      console.error('[remoteMachines] Could not read execution machine; local execution remains blocked.', error);
    });
    return () => { disposed = true; };
  };
  return atom(get => get(value), async (get, set, next: string) => {
    const currentRevision = ++revision;
    const previous = get(value);
    set(value, EXECUTION_MACHINE_LOADING);
    try {
      await window.electronAPI.invoke('workspace:update-state', workspace, {executionMachineId: next});
      if (revision === currentRevision) set(value, next);
    } catch (error) {
      if (revision === currentRevision) set(value, previous);
      throw error;
    }
  });
});
export const machineSessionSelectionsAtom = atomFamily((_workspace: string) =>
  atom<Record<string, string>>({})
);
