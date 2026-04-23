import * as kdbxweb from 'kdbxweb';
import { Logger } from 'util/logger';

// Webpack require — resolved at build time. The two modules consumed
// here (`argon2` from argon2-browser and `argon2-wasm` from a webpack
// alias) are loaded via raw-loader and base64-loader respectively, so
// the runtime shape is a string of JavaScript source / base64-encoded
// WASM bytes. We narrow at the call site rather than typing the whole
// require() function.
interface ArgonModule {
    default: string;
}
declare function require(module: 'argon2'): ArgonModule;
declare function require(module: 'argon2-wasm'): string;

const logger = new Logger('argon2');

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

interface RuntimeModule {
    hash(args: Argon2Args): Promise<Uint8Array>;
}

// Subset of the Emscripten Module surface that calcHash() touches.
// `calcHash` is stringified and embedded in the WASM worker bootstrap,
// so this type only needs to exist for the type checker — at runtime
// the function executes inside the worker scope where `Module` is the
// real Emscripten runtime with hundreds of generated methods.
interface EmscriptenModule {
    allocate(slab: Uint8Array | number[], allocType: 'i8', kind: number): number;
    ALLOC_NORMAL: number;
    HEAP8: Uint8Array;
    _argon2_hash(
        iterations: number,
        memory: number,
        parallelism: number,
        passwordPtr: number,
        passwordLen: number,
        saltPtr: number,
        saltLen: number,
        hashPtr: number,
        hashLen: number,
        encodedPtr: number,
        encodedLen: number,
        type: number,
        version: number
    ): number;
    _free(ptr: number): void;
}

