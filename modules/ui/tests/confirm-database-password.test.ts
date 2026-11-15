import { afterAll, expect, test } from 'bun:test';
import type { AppModel } from 'models/app-model';
import type { FileModel } from 'models/file-model';
import { getSessionAccess } from 'comp/app/session-access';
import { confirmDatabasePassword } from '../src/confirm-database-password';

const originalWindow = globalThis.window;
afterAll(() => { Object.assign(globalThis, { window: originalWindow }); });

test('empty-password cancellation and session or identity changes during confirmation refuse the operation', () => {
    for (const outcome of ['cancel', 'securing', 'database', 'credentials', 'closed', 'unmount', 'accept']) {
        const file = { id: 'one', active: true, passwordLength: 0, db: { credentials: { passwordHash: undefined } } } as unknown as FileModel;
        const model = { files: { get: () => file, filter: () => [] } } as unknown as AppModel;
        const access = getSessionAccess(model);
        let mounted = true, confirmations = 0;
        Object.assign(globalThis, { window: { confirm() {
            confirmations++;
            if (outcome === 'securing') access.beginSecuring();
            if (outcome === 'database') file.db = { credentials: { passwordHash: undefined } } as FileModel['db'];
            if (outcome === 'credentials') file.db.credentials.passwordHash = {} as typeof file.db.credentials.passwordHash;
            if (outcome === 'closed') file.active = false;
            if (outcome === 'unmount') mounted = false;
            return outcome !== 'cancel';
        } } });
        expect(confirmDatabasePassword(model, file, () => mounted)).toBe(outcome === 'accept');
        expect(confirmations).toBe(1);
    }
});

test('password-protected databases need no extra confirmation; already suspended access cannot prompt', () => {
    const file = { id: 'one', active: true, passwordLength: 12, db: { credentials: { passwordHash: {} } } } as unknown as FileModel;
    const model = { files: { get: () => file, filter: () => [] } } as unknown as AppModel;
    Object.assign(globalThis, { window: { confirm() { throw new Error('Unexpected confirmation'); } } });
    expect(confirmDatabasePassword(model, file, () => true)).toBe(true);
    getSessionAccess(model).beginSecuring();
    expect(confirmDatabasePassword(model, file, () => true)).toBe(false);
});
