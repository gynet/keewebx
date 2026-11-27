/**
 * The extension's long-term identity: an ed25519 key pair kept in extension
 * origin storage. The app stores what the user approved for this key, so another
 * client cannot reuse that approval.
 */
import { sign as tweetnaclSign } from 'tweetnacl';
import { fromBase64, toBase64 } from './utils';

export interface Identity {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
}

const STORAGE_KEY = 'kwxIdentity';
const STORE = 'keys';

interface StoredIdentity {
    publicKey: string;
    secretKey: string;
}

let cached: Promise<Identity> | undefined;

async function openIdentityDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('keewebx-connect-identity', 1);
        request.onupgradeneeded = () => request.result.createObjectStore(STORE);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function loadOrCreate(): Promise<Identity> {
    const legacy = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as StoredIdentity | undefined;
    const db = await openIdentityDb();
    try {
        const stored = await new Promise<StoredIdentity>((resolve, reject) => {
            const transaction = db.transaction(STORE, 'readwrite');
            const store = transaction.objectStore(STORE);
            const request = store.get(STORAGE_KEY);
            let identity: StoredIdentity;
            request.onsuccess = () => {
                const existing = request.result as StoredIdentity | undefined;
                if (existing?.publicKey && existing.secretKey) {
                    identity = existing;
                    return;
                }
                if (legacy?.publicKey && legacy.secretKey) {
                    identity = legacy;
                } else {
                    const keys = tweetnaclSign.keyPair();
                    identity = { publicKey: toBase64(keys.publicKey), secretKey: toBase64(keys.secretKey) };
                }
                store.put(identity, STORAGE_KEY);
            };
            transaction.oncomplete = () => resolve(identity);
            transaction.onabort = () => reject(transaction.error);
        });
        // Keep the existing pairing until its identity is durably migrated.
        if (legacy !== undefined) await chrome.storage.local.remove(STORAGE_KEY);
        return { publicKey: fromBase64(stored.publicKey), secretKey: fromBase64(stored.secretKey) };
    } finally {
        db.close();
    }
}

export function getIdentity(): Promise<Identity> {
    cached ??= loadOrCreate().catch((e) => {
        cached = undefined;
        throw e;
    });
    return cached;
}
