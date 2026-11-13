import { afterAll, afterEach, expect, test } from 'bun:test';
import { AppSettingsModel } from '../../../../vault/src/models/app-settings-model';
const previousWindow = globalThis.window;
Object.assign(globalThis, { window: {} });
afterAll(() => { Object.assign(globalThis, { window: previousWindow }); });
const { setShortLivedProviderSessions } = await import('../../../../vault/src/comp/app/provider-preferences');
const { assertVaultPolicy, canOpenProvider } = await import('../../../../vault/src/comp/app/vault-policy');
const { Storage } = await import('../../../../vault/src/storage');
afterEach(() => {
    AppSettingsModel.set({ shortLivedStorageToken: false, canOpen: true, canOpenDemo: true, canSaveTo: true, canOpenStorage: true, webdav: true });
    Storage.webdav.setEnabled(true);
});
test('short sessions clear every provider even after synchronous and asynchronous failures', async () => {
    const calls: string[] = [];
    await expect(setShortLivedProviderSessions(true, {
        first: { deleteStoredToken() { calls.push('first'); throw new Error('Unavailable'); } },
        disabled: { deleteStoredToken() { calls.push('disabled'); } },
        last: { async deleteStoredToken() { calls.push('last'); throw new Error('Unavailable'); } }
    })).rejects.toThrow('cleanup failed');
    expect(calls).toEqual(['first', 'disabled', 'last']);
    expect(AppSettingsModel.shortLivedStorageToken).toBe(true);
});
test('retry removes persisted tokens and disabling does not restore them', async () => {
    const tokens = new Map([['provider', 'synthetic token']]);
    await setShortLivedProviderSessions(true, { provider: { deleteStoredToken() { tokens.clear(); } } });
    expect(tokens.size).toBe(0);
    await setShortLivedProviderSessions(false, { provider: { deleteStoredToken() { throw new Error('Unexpected cleanup'); } } });
    expect(AppSettingsModel.shortLivedStorageToken).toBe(false);
    expect(tokens.size).toBe(0);
});
test('host policy and adapter enablement independently deny provider opens', () => {
    expect(canOpenProvider('webdav')).toBe(true);
    expect(canOpenProvider('cache')).toBe(false);
    expect(canOpenProvider('missing')).toBe(false);
    Storage.webdav.setEnabled(false);
    expect(() => assertVaultPolicy('provider', 'webdav')).toThrow('disabled');
    Storage.webdav.setEnabled(true);
    AppSettingsModel.canOpenStorage = false;
    expect(() => assertVaultPolicy('provider', 'webdav')).toThrow('disabled');
    AppSettingsModel.canOpenStorage = true;
    AppSettingsModel.webdav = false;
    expect(canOpenProvider('webdav')).toBe(false);
});
test('host restrictions are independent; denied export does not disable local opening', () => {
    AppSettingsModel.canSaveTo = false;
    expect(() => assertVaultPolicy('export')).toThrow('disabled');
    expect(() => assertVaultPolicy('open')).not.toThrow();
    AppSettingsModel.canOpen = false;
    AppSettingsModel.canOpenDemo = false;
    expect(() => assertVaultPolicy('open')).toThrow('disabled');
    expect(() => assertVaultPolicy('demo')).toThrow('disabled');
});
