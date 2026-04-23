import * as kdbxweb from 'kdbxweb';
import demoFileData from 'demo.kdbx';
import { Model } from 'framework/model';
import { Events } from 'framework/events';
import { GroupCollection } from 'collections/group-collection';
import { KdbxToHtml } from 'comp/format/kdbx-to-html';
import { GroupModel, type GroupFilter } from 'models/group-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { EntryModel, type EntryFilter } from 'models/entry-model';
import { IconUrlFormat } from 'util/formatting/icon-url-format';
import { Logger } from 'util/logger';
import { Locale } from 'util/locale';
import { StringFormat } from 'util/formatting/string-format';
import { FileInfoCollection } from 'collections/file-info-collection';

const logger = new Logger('file');

interface KdfParams {
    parallelism?: number;
    iterations?: number;
    memory?: number;
    rounds?: number;
}

interface RemoteKey {
    password?: kdbxweb.ProtectedValue;
    keyFileName?: string;
    keyFileData?: ArrayBuffer;
}

// chalResp on FileModel can be either:
//   - legacy YubiKey descriptor metadata (Record<string, unknown>) — kept
//     for FileInfoModel persistence shape compatibility; dead code at
//     runtime since the YubiKey hardware path was stripped from web-only
//     mode but still needed on-disk until #9 replaces it, and
//   - a KdbxChallengeResponseFn, used by the Passkey Quick Unlock (#9)
//     groundwork to feed a PRF-derived HMAC through the KDBX credentials
//     chain without a native USB key.
// Both variants flow through the same `this.chalResp` slot so
// `FileModel.open()` can forward the function form straight into
// `kdbxweb.Credentials` while the metadata form is ignored until TL
// lands the full UI. Do NOT treat this as a public API yet.
type FileModelChalResp =
    | kdbxweb.KdbxChallengeResponseFn
    | Record<string, unknown>
    | null;

interface FileModelProperties {
    id: string;
    uuid: string;
    name: string;
    db: kdbxweb.Kdbx | null;
    entryMap: Record<string, EntryModel> | null;
    groupMap: Record<string, GroupModel> | null;
    keyFileName: string;
    keyFilePath: string | null;
    chalResp: FileModelChalResp;
    passwordLength: number;
    path: string;
    opts: Record<string, unknown> | null;
    storage: string | null;
    modified: boolean;
    dirty: boolean;
    active: boolean;
    created: boolean;
    demo: boolean;
    groups: GroupCollection | null;
    oldPasswordLength: number;
    oldKeyFileName: string;
    passwordChanged: boolean;
    keyFileChanged: boolean;
    keyChangeForce: number;
    syncing: boolean;
    syncError: string | null;
    syncDate: Date | null;
    backup: Record<string, unknown> | null;
    formatVersion: number | null;
    defaultUser: string | null;
    recycleBinEnabled: boolean | null;
    historyMaxItems: number | null;
    historyMaxSize: number | null;
    keyEncryptionRounds: number | null;
    kdfName: string | null;
    kdfParameters: KdfParams | null;
    fingerprint: string | null;
    // kdbxweb stores credential hashes as ProtectedValue | undefined;
    // these mirrors exist solely so "has the key changed?" can compare
    // object identity against the current credentials. They're never
    // inspected directly, only round-tripped.
    oldPasswordHash: kdbxweb.ProtectedValue | undefined;
    oldKeyFileHash: kdbxweb.ProtectedValue | undefined;
    oldKeyChangeDate: Date | undefined;
    encryptedPassword: string | null;
    encryptedPasswordDate: Date | null;
    supportsTags: boolean;
    supportsColors: boolean;
    supportsIcons: boolean;
    supportsExpiration: boolean;
    defaultGroupHash: string;
}

