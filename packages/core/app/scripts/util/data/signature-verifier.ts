import * as kdbxweb from 'kdbxweb';
import { Logger } from 'util/logger';
// *.pem ambient modules declared in app/scripts/types.d.ts; webpack
// resolves via resolve.alias (see webpack.config.js) and a raw-loader
// delivers the file content as a string at build time.
import publicKeyData from 'public-key.pem';
import publicKeyDataNew from 'public-key-new.pem';

const SignatureVerifier = {
    logger: new Logger('signature-verifier'),

    publicKeys: null as string[] | null,

    verify(
        data: ArrayBuffer | Uint8Array,
        signature: string | ArrayBuffer | Uint8Array,
        pk?: string
    ): Promise<boolean> {
        if (!pk) {
            const pks = this.getPublicKeys();
            return this.verify(data, signature, pks[0]).then((isValid) => {
                if (isValid || !pks[1]) {
                    return isValid;
                }
                return this.verify(data, signature, pks[1]);
            });
        }
        return new Promise((resolve, reject) => {
            const algo = { name: 'RSASSA-PKCS1-v1_5', hash: { name: 'SHA-256' } };
            try {
                let sigBytes: Uint8Array | ArrayBuffer;
                if (typeof signature === 'string') {
                    sigBytes = kdbxweb.ByteUtils.base64ToBytes(signature);
                } else {
                    sigBytes = signature;
                }
                const subtle = window.crypto.subtle;
                const keyFormat = 'spki';
                // base64ToBytes returns a Uint8Array whose backing buffer
                // is typed as ArrayBufferLike (could be SharedArrayBuffer
                // in strict TS); pass the concrete ArrayBuffer slice
                // into WebCrypto.
                const pkBytes = kdbxweb.ByteUtils.arrayToBuffer(
                    kdbxweb.ByteUtils.base64ToBytes(pk)
                );
                subtle
                    .importKey(keyFormat, pkBytes, algo, false, ['verify'])
                    .then((cryptoKey) => {
                        try {
                            subtle
                                .verify(
                                    algo,
                                    cryptoKey,
                                    kdbxweb.ByteUtils.arrayToBuffer(sigBytes),
                                    kdbxweb.ByteUtils.arrayToBuffer(data)
                                )
                                .then((isValid) => {
                                    resolve(isValid);
                                })
                                .catch((e) => {
                                    this.logger.error('Verify error', e);
                                    reject(e);
                                });
                        } catch (e) {
                            this.logger.error('Signature verification error', e);
                            reject(e);
                        }
                    })
                    .catch((e) => {
                        this.logger.error('ImportKey error', e);
                        reject(e);
                    });
            } catch (e) {
                this.logger.error('Signature key verification error', e);
                reject(e);
            }
        });
    },

    getPublicKeys(): string[] {
        if (!this.publicKeys) {
            this.publicKeys = [publicKeyData, publicKeyDataNew].map((pk) => {
                const m = pk.match(/-+BEGIN PUBLIC KEY-+([\s\S]+?)-+END PUBLIC KEY-+/);
                if (!m) {
                    throw new Error('Malformed PEM public key');
                }
                return m[1].replace(/\s+/g, '');
            });
        }
        return this.publicKeys;
    }
};

export { SignatureVerifier };
