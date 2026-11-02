import { app, safeStorage } from 'electron';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readSecretFile, writeSecretFile } from '../../utils/fileUtils';
import { isProviderEncryptionAvailable } from '../credentials/providerCredentials';

const SECRET_KEY = 'nimbalyst:linear:api-key';
function requireEncryption(): void {
  if (!isProviderEncryptionAvailable(safeStorage, process.platform, app.isReady())) throw new Error('Linear requires secure credential storage. Unlock your keychain and retry.');
}
export function readLinearKey(): string | null {
  requireEncryption();
  try { return readSecretFile(join(app.getPath('userData'), 'extension-secrets'), SECRET_KEY, data => safeStorage.decryptString(data)); }
  catch { throw new Error('Linear credentials could not be read. Unlock secure storage and retry.'); }
}
export function saveLinearKey(input: string): void {
  requireEncryption();
  if (typeof input !== 'string' || !input.trim()) throw new Error('A Linear personal API key is required.');
  const dir = join(app.getPath('userData'), 'extension-secrets');
  try {
    mkdirSync(dir, { recursive: true });
    writeSecretFile(dir, SECRET_KEY, safeStorage.encryptString(input.trim()));
  } catch { throw new Error('Linear credentials could not be saved securely.'); }
}