class FileModel extends Model {
    declare id: string;
    declare uuid: string;
    declare name: string;
    declare db: kdbxweb.Kdbx;
    declare entryMap: Record<string, EntryModel>;
    declare groupMap: Record<string, GroupModel>;
    declare keyFileName: string;
    declare keyFilePath: string | null;
    declare chalResp: FileModelChalResp;
    declare passwordLength: number;
    declare path: string;
    declare opts: Record<string, unknown> | null;
    declare storage: string | null;
    declare modified: boolean;
    declare dirty: boolean;
    declare active: boolean;
    declare created: boolean;
    declare demo: boolean;
    declare groups: GroupCollection;
    declare oldPasswordLength: number;
    declare oldKeyFileName: string;
    declare passwordChanged: boolean;
    declare keyFileChanged: boolean;
    declare keyChangeForce: number;
    declare syncing: boolean;
    declare syncError: string | null;
    declare syncDate: Date | null;
    declare backup: Record<string, unknown> | null;
    declare formatVersion: number | null;
    declare defaultUser: string | null;
    declare recycleBinEnabled: boolean | null;
    declare historyMaxItems: number | null;
    declare historyMaxSize: number | null;
    declare keyEncryptionRounds: number | null;
    declare kdfName: string | null;
    declare kdfParameters: KdfParams | null;
    declare fingerprint: string | null;
    declare oldPasswordHash: kdbxweb.ProtectedValue | undefined;
    declare oldKeyFileHash: kdbxweb.ProtectedValue | undefined;
    declare oldKeyChangeDate: Date | undefined;
    declare encryptedPassword: string | null;
    declare encryptedPasswordDate: Date | null;
    declare supportsTags: boolean;
    declare supportsColors: boolean;
    declare supportsIcons: boolean;
    declare supportsExpiration: boolean;
    declare defaultGroupHash: string;

    constructor(data?: Partial<FileModelProperties>) {
        super({
            entryMap: {},
            groupMap: {},
            ...data
        } as Record<string, unknown>);
    }

    open(
        password: kdbxweb.ProtectedValue | null,
        fileData: ArrayBuffer,
        keyFileData: ArrayBuffer | null,
        callback: (err?: unknown) => void
    ): void {
        try {
            // Forward the challenge-response fn (if any) to kdbxweb.Credentials.
            // Prior to the #9 Passkey Quick Unlock groundwork, chalResp was
            // silently dropped here, making `params.chalResp` / `FileInfoModel
            // .chalResp` dead code since the YubiKey hardware path was
            // stripped. kdbxweb.Credentials accepts a (challenge) => Promise
            // <ArrayBuffer|Uint8Array> function as its 3rd constructor arg;
            // we only forward if `this.chalResp` is actually callable so any
            // leftover legacy descriptor metadata is safely ignored.
            const chalRespFn =
                typeof this.chalResp === 'function'
                    ? (this.chalResp as kdbxweb.KdbxChallengeResponseFn)
                    : undefined;
            const credentials = new kdbxweb.Credentials(
                password as kdbxweb.ProtectedValue,
                keyFileData as ArrayBuffer,
                chalRespFn
            );
            const ts = logger.ts();

            kdbxweb.Kdbx.load(fileData, credentials)
                .then((db) => {
                    this.db = db;
                })
                .then(() => {
                    this.readModel();
                    this.setOpenFile({
                        passwordLength: password ? password.textLength : 0
                    });
                    if (keyFileData) {
                        kdbxweb.ByteUtils.zeroBuffer(keyFileData);
                    }
                    logger.info(
                        'Opened file ' +
                            this.name +
                            ': ' +
                            logger.ts(ts) +
                            ', ' +
                            this.kdfArgsToString(this.db.header) +
                            ', ' +
                            Math.round(fileData.byteLength / 1024) +
                            ' kB'
                    );
                    callback();
                })
                .catch((err: { code?: string }) => {
                    if (
                        err.code === kdbxweb.Consts.ErrorCodes.InvalidKey &&
                        password &&
                        !password.byteLength
                    ) {
                        logger.info(
                            'Error opening file with empty password, try to open with null password'
                        );
                        return this.open(null, fileData, keyFileData, callback);
                    }
                    logger.error('Error opening file', err.code, (err as Error).message, err);
                    callback(err);
                });
        } catch (e) {
            logger.error('Error opening file', e, (e as { code?: string }).code, (e as Error).message, e);
            callback(e);
        }
    }

