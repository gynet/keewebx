import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'events';
import type { AppModel } from '../../../../vault/src/models/app-model';
import { saveAndLock } from '../../../../vault/src/comp/app/vault-lifecycle';

class VaultFile extends EventEmitter {
    demo = false;
    dirty = true;
    modified = true;
    syncing = false;
}

function model(files: VaultFile[], save: (file: VaultFile, callback: (error?: unknown) => void) => void) {
    let closed = false;
    const instance = {
        files,
        syncFile(file: VaultFile, _options: unknown, callback: (error?: unknown) => void) {
            save(file, callback);
        },
        closeAllFiles() { closed = true; }
    };
    return { instance: instance as unknown as AppModel, closed: () => closed };
}

describe('vault lock persistence', () => {
    test('keeps the vault open when serialization or cache saving fails', async () => {
        const file = new VaultFile();
        const vault = model([file], (_file, callback) => callback(new Error('disk full')));
        await expect(saveAndLock(vault.instance)).rejects.toThrow('Changes could not be saved');
        expect(vault.closed()).toBe(false);
    });

    test('allows locking after a remote failure when the encrypted local cache is saved', async () => {
        const file = new VaultFile();
        const vault = model([file], (saved, callback) => {
            saved.dirty = false;
            callback(new Error('offline'));
        });
        await saveAndLock(vault.instance);
        expect(vault.closed()).toBe(true);
    });

    test('waits for an active sync before saving subsequent edits and locking', async () => {
        const file = new VaultFile();
        file.syncing = true;
        let calls = 0;
        const vault = model([file], (saved, callback) => {
            calls++;
            saved.dirty = false;
            callback();
        });
        const locking = saveAndLock(vault.instance);
        expect(calls).toBe(0);
        expect(vault.closed()).toBe(false);
        file.syncing = false;
        file.emit('change:syncing');
        await locking;
        expect(calls).toBe(1);
        expect(file.listenerCount('change:syncing')).toBe(0);
        expect(vault.closed()).toBe(true);
    });

    test('retains all vaults if one still has unsaved edits after the save callback', async () => {
        const first = new VaultFile();
        const second = new VaultFile();
        const vault = model([first, second], (file, callback) => {
            if (file === first) file.dirty = false;
            callback();
        });
        await expect(saveAndLock(vault.instance)).rejects.toThrow('Changes could not be saved');
        expect(vault.closed()).toBe(false);
    });

    test('does not persist demo edits', async () => {
        const file = new VaultFile();
        file.demo = true;
        const vault = model([file], () => { throw new Error('Unexpected demo save'); });
        await saveAndLock(vault.instance);
        expect(vault.closed()).toBe(true);
    });
});
