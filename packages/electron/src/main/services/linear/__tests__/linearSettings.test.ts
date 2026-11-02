// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ available: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(), write: vi.fn(), read: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => '/test-user-data', isReady: () => true }, safeStorage: { encryptString: h.encrypt, decryptString: h.decrypt } }));
vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));
vi.mock('../../../utils/fileUtils', () => ({ writeSecretFile: h.write, readSecretFile: h.read }));
vi.mock('../../credentials/providerCredentials', () => ({ isProviderEncryptionAvailable: h.available }));
import { readLinearKey, saveLinearKey } from '../linearSettings';

beforeEach(() => { vi.resetAllMocks(); h.available.mockReturnValue(true); h.encrypt.mockReturnValue(Buffer.from('encrypted')); h.read.mockReturnValue(null); });
it('writes only OS-encrypted bytes and reads through the decrypt callback', () => {
  saveLinearKey(' private-key ');
  expect(h.encrypt).toHaveBeenCalledWith('private-key');
  expect(h.write).toHaveBeenCalledWith(expect.any(String), 'nimbalyst:linear:api-key', Buffer.from('encrypted'));
  h.read.mockImplementation((_dir, _key, decrypt) => decrypt(Buffer.from('encrypted')));
  h.decrypt.mockReturnValue('private-key');
  expect(readLinearKey()).toBe('private-key');
  expect(h.decrypt).toHaveBeenCalledWith(Buffer.from('encrypted'));
});
it('fails closed when encryption is unavailable or the key is blank', () => {
  expect(() => saveLinearKey(' ')).toThrow('API key');
  h.available.mockReturnValue(false);
  expect(() => saveLinearKey('key')).toThrow('secure credential storage');
  expect(() => readLinearKey()).toThrow('secure credential storage');
  expect(h.write).not.toHaveBeenCalled();
});
it('sanitizes encryption and read failures without exposing secret values', () => {
  h.encrypt.mockImplementation(() => { throw new Error('private-key'); });
  expect(() => saveLinearKey('private-key')).toThrow('could not be saved securely');
  h.read.mockImplementation(() => { throw new Error('private-key'); });
  expect(() => readLinearKey()).toThrow('could not be read');
  expect(h.write).not.toHaveBeenCalled();
});
