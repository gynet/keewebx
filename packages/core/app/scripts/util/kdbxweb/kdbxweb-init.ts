import * as kdbxweb from 'kdbxweb';
import { argon2dAsync, argon2idAsync } from '@noble/hashes/argon2.js';
import { Logger } from 'util/logger';

// Resolved at build time by a webpack alias + raw-loader: the runtime
// value is the JavaScript source of hash-wasm's Argon2 UMD bundle.
interface ArgonModule {
    default: string;
}
declare function require(module: 'argon2'): ArgonModule;

const logger = new Logger('argon2');

const ARGON2_TYPE_D = 0;
const ARGON2_VERSION_13 = 0x13;

interface Argon2Args {
    password: ArrayBuffer;
    salt: ArrayBuffer;
    memory: number;
    iterations: number;
    length: number;
    parallelism: number;
    type: number;
    version: number;
}

// The worker is started from a blob so the app keeps working from a
// single static bundle, including when opened over file://.
const ARGON2_WORKER_MAIN = `
self.onmessage = function (e) {
    var args = e.data;
    var hash = args.type === ${ARGON2_TYPE_D} ? hashwasm.argon2d : hashwasm.argon2id;
    hash({
        password: new Uint8Array(args.password),
        salt: new Uint8Array(args.salt),
        memorySize: args.memory,
        iterations: args.iterations,
        parallelism: args.parallelism,
        hashLength: args.length,
        outputType: 'binary'
    }).then(
        function (hash) {
            self.postMessage({ hash: hash });
        },
        function (err) {
            self.postMessage({ error: String(err) });
        }
    );
};`;

function buildArgon2WorkerSource(loaderCode: string): string {
    return `${loaderCode}\n${ARGON2_WORKER_MAIN}`;
}

function hashInWorker(args: Argon2Args): Promise<Uint8Array> {
    if (typeof WebAssembly === 'undefined') {
        return Promise.reject(new Error('WebAssembly is not supported'));
    }
    return new Promise<Uint8Array>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const source = buildArgon2WorkerSource(require('argon2').default);
        const url = URL.createObjectURL(new Blob([source], { type: 'application/javascript' }));
        const worker = new Worker(url);
        // One worker per hash: terminating it discards the key material.
        const finish = (): void => {
            worker.terminate();
            URL.revokeObjectURL(url);
        };
        worker.onmessage = (e: MessageEvent): void => {
            finish();
            if (e.data && e.data.hash) {
                resolve(e.data.hash);
            } else {
                const error = (e.data && e.data.error) || 'unexpected error';
                logger.error('Worker error', error);
                reject(new Error(error));
            }
        };
        worker.onerror = (e: ErrorEvent): void => {
            finish();
            logger.warn('WebAssembly error', e.message);
            reject(new Error('WebAssembly error'));
        };
        worker.postMessage(args);
    });
}

// hash-wasm only implements Argon2 v1.3 and rejects empty passwords.
// Both remaining cases are rare, so they run on @noble/hashes, which
// yields to the event loop while computing.
function hashWithFallback(args: Argon2Args): Promise<Uint8Array> {
    const hash = args.type === ARGON2_TYPE_D ? argon2dAsync : argon2idAsync;
    return hash(new Uint8Array(args.password), new Uint8Array(args.salt), {
        t: args.iterations,
        m: args.memory,
        p: args.parallelism,
        dkLen: args.length,
        version: args.version
    });
}

const KdbxwebInit = {
    init(): void {
        kdbxweb.CryptoEngine.setArgon2Impl(
            (password, salt, memory, iterations, length, parallelism, type, version) =>
                this.argon2(
                    password,
                    salt,
                    memory,
                    iterations,
                    length,
                    parallelism,
                    type,
                    version
                ).then((bytes) => kdbxweb.ByteUtils.arrayToBuffer(bytes))
        );
    },

    argon2(
        password: ArrayBuffer,
        salt: ArrayBuffer,
        memory: number,
        iterations: number,
        length: number,
        parallelism: number,
        type: number,
        version: number
    ): Promise<Uint8Array> {
        const args: Argon2Args = {
            password,
            salt,
            memory,
            iterations,
            length,
            parallelism,
            type,
            version
        };
        const ts = logger.ts() as number;
        const useWorker = version === ARGON2_VERSION_13 && password.byteLength > 0;
        return (useWorker ? hashInWorker(args) : hashWithFallback(args)).then((hash) => {
            logger.debug('Hash computed', logger.ts(ts));
            return hash;
        });
    }
};

export { KdbxwebInit, buildArgon2WorkerSource };
