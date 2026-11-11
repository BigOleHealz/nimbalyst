import { afterEach, describe, expect, it } from 'vitest';
import {
  areTrackerToolsEnabled,
  configureMcpServers,
  isInternalMcpServerEnabled,
  resolveTrackersWorkspacePath,
} from '../mcpServerConfig';

describe('areTrackerToolsEnabled', () => {
  afterEach(() => {
    configureMcpServers({ trackersAgentToolsDisabledLoader: null });
  });

  it('defaults to enabled when no loader is wired', () => {
    expect(areTrackerToolsEnabled('/some/workspace')).toBe(true);
  });

  it('reflects the loader per workspace', () => {
    configureMcpServers({
      trackersAgentToolsDisabledLoader: (workspacePath?: string) => workspacePath === '/disabled',
    });

    expect(areTrackerToolsEnabled('/disabled')).toBe(false);
    expect(areTrackerToolsEnabled('/enabled')).toBe(true);
  });

  it('falls back to enabled when the loader throws', () => {
    configureMcpServers({
      trackersAgentToolsDisabledLoader: () => {
        throw new Error('boom');
      },
    });

    expect(areTrackerToolsEnabled('/any')).toBe(true);
  });
});

describe('resolveTrackersWorkspacePath', () => {
  it('prefers the MCP config workspace path (parent project for worktrees)', () => {
    expect(
      resolveTrackersWorkspacePath({
        mcpConfigWorkspacePath: '/project',
        worktreeProjectPath: '/project-alt',
        worktreePath: '/project_worktrees/wt',
      })
    ).toBe('/project');
  });

  it('falls back through worktree project path then worktree path', () => {
    expect(
      resolveTrackersWorkspacePath({ worktreeProjectPath: '/project', worktreePath: '/wt' })
    ).toBe('/project');
    expect(resolveTrackersWorkspacePath({ worktreePath: '/wt' })).toBe('/wt');
    expect(resolveTrackersWorkspacePath(undefined)).toBeUndefined();
  });
});


describe('native headless session metadata', () => {
  afterEach(() => { configureMcpServers({ mcpServerPort: null, sessionMetaServerPort: null, sessionMetaAuthTokenLoader: null }); });
  it('enables phase reporting instructions without a desktop MCP server', () => {
    configureMcpServers({ mcpServerPort: null, sessionMetaServerPort: null, sessionMetaAuthTokenLoader: null });
    expect(isInternalMcpServerEnabled()).toBe(false);
    configureMcpServers({ sessionMetaServerPort: 41111 });
    expect(isInternalMcpServerEnabled()).toBe(false);
    configureMcpServers({ sessionMetaAuthTokenLoader: () => 'scoped-token' });
    expect(isInternalMcpServerEnabled()).toBe(true);
  });
});
