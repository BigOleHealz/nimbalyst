// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { normalizeBundleReportModuleId } from '../../scripts/bundleReportModuleId';

const root = '/Users/developer/project/worktrees/feature';

describe('portable bundle report module IDs', () => {
  it('keeps workspace modules relative to the current checkout', () => {
    expect(normalizeBundleReportModuleId(`${root}/packages/runtime/src/index.ts`, root))
      .toBe('/packages/runtime/src/index.ts');
  });

  it('normalizes dependencies shared with the primary checkout', () => {
    expect(normalizeBundleReportModuleId('/Users/developer/project/node_modules/lodash-es/map.js', root))
      .toBe('/node_modules/lodash-es/map.js');
  });

  it('preserves nested dependency locations and version identities', () => {
    expect(normalizeBundleReportModuleId('/Users/developer/project/node_modules/.pnpm/example@2/node_modules/example/index.js', root))
      .toBe('/node_modules/.pnpm/example@2/node_modules/example/index.js');
  });

  it('preserves virtual module identity and query suffixes', () => {
    expect(normalizeBundleReportModuleId('\0/Users/developer/project/node_modules/example/index.js?commonjs-proxy', root))
      .toBe('\0/node_modules/example/index.js?commonjs-proxy');
  });

  it('handles linked dependencies on Windows', () => {
    expect(normalizeBundleReportModuleId('C:\\project\\node_modules\\example\\index.js', 'C:\\project\\worktrees\\feature'))
      .toBe('/node_modules/example/index.js');
  });

  it('retains unknown absolute source paths so the audit can still reject them', () => {
    const source = '/Users/developer/unrelated/private.ts';
    expect(normalizeBundleReportModuleId(source, root)).toBe(source);
  });

  it('preserves external specifiers and missing facade IDs', () => {
    expect(normalizeBundleReportModuleId('react', root)).toBe('react');
    expect(normalizeBundleReportModuleId(null, root)).toBeNull();
  });
});
