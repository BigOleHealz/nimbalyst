// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { normalizeGitStatus } from '../gitStatus';

describe('normalizeGitStatus', () => {
  it('keeps the source repository so a selected tab cannot lend its Git requirements to another delivery', () => {
    expect(normalizeGitStatus({ branch: 'feature', ahead: 1, behind: 0, hasUncommitted: false, repoPath: '/delivery' })).toMatchObject({ repoPath: '/delivery' });
  });
  it('accepts the bounded status needed by the window top bar', () => {
    expect(normalizeGitStatus({
      branch: ' main ',
      ahead: 2,
      behind: 1,
      hasUncommitted: true,
      ignored: 'value',
    })).toEqual({
      branch: 'main',
      ahead: 2,
      behind: 1,
      hasUncommitted: true,
    });
  });

  it.each([
    null,
    {},
    { branch: '', ahead: 0, behind: 0, hasUncommitted: false },
    { branch: 'main', ahead: '0', behind: 0, hasUncommitted: false },
  ])('maps missing, non-repository, and malformed results to unavailable: %j', (value) => {
    expect(normalizeGitStatus(value)).toBeNull();
  });
});
