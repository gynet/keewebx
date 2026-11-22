import { expect, test } from 'bun:test';
import { FileInfoCollection } from '../src/collections/file-info-collection';

test('loading recent vaults removes remembered key material from persistent storage', async () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const storage = {
        fileInfo: JSON.stringify([{ id: 'legacy', keyFileName: 'vault.keyx', keyFileHash: 'legacy-key-material' }])
    };
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    try {
        await FileInfoCollection.load();
        expect(FileInfoCollection.get('legacy')?.keyFileName).toBe('vault.keyx');
        expect(FileInfoCollection.get('legacy')?.keyFileHash).toBeNull();
        expect(storage.fileInfo).not.toContain('legacy-key-material');
    } finally {
        FileInfoCollection.remove('legacy');
        if (before) Object.defineProperty(globalThis, 'localStorage', before);
        else Reflect.deleteProperty(globalThis, 'localStorage');
    }
});