const KdbxwebInit: {
    runtimeModule: RuntimeModule | null;
    init(): void;
    argon2(
        password: ArrayBuffer,
        salt: ArrayBuffer,
        memory: number,
        iterations: number,
        length: number,
        parallelism: number,
        type: number,
        version: number
    ): Promise<Uint8Array>;
    loadRuntime(requiredMemory: number): Promise<RuntimeModule>;
    workerPostRun(): void;
    calcHash(Module: EmscriptenModule, args: Argon2Args): Uint8Array;
} = {
    runtimeModule: null,

    init(): void {
        kdbxweb.CryptoEngine.setArgon2Impl(
            (password, salt, memory, iterations, length, parallelism, type, version) =>
                // kdbxweb's setArgon2Impl signature demands Promise<ArrayBuffer>;
                // our argon2() returns Promise<Uint8Array>. Runtime is fine
                // because kdbxweb pipes the result through arrayToBuffer,
                // but we still need to satisfy the type checker — wrap in
                // arrayToBuffer here too.
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
        return this.loadRuntime(memory).then((runtime) => {
            const ts = logger.ts() as number;
            return runtime.hash(args).then((hash) => {
                logger.debug('Hash computed', logger.ts(ts));
                return hash;
            });
        });
    },

    loadRuntime(requiredMemory: number): Promise<RuntimeModule> {
        if (this.runtimeModule) {
            return Promise.resolve(this.runtimeModule);
        }
        if (typeof WebAssembly === 'undefined') {
            return Promise.reject('WebAssembly is not supported');
        }
        return new Promise<RuntimeModule>((resolve, reject) => {
            const loadTimeout = setTimeout(() => reject('timeout'), 5000);
            try {
                const ts = logger.ts() as number;
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const argon2LoaderCode: string = require('argon2').default;
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                const wasmBinaryBase64: string = require('argon2-wasm');

                const KB = 1024 * 1024;
                const MB = 1024 * KB;
                const GB = 1024 * MB;
                const WASM_PAGE_SIZE = 64 * 1024;
                const totalMemory = (2 * GB - 64 * KB) / 1024 / WASM_PAGE_SIZE;
                const initialMemory = Math.min(
                    Math.max(Math.ceil((requiredMemory * 1024) / WASM_PAGE_SIZE), 256) + 256,
                    totalMemory
                );

                const memoryDecl = `var wasmMemory=new WebAssembly.Memory({initial:${initialMemory},maximum:${totalMemory}});`;
                const moduleDecl =
                    'var Module={' +
                    'wasmJSMethod: "native-wasm",' +
                    'wasmBinary: Uint8Array.from(atob("' +
                    wasmBinaryBase64 +
                    '"), c => c.charCodeAt(0)),' +
                    'print(...args) { postMessage({op:"log",args}) },' +
                    'printErr(...args) { postMessage({op:"log",args}) },' +
                    'postRun:' +
                    this.workerPostRun.toString() +
                    ',' +
                    'calcHash:' +
                    this.calcHash.toString() +
                    ',' +
                    'wasmMemory:wasmMemory,' +
                    'buffer:wasmMemory.buffer,' +
                    'TOTAL_MEMORY:' +
                    initialMemory * WASM_PAGE_SIZE +
                    '}';
                const script = argon2LoaderCode.replace(
                    /^var Module.*?}/,
                    memoryDecl + moduleDecl
                );
                const blob = new Blob([script], { type: 'application/javascript' });
                const objectUrl = URL.createObjectURL(blob);
                const worker = new Worker(objectUrl);
                const onMessage = (e: MessageEvent): void => {
                    switch (e.data.op) {
                        case 'log':
                            logger.debug(...e.data.args);
                            break;
                        case 'postRun':
                            logger.debug(
                                'WebAssembly runtime loaded (web worker)',
                                logger.ts(ts)
                            );
                            URL.revokeObjectURL(objectUrl);
                            clearTimeout(loadTimeout);
                            worker.removeEventListener('message', onMessage);
                            this.runtimeModule = {
                                hash(args: Argon2Args): Promise<Uint8Array> {
                                    return new Promise<Uint8Array>((resolve, reject) => {
                                        worker.postMessage(args);
                                        const onHashMessage = (
                                            e: MessageEvent
                                        ): void => {
                                            worker.removeEventListener(
                                                'message',
                                                onHashMessage
                                            );
                                            worker.terminate();
                                            KdbxwebInit.runtimeModule = null;
                                            if (
                                                !e.data ||
                                                e.data.error ||
                                                !e.data.hash
                                            ) {
                                                const ex =
                                                    (e.data && e.data.error) ||
                                                    'unexpected error';
                                                logger.error('Worker error', ex);
                                                reject(ex);
                                            } else {
                                                resolve(e.data.hash);
                                            }
                                        };
                                        worker.addEventListener('message', onHashMessage);
                                    });
                                }
                            };
                            resolve(this.runtimeModule!);
                            break;
                        default:
                            logger.error('Unknown message', e.data);
                            URL.revokeObjectURL(objectUrl);
                            reject('Load error');
                    }
                };
                worker.addEventListener('message', onMessage);
            } catch (err) {
                reject(err);
            }
        }).catch((err: unknown) => {
            logger.warn('WebAssembly error', err);
            throw new Error('WebAssembly error');
        });
    },

    // eslint-disable-next-line object-shorthand
    workerPostRun: function (): void {
        // NOTE: this entire function is `.toString()`-ed and embedded
        // in the worker bootstrap script — it never executes in the
        // host scope. Inside the worker `Module` is a global Emscripten
        // runtime declared by `var Module = {...}` in the embedded
        // moduleDecl below, so the free `Module` identifier resolves
        // against the worker's global scope at runtime. TypeScript
        // cannot see that global from our host-side compilation, so
        // we keep the type suppression rather than inject a typed
        // reference (which would change the stringified output and
        // risk the host->worker bootstrap contract).
        self.postMessage({ op: 'postRun' });
        self.onmessage = (e: MessageEvent) => {
            try {
                /* eslint-disable-next-line no-undef */
                // @ts-ignore -- Module is a global in the worker scope
                const hash = Module.calcHash(Module, e.data);
                self.postMessage({ hash });
            } catch (e) {
                self.postMessage({ error: (e as Error).toString() });
            }
        };
    },

    // eslint-disable-next-line object-shorthand
    calcHash: function (Module: EmscriptenModule, args: Argon2Args): Uint8Array {
        const { password: passwordBuf, salt: saltBuf } = args;
        const { memory, iterations, length, parallelism, type, version } = args;
        const passwordLen = passwordBuf.byteLength;
        const passwordPtr = Module.allocate(
            new Uint8Array(passwordBuf),
            'i8',
            Module.ALLOC_NORMAL
        );
        const saltLen = saltBuf.byteLength;
        const saltPtr = Module.allocate(new Uint8Array(saltBuf), 'i8', Module.ALLOC_NORMAL);
        const hashPtr = Module.allocate(new Array(length), 'i8', Module.ALLOC_NORMAL);
        const encodedLen = 512;
        const encodedPtr = Module.allocate(
            new Array(encodedLen),
            'i8',
            Module.ALLOC_NORMAL
        );

        const res = Module._argon2_hash(
            iterations,
            memory,
            parallelism,
            passwordPtr,
            passwordLen,
            saltPtr,
            saltLen,
            hashPtr,
            length,
            encodedPtr,
            encodedLen,
            type,
            version
        );
        if (res) {
            throw new Error('Argon2 error ' + res);
        }
        const hashArr = new Uint8Array(length);
        for (let i = 0; i < length; i++) {
            hashArr[i] = Module.HEAP8[hashPtr + i];
        }
        Module._free(passwordPtr);
        Module._free(saltPtr);
        Module._free(hashPtr);
        Module._free(encodedPtr);
        return hashArr;
    }
};

export { KdbxwebInit };
