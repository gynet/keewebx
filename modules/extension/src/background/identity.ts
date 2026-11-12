/**
 * The extension's long-term identity: an ed25519 key pair kept in extension
 * storage. The app stores what the user approved for this key, so another
 * client cannot reuse that approval.
 */
import { sign as tweetnaclSign } from 'tweetnacl';
import { fromBase64, toBase64 } from './utils';

export interface Identity {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

const STORAGE_KEY = 'kwxIdentity';
let cached: Promise<Identity> | undefined;

async function loadOrCreate(): Promise<Identity> {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as
        | { publicKey: string; secretKey: string }
        | undefined;
    if (stored?.publicKey && stored.secretKey) {
        return { publicKey: fromBase64(stored.publicKey), secretKey: fromBase64(stored.secretKey) };
    }
    const keys = tweetnaclSign.keyPair();
    await chrome.storage.local.set({
        [STORAGE_KEY]: { publicKey: toBase64(keys.publicKey), secretKey: toBase64(keys.secretKey) }
    });
    return keys;
}

export function getIdentity(): Promise<Identity> {
    cached ??= loadOrCreate().catch((e) => {
        cached = undefined;
        throw e;
    });
    return cached;
}