    kdfArgsToString(header: kdbxweb.KdbxHeader): string {
        if (header.kdfParameters) {
            return header.kdfParameters
                .keys()
                .map((key: string) => {
                    const val = header.kdfParameters!.get(key);
                    if (val instanceof ArrayBuffer) {
                        return undefined;
                    }
                    return key + '=' + val;
                })
                .filter((p: string | undefined) => p)
                .join('&');
        } else if (header.keyEncryptionRounds) {
            return header.keyEncryptionRounds + ' rounds';
        } else {
            return '?';
        }
    }

    create(name: string, callback: () => void): void {
        const password = kdbxweb.ProtectedValue.fromString('');
        const credentials = new kdbxweb.Credentials(password);
        this.db = kdbxweb.Kdbx.create(credentials, name);
        this.name = name;
        this.readModel();
        this.set({ active: true, created: true, name });
        callback();
    }

    importWithXml(fileXml: string, callback: (err?: unknown) => void): void {
        try {
            const ts = logger.ts();
            const password = kdbxweb.ProtectedValue.fromString('');
            const credentials = new kdbxweb.Credentials(password);
            kdbxweb.Kdbx.loadXml(fileXml, credentials)
                .then((db) => {
                    this.db = db;
                })
                .then(() => {
                    this.readModel();
                    this.set({ active: true, created: true });
                    logger.info('Imported file ' + this.name + ': ' + logger.ts(ts));
                    callback();
                })
                .catch((err: { code?: string; message?: string }) => {
                    logger.error('Error importing file', err.code, err.message, err);
                    callback(err);
                });
        } catch (e) {
            logger.error('Error importing file', e, (e as { code?: string }).code, (e as Error).message, e);
            callback(e);
        }
    }

    openDemo(callback: () => void): void {
        const password = kdbxweb.ProtectedValue.fromString('demo');
        const credentials = new kdbxweb.Credentials(password);
        const demoFile = kdbxweb.ByteUtils.arrayToBuffer(
            kdbxweb.ByteUtils.base64ToBytes(demoFileData)
        );
        kdbxweb.Kdbx.load(demoFile, credentials)
            .then((db) => {
                this.db = db;
            })
            .then(() => {
                this.name = 'Demo';
                this.readModel();
                this.setOpenFile({ passwordLength: 4, demo: true });
                callback();
            });
    }

    setOpenFile(props: Record<string, unknown>): void {
        this.set({
            ...props,
            active: true,
            oldKeyFileName: this.keyFileName,
            oldPasswordLength: props.passwordLength,
            passwordChanged: false,
            keyFileChanged: false
        });
        this.oldPasswordHash = this.db.credentials.passwordHash;
        this.oldKeyFileHash = this.db.credentials.keyFileHash;
        this.oldKeyChangeDate = this.db.meta.keyChanged;
    }

    readModel(): void {
        const groups = new GroupCollection();
        this.set(
            {
                uuid: this.db.getDefaultGroup().uuid.toString(),
                groups,
                formatVersion: this.db.header.versionMajor,
                defaultUser: this.db.meta.defaultUser,
                recycleBinEnabled: this.db.meta.recycleBinEnabled,
                historyMaxItems: this.db.meta.historyMaxItems,
                historyMaxSize: this.db.meta.historyMaxSize,
                keyEncryptionRounds: this.db.header.keyEncryptionRounds,
                keyChangeForce: this.db.meta.keyChangeForce,
                kdfName: this.readKdfName(),
                kdfParameters: this.readKdfParams()
            },
            { silent: true }
        );
        this.db.groups.forEach(function (this: FileModel, group) {
            let groupModel = this.getGroup(this.subId((group.uuid as unknown as { id: string }).id));
            if (groupModel) {
                groupModel.setGroup(group, this as unknown as FileModel);
            } else {
                groupModel = GroupModel.fromGroup(group, this as unknown as FileModel);
            }
            groups.push(groupModel);
        }, this);
        this.buildObjectMap();
        this.resolveFieldReferences();
    }

