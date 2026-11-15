import { sign } from 'tweetnacl';
import { fromBase64, toBase64 } from '../../src/background/utils';

declare const GM: { getValue(key: string): Promise<any>; setValue(key: string, value: any): Promise<void> };
const KEY = 'keewebx-userscript-connect-identity-v1';
export async function identity(create = false): Promise<{ publicKey: Uint8Array; secretKey: Uint8Array }> {
    const stored = await GM.getValue(KEY);
    if (stored) {
        if (typeof stored.publicKey !== 'string' || typeof stored.secretKey !== 'string') throw new Error('The userscript identity is invalid. Initialize it again in KeeWebX.');
        const secretKey = fromBase64(stored.secretKey);
        if (secretKey.length !== sign.secretKeyLength) throw new Error('The userscript identity key is invalid.');
        const keys = sign.keyPair.fromSecretKey(secretKey);
        if (toBase64(keys.publicKey) !== stored.publicKey) throw new Error('The userscript identity data is inconsistent.');
        return keys;
    }
    if (!create) throw new Error('Click "Authorize Connect" in the KeeWebX userscript panel first.');
    const keys = sign.keyPair();
    await GM.setValue(KEY, { publicKey: toBase64(keys.publicKey), secretKey: toBase64(keys.secretKey) });
    return keys;
}
