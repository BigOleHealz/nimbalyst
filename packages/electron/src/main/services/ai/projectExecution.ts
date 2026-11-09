import {getWorkspaceState} from '../../utils/store';

export function projectExecutionMachine(workspacePath: string): string {
  const value = getWorkspaceState(workspacePath).executionMachineId;
  return typeof value === 'string' ? value : '';
}

export function assertProjectAllowsLocalExecution(workspacePath: string): void {
  if (projectExecutionMachine(workspacePath)) {
    throw new Error('This project is configured to execute on its remote machine. Start a remote session; existing local sessions cannot run here.');
  }
}