    readKdfName(): string {
        if (this.db.header.versionMajor === 4 && this.db.header.kdfParameters) {
            const kdfParameters = this.db.header.kdfParameters;
            let uuid = kdfParameters.get('$UUID') as ArrayBuffer | undefined;
            if (uuid) {
                const uuidStr = kdbxweb.ByteUtils.bytesToBase64(uuid);
                switch (uuidStr) {
                    case kdbxweb.Consts.KdfId.Argon2d:
                        return 'Argon2d';
                    case kdbxweb.Consts.KdfId.Argon2id:
                        return 'Argon2id';
                    case kdbxweb.Consts.KdfId.Aes:
                        return 'Aes';
                }
            }
            return 'Unknown';
        } else {
            return 'Aes';
        }
    }

    readKdfParams(): KdfParams | undefined {
        const kdfParameters = this.db.header.kdfParameters;
        if (!kdfParameters) {
            return undefined;
        }
        let uuid = kdfParameters.get('$UUID') as ArrayBuffer | undefined;
        if (!uuid) {
            return undefined;
        }
        const uuidStr = kdbxweb.ByteUtils.bytesToBase64(uuid);
        switch (uuidStr) {
            case kdbxweb.Consts.KdfId.Argon2d:
            case kdbxweb.Consts.KdfId.Argon2id:
                return {
                    parallelism: (kdfParameters.get('P') as { valueOf(): number }).valueOf(),
                    iterations: (kdfParameters.get('I') as { valueOf(): number }).valueOf(),
                    memory: (kdfParameters.get('M') as { valueOf(): number }).valueOf()
                };
            case kdbxweb.Consts.KdfId.Aes:
                return {
                    rounds: (kdfParameters.get('R') as { valueOf(): number }).valueOf()
                };
            default:
                return undefined;
        }
    }

    subId(id: string): string {
        return this.id + ':' + id;
    }

    buildObjectMap(): void {
        const entryMap: Record<string, EntryModel> = {};
        const groupMap: Record<string, GroupModel> = {};
        this.forEachGroup(
            (group) => {
                groupMap[group.id] = group;
                group.forEachOwnEntry(null, (entry) => {
                    entryMap[entry.id] = entry;
                });
            },
            { includeDisabled: true }
        );
        this.entryMap = entryMap;
        this.groupMap = groupMap;
    }

    resolveFieldReferences(): void {
        const entryMap = this.entryMap;
        Object.keys(entryMap).forEach((e) => {
            entryMap[e].resolveFieldReferences();
        });
    }

    reload(): void {
        this.buildObjectMap();
        this.readModel();
        this.emit('reload', this);
    }

