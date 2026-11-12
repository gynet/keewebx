import { Kdbx, Credentials, ProtectedValue, Consts, ByteUtils } from 'kdbxweb';
import type { FileModel } from 'models/file-model';

export interface DatabaseSettings {
    name: string;
    defaultUser: string;
    recycleBin: boolean;
    historyItems: number;
    historyBytes: number;
    kdf: string;
    iterations: number;
    memoryKiB: number;
    parallelism: number;
    keyChangeDays: number;
}

function read(db: Kdbx, name: string): DatabaseSettings {
    const params = db.header.kdfParameters;
    const uuid = params?.get('$UUID');
    const id = uuid ? ByteUtils.bytesToBase64(uuid as ArrayBuffer) : '';
    return {
        name, defaultUser: db.meta.defaultUser ?? '', recycleBin: db.meta.recycleBinEnabled !== false,
        historyItems: db.meta.historyMaxItems ?? Consts.Defaults.HistoryMaxItems,
        historyBytes: db.meta.historyMaxSize ?? Consts.Defaults.HistoryMaxSize,
        kdf: id === Consts.KdfId.Argon2id ? 'Argon2id' : id === Consts.KdfId.Argon2d ? 'Argon2d' : 'Aes',
        iterations: Number(params?.get('I') ?? 2), memoryKiB: Number(params?.get('M') ?? 1048576) / 1024,
        parallelism: Number(params?.get('P') ?? 1), keyChangeDays: db.meta.keyChangeForce ?? -1
    };
}

export function defaultDatabaseSettings(): DatabaseSettings {
    return read(Kdbx.create(new Credentials(ProtectedValue.fromString('')), ''), '');
}
export function readDatabaseSettings(file: FileModel): DatabaseSettings { return read(file.db, file.name); }

export function validateDatabaseSettings(value: DatabaseSettings): void {
    if (!value.name.trim()) throw new Error('A vault name is required.');
    for (const number of [value.historyItems, value.historyBytes, value.keyChangeDays]) {
        if (!Number.isSafeInteger(number) || number < -1) throw new Error('Invalid history or key change limit.');
    }
    if (!['Argon2d', 'Argon2id', 'Aes'].includes(value.kdf)) throw new Error('Unsupported key derivation function.');
    if (value.kdf !== 'Aes') {
        if (![value.iterations, value.memoryKiB, value.parallelism].every((number) => Number.isSafeInteger(number) && number > 0)
            || value.memoryKiB < 8 * value.parallelism || value.parallelism > 0xffffff
            || value.iterations > 0xffffffff || value.memoryKiB > 0xffffffff) {
            throw new Error('Invalid Argon2 parameters. Memory must be at least 8 KiB per parallel thread.');
        }
    }
}

/** Only changed values reach the existing model setters; untouched KDF bytes stay intact. */
export function applyDatabaseSettings(file: FileModel, value: DatabaseSettings): void {
    validateDatabaseSettings(value);
    if (file.syncing) throw new Error('A save is in progress. Wait for it to finish, then retry.');
    const before = readDatabaseSettings(file);
    if (value.kdf === 'Aes' && before.kdf !== 'Aes') throw new Error('Select Argon2d or Argon2id.');
    if (value.name !== before.name) file.setName(value.name.trim());
    if (value.defaultUser !== before.defaultUser) file.setDefaultUser(value.defaultUser);
    if (value.recycleBin !== before.recycleBin) file.setRecycleBinEnabled(value.recycleBin);
    if (value.historyItems !== before.historyItems) file.setHistoryMaxItems(value.historyItems);
    if (value.historyBytes !== before.historyBytes) file.setHistoryMaxSize(value.historyBytes);
    if (value.keyChangeDays !== before.keyChangeDays) file.setKeyChange(true, value.keyChangeDays);
    if (value.kdf !== before.kdf) file.setKdf(value.kdf);
    if (value.kdf !== 'Aes') {
        if (value.kdf !== before.kdf || value.iterations !== before.iterations) file.setKdfParameter('iterations', value.iterations);
        if (value.kdf !== before.kdf || value.memoryKiB !== before.memoryKiB) file.setKdfParameter('memory', value.memoryKiB * 1024);
        if (value.kdf !== before.kdf || value.parallelism !== before.parallelism) file.setKdfParameter('parallelism', value.parallelism);
    }
}
