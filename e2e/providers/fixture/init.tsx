import { registerStorage, registerDefaultSetting } from 'hooks/data-registry';
import { StorageBase } from 'storage/storage-base';
import { registerStorageUi } from 'app/storage-extensions';
import { ByteUtils } from 'kdbxweb';
import demo from 'demo.kdbx';

class ExampleStorage extends StorageBase {
    name = 'example'; enabled = true; system = true; supportsOpen = true;
    configured = false;
    needShowOpenConfig() { return !this.configured; }
    getOpenConfig() { return { fields: [{id: 'account', title: 'Account', required: true}, {id: 'password', title: 'Connection password', type: 'password', required: true}] }; }
    applyConfig(values: Record<string, unknown>, callback: (error?: unknown) => void, options: {signal: AbortSignal}) {
        const complete = () => { if (options.signal.aborted) return; if (values.password !== 'connection-secret') callback('Connection rejected'); else { this.configured = true; callback(); } };
        if (values.account === 'delayed') setTimeout(complete, 1000); else complete();
    }
    list(directory: string | null, callback: (error: unknown, files: unknown[]) => void, options: {signal: AbortSignal}) {
        const files = directory === 'folder' ? [{name: 'Nested.kdbx', path: 'nested'}, {name: 'notes.txt', path: 'text'}] : [{name: 'Folder', path: 'folder', dir: true}, {name: 'Vault.kdbx', path: 'vault'}, {name: 'Pending', path: 'pending', dir: true}];
        // Deliberately deliver a late callback: the UI owns the admission check too.
        if (directory === 'pending') setTimeout(() => callback(null, [{name: 'Late.kdbx', path: 'late'}]), 500);
        else callback(null, files);
    }
    load(_path: string, _opts: unknown, callback: (error: unknown, data: ArrayBuffer, stat: unknown) => void) { callback(null, ByteUtils.arrayToBuffer(ByteUtils.base64ToBytes(demo)), {rev: '1'}); }
    stat(_path: string, _opts: unknown, callback: (error: unknown, stat: unknown) => void) { callback(null, {rev: '1'}); }
}
registerDefaultSetting('example', true);
registerStorage('example', () => new ExampleStorage());
registerStorageUi({id: 'example', provider: 'example', title: 'Example storage', Settings: () => <p>Example connection settings</p>, DatabaseSettings: () => <p>Example database settings</p>});
