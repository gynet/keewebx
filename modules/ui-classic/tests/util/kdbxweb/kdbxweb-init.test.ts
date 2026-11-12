import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { KdbxwebInit, buildArgon2WorkerSource } from 'util/kdbxweb/kdbxweb-init';

interface Vector {
    type: number;
    version: number;
    memory: number;
    iterations: number;
    parallelism: number;
    length: number;
    password: string;
    salt: string;
    hash: string;
}

const root = join(import.meta.dir, '../../..');
const vectors: Vector[] = JSON.parse(
    readFileSync(join(root, '../db/test/crypto/argon2-vectors.json'), 'utf8')
);
const loaderCode = readFileSync(
    join(root, 'node_modules/hash-wasm/dist/argon2.umd.min.js'),
    'utf8'
);
const toBuffer = (hex: string): ArrayBuffer =>
    Uint8Array.from(Buffer.from(hex, 'hex')).buffer as ArrayBuffer;
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');
const toArgs = (v: Vector) => ({
    password: toBuffer(v.password),
    salt: toBuffer(v.salt),
    memory: v.memory,
    iterations: v.iterations,
    length: v.length,
    parallelism: v.parallelism,
    type: v.type,
    version: v.version
});

// Runs the exact source handed to the production worker. Blanking the
// module globals makes the UMD header take its browser branch.
function loadWorker(): { hash(args: unknown): Promise<Uint8Array> } {
    const scope: Record<string, any> = {};
    new Function('self', 'exports', 'module', 'define', buildArgon2WorkerSource(loaderCode))(
        scope
    );
    return {
        hash(args: unknown): Promise<Uint8Array> {
            return new Promise((resolve, reject) => {
                scope.postMessage = (m: { hash?: Uint8Array; error?: string }): void =>
                    m.hash ? resolve(m.hash) : reject(new Error(m.error));
                scope.onmessage({ data: args });
            });
        }
    };
}

describe('Argon2 worker', () => {
    const worker = loadWorker();
    const cases = vectors.filter((v) => v.version === 0x13 && v.password.length > 0);

    it('covers Argon2d and Argon2id', () => {
        expect(new Set(cases.map((v) => v.type))).toEqual(new Set([0, 2]));
    });

    for (const v of cases) {
        it(`type=${v.type} m=${v.memory} t=${v.iterations} p=${v.parallelism}`, async () => {
            expect(toHex(await worker.hash(toArgs(v)))).toBe(v.hash);
        }, 60000);
    }

    it('reports a failed hash as an error', async () => {
        const [v] = cases;
        await expect(worker.hash({ ...toArgs(v), salt: new ArrayBuffer(1) })).rejects.toThrow();
    });
});

describe('KdbxwebInit.argon2 fallback', () => {
    const cases = vectors.filter(
        (v) => (v.version !== 0x13 || v.password.length === 0) && v.memory <= 4096
    );

    it('covers Argon2 v1.0 and empty passwords', () => {
        expect(cases.some((v) => v.version === 0x10)).toBe(true);
        expect(cases.some((v) => v.password.length === 0)).toBe(true);
    });

    for (const v of cases) {
        const name = `type=${v.type} v=0x${v.version.toString(16)} m=${v.memory} pw=${v.password.length / 2}`;
        it(name, async () => {
            const a = toArgs(v);
            const hash = await KdbxwebInit.argon2(
                a.password,
                a.salt,
                a.memory,
                a.iterations,
                a.length,
                a.parallelism,
                a.type,
                a.version
            );
            expect(toHex(hash)).toBe(v.hash);
        }, 60000);
    }
});
