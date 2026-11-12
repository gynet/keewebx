import { describe, test, expect } from 'bun:test';
import { Credentials, Kdbx, ProtectedValue } from 'kdbxweb';
import type { AppModel } from '../src/models/app-model';
import type { FileModel } from '../src/models/file-model';
import { Events } from '../src/framework/events';
import { getSessionAccess } from '../src/comp/app/session-access';
import { createClassicProtocolAccess, createSessionProtocolAccess } from '../src/comp/extension/protocol-access';

async function fixture() {
    const credentials = new Credentials(ProtectedValue.fromString('master'));
    await credentials.ready;
    const file = { id: 'one', name: 'Vault', active: true, db: Kdbx.create(credentials, 'Vault') } as FileModel;
    const files = Object.assign([file], { hasOpenFiles: () => files.some((item) => item.active) });
    return { file, files, model: { files } as unknown as AppModel };
}

describe('required protocol access policy', () => {
    test('New synchronously invalidates retained-model access and old epochs stay stale after recovery', async () => {
        const { model } = await fixture();
        const gate = getSessionAccess(model);
        const access = createSessionProtocolAccess(model);
        const snapshots: Array<{ open: boolean; epoch: number }> = [];
        const unsubscribe = access.subscribeInvalidation(() => snapshots.push(access.snapshot()));
        const initial = access.snapshot().epoch;
        const securing = gate.beginSecuring();
        expect(snapshots).toEqual([{ open: false, epoch: initial + 1 }]);
        expect(model.files.hasOpenFiles()).toBe(true);
        expect(() => access.assertOpen(initial)).toThrow();
        const recovery = gate.requireRecovery(securing);
        await gate.prepareRecovery(recovery);
        await gate.verifyVault(recovery, 'one', { password: 'master' });
        gate.resumeRecovery(recovery);
        expect(access.snapshot().open).toBe(true);
        access.assertOpen();
        expect(() => access.assertOpen(initial)).toThrow();
        expect(snapshots).toHaveLength(3);
        unsubscribe();
        gate.beginSecuring();
        expect(snapshots).toHaveLength(3);
    });

    test('Classic explicitly uses physical file access and file lifecycle events invalidate epochs', async () => {
        const { model, file } = await fixture();
        const access = createClassicProtocolAccess(model);
        let count = 0;
        const before = Events.listenerCount('one-file-closed');
        const first = access.subscribeInvalidation(() => count++);
        const second = access.subscribeInvalidation(() => count++);
        expect(Events.listenerCount('one-file-closed')).toBe(before + 1);
        getSessionAccess(model).beginSecuring();
        access.assertOpen();
        const epoch = access.snapshot().epoch;
        Events.emit('lock-workspace');
        expect(count).toBe(2);
        expect(() => access.assertOpen(epoch)).toThrow();
        first(); second();
        expect(Events.listenerCount('one-file-closed')).toBe(before);
        file.active = false;
        expect(() => access.assertOpen()).toThrow();
    });
});
