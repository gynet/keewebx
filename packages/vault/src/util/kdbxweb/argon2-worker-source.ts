// Source of the Argon2 worker. Web builds start it from a blob; browser
// extension pages cannot use blob workers, so the extension build writes
// the same source to a packaged file.

const ARGON2_TYPE_D = 0;

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

export function buildArgon2WorkerSource(loaderCode: string): string {
    return `${loaderCode}\n${ARGON2_WORKER_MAIN}`;
}

export { ARGON2_TYPE_D };
