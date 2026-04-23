import { ChaCha20 } from './chacha20';
import { arrayToBuffer } from '../utils/byte-utils';
import { CrsAlgorithm, ErrorCodes } from '../defs/consts';
import { KdbxError } from '../errors/kdbx-error';
import * as CryptoEngine from '../crypto/crypto-engine';

/**
 * Protect information used for decrypt and encrypt protected data fields
 * @constructor
 */
export class ProtectSaltGenerator {
    private _algo: ChaCha20;

    constructor(algo: ChaCha20) {
        this._algo = algo;
    }

    getSalt(len: number): ArrayBuffer {
        return arrayToBuffer(this._algo.getBytes(len));
    }

    static create(
        key: ArrayBuffer | Uint8Array,
        crsAlgorithm: number
    ): Promise<ProtectSaltGenerator> {
        switch (crsAlgorithm) {
            case CrsAlgorithm.ChaCha20:
                return CryptoEngine.sha512(arrayToBuffer(key)).then((hash) => {
                    const key = new Uint8Array(hash, 0, 32);
                    const nonce = new Uint8Array(hash, 32, 12);
                    const algo = new ChaCha20(key, nonce);
                    return new ProtectSaltGenerator(algo);
                });
            default:
                return Promise.reject(new KdbxError(ErrorCodes.Unsupported, 'crsAlgorithm'));
        }
    }
}
