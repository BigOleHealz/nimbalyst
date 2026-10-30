// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ available: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(), write: vi.fn(), read: vi.fn(), set: vi.fn(), get: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/jira-settings-test', isReady: () => true }, safeStorage: { encryptString: h.encrypt, decryptString: h.decrypt } }));
vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));
vi.mock('../../../utils/fileUtils', () => ({ writeSecretFile: h.write, readSecretFile: h.read }));
vi.mock('../../../utils/store', () => ({ getAppSetting: h.get, setAppSetting: h.set }));
vi.mock('../../credentials/providerCredentials', () => ({ isProviderEncryptionAvailable: h.available }));
import { jiraProjectSettings, readJiraCredentials, saveJiraCredentials, saveJiraProjectSettings } from '../jiraSettings';

describe('Jira settings custody', () => {
  beforeEach(() => { vi.clearAllMocks(); h.available.mockReturnValue(true); h.encrypt.mockReturnValue(Buffer.from('encrypted')); h.read.mockReturnValue(null); h.get.mockReturnValue(undefined); });
  const credentials = { siteUrl: 'https://team.atlassian.net/', email: 'me@example.com', apiToken: 'secret' };
  it('encrypts all connection details and never places credentials in plain config', () => {
    saveJiraCredentials(credentials);
    expect(h.encrypt).toHaveBeenCalledWith(JSON.stringify({ ...credentials, siteUrl: 'https://team.atlassian.net' }));
    expect(h.write).toHaveBeenCalledWith(expect.any(String), 'nimbalyst:jira:credentials', Buffer.from('encrypted'));
    expect(h.set).not.toHaveBeenCalled();
    saveJiraProjectSettings('/project', { jql: 'mine', autoSyncMinutes: 1, apiToken: 'secret' } as never);
    expect(h.set).toHaveBeenCalledWith('jiraProjects', { '/project': { jql: 'mine', autoSyncMinutes: 1 } });
  });
  it('fails closed when OS encryption is unavailable', () => {
    h.available.mockReturnValue(false);
    expect(() => saveJiraCredentials(credentials)).toThrow('secure credential storage');
    expect(() => readJiraCredentials()).toThrow('secure credential storage');
    expect(h.write).not.toHaveBeenCalled();
  });
  it('sanitizes storage failures and retains existing files', () => {
    h.read.mockImplementation(() => { throw new Error('secret'); });
    expect(() => readJiraCredentials()).toThrow('could not be read');
    expect(h.write).not.toHaveBeenCalled();
    h.encrypt.mockImplementation(() => { throw new Error('secret'); });
    expect(() => saveJiraCredentials(credentials)).toThrow('could not be saved securely');
  });
  it('defaults auto-sync off and rejects invalid schedules', () => {
    expect(jiraProjectSettings('/new').autoSyncMinutes).toBe(0);
    for (const minutes of [-1, 0.5, NaN, 10081]) expect(() => saveJiraProjectSettings('/project', { jql: 'mine', autoSyncMinutes: minutes })).toThrow('whole number');
    expect(h.set).not.toHaveBeenCalled();
  });
  it('persists project-specific acceptance mappings and rejects request injection', () => {
    saveJiraProjectSettings('/project', { jql: 'mine', autoSyncMinutes: 0, acceptanceCriteriaFieldIds: ['customfield_77', 'customfield_77'] });
    expect(h.set).toHaveBeenCalledWith('jiraProjects', { '/project': { jql: 'mine', autoSyncMinutes: 0, acceptanceCriteriaFieldIds: ['customfield_77'] } });
    expect(() => saveJiraProjectSettings('/project', { jql: 'mine', autoSyncMinutes: 0, acceptanceCriteriaFieldIds: ['bad&fields=*all'] })).toThrow('field IDs');
  });
});