    mergeOrUpdate(
        fileData: ArrayBuffer,
        remoteKey: RemoteKey | null,
        callback: (err?: unknown) => void
    ): void {
        let credentials: kdbxweb.Credentials;
        let credentialsPromise: Promise<unknown> = Promise.resolve();
        if (remoteKey) {
            credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(''));
            credentialsPromise = credentials.ready.then(() => {
                const promises: Promise<unknown>[] = [];
                if (remoteKey.password) {
                    promises.push(credentials.setPassword(remoteKey.password));
                } else {
                    credentials.passwordHash = this.db.credentials.passwordHash;
                }
                if (remoteKey.keyFileName) {
                    if (remoteKey.keyFileData) {
                        promises.push(credentials.setKeyFile(remoteKey.keyFileData));
                    } else {
                        credentials.keyFileHash = this.db.credentials.keyFileHash;
                    }
                }
                return Promise.all(promises);
            });
        } else {
            credentials = this.db.credentials;
        }
        credentialsPromise.then(() => {
            kdbxweb.Kdbx.load(fileData, credentials)
                .then((remoteDb) => {
                    if (this.modified) {
                        try {
                            if (
                                remoteKey &&
                                (remoteDb.meta.keyChanged as Date) >
                                    (this.db.meta.keyChanged as Date)
                            ) {
                                this.db.credentials = remoteDb.credentials;
                                this.keyFileName = remoteKey.keyFileName || '';
                                if (remoteKey.password) {
                                    this.passwordLength = remoteKey.password.textLength;
                                }
                            }
                            this.db.merge(remoteDb);
                        } catch (e) {
                            logger.error('File merge error', e);
                            return callback(e);
                        }
                    } else {
                        this.db = remoteDb;
                    }
                    this.dirty = true;
                    this.reload();
                    callback();
                })
                .catch((err: { code?: string; message?: string }) => {
                    logger.error(
                        'Error opening file to merge',
                        err.code,
                        err.message,
                        err
                    );
                    callback(err);
                });
        });
    }

    getLocalEditState(): kdbxweb.KdbxEditState {
        return this.db.getLocalEditState();
    }

    setLocalEditState(editState: kdbxweb.KdbxEditState): void {
        this.db.setLocalEditState(editState);
    }

    close(): void {
        this.set({
            keyFileName: '',
            passwordLength: 0,
            modified: false,
            dirty: false,
            active: false,
            created: false,
            groups: null,
            passwordChanged: false,
            keyFileChanged: false,
            syncing: false
        });
    }

    getEntry(id: string): EntryModel | undefined {
        return this.entryMap[id];
    }

    getGroup(id: string): GroupModel | undefined {
        return this.groupMap[id];
    }

    forEachEntry(
        filter: EntryFilter & { trash?: boolean; group?: string; subGroups?: boolean },
        callback: (entry: EntryModel) => void
    ): void {
        let top: FileModel | GroupModel | undefined = this;
        if (filter.trash) {
            top = this.getGroup(
                this.db.meta.recycleBinUuid
                    ? this.subId((this.db.meta.recycleBinUuid as unknown as { id: string }).id)
                    : ''
            );
        } else if (filter.group) {
            top = this.getGroup(filter.group);
        }
        if (top) {
            if ((top as GroupModel).forEachOwnEntry) {
                (top as GroupModel).forEachOwnEntry(filter, callback);
            }
            if (!filter.group || filter.subGroups) {
                (top as FileModel | GroupModel).forEachGroup(
                    (group: GroupModel) => {
                        group.forEachOwnEntry(filter, callback);
                    },
                    filter as GroupFilter
                );
            }
        }
    }

    forEachGroup(callback: (group: GroupModel) => boolean | void, filter?: GroupFilter): void {
        this.groups.forEach((group: GroupModel) => {
            if (callback(group) !== false) {
                group.forEachGroup(callback, filter);
            }
        });
    }

    getTrashGroup(): GroupModel | null {
        return this.db.meta.recycleBinEnabled
            ? this.getGroup(
                  this.subId((this.db.meta.recycleBinUuid as unknown as { id: string }).id)
              ) ?? null
            : null;
    }

    getEntryTemplatesGroup(): GroupModel | null {
        return this.db.meta.entryTemplatesGroup
            ? this.getGroup(
                  this.subId(
                      (this.db.meta.entryTemplatesGroup as unknown as { id: string }).id
                  )
              ) ?? null
            : null;
    }

    createEntryTemplatesGroup(): GroupModel {
        const rootGroup = this.groups[0] as GroupModel;
        const templatesGroup = GroupModel.newGroup(rootGroup, this as unknown as {
            subId(id: string): string;
            name: string;
            db: kdbxweb.Kdbx;
            getGroup(id: string): GroupModel | undefined;
            getEntry(id: string): EntryModel | undefined;
            setModified(): void;
            reload(): void;
        });
        templatesGroup.setName(
            StringFormat.capFirst((Locale as Record<string, string>).templates)
        );
        this.db.meta.entryTemplatesGroup = templatesGroup.group.uuid;
        this.reload();
        return templatesGroup;
    }

    setModified(): void {
        if (!this.demo) {
            this.set({ modified: true, dirty: true });
        }
    }

    getData(cb: (data?: ArrayBuffer, err?: unknown) => void): void {
        this.db.cleanup({
            historyRules: true,
            customIcons: true,
            binaries: true
        });
        this.db.cleanup({ binaries: true });
        this.db
            .save()
            .then((data) => {
                cb(data);
            })
            .catch((err) => {
                logger.error('Error saving file', this.name, err);
                cb(undefined, err);
            });
    }

    getXml(cb: (xml: string) => void): void {
        this.db.saveXml(true).then((xml) => {
            cb(xml);
        });
    }

    getHtml(cb: (html: string) => void): void {
        cb(
            KdbxToHtml.convert(this.db, {
                name: this.name
            })
        );
    }

    getKeyFileHash(): string | null {
        const hash = this.db.credentials.keyFileHash;
        return hash
            ? kdbxweb.ByteUtils.bytesToBase64(
                  (hash as unknown as { getBinary(): ArrayBuffer }).getBinary()
              )
            : null;
    }

    forEachEntryTemplate(callback: (entry: EntryModel) => void): void {
        if (!this.db.meta.entryTemplatesGroup) {
            return;
        }
        const group = this.getGroup(
            this.subId(
                (this.db.meta.entryTemplatesGroup as unknown as { id: string }).id
            )
        );
        if (!group) {
            return;
        }
        group.forEachOwnEntry({}, callback);
    }

    setSyncProgress(): void {
        this.set({ syncing: true });
    }

    setSyncComplete(
        path: string | null,
        storage: string | null,
        error: string | null
    ): void {
        if (!error) {
            this.db.removeLocalEditState();
        }
        const modified = this.modified && !!error;
        this.set({
            created: false,
            path: path || this.path,
            storage: storage || this.storage,
            modified,
            dirty: error ? this.dirty : false,
            syncing: false,
            syncError: error
        });

        if (!error && this.passwordChanged && this.encryptedPassword) {
            this.set({
                encryptedPassword: null,
                encryptedPasswordDate: null
            });
        }

        if (!error && this.passwordChanged) {
            const fi = FileInfoCollection.get(this.id);
            if (fi && fi.passkeyWrappedKey) {
                logger.info('Password changed — clearing stale passkey registration');
                fi.passkeyCredentialId = null;
                fi.passkeyPrfSalt = null;
                fi.passkeyWrappedKey = null;
                fi.passkeyCreatedDate = null;
                FileInfoCollection.save();
            }
        }

        if (!(this as unknown as Record<string, unknown>).open) {
            return;
        }
        this.setOpenFile({ passwordLength: this.passwordLength });
        this.forEachEntry({ includeDisabled: true }, (entry) => entry.setSaved());
    }

    setPassword(password: kdbxweb.ProtectedValue): void {
        this.db.credentials.setPassword(password);
        this.db.meta.keyChanged = new Date();
        this.set({ passwordLength: password.textLength, passwordChanged: true });
        this.setModified();
    }

    resetPassword(): void {
        this.db.credentials.passwordHash = this.oldPasswordHash;
        if (this.db.credentials.keyFileHash === this.oldKeyFileHash) {
            this.db.meta.keyChanged = this.oldKeyChangeDate;
        }
        this.set({
            passwordLength: this.oldPasswordLength,
            passwordChanged: false
        });
    }

    setKeyFile(keyFile: ArrayBuffer | Uint8Array, keyFileName: string): void {
        this.db.credentials.setKeyFile(keyFile);
        this.db.meta.keyChanged = new Date();
        this.set({ keyFileName, keyFileChanged: true });
        this.setModified();
    }

    generateAndSetKeyFile(): Promise<Uint8Array> {
        return kdbxweb.Credentials.createRandomKeyFile().then((keyFile) => {
            const keyFileName = 'Generated';
            this.setKeyFile(keyFile, keyFileName);
            return keyFile;
        });
    }

    resetKeyFile(): void {
        this.db.credentials.keyFileHash = this.oldKeyFileHash;
        if (this.db.credentials.passwordHash === this.oldPasswordHash) {
            this.db.meta.keyChanged = this.oldKeyChangeDate;
        }
        this.set({ keyFileName: this.oldKeyFileName, keyFileChanged: false });
    }

    removeKeyFile(): void {
        this.db.credentials.setKeyFile(null);
        const changed = !!this.oldKeyFileHash;
        if (!changed && this.db.credentials.passwordHash === this.oldPasswordHash) {
            this.db.meta.keyChanged = this.oldKeyChangeDate;
        }
        this.set({
            keyFileName: '',
            keyFilePath: '',
            keyFileChanged: changed
        });
        Events.emit('unset-keyfile', this.id);
        this.setModified();
    }

    isKeyChangePending(force: boolean): boolean {
        if (!this.db.meta.keyChanged) {
            return false;
        }
        const expiryDays = (
            force ? this.db.meta.keyChangeForce : this.db.meta.keyChangeRec
        ) as number;
        if (!expiryDays || expiryDays < 0 || isNaN(expiryDays)) {
            return false;
        }
        const daysDiff =
            (Date.now() - +(this.db.meta.keyChanged as Date)) / 1000 / 3600 / 24;
        return daysDiff > expiryDays;
    }

    setChallengeResponse(): void {
        // No-op: challenge-response (YubiKey) removed in web-only fork
    }

    setKeyChange(force: boolean, days: number): void {
        if (isNaN(days) || !days || days < 0) {
            days = -1;
        }
        const prop = force ? 'keyChangeForce' : 'keyChangeRec';
        (this.db.meta as unknown as Record<string, number>)[prop] = days;
        (this as unknown as Record<string, number>)[prop] = days;
        this.setModified();
    }

    setName(name: string): void {
        this.db.meta.name = name;
        this.db.meta.nameChanged = new Date();
        this.name = name;
        (this.groups[0] as GroupModel).setName(name);
        this.setModified();
        this.reload();
    }

    setDefaultUser(defaultUser: string): void {
        this.db.meta.defaultUser = defaultUser;
        this.db.meta.defaultUserChanged = new Date();
        this.defaultUser = defaultUser;
        this.setModified();
    }

    setRecycleBinEnabled(enabled: boolean): void {
        enabled = !!enabled;
        this.db.meta.recycleBinEnabled = enabled;
        if (enabled) {
            this.db.createRecycleBin();
        }
        this.recycleBinEnabled = enabled;
        this.setModified();
    }

    setHistoryMaxItems(count: number): void {
        this.db.meta.historyMaxItems = count;
        this.historyMaxItems = count;
        this.setModified();
    }

    setHistoryMaxSize(size: number): void {
        this.db.meta.historyMaxSize = size;
        this.historyMaxSize = size;
        this.setModified();
    }

    setKeyEncryptionRounds(rounds: number): void {
        this.db.header.keyEncryptionRounds = rounds;
        this.keyEncryptionRounds = rounds;
        this.setModified();
    }

    setKdfParameter(field: string, value: number): void {
        const ValueType = kdbxweb.VarDictionary.ValueType;
        switch (field) {
            case 'memory':
                this.db.header.kdfParameters!.set(
                    'M',
                    ValueType.UInt64,
                    kdbxweb.Int64.from(value)
                );
                break;
            case 'iterations':
                this.db.header.kdfParameters!.set(
                    'I',
                    ValueType.UInt64,
                    kdbxweb.Int64.from(value)
                );
                break;
            case 'parallelism':
                this.db.header.kdfParameters!.set('P', ValueType.UInt32, value);
                break;
            case 'rounds':
                this.db.header.kdfParameters!.set('R', ValueType.UInt32, value);
                break;
            default:
                return;
        }
        this.kdfParameters = this.readKdfParams() ?? null;
        this.setModified();
    }

    emptyTrash(): void {
        const trashGroup = this.getTrashGroup();
        if (trashGroup) {
            let modified = false;
            trashGroup
                .getOwnSubGroups()
                .slice()
                .forEach((group) => {
                    this.db.move(group, null);
                    modified = true;
                });
            trashGroup.group.entries.slice().forEach((entry) => {
                this.db.move(entry, null);
                modified = true;
            });
            (trashGroup.items as unknown[]).length = 0;
            trashGroup.entries.length = 0;
            if (modified) {
                this.setModified();
            }
        }
    }

    getCustomIcons(): Record<string, string> {
        const customIcons: Record<string, string> = {};
        for (const [id, icon] of this.db.meta.customIcons) {
            // toDataUrl only returns null for null/undefined input; icon.data
            // is ArrayBuffer so the result is always a string here.
            const dataUrl = IconUrlFormat.toDataUrl(icon.data);
            if (dataUrl) {
                customIcons[id] = dataUrl;
            }
        }
        return customIcons;
    }

    addCustomIcon(iconData: string): string {
        const uuid = kdbxweb.KdbxUuid.random();
        this.db.meta.customIcons.set((uuid as unknown as { id: string }).id, {
            data: kdbxweb.ByteUtils.arrayToBuffer(
                kdbxweb.ByteUtils.base64ToBytes(iconData)
            ),
            lastModified: new Date()
        });
        return uuid.toString();
    }

    renameTag(from: string, to: string): void {
        this.forEachEntry({}, (entry) => entry.renameTag(from, to));
    }

    setFormatVersion(version: 4): void {
        // KeeWebX is KDBX4-only (see CLAUDE.md Architecture Decisions).
        if (version !== 4) {
            throw new Error(`Unsupported KDBX version: ${String(version)}. KeeWebX only supports KDBX4.`);
        }
        this.db.setVersion(version);
        this.setModified();
        this.readModel();
    }

    setKdf(kdfName: string): void {
        const kdfParameters = this.db.header.kdfParameters;
        if (!kdfParameters) {
            throw new Error('Cannot set KDF on this version');
        }
        switch (kdfName) {
            case 'Argon2d':
                this.db.setKdf(kdbxweb.Consts.KdfId.Argon2d);
                break;
            case 'Argon2id':
                this.db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
                break;
            default:
                throw new Error('Bad KDF name: only Argon2d and Argon2id are supported');
        }
        this.setModified();
        this.readModel();
    }

    static createKeyFileWithHash(hash: string): Uint8Array {
        const hashData = kdbxweb.ByteUtils.base64ToBytes(hash);
        const hexHash = kdbxweb.ByteUtils.bytesToHex(hashData);
        return kdbxweb.ByteUtils.stringToBytes(hexHash);
    }
}

