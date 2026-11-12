import { describe, expect, test } from 'bun:test';
import { ByteUtils, Credentials, Kdbx, ProtectedValue } from 'kdbxweb';
import type { AppModel } from '../src/models/app-model';
import type { FileModel } from '../src/models/file-model';
import { getSessionAccess, SessionAccessError } from '../src/comp/app/session-access';
import { changeCredential } from '../src/util/kdbxweb/credential-changes';

const pw = (text: string) => ProtectedValue.fromString(text);
const key = (text: string) => new TextEncoder().encode(text);
function deferred<T = void>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function file(id: string, password: string | null = 'master', keyText?: string): Promise<FileModel> {
    const credentials = new Credentials(password === null ? null : pw(password), keyText === undefined ? undefined : key(keyText));
    await credentials.ready;
    return { id, name: 'Same name', active: true, demo: false, chalResp: null, db: Kdbx.create(credentials, 'Test') } as FileModel;
}
function app(...files: FileModel[]): AppModel { return { files } as unknown as AppModel; }
async function recovery(model: AppModel) {
    const gate = getSessionAccess(model);
    const securing = gate.beginSecuring();
    const epoch = gate.requireRecovery(securing);
    const files = await gate.prepareRecovery(epoch);
    return { gate, securing, epoch, files };
}

