import {BrowserWindow, type IpcMainInvokeEvent} from 'electron';
import {getWindowIdForWindow, resolveActiveWorkspacePathForWindowId} from '../window/windowState';

/** Older sidebar callers omit the workspace; scope those to their own window. */
export function sessionLifecycleWorkspace(event: IpcMainInvokeEvent, workspacePath?: string): string | undefined {
  return workspacePath ?? resolveActiveWorkspacePathForWindowId(getWindowIdForWindow(BrowserWindow.fromWebContents(event.sender)));
}
