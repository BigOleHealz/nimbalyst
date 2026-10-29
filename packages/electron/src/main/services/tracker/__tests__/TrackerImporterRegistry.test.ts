// @vitest-environment node
import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ discover: vi.fn(async () => []), find: vi.fn(async () => null), host: vi.fn() }));
vi.mock('../../../database/initialize', () => ({ getDatabase: vi.fn() }));
vi.mock('../../../extensions/PrivilegedExtensionHost', () => ({ getPrivilegedExtensionHost: h.host }));
vi.mock('../trackerImporterDiscovery', () => ({ discoverImporters: h.discover, findImporter: h.find }));
import { getTrackerImporterRegistry } from '../TrackerImporterRegistry';

it('routes host connectors through the existing importer API with explicit project scope', async () => {
  const registry = getTrackerImporterRegistry();
  const fetch = vi.fn(async () => ({ title: 'APP-1 First' }));
  const factory = vi.fn(() => ({ isAuthenticated: async () => true, listBindings: async () => [{ id: 'site', label: 'Jira site' }], list: async () => ({ items: [] }), fetch }));
  const contribution = { id: 'jira-test', displayName: 'Jira', icon: 'sync', urnScheme: 'jira', backendModuleId: 'host', importsAs: ['task'] };
  registry.registerBuiltin(contribution, factory as never);
  expect(await registry.listImporters('/one')).toContainEqual(expect.objectContaining({ id: 'jira-test' }));
  expect(await registry.getContribution('jira-test')).toEqual(contribution);
  expect(await registry.isAuthenticated('/one', 'jira-test')).toBe(true);
  expect(await registry.listBindings('/one', 'jira-test')).toEqual([{ id: 'site', label: 'Jira site' }]);
  expect(await registry.listItems('/one', 'jira-test', { id: 'site', label: 'Jira site' }, {})).toEqual({ items: [] });
  expect(await registry.fetchSnapshot('/two', 'jira-test', 'APP-1')).toEqual({ title: 'APP-1 First' });
  expect(factory).toHaveBeenCalledWith('/one');
  expect(factory).toHaveBeenCalledWith('/two');
  expect(fetch).toHaveBeenCalledWith({ externalId: 'APP-1' });
  expect(h.host).not.toHaveBeenCalled();
});