FileModel.defineModelProperties({
    id: '',
    uuid: '',
    name: '',
    db: null,
    entryMap: null,
    groupMap: null,
    keyFileName: '',
    keyFilePath: null,
    chalResp: null,
    passwordLength: 0,
    path: '',
    opts: null,
    storage: null,
    modified: false,
    dirty: false,
    active: false,
    created: false,
    demo: false,
    groups: null,
    oldPasswordLength: 0,
    oldKeyFileName: '',
    passwordChanged: false,
    keyFileChanged: false,
    keyChangeForce: -1,
    syncing: false,
    syncError: null,
    syncDate: null,
    backup: null,
    formatVersion: null,
    defaultUser: null,
    recycleBinEnabled: null,
    historyMaxItems: null,
    historyMaxSize: null,
    keyEncryptionRounds: null,
    kdfName: null,
    kdfParameters: null,
    fingerprint: null, // obsolete
    oldPasswordHash: null,
    oldKeyFileHash: null,
    oldKeyChangeDate: null,
    encryptedPassword: null,
    encryptedPasswordDate: null,
    supportsTags: true,
    supportsColors: true,
    supportsIcons: true,
    supportsExpiration: true,
    defaultGroupHash: ''
});

export { FileModel };
export type { FileModelProperties, KdfParams, RemoteKey };
