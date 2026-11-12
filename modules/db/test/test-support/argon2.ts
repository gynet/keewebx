import { argon2d, argon2id } from 'hash-wasm';
import { argon2dAsync, argon2idAsync } from '@noble/hashes/argon2.js';
import { Argon2Type, Argon2TypeArgon2d, Argon2Version } from '../../lib/crypto/crypto-engine';

export async function argon2(
    password: ArrayBuffer,
    salt: ArrayBuffer,
    memory: number,
    iterations: number,
    length: number,
    parallelism: number,
    type: Argon2Type,
    version: Argon2Version
): Promise<ArrayBuffer> {
    const passwordBytes = new Uint8Array(password);
    const saltBytes = new Uint8Array(salt);
    const isArgon2d = type === Argon2TypeArgon2d;
    // hash-wasm only implements v1.3 and rejects empty passwords.
    if (version !== 0x13 || passwordBytes.length === 0) {
        const hash = isArgon2d ? argon2dAsync : argon2idAsync;
        const result = await hash(passwordBytes, saltBytes, {
            t: iterations,
            m: memory,
            p: parallelism,
            dkLen: length,
            version
        });
        return result.buffer.slice(
            result.byteOffset,
            result.byteOffset + result.byteLength
        ) as ArrayBuffer;
    }
    const hash = isArgon2d ? argon2d : argon2id;
    const result = await hash({
        password: passwordBytes,
        salt: saltBytes,
        memorySize: memory,
        iterations,
        parallelism,
        hashLength: length,
        outputType: 'binary'
    });
    return result.buffer.slice(
        result.byteOffset,
        result.byteOffset + result.byteLength
    ) as ArrayBuffer;
}
