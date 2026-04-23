import * as kdbxweb from 'kdbxweb';
import { Logger } from 'util/logger';

const logger = new Logger('online-password-checker');

const exposedPasswords: Record<string, boolean> = {};

interface ProtectedValueLike {
    isProtected?: boolean;
    byteLength?: number;
    saltedValue(): string;
    getBinary(): ArrayBuffer;
}

function checkIfPasswordIsExposedOnline(
    password: ProtectedValueLike | null | undefined
): false | Promise<boolean | void> {
    if (!password || !password.isProtected || !password.byteLength) {
        return false;
    }
    const saltedValue = password.saltedValue();
    const cached = exposedPasswords[saltedValue];
    if (cached !== undefined) {
        // Cached result: wrap in a resolved promise so the
        // return type covers both the "not exposed" short-circuit
        // (false) and the async fetch/cache branches.
        return Promise.resolve(cached);
    }
    const passwordBytes = password.getBinary();
    return crypto.subtle
        .digest({ name: 'SHA-1' }, passwordBytes)
        .then((sha1Raw) => {
            kdbxweb.ByteUtils.zeroBuffer(passwordBytes);
            const sha1 = kdbxweb.ByteUtils.bytesToHex(sha1Raw).toUpperCase();
            const shaFirst = sha1.substr(0, 5);
            return fetch(`https://api.pwnedpasswords.com/range/${shaFirst}`)
                .then((response) => response.text())
                .then((response) => {
                    const isPresent = response.includes(sha1.substr(5));
                    exposedPasswords[saltedValue] = isPresent;
                    return isPresent;
                });
        })
        .catch((e: Error) => {
            logger.error('Error checking password online', e);
        });
}

export { checkIfPasswordIsExposedOnline };
