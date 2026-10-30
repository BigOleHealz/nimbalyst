import { app, safeStorage } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_JIRA_JQL, normalizeJiraSite, type JiraCredentials, type JiraProjectSettings } from '@nimbalyst/runtime/integrations/jira';
import { getAppSetting, setAppSetting } from '../../utils/store';
import { readSecretFile, writeSecretFile } from '../../utils/fileUtils';
import { isProviderEncryptionAvailable } from '../credentials/providerCredentials';

const SECRET_KEY = 'nimbalyst:jira:credentials';
const SETTINGS_KEY = 'jiraProjects';
function requireEncryption(): void {
  if (!isProviderEncryptionAvailable(safeStorage, process.platform, app.isReady())) throw new Error('Jira requires secure credential storage. Unlock your keychain and retry.');
}
export function readJiraCredentials(): JiraCredentials | null {
  requireEncryption();
  try {
    const value = readSecretFile(join(app.getPath('userData'), 'extension-secrets'), SECRET_KEY, data => safeStorage.decryptString(data));
    return value ? JSON.parse(value) as JiraCredentials : null;
  } catch { throw new Error('Jira credentials could not be read. Unlock secure storage and retry.'); }
}
export function saveJiraCredentials(input: JiraCredentials): void {
  requireEncryption();
  const siteUrl = normalizeJiraSite(input.siteUrl);
  if (!input.email?.trim() || !input.apiToken?.trim()) throw new Error('Jira email and API token are required.');
  const dir = join(app.getPath('userData'), 'extension-secrets');
  try {
    mkdirSync(dir, { recursive: true });
    writeSecretFile(dir, SECRET_KEY, safeStorage.encryptString(JSON.stringify({ siteUrl, email: input.email.trim(), apiToken: input.apiToken.trim() })));
  } catch { throw new Error('Jira credentials could not be saved securely.'); }
}
export function jiraProjects(): Record<string, JiraProjectSettings> {
  return getAppSetting<Record<string, JiraProjectSettings>>(SETTINGS_KEY) ?? {};
}
export function jiraProjectSettings(workspacePath: string): JiraProjectSettings {
  return jiraProjects()[workspacePath] ?? { jql: DEFAULT_JIRA_JQL, autoSyncMinutes: 0 };
}
export function saveJiraProjectSettings(workspacePath: string, settings: JiraProjectSettings): void {
  if (!settings.jql?.trim()) throw new Error('JQL is required.');
  if (!Number.isInteger(settings.autoSyncMinutes) || settings.autoSyncMinutes < 0 || settings.autoSyncMinutes > 10080) throw new Error('Auto-sync minutes must be a whole number from 0 to 10080.');
  const fieldIds = settings.acceptanceCriteriaFieldIds;
  if (fieldIds !== undefined && (!Array.isArray(fieldIds) || fieldIds.some(id => typeof id !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(id)))) throw new Error('Acceptance criteria field IDs must be Jira field identifiers.');
  // Explicit allowlist: credentials can never enter the plain settings store.
  setAppSetting(SETTINGS_KEY, { ...jiraProjects(), [workspacePath]: { jql: settings.jql.trim(), autoSyncMinutes: settings.autoSyncMinutes, ...(fieldIds?.length ? { acceptanceCriteriaFieldIds: [...new Set(fieldIds)] } : {}) } });
}