describe('per-app session access', () => {
    test('defaults open for Classic and isolates different AppModels', async () => {
        const first = app(await file('first'));
        const second = app(await file('second'));
        const gate = getSessionAccess(first);
        expect(getSessionAccess(first)).toBe(gate);
        gate.assertOpen();
        gate.beginSecuring();
        expect(() => gate.assertOpen()).toThrow('access-denied');
        getSessionAccess(second).assertOpen();
        expect(getSessionAccess(second).state).toBe('open');
    });

    test('denies synchronously, keeps repeated locks idempotent, and rejects old delivery/close epochs after recovery', async () => {
        const model = app(await file('one'));
        const gate = getSessionAccess(model);
        const delivery = gate.epoch;
        const securing = gate.beginSecuring();
        expect(gate.state).toBe('securing');
        expect(() => gate.assertOpen(delivery)).toThrow('access-denied');
        expect(gate.beginSecuring()).toBe(securing);
        const epoch = gate.requireRecovery(securing);
        expect(gate.isCurrent(securing)).toBe(false);
        expect(gate.beginSecuring()).toBe(epoch);
        await gate.prepareRecovery(epoch);
        expect(() => gate.resumeRecovery(epoch)).toThrow('incomplete-recovery');
        await gate.verifyVault(epoch, 'one', { password: 'master' });
        gate.resumeRecovery(epoch);
        gate.assertOpen();
        expect(() => gate.assertOpen(delivery)).toThrow('stale-session');
        expect(() => gate.completeClose(securing)).toThrow('stale-session');
        expect(() => gate.resumeRecovery(epoch)).toThrow('stale-session');
    });

    test('requires every active real vault by ID, including duplicate names; demo cannot grant access', async () => {
        const a = await file('a', 'first');
        const b = await file('b', 'second');
        const demo = await file('demo'); demo.demo = true;
        const inactive = await file('inactive'); inactive.active = false;
        const { gate, epoch, files } = await recovery(app(a, b, demo, inactive));
        expect(files.map((target) => target.id)).toEqual(['a', 'b']);
        expect(files[0].name).toBe(files[1].name);
        expect(Object.keys(files[0]).sort()).toEqual(['id', 'name', 'requiresKeyFile', 'requiresPassword']);
        await gate.verifyVault(epoch, 'a', { password: 'first' });
        await expect(gate.verifyVault(epoch, 'b', { password: 'first' })).rejects.toThrow('invalid-credentials');
        await expect(gate.verifyVault(epoch, 'demo', { password: 'master' })).rejects.toThrow('invalid-credentials');
        expect(() => gate.resumeRecovery(epoch)).toThrow('incomplete-recovery');
        await gate.verifyVault(epoch, 'b', { password: 'second' });
        gate.resumeRecovery(epoch);
        expect(gate.state).toBe('open');
    });

    test('password-plus-keyfile rejects wrong/missing factors and leaves caller key bytes intact', async () => {
        const model = app(await file('one', 'master', 'required-key'));
        const { gate, epoch } = await recovery(model);
        for (const input of [{ password: 'master' }, { keyFile: key('required-key') },
            { password: 'master', keyFile: key('wrong-key') }, { password: 'wrong', keyFile: key('required-key') }]) {
            await expect(gate.verifyVault(epoch, 'one', input)).rejects.toThrow('invalid-credentials');
            expect(() => gate.resumeRecovery(epoch)).toThrow('incomplete-recovery');
        }
        const selectedKey = key('required-key');
        await gate.verifyVault(epoch, 'one', { password: 'master', keyFile: selectedKey });
        expect(selectedKey).toEqual(key('required-key'));
        gate.resumeRecovery(epoch);
    });

    test('key-only accepts empty/null-password fallback only with the freshly supplied correct key', async () => {
        const { gate, epoch, files } = await recovery(app(await file('one', null, 'key-only')));
        expect(files[0]).toMatchObject({ requiresPassword: false, requiresKeyFile: true });
        await expect(gate.verifyVault(epoch, 'one', { password: '' })).rejects.toThrow('invalid-credentials');
        await expect(gate.verifyVault(epoch, 'one', { password: 'extra', keyFile: key('key-only') })).rejects.toThrow('invalid-credentials');
        await gate.verifyVault(epoch, 'one', { password: '', keyFile: key('key-only') });
        gate.resumeRecovery(epoch);
    });

    test('a genuine empty-password factor still requires an explicit password submission', async () => {
        const { gate, epoch, files } = await recovery(app(await file('one', '')));
        expect(files[0].requiresPassword).toBe(true);
        await expect(gate.verifyVault(epoch, 'one', {})).rejects.toThrow('invalid-credentials');
        await expect(gate.verifyVault(epoch, 'one', { password: 'wrong' })).rejects.toThrow('invalid-credentials');
        await gate.verifyVault(epoch, 'one', { password: '' });
        gate.resumeRecovery(epoch);
    });

    test('capture waits for the gate-entry credential operation and verifies current unsaved credentials', async () => {
        const target = await file('one');
        const release = deferred();
        changeCredential(target.db.credentials, 'password', (staged) => release.promise.then(() => staged.setPassword(pw('unsaved'))));
        const gate = getSessionAccess(app(target));
        const epoch = gate.requireRecovery(gate.beginSecuring());
        let ready = false;
        const preparation = gate.prepareRecovery(epoch).then(() => { ready = true; });
        await Promise.resolve();
        expect(ready).toBe(false);
        release.resolve();
        await preparation;
        await expect(gate.verifyVault(epoch, 'one', { password: 'master' })).rejects.toThrow('invalid-credentials');
        await gate.verifyVault(epoch, 'one', { password: 'unsaved' });
        gate.resumeRecovery(epoch);
    });

    test('failed credential settlement remains gated without leaking the underlying error', async () => {
        const target = await file('one');
        changeCredential(target.db.credentials, 'password', async () => { throw new Error('private diagnostic'); });
        const gate = getSessionAccess(app(target));
        const epoch = gate.requireRecovery(gate.beginSecuring());
        await expect(gate.prepareRecovery(epoch)).rejects.toThrow('credentials-not-ready');
        expect(() => gate.resumeRecovery(epoch)).toThrow('incomplete-recovery');
        expect(() => gate.assertOpen()).toThrow('access-denied');
    });

    for (const mutation of ['add', 'remove', 'close', 'replace-file', 'replace-db', 'replace-credentials', 'credential-generation', 'hash-reference', 'hash-bytes']) {
        test(`${mutation} invalidates all approvals before resume`, async () => {
            const target = await file('one');
            const model = app(target);
            const { gate, epoch } = await recovery(model);
            await gate.verifyVault(epoch, 'one', { password: 'master' });
            switch (mutation) {
                case 'add': model.files.push(await file('two')); break;
                case 'remove': model.files.splice(0, 1); break;
                case 'close': target.active = false; break;
                case 'replace-file': model.files[0] = await file('one'); break;
                case 'replace-db': target.db = (await file('one')).db; break;
                case 'replace-credentials': target.db.credentials = new Credentials(pw('master')); await target.db.credentials.ready; break;
                case 'credential-generation': changeCredential(target.db.credentials, 'password', (staged) => staged.setPassword(pw('master'))); break;
                case 'hash-reference': target.db.credentials.passwordHash = target.db.credentials.passwordHash!.clone(); break;
                case 'hash-bytes': target.db.credentials.passwordHash!.value[0] ^= 1; break;
            }
            expect(() => gate.resumeRecovery(epoch)).toThrow('session-changed');
            expect(gate.isCurrent(epoch)).toBe(false);
            expect(() => gate.assertOpen()).toThrow('access-denied');
            await expect(gate.prepareRecovery(gate.epoch)).rejects.toThrow('session-changed');
        });
    }

    test('a new credential operation during preparation cannot silently replace the gate-entry generation', async () => {
        const target = await file('one');
        const release = deferred();
        changeCredential(target.db.credentials, 'password', (staged) => release.promise.then(() => staged.setPassword(pw('first'))));
        const gate = getSessionAccess(app(target));
        const epoch = gate.requireRecovery(gate.beginSecuring());
        const preparing = gate.prepareRecovery(epoch);
        changeCredential(target.db.credentials, 'password', (staged) => staged.setPassword(pw('second')));
        await expect(preparing).rejects.toThrow('session-changed');
        release.resolve();
        expect(gate.state).toBe('recovery-required');
    });

    for (const mode of ['challenge', 'file-factor', 'custom', 'custom-hidden', 'none', 'demo-only']) {
        test(`${mode} recovery fails closed and never invokes stored extra-factor proof`, async () => {
            const target = await file('one', mode === 'none' ? null : 'master');
            let invoked = false;
            if (mode === 'challenge') {
                target.db.credentials = new Credentials(pw('master'), undefined, async () => { invoked = true; return new ArrayBuffer(32); });
                await target.db.credentials.ready;
            }
            if (mode === 'file-factor') target.chalResp = {};
            if (mode === 'custom') Object.defineProperty(target.db.credentials, 'getHash', { value: () => Promise.resolve(new ArrayBuffer(32)), enumerable: true });
            if (mode === 'custom-hidden') Object.defineProperty(target.db.credentials, 'getHash', { value: () => Promise.resolve(new ArrayBuffer(32)) });
            if (mode === 'demo-only') target.demo = true;
            const gate = getSessionAccess(app(target));
            const epoch = gate.requireRecovery(gate.beginSecuring());
            await expect(gate.prepareRecovery(epoch)).rejects.toThrow('unsupported-recovery');
            expect(() => gate.resumeRecovery(epoch)).toThrow('incomplete-recovery');
            expect(invoked).toBe(false);
            expect(() => gate.assertOpen()).toThrow('access-denied');
        });
    }

    test('fresh failed verification revokes previous approval and cannot be bypassed by UI flags', async () => {
        const { gate, epoch } = await recovery(app(await file('one')));
        await gate.verifyVault(epoch, 'one', { password: 'master' });
        await expect(gate.verifyVault(epoch, 'one', { password: 'wrong' })).rejects.toThrow('invalid-credentials');
        expect(() => gate.resumeRecovery(epoch)).toThrow('incomplete-recovery');
        expect(() => gate.resetClosedSession()).toThrow('invalid-state');
    });

    for (const scenario of ['new-lock', 'wrong-retry', 'db-replaced']) {
        test(`late authentication cannot grant access after ${scenario}`, async () => {
            const target = await file('one');
            const { gate, epoch } = await recovery(app(target));
            const started = deferred();
            const release = deferred();
            const original = ProtectedValue.prototype.getHash;
            let held = false;
            ProtectedValue.prototype.getHash = function () {
                if (!held) {
                    held = true;
                    started.resolve();
                    return release.promise.then(() => original.call(this));
                }
                return original.call(this);
            };
            try {
                const pending = gate.verifyVault(epoch, 'one', { password: 'master' });
                await started.promise;
                if (scenario === 'new-lock') {
                    await gate.verifyVault(epoch, 'one', { password: 'master' });
                    gate.resumeRecovery(epoch);
                    gate.beginSecuring();
                } else if (scenario === 'wrong-retry') {
                    await expect(gate.verifyVault(epoch, 'one', { password: 'wrong' })).rejects.toThrow('invalid-credentials');
                } else {
                    target.db = (await file('one')).db;
                }
                release.resolve();
                await expect(pending).rejects.toThrow(scenario === 'db-replaced' ? 'session-changed' : 'stale-session');
                expect(() => gate.assertOpen()).toThrow('access-denied');
                if (scenario === 'wrong-retry') expect(() => gate.resumeRecovery(epoch)).toThrow('incomplete-recovery');
            } finally { release.resolve(); ProtectedValue.prototype.getHash = original; }
        });
    }

    test('cleans candidate hashes only after all factor calculations settle, even on malformed key-file input', async () => {
        const { gate, epoch } = await recovery(app(await file('one', 'master', 'key')));
        const started = deferred();
        const release = deferred();
        const original = ProtectedValue.prototype.getHash;
        ProtectedValue.prototype.getHash = function () {
            started.resolve();
            return release.promise.then(() => original.call(this));
        };
        try {
            const invalidKey = key('<KeyFile><Meta><Version>99</Version></Meta><Key><Data>AA==</Data></Key></KeyFile>');
            let done = false;
            const verification = gate.verifyVault(epoch, 'one', { password: 'master', keyFile: invalidKey });
            void verification.then(() => { done = true; }, () => { done = true; });
            await started.promise;
            await Promise.resolve();
            expect(done).toBe(false);
            release.resolve();
            await expect(verification).rejects.toThrow('invalid-credentials');
            expect(() => gate.resumeRecovery(epoch)).toThrow('incomplete-recovery');
        } finally { release.resolve(); ProtectedValue.prototype.getHash = original; }
    });

    test('detached references and temporary candidate cleanup do not alter live credential bytes', async () => {
        const target = await file('one', 'master', 'key');
        const passwordBefore = ByteUtils.bytesToHex(target.db.credentials.passwordHash!.getBinary());
        const keyBefore = ByteUtils.bytesToHex(target.db.credentials.keyFileHash!.getBinary());
        const { gate, epoch } = await recovery(app(target));
        expect(JSON.stringify(gate)).toBe('{}');
        await gate.verifyVault(epoch, 'one', { password: 'master', keyFile: key('key') });
        gate.resumeRecovery(epoch);
        expect(ByteUtils.bytesToHex(target.db.credentials.passwordHash!.getBinary())).toBe(passwordBefore);
        expect(ByteUtils.bytesToHex(target.db.credentials.keyFileHash!.getBinary())).toBe(keyBefore);
    });

    test('normal close must actually empty the session before it can reset for a fresh unlock', async () => {
        const target = await file('one');
        const gate = getSessionAccess(app(target));
        const epoch = gate.beginSecuring();
        expect(() => gate.completeClose(epoch)).toThrow('invalid-state');
        expect(() => gate.resetClosedSession()).toThrow('invalid-state');
        target.active = false;
        gate.completeClose(epoch);
        expect(gate.state).toBe('closed');
        target.active = true;
        expect(() => gate.resetClosedSession()).toThrow('invalid-state');
        target.active = false;
        gate.resetClosedSession();
        gate.assertOpen();
        expect(gate.isCurrent(epoch)).toBe(false);
    });

    test('errors expose only stable codes', () => {
        const error = new SessionAccessError('invalid-credentials');
        expect(error.message).toBe('invalid-credentials');
        expect(error.code).toBe('invalid-credentials');
    });
});
