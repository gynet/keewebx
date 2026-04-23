import * as kdbxweb from 'kdbxweb';
import { Events } from 'framework/events';
import { Storage } from 'storage';
import { SearchResultCollection } from 'collections/search-result-collection';
import { FileCollection } from 'collections/file-collection';
import { FileInfoCollection } from 'collections/file-info-collection';
import { RuntimeInfo } from 'const/runtime-info';
import { Timeouts } from 'const/timeouts';
import { AppSettingsModel } from 'models/app-settings-model';
import { EntryModel, type EntryFilter } from 'models/entry-model';
import { FileInfoModel } from 'models/file-info-model';
import { FileModel, type RemoteKey } from 'models/file-model';
import { GroupModel } from 'models/group-model';
import { MenuModel } from 'models/menu/menu-model';
import { Features } from 'util/features';
import { DateFormat } from 'comp/i18n/date-format';
import { UrlFormat } from 'util/formatting/url-format';
import { IdGenerator } from 'util/generators/id-generator';
import { Locale } from 'util/locale';
import { Logger } from 'util/logger';
import { debounce, noop } from 'util/fn';
import { Alerts } from 'comp/ui/alerts';
import { runBeforeOpen, runBeforeSync } from 'hooks/storage-guards';
import 'util/kdbxweb/protected-value-ex';

interface StorageStat {
    rev?: string | null;
    path?: string;
    notFound?: boolean;
}

interface StorageError {
    name?: string;
    message?: string;
    code?: string;
    notFound?: boolean;
    revConflict?: boolean;
    ykError?: boolean;
    toString(): string;
}

type StorageErrorLike = StorageError | string | null | undefined;

type StorageLoadCallback = (
    err: StorageErrorLike,
    data?: ArrayBuffer,
    stat?: StorageStat | null
) => void;

type StorageStatCallback = (err: StorageErrorLike, stat?: StorageStat | null) => void;

type StorageSaveCallback = (err: StorageErrorLike, stat?: StorageStat | null) => void;

/**
 * Common provider-method shape used by app-model for dynamic `Storage[name]`
 * lookups. Individual provider classes (StorageCache, StorageWebDav) implement
 * a superset of this; the optional methods (stat/watch/getPathForName/mkdir)
 * originate from upstream KeeWeb file-system providers that are not shipped in
 * the web-only fork, but app-model still guards them with runtime checks.
 */
interface StorageProvider {
    name: string | null;
    enabled: boolean;
    load(
        path: string | null | undefined,
        opts: Record<string, unknown> | null | undefined,
        callback: StorageLoadCallback | null
    ): void;
    save(
        path: string | null | undefined,
        opts: Record<string, unknown> | null | undefined,
        data: ArrayBuffer,
        callback: StorageSaveCallback | null,
        rev?: string
    ): void;
    remove?(id: string, opts?: unknown, callback?: (err?: unknown) => void): void;
    stat?(
        path: string | null | undefined,
        opts: Record<string, unknown> | null | undefined,
        callback: StorageStatCallback | null
    ): void;
    watch?(path: string, callback: () => void): void;
    unwatch?(path: string): void;
    getPathForName?(name: string): string;
    mkdir?(path: string, callback: (err?: unknown) => void): void;
    fileOptsToStoreOpts?(
        opts: Record<string, unknown>,
        file: FileModel,
        passwordHash?: Uint8Array
    ): Record<string, unknown> | Promise<Record<string, unknown>>;
    storeOptsToFileOpts?(
        opts: Record<string, unknown>,
        file: FileModel,
        passwordHash?: Uint8Array
    ): Record<string, unknown> | Promise<Record<string, unknown>>;
}

function getStorageProvider(name: string | null | undefined): StorageProvider | undefined {
    if (!name) {
        return undefined;
    }
    return (Storage as unknown as Record<string, StorageProvider | undefined>)[name];
}

/**
 * Upstream KeeWeb exposes a `readOnly` flag on FileModel that was only ever
 * set by desktop file-system storages (filesystem-level RO flag). The
 * web-only fork ships no such provider and never sets the flag, so it is
 * always falsy. We keep the call sites honest by reading it through this
 * helper instead of adding the property to FileModel, because adding it
 * there would imply the UI has a way to mutate it (it does not).
 */
function isReadOnly(file: FileModel): boolean {
    return (file as unknown as { readOnly?: boolean }).readOnly === true;
}

function toArrayBuffer(
    data: ArrayBuffer | Uint8Array | null | undefined
): ArrayBuffer | null {
    if (!data) {
        return null;
    }
    if (data instanceof ArrayBuffer) {
        return data;
    }
    return data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
    ) as ArrayBuffer;
}

interface FileUnlockPromise {
    resolve: (file: FileModel) => void;
    reject: (err: Error) => void;
    unlockRes: unknown;
}

interface AdvancedSearch {
    exact?: boolean;
    protect?: boolean;
    user?: boolean;
}

interface OpenFileParams {
    id?: string;
    name: string;
    storage?: string;
    path?: string;
    opts?: Record<string, unknown>;
    password?: kdbxweb.ProtectedValue | null;
    keyFileData?: ArrayBuffer | Uint8Array | null;
    keyFileName?: string;
    keyFilePath?: string;
    fileData?: ArrayBuffer;
    rev?: string;
    chalResp?: Record<string, unknown>;
    encryptedPassword?: string;
    fileXml?: string;
    template?: { file: FileModel; entry: EntryModel };
}

interface SyncOptions {
    storage?: string;
    path?: string;
    opts?: Record<string, unknown>;
    remoteKey?: RemoteKey | null;
}

interface ConfigFileEntry {
    storage?: string;
    name?: string;
    path?: string;
    options?: Record<string, unknown>;
}

interface UserConfig {
    settings?: Record<string, unknown>;
    files?: ConfigFileEntry[];
    showOnlyFilesFromConfig?: boolean;
    advancedSearch?: AdvancedSearch;
}

type AppFilter = EntryFilter & {
    trash?: boolean;
    group?: string;
    subGroups?: boolean;
    tag?: string;
    tagLower?: string;
    text?: string;
    textLower?: string;
    textParts?: string[] | null;
    textLowerParts?: string[] | null;
    advanced?: AdvancedSearch;
};

/**
 * Shape of FileModel.backup (declared as Record<string, unknown> on the
 * model since it is persisted as a JSON blob). Defined centrally so the
 * backup/restore helpers can narrow safely.
 */
interface BackupSettings extends Record<string, unknown> {
    enabled?: boolean;
    pending?: boolean;
    storage?: string;
    path?: string;
    schedule?: string;
    lastTime?: number;
}

function asBackupSettings(
    value: Record<string, unknown> | null | undefined
): BackupSettings | null {
    return (value ?? null) as BackupSettings | null;
}

class AppModel {
    static instance: AppModel;

    tags: string[] = [];
    files: FileCollection = new FileCollection();
    fileInfos: typeof FileInfoCollection = FileInfoCollection;
    menu: MenuModel = new MenuModel();
    filter: AppFilter = {};
    sort: string = 'title';
    settings: typeof AppSettingsModel = AppSettingsModel;
    activeEntryId: string | null = null;
    isBeta: boolean = (RuntimeInfo as { beta: boolean }).beta;
    advancedSearch: AdvancedSearch | null = null;
    memoryPasswordStorage: Record<string, { value: string; date: Date }> = {};
    fileUnlockPromise: FileUnlockPromise | null = null;
    hardwareDecryptInProgress: boolean = false;
    mainWindowBlurTimer: ReturnType<typeof setTimeout> | null = null;
    appLogger!: Logger;

    constructor() {
        Events.on('refresh', this.refresh.bind(this));
        Events.on('tags-style-changed', () => this._tagsChanged());
        Events.on('set-filter', this.setFilter.bind(this));
        Events.on('add-filter', this.addFilter.bind(this));
        Events.on('set-sort', this.setSort.bind(this));
        Events.on('empty-trash', this.emptyTrash.bind(this));
        Events.on('select-entry', this.selectEntry.bind(this));
        Events.on('unset-keyfile', this.unsetKeyFile.bind(this));
        Events.on('usb-devices-changed', this.usbDevicesChanged.bind(this));
        Events.on('main-window-blur', this.mainWindowBlur.bind(this));
        Events.on('main-window-focus', this.mainWindowFocus.bind(this));
        Events.on('main-window-will-close', this.mainWindowWillClose.bind(this));
        Events.on('hardware-decrypt-started', this.hardwareDecryptStarted.bind(this));
        Events.on('hardware-decrypt-finished', this.hardwareDecryptFinished.bind(this));

        this.appLogger = new Logger('app');
        AppModel.instance = this;
    }

    loadConfig(configLocation: string): Promise<void> {
        return new Promise<UserConfig>((resolve, reject) => {
            this.ensureCanLoadConfig(configLocation);
            this.appLogger.debug('Loading config from', configLocation);
            const ts = this.appLogger.ts();
            const xhr = new XMLHttpRequest();
            xhr.open('GET', configLocation);
            xhr.responseType = 'json';
            xhr.send();
            xhr.addEventListener('load', () => {
                let response: unknown = xhr.response;
                if (!response) {
                    const errorDesc = xhr.statusText === 'OK' ? 'Malformed JSON' : xhr.statusText;
                    this.appLogger.error('Error loading app config', errorDesc);
                    return reject('Error loading app config');
                }
                if (typeof response === 'string') {
                    try {
                        response = JSON.parse(response);
                    } catch (e) {
                        this.appLogger.error('Error parsing response', e, response);
                        return reject('Error parsing response');
                    }
                }
                const cfg = response as UserConfig;
                if (!cfg.settings) {
                    this.appLogger.error('Invalid app config, no settings section', cfg);
                    return reject('Invalid app config, no settings section');
                }
                this.appLogger.info(
                    'Loaded app config from',
                    configLocation,
                    this.appLogger.ts(ts)
                );
                resolve(cfg);
            });
            xhr.addEventListener('error', () => {
                this.appLogger.error('Error loading app config', xhr.statusText, xhr.status);
                reject('Error loading app config');
            });
        }).then((config) => {
            this.applyUserConfig(config);
        });
    }

    ensureCanLoadConfig(url: string): void {
        if (!Features.isSelfHosted) {
            throw 'Configs are supported only in self-hosted installations';
        }
        const link = document.createElement('a');
        link.href = url;
        const isExternal = link.host && link.host !== location.host;
        if (isExternal) {
            throw 'Loading config from this location is not allowed';
        }
    }

    applyUserConfig(config: UserConfig): void {
        if (config.settings) {
            this.settings.set(config.settings);
        }
        if (config.files) {
            if (config.showOnlyFilesFromConfig) {
                this.fileInfos.length = 0;
            }
            config.files
                .filter(
                    (file): file is Required<Pick<ConfigFileEntry, 'storage' | 'name' | 'path'>> & ConfigFileEntry =>
                        !!(
                            file &&
                            file.storage &&
                            file.name &&
                            file.path &&
                            !this.fileInfos.getMatch(file.storage, file.name, file.path)
                        )
                )
                .map(
                    (file) =>
                        new FileInfoModel({
                            id: IdGenerator.uuid(),
                            name: file.name,
                            storage: file.storage,
                            path: file.path,
                            opts: file.options
                        })
                )
                .reverse()
                .forEach((fi) => this.fileInfos.unshift(fi));
        }
        if (config.advancedSearch) {
            this.advancedSearch = config.advancedSearch;
            this.addFilter({ advanced: this.advancedSearch });
        }
    }

    addFile(file: FileModel): boolean {
        if (this.files.get(file.id)) {
            return false;
        }
        this.files.push(file);
        for (const group of file.groups) {
            this.menu.groupsSection.addItem(group);
        }
        this._addTags(file);
        this._tagsChanged();
        this.menu.filesSection.addItem({
            icon: 'lock',
            title: Locale.menuSetFile,
            page: 'file',
            file
        });
        this.updateFileSettingsSection();

        this.refresh();

        file.on('reload', this.reloadFile.bind(this));
        file.on('change', () => {
            Events.emit('file-changed', file);
        });
        file.on('ejected', () => this.closeFile(file));
        file.on('change:dirty', (file, dirty) => {
            if (dirty && this.settings.autoSaveInterval === -1) {
                this.syncFile(file);
            }
        });

        Events.emit('file-opened');

        if (this.fileUnlockPromise) {
            this.appLogger.info('Running pending file unlock operation');
            this.fileUnlockPromise.resolve(file);
            this.fileUnlockPromise = null;
            Events.emit('unlock-message-changed', null);
        }

        return true;
    }

    reloadFile(file: FileModel): void {
        this.menu.groupsSection.replaceByFile(file, file.groups[0]);
        this.updateTags();
    }

    tagCounts: Record<string, number> = {};

    _addTags(file: FileModel): void {
        const tagsHash: Record<string, boolean> = {};
        this.tags.forEach((tag) => {
            tagsHash[tag.toLowerCase()] = true;
        });
        file.forEachEntry({}, (entry: EntryModel) => {
            for (const tag of entry.tags) {
                const key = tag.toLowerCase();
                if (!tagsHash[key]) {
                    tagsHash[key] = true;
                    this.tags.push(tag);
                }
                this.tagCounts[tag] = (this.tagCounts[tag] || 0) + 1;
            }
        });
        this.tags.sort();
    }

    _tagsChanged(): void {
        if (this.tags.length) {
            this.menu.tagsSection.scrollable = true;
            const isCloud = this.settings.tagStyle !== 'dot';
            this.menu.tagsSection.setItems(
                this.tags.map((tag) => {
                    // Deterministic hue per tag name (djb2 hash mod 360)
                    let h = 0;
                    for (let i = 0; i < tag.length; i++) {
                        h = tag.charCodeAt(i) + ((h << 5) - h);
                    }
                    const hue = Math.abs(h) % 360;
                    const count = this.tagCounts[tag] || 0;
                    const dot = `data:image/svg+xml,${encodeURIComponent(
                        `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12'><circle cx='6' cy='6' r='5' fill='hsl(${hue},65%,55%)'/></svg>`
                    )}`;
                    return {
                        title: count > 0 ? `${tag} (${count})` : tag,
                        customIcon: dot,
                        cls: isCloud ? 'menu__item--tag menu__item--tag-cloud' : 'menu__item--tag menu__item--tag-dot',
                        itemStyle: isCloud ? `--tag-hue:${hue}` : undefined,
                        filterKey: 'tag',
                        filterValue: tag,
                        editable: true
                    };
                })
            );
        } else {
            this.menu.tagsSection.scrollable = false;
            this.menu.tagsSection.removeAllItems();
        }
    }

    updateTags(): void {
        const oldTags = this.tags.slice();
        this.tags.splice(0, this.tags.length);
        this.tagCounts = {};
        for (const file of this.files) {
            this._addTags(file);
        }
        if (oldTags.join(',') !== this.tags.join(',')) {
            this._tagsChanged();
        }
    }

    renameTag(from: string, to: string): void {
        this.files.forEach((file) => file.renameTag && file.renameTag(from, to));
        this.updateTags();
    }

    closeAllFiles(): void {
        if (!this.files.hasOpenFiles()) {
            return;
        }
        for (const file of this.files) {
            file.close();
            this.fileClosed(file);
        }
        this.files.length = 0;
        this.menu.groupsSection.removeAllItems();
        this.menu.tagsSection.scrollable = false;
        this.menu.tagsSection.removeAllItems();
        this.menu.filesSection.removeAllItems();
        this.updateFileSettingsSection();
        this.tags.splice(0, this.tags.length);
        this.filter = {};
        this.menu.select({ item: this.menu.allItemsItem });
        Events.emit('all-files-closed');
    }

    closeFile(file: FileModel): void {
        file.close();
        this.fileClosed(file);
        this.files.remove(file);
        this.updateTags();
        this.menu.groupsSection.removeByFile(file);
        this.menu.filesSection.removeByFile(file);
        this.updateFileSettingsSection();
        this.menu.select({ item: this.menu.allItemsSection.items[0] });
        Events.emit('one-file-closed');
    }

    /**
     * Bind the static "File" entry in the Settings sidebar to the first
     * open database and toggle its visibility. This is the #17-era UX
     * tweak: a fixed "File" tab next to General/Shortcuts/About so users
     * don't have to realise the filename-labelled item below IS the file
     * settings entry. Dynamic filename entries stay untouched.
     */
    private updateFileSettingsSection(): void {
        const section = this.menu.fileSettingsSection;
        const item = section.items[0];
        if (this.files.length > 0) {
            (item as unknown as { set(p: Record<string, unknown>): void }).set({
                file: this.files[0]
            });
            section.set({ visible: true });
        } else {
            (item as unknown as { set(p: Record<string, unknown>): void }).set({
                file: null
            });
            section.set({ visible: false });
        }
    }

    emptyTrash(): void {
        this.files.forEach((file) => file.emptyTrash && file.emptyTrash());
        this.refresh();
    }

    setFilter(filter: AppFilter): void {
        this.filter = this.prepareFilter(filter);
        this.filter.subGroups = this.settings.expandGroups;
        if (!this.filter.advanced && this.advancedSearch) {
            this.filter.advanced = this.advancedSearch;
        }
        const entries = this.getEntries();
        if (!this.activeEntryId || !entries.get(this.activeEntryId)) {
            const firstEntry = entries[0] as EntryModel | undefined;
            this.activeEntryId = firstEntry ? firstEntry.id : null;
        }
        Events.emit('filter', { filter: this.filter, sort: this.sort, entries });
        if (this.activeEntryId) {
            Events.emit('entry-selected', entries.get(this.activeEntryId));
        } else {
            Events.emit('entry-selected', undefined);
        }
    }

    refresh(): void {
        this.setFilter(this.filter);
    }

    selectEntry(entry: { id: string }): void {
        this.activeEntryId = entry.id;
        this.refresh();
    }

    addFilter(filter: AppFilter): void {
        this.setFilter(Object.assign(this.filter, filter));
    }

    setSort(sort: string): void {
        this.sort = sort;
        this.setFilter(this.filter);
    }

    getEntries(): SearchResultCollection {
        const entries = this.getEntriesByFilter(this.filter, this.files);
        entries.sortEntries(this.sort, this.filter);
        if (this.filter.trash) {
            this.addTrashGroups(entries);
        }
        return entries;
    }

    getEntriesByFilter(filter: AppFilter, files: FileCollection): SearchResultCollection {
        const preparedFilter = this.prepareFilter(filter);
        const entries = new SearchResultCollection();

        files.forEach((file) => {
            file.forEachEntry(preparedFilter, (entry) => {
                entries.push(entry);
            });
        });

        return entries;
    }

    addTrashGroups(collection: SearchResultCollection): void {
        this.files.forEach((file) => {
            const trashGroup = file.getTrashGroup && file.getTrashGroup();
            if (trashGroup) {
                trashGroup.getOwnSubGroups().forEach((group) => {
                    collection.unshift(GroupModel.fromGroup(group, file, trashGroup));
                });
            }
        });
    }

    prepareFilter(filter: AppFilter): AppFilter {
        const prepared: AppFilter = { ...filter };

        prepared.textLower = prepared.text ? prepared.text.toLowerCase() : '';
        prepared.textParts = null;
        prepared.textLowerParts = null;

        const exact = prepared.advanced && prepared.advanced.exact;
        if (!exact && prepared.text) {
            const textParts = prepared.text.split(/\s+/).filter((s: string) => s);
            if (textParts.length) {
                prepared.textParts = textParts;
                prepared.textLowerParts = (prepared.textLower ?? '').split(/\s+/).filter((s: string) => s);
            }
        }

        prepared.tagLower = prepared.tag ? prepared.tag.toLowerCase() : '';

        return prepared;
    }

    getFirstSelectedGroupForCreation(): { group: GroupModel; file: FileModel } {
        const selGroupId = this.filter.group;
        let file: FileModel | undefined;
        let group: GroupModel | undefined;
        if (selGroupId) {
            this.files.some((f) => {
                file = f;
                group = f.getGroup(selGroupId);
                return !!group;
            });
        }
        if (!group) {
            file = this.files.find((f) => f.active && !isReadOnly(f));
            if (!file) {
                throw new Error('No writable file available for creation');
            }
            group = file.groups[0];
        }
        if (!file || !group) {
            throw new Error('Unable to resolve target group for creation');
        }
        return { group, file };
    }

    completeUserNames(part: string): string[] {
        const userNames: Record<string, number> = {};
        this.files.forEach((file) => {
            file.forEachEntry(
                { text: part, textLower: part.toLowerCase(), advanced: { user: true } },
                (entry) => {
                    const userName = entry.user;
                    if (userName) {
                        userNames[userName] = (userNames[userName] || 0) + 1;
                    }
                }
            );
        });
        const matches = Object.entries(userNames);
        matches.sort((x, y) => y[1] - x[1]);
        const maxResults = 5;
        if (matches.length > maxResults) {
            matches.length = maxResults;
        }
        return matches.map((m) => m[0]);
    }

    getEntryTemplates(): Array<{ file: FileModel; entry: EntryModel }> {
        const entryTemplates: Array<{ file: FileModel; entry: EntryModel }> = [];
        this.files.forEach((file) => {
            file.forEachEntryTemplate?.((entry) => {
                entryTemplates.push({ file, entry });
            });
        });
        return entryTemplates;
    }

    canCreateEntries(): boolean {
        return this.files.some((f) => f.active && !isReadOnly(f));
    }

    createNewEntry(args?: { template?: { file: FileModel; entry: EntryModel } }): EntryModel {
        const sel = this.getFirstSelectedGroupForCreation();
        if (args?.template) {
            if (sel.file !== args.template.file) {
                sel.file = args.template.file;
                sel.group = args.template.file.groups[0];
            }
            const templateEntry = args.template.entry;
            const newEntry = EntryModel.newEntry(sel.group, sel.file);
            newEntry.copyFromTemplate(templateEntry);
            return newEntry;
        } else {
            return EntryModel.newEntry(sel.group, sel.file, {
                tag: this.filter.tag
            });
        }
    }

    createNewEntryWithFields(group: GroupModel, fields: Record<string, unknown>): EntryModel {
        return EntryModel.newEntryWithFields(group, fields);
    }

    createNewGroup(): GroupModel {
        const sel = this.getFirstSelectedGroupForCreation();
        return GroupModel.newGroup(sel.group, sel.file);
    }

    createNewGroupWithName(group: GroupModel, file: FileModel, name: string): GroupModel {
        const newGroup = GroupModel.newGroup(group, file);
        newGroup.setName(name);
        return newGroup;
    }

    createNewTemplateEntry(): EntryModel {
        const file = this.getFirstSelectedGroupForCreation().file;
        const group = file.getEntryTemplatesGroup() || file.createEntryTemplatesGroup();
        return EntryModel.newEntry(group, file);
    }

    createDemoFile(): boolean {
        if (!this.files.getByName('Demo')) {
            const demoFile = new FileModel({ id: IdGenerator.uuid() });
            demoFile.openDemo(() => {
                this.addFile(demoFile);
            });
            return true;
        } else {
            return false;
        }
    }

    createNewFile(name: string | null, callback?: (file: FileModel) => void): void {
        if (!name) {
            for (let i = 0; ; i++) {
                name = Locale.openNewFile + (i || '');
                if (!this.files.getByName(name) && !this.fileInfos.getByName(name)) {
                    break;
                }
            }
        }
        const newFile = new FileModel({ id: IdGenerator.uuid() });
        newFile.create(name, () => {
            this.addFile(newFile);
            callback?.(newFile);
        });
    }

    openFile(params: OpenFileParams, callback: (err?: unknown, file?: FileModel) => void): void {
        const logger = new Logger('open', params.name);
        logger.info('File open request');

        const fileInfo: FileInfoModel | undefined = params.id
            ? this.fileInfos.get(params.id)
            : this.fileInfos.getMatch(params.storage, params.name, params.path);

        if (!params.opts && fileInfo && fileInfo.opts) {
            params.opts = fileInfo.opts;
        }

        if (fileInfo && fileInfo.modified) {
            logger.info('Open file from cache because it is modified');
            this.openFileFromCache(
                params,
                (err, file) => {
                    if (!err && file) {
                        logger.info('Sync just opened modified file');
                        setTimeout(() => this.syncFile(file), 0);
                    }
                    callback(err);
                },
                fileInfo
            );
        } else if (params.fileData) {
            logger.info('Open file from supplied content');
            // params.storage === 'file' was a desktop/Electron code path;
            // in the web-only fork, Storage['file'] is never present, so the
            // branch is effectively a no-op. Keep it so that any future file
            // provider can be re-enabled without touching app-model.
            const fileStorage = getStorageProvider('file');
            if (params.storage === 'file' && fileStorage?.stat) {
                fileStorage.stat(params.path, null, (err, stat) => {
                    if (err) {
                        return callback(err);
                    }
                    params.rev = stat?.rev ?? undefined;
                    this.openFileWithData(params, callback, fileInfo ?? null, params.fileData!);
                });
            } else {
                this.openFileWithData(params, callback, fileInfo ?? null, params.fileData, true);
            }
        } else if (!params.storage) {
            logger.info('Open file from cache as main storage');
            if (fileInfo) {
                this.openFileFromCache(params, callback, fileInfo);
            } else {
                callback(Locale.openFileNoCacheError);
            }
        } else if (
            fileInfo &&
            fileInfo.openDate &&
            fileInfo.rev === params.rev &&
            fileInfo.storage !== 'file' &&
            !this.settings.disableOfflineStorage
        ) {
            logger.info('Open file from cache because it is latest');
            this.openFileFromCache(
                params,
                (err, file) => {
                    const errObj = err as StorageError | undefined;
                    if (errObj) {
                        if (errObj.name === 'KdbxError' || errObj.ykError) {
                            return callback(err);
                        }
                        logger.info(
                            'Error loading file from cache, trying to open from storage',
                            err
                        );
                        this.openFileFromStorage(params, callback, fileInfo, logger, true);
                    } else {
                        callback(err, file);
                    }
                },
                fileInfo
            );
        } else if (
            !fileInfo ||
            !fileInfo.openDate ||
            params.storage === 'file' ||
            this.settings.disableOfflineStorage
        ) {
            this.openFileFromStorage(params, callback, fileInfo ?? null, logger);
        } else {
            logger.info('Open file from cache, will sync after load', params.storage);
            this.openFileFromCache(
                params,
                (err, file) => {
                    if (!err && file) {
                        logger.info('Sync just opened file');
                        setTimeout(() => this.syncFile(file), 0);
                        callback(err);
                    } else {
                        const errObj = err as StorageError | undefined;
                        if (errObj?.name === 'KdbxError' || errObj?.ykError) {
                            return callback(err);
                        }
                        logger.info(
                            'Error loading file from cache, trying to open from storage',
                            err
                        );
                        this.openFileFromStorage(params, callback, fileInfo, logger, true);
                    }
                },
                fileInfo
            );
        }
    }

    openFileFromCache(
        params: OpenFileParams,
        callback: (err?: unknown, file?: FileModel) => void,
        fileInfo: FileInfoModel
    ): void {
        Storage.cache.load(fileInfo.id, null, (err, data) => {
            let loadErr: unknown = err;
            if (!data) {
                loadErr = Locale.openFileNoCacheError;
            }
            new Logger('open', params.name).info('Loaded file from cache', loadErr);
            if (loadErr) {
                callback(loadErr);
            } else {
                this.openFileWithData(params, callback, fileInfo, data as ArrayBuffer);
            }
        });
    }

    openFileFromStorage(
        params: OpenFileParams,
        callback: (err?: unknown, file?: FileModel) => void,
        fileInfo: FileInfoModel | null,
        logger: Logger,
        noCache?: boolean
    ): void {
        logger.info('Open file from storage', params.storage);
        const storage = getStorageProvider(params.storage);
        if (!storage) {
            callback('Storage not available: ' + params.storage);
            return;
        }
        const openErr = runBeforeOpen(params.storage, fileInfo ?? null);
        if (openErr) {
            callback(openErr);
            return;
        }
        const storageLoad = () => {
            logger.info('Load from storage');
            storage.load(params.path, params.opts, (err, data, stat) => {
                if (err) {
                    if (fileInfo && fileInfo.openDate && !this.settings.disableOfflineStorage) {
                        logger.info('Open file from cache because of storage load error', err);
                        this.openFileFromCache(params, callback, fileInfo);
                    } else {
                        logger.info('Storage load error', err);
                        callback(err);
                    }
                } else {
                    logger.info('Open file from content loaded from storage');
                    params.fileData = data;
                    params.rev = (stat && stat.rev) || undefined;
                    const needSaveToCache = storage.name !== 'file';
                    this.openFileWithData(
                        params,
                        callback,
                        fileInfo,
                        data as ArrayBuffer,
                        needSaveToCache
                    );
                }
            });
        };
        const cacheRev = (fileInfo && fileInfo.rev) || null;
        if (cacheRev && storage.stat) {
            logger.info('Stat file');
            storage.stat(params.path, params.opts, (err, stat) => {
                if (
                    !noCache &&
                    fileInfo &&
                    storage.name !== 'file' &&
                    (err || (stat && stat.rev === cacheRev)) &&
                    !this.settings.disableOfflineStorage
                ) {
                    logger.info(
                        'Open file from cache because ' + (err ? 'stat error' : 'it is latest'),
                        err
                    );
                    this.openFileFromCache(params, callback, fileInfo);
                } else if (stat) {
                    logger.info(
                        'Open file from storage (' + stat.rev + ', local ' + cacheRev + ')'
                    );
                    storageLoad();
                } else {
                    logger.info('Stat error', err);
                    callback(err);
                }
            });
        } else {
            storageLoad();
        }
    }

    openFileWithData(
        params: OpenFileParams,
        callback: (err?: unknown, file?: FileModel) => void,
        fileInfo: FileInfoModel | null,
        data: ArrayBuffer,
        updateCacheOnSuccess?: boolean
    ): void {
        const logger = new Logger('open', params.name);
        let needLoadKeyFile = false;
        const fileStorage = getStorageProvider('file');
        if (!params.keyFileData && fileInfo && fileInfo.keyFileName) {
            params.keyFileName = fileInfo.keyFileName;
            if (this.settings.rememberKeyFiles === 'data' && fileInfo.keyFileHash) {
                params.keyFileData = FileModel.createKeyFileWithHash(fileInfo.keyFileHash);
            } else if (this.settings.rememberKeyFiles === 'path' && fileInfo.keyFilePath) {
                params.keyFilePath = fileInfo.keyFilePath;
                if (fileStorage?.enabled) {
                    needLoadKeyFile = true;
                }
            }
        } else if (params.keyFilePath && !params.keyFileData && !fileInfo) {
            needLoadKeyFile = true;
        }
        const file = new FileModel({
            id: fileInfo ? fileInfo.id : IdGenerator.uuid(),
            name: params.name,
            storage: params.storage,
            path: params.path,
            keyFileName: params.keyFileName,
            keyFilePath: params.keyFilePath,
            backup: fileInfo?.backup || null,
            chalResp: params.chalResp
        });
        if (params.encryptedPassword && fileInfo) {
            file.encryptedPassword = fileInfo.encryptedPassword;
            file.encryptedPasswordDate = fileInfo.encryptedPasswordDate || new Date();
        }
        const openComplete = (err?: unknown): void => {
            if (err) {
                return callback(err);
            }
            if (this.files.get(file.id)) {
                return callback('Duplicate file id');
            }
            if (fileInfo && fileInfo.modified) {
                if (fileInfo.editState) {
                    logger.info('Loaded local edit state');
                    file.setLocalEditState(fileInfo.editState);
                }
                logger.info('Mark file as modified');
                file.modified = true;
            }
            if (fileInfo) {
                file.syncDate = fileInfo.syncDate;
            }
            if (updateCacheOnSuccess && !this.settings.disableOfflineStorage && params.fileData) {
                logger.info('Save loaded file to cache');
                Storage.cache.save(file.id, null, params.fileData);
            }
            const rev = params.rev || (fileInfo && fileInfo.rev) || null;
            this.setFileOpts(file, params.opts).then(() => {
                this.addToLastOpenFiles(file, rev);
                this.addFile(file);
                callback(null, file);
                this.fileOpened(file, data, params);
            });
        };
        const open = (): void => {
            const keyFileBuf: ArrayBuffer | null = toArrayBuffer(params.keyFileData);
            file.open(
                params.password ?? null,
                data,
                keyFileBuf,
                openComplete
            );
        };
        if (needLoadKeyFile && fileStorage?.load && params.keyFilePath) {
            fileStorage.load(params.keyFilePath, {}, (err, loaded) => {
                if (err) {
                    logger.info('Storage load error', err);
                    callback(err);
                } else {
                    params.keyFileData = (loaded as ArrayBuffer | undefined) ?? null;
                    open();
                }
            });
        } else {
            open();
        }
    }

    importFileWithXml(params: OpenFileParams, callback: (err?: unknown) => void): void {
        const logger = new Logger('import', params.name);
        logger.info('File import request with supplied xml');
        const file = new FileModel({
            id: IdGenerator.uuid(),
            name: params.name,
            storage: params.storage,
            path: params.path
        });
        if (!params.fileXml) {
            return callback('Missing fileXml in import params');
        }
        file.importWithXml(params.fileXml, (err) => {
            logger.info('Import xml complete ' + (err ? 'with error' : ''), err);
            if (err) {
                return callback(err);
            }
            this.addFile(file);
            this.fileOpened(file);
        });
    }

    addToLastOpenFiles(file: FileModel, rev: string | null): void {
        this.appLogger.debug(
            'Add last open file',
            file.id,
            file.name,
            file.storage,
            file.path,
            rev
        );
        const dt = new Date();
        // Grab the pre-existing FileInfoModel (if any) BEFORE the remove/unshift
        // below, so we can carry forward descriptor-only fields that live
        // exclusively on the FileInfoModel row and have no FileModel source
        // of truth. Without this, every re-open constructs a fresh
        // FileInfoModel with defaults, silently wiping the passkey
        // registration (#9) on any password-fallback re-open.
        const existingFileInfo = this.fileInfos.get(file.id);
        this.getStoreOpts(file).then((storeOpts) => {
            const fileInfo = new FileInfoModel({
                id: file.id,
                name: file.name,
                storage: file.storage,
                path: file.path,
                opts: storeOpts,
                modified: file.modified,
                editState: file.getLocalEditState(),
                rev,
                syncDate: file.syncDate || dt,
                openDate: dt,
                backup: file.backup,
                // chalResp on FileModel can now be a live challenge-response
                // function (Passkey PRF groundwork, #9). FileInfoModel persists
                // to JSON so only the legacy descriptor variant is round-trippable;
                // drop function-typed chalResp here — the re-open flow will
                // re-acquire the passkey callback via registration/UI.
                chalResp: typeof file.chalResp === 'function' ? null : file.chalResp
            });
            // Passkey quick unlock (#9) carry-forward: FileInfoModel is the sole
            // owner of these four fields (FileModel has no passkey state), so
            // if we don't copy them from the previous row they're gone after a
            // single password-fallback re-open. The registration ritual (button
            // click + WebAuthn prompt + HKDF unwrap) is expensive; silently
            // dropping it after one password unlock would be a nasty UX trap.
            if (existingFileInfo) {
                fileInfo.passkeyCredentialId = existingFileInfo.passkeyCredentialId;
                fileInfo.passkeyPrfSalt = existingFileInfo.passkeyPrfSalt;
                fileInfo.passkeyWrappedKey = existingFileInfo.passkeyWrappedKey;
                fileInfo.passkeyCreatedDate = existingFileInfo.passkeyCreatedDate;
            }
            switch (this.settings.rememberKeyFiles) {
                case 'data':
                    fileInfo.set({
                        keyFileName: file.keyFileName || null,
                        keyFileHash: file.getKeyFileHash()
                    });
                    break;
                case 'path':
                    fileInfo.set({
                        keyFileName: file.keyFileName || null,
                        keyFilePath: file.keyFilePath || null
                    });
            }
            if (
                this.settings.deviceOwnerAuth === 'file' &&
                file.encryptedPassword &&
                file.encryptedPasswordDate
            ) {
                const maxDate = new Date(file.encryptedPasswordDate);
                maxDate.setMinutes(
                    maxDate.getMinutes() + this.settings.deviceOwnerAuthTimeoutMinutes
                );
                if (maxDate > new Date()) {
                    fileInfo.encryptedPassword = file.encryptedPassword;
                    fileInfo.encryptedPasswordDate = file.encryptedPasswordDate;
                }
            }
            this.fileInfos.remove(file.id);
            this.fileInfos.unshift(fileInfo);
            this.fileInfos.save();
        });
    }

    getStoreOpts(file: FileModel): Promise<Record<string, unknown> | null> {
        const opts = file.opts;
        const storage = getStorageProvider(file.storage);
        if (storage?.fileOptsToStoreOpts && opts) {
            const passwordHash = this._getPasswordHash(file);
            return Promise.resolve(
                storage.fileOptsToStoreOpts(opts, file, passwordHash ?? undefined)
            );
        }
        return Promise.resolve(null);
    }

    setFileOpts(file: FileModel, opts: Record<string, unknown> | undefined): Promise<void> {
        const storage = getStorageProvider(file.storage);
        if (storage?.storeOptsToFileOpts && opts) {
            const passwordHash = this._getPasswordHash(file);
            return Promise.resolve(
                storage.storeOptsToFileOpts(opts, file, passwordHash ?? undefined)
            ).then((fileOpts) => {
                file.opts = fileOpts;
            });
        }
        return Promise.resolve();
    }

    /**
     * Extract the master password's SHA-256 hash from an open file's
     * credentials. Returns null if the file has no db or no passwordHash
     * (e.g. key-file-only databases).
     */
    private _getPasswordHash(file: FileModel): Uint8Array | null {
        try {
            const hash = file.db?.credentials?.passwordHash;
            if (hash && typeof hash.getBinary === 'function') {
                return hash.getBinary();
            }
        } catch {
            // File not open or credentials unavailable
        }
        return null;
    }

    fileOpened(file: FileModel, data?: ArrayBuffer, params?: OpenFileParams): void {
        const fileStorage = getStorageProvider('file');
        if (file.storage === 'file' && fileStorage?.watch) {
            fileStorage.watch(
                file.path,
                debounce(() => {
                    this.syncFile(file);
                }, Timeouts.FileChangeSync)
            );
        }
        if (file.isKeyChangePending(true)) {
            Events.emit('key-change-pending', { file });
        }
        const backup = file.backup;
        if (data && backup && backup.enabled && backup.pending) {
            this.scheduleBackupFile(file, data);
        }
        if (this.settings.deviceOwnerAuth) {
            this.saveEncryptedPassword(file, params);
        }
    }

    fileClosed(file: FileModel): void {
        const fileStorage = getStorageProvider('file');
        if (file.storage === 'file' && fileStorage?.unwatch) {
            fileStorage.unwatch(file.path);
        }
    }

    removeFileInfo(id: string): void {
        Storage.cache.remove(id);
        this.fileInfos.remove(id);
        this.fileInfos.save();
    }

    getFileInfo(file: FileModel): FileInfoModel | undefined {
        return (
            this.fileInfos.get(file.id) ||
            this.fileInfos.getMatch(file.storage, file.name, file.path)
        );
    }

    syncFile(file: FileModel, options?: SyncOptions, callback?: (err?: unknown) => void): void {
        if (file.demo) {
            if (callback) callback();
            return;
        }
        if (file.syncing) {
            if (callback) callback('Sync in progress');
            return;
        }
        if (!file.active) {
            if (callback) callback('File is closed');
            return;
        }
        const syncOptions: SyncOptions = options ?? {};
        const logger = new Logger('sync', file.name);
        const storageName = syncOptions.storage || file.storage || null;
        const storageProvider = getStorageProvider(storageName);
        runBeforeSync(storageName, this.getFileInfo(file));
        let path = syncOptions.path || file.path;
        const opts = (syncOptions.opts || file.opts) ?? undefined;
        if (
            storageProvider?.getPathForName &&
            (!path || storageName !== file.storage)
        ) {
            path = storageProvider.getPathForName(file.name);
        }
        const optionsForLogging: SyncOptions = { ...syncOptions };
        if (optionsForLogging.opts && optionsForLogging.opts.password) {
            optionsForLogging.opts = { ...optionsForLogging.opts };
            optionsForLogging.opts.password = '***';
        }
        logger.info('Sync started', storageName, path, optionsForLogging);
        const existingFileInfo = this.getFileInfo(file);
        const startSync = (resolvedFileInfo: FileInfoModel): void => {
            file.setSyncProgress();
            const complete = (err?: unknown): void => {
                if (!file.active) {
                    if (callback) callback('File is closed');
                    return;
                }
                logger.info('Sync finished', err || 'no error');
                const errStr = err
                    ? typeof err === 'string'
                        ? err
                        : (err as { toString?: () => string }).toString?.() ?? String(err)
                    : null;
                file.setSyncComplete(path ?? null, storageName, errStr);
                this.getStoreOpts(file).then((storeOpts) => {
                    resolvedFileInfo.set({
                        name: file.name,
                        storage: storageName,
                        path,
                        opts: storeOpts,
                        modified: file.dirty ? resolvedFileInfo.modified : file.modified,
                        editState: file.dirty
                            ? resolvedFileInfo.editState
                            : file.getLocalEditState(),
                        syncDate: file.syncDate,
                        chalResp: file.chalResp
                    });
                    if (this.settings.rememberKeyFiles === 'data') {
                        resolvedFileInfo.set({
                            keyFileName: file.keyFileName || null,
                            keyFileHash: file.getKeyFileHash()
                        });
                    }
                    if (!this.fileInfos.get(resolvedFileInfo.id)) {
                        this.fileInfos.unshift(resolvedFileInfo);
                    }
                    this.fileInfos.save();
                    if (callback) {
                        callback(err);
                    }
                });
            };
            const asyncVerifySavedData = (data: ArrayBuffer): void => {
                if (!this.settings.saveVerify) {
                    return;
                }
                const creds = (file as { db?: { credentials?: unknown } }).db
                    ?.credentials as kdbxweb.Credentials | undefined;
                if (!creds) {
                    logger.warn(
                        'Save verification skipped: no credentials on file'
                    );
                    return;
                }
                logger.info('Verifying saved data (async, non-blocking)');
                Promise.resolve()
                    .then(() => kdbxweb.Kdbx.load(data, creds))
                    .then(() => {
                        logger.info('Save verification passed');
                    })
                    .catch((verifyErr: unknown) => {
                        logger.error('Save verification FAILED', verifyErr);
                        const errStr =
                            verifyErr instanceof Error
                                ? verifyErr.message
                                : String(verifyErr);
                        Alerts.error({
                            header: Locale.saveVerifyFailedHeader,
                            body:
                                Locale.saveVerifyFailedBody +
                                ' (' +
                                errStr +
                                ')'
                        });
                        file.dirty = true;
                    });
            };
            if (!storageName || !storageProvider) {
                if (!file.modified && resolvedFileInfo.id === file.id) {
                    logger.info('Local, not modified');
                    return complete();
                }
                logger.info('Local, save to cache');
                file.getData((data, err) => {
                    if (err || !data) {
                        return complete(err || 'No file data');
                    }
                    asyncVerifySavedData(data);
                    Storage.cache.save(resolvedFileInfo.id, null, data, (saveErr) => {
                        logger.info('Saved to cache', saveErr || 'no error');
                        complete(saveErr);
                        if (!saveErr) {
                            this.scheduleBackupFile(file, data);
                        }
                    });
                });
            } else {
            const maxLoadLoops = 3;
            let loadLoops = 0;
            const loadFromStorageAndMerge = (): void => {
                if (++loadLoops === maxLoadLoops) {
                    return complete('Too many load attempts');
                }
                logger.info('Load from storage, attempt ' + loadLoops);
                storageProvider.load(path, opts, (err, data, stat) => {
                    logger.info('Load from storage', stat, err || 'no error');
                    if (!file.active) {
                        return complete('File is closed');
                    }
                    if (err) {
                        return complete(err);
                    }
                    if (!data) {
                        return complete('No file data');
                    }
                    file.mergeOrUpdate(
                        data,
                        syncOptions.remoteKey ?? null,
                        (mergeErr) => {
                            logger.info('Merge complete', mergeErr || 'no error');
                            this.refresh();
                            if (mergeErr) {
                                if (
                                    (mergeErr as StorageError).code === 'InvalidKey'
                                ) {
                                    logger.info(
                                        'Remote key changed, request to enter new key'
                                    );
                                    Events.emit('remote-key-changed', { file });
                                }
                                return complete(mergeErr);
                            }
                            if (stat && stat.rev) {
                                logger.info('Update rev in file info');
                                resolvedFileInfo.rev = stat.rev;
                            }
                            file.syncDate = new Date();
                            if (file.modified) {
                                logger.info(
                                    'Updated sync date, saving modified file'
                                );
                                saveToCacheAndStorage();
                            } else if (file.dirty) {
                                if (this.settings.disableOfflineStorage) {
                                    logger.info(
                                        'File is dirty and cache is disabled'
                                    );
                                    return complete(mergeErr);
                                }
                                logger.info(
                                    'Saving not modified dirty file to cache'
                                );
                                Storage.cache.save(
                                    resolvedFileInfo.id,
                                    null,
                                    data,
                                    (cacheErr) => {
                                        if (cacheErr) {
                                            return complete(cacheErr);
                                        }
                                        file.dirty = false;
                                        logger.info(
                                            'Complete, remove dirty flag'
                                        );
                                        complete();
                                    }
                                );
                            } else {
                                logger.info('Complete, no changes');
                                complete();
                            }
                        }
                    );
                });
            };
            const saveToStorage = (data: ArrayBuffer): void => {
                logger.info('Save data to storage');
                const storageRev =
                    resolvedFileInfo.storage === storageName
                        ? resolvedFileInfo.rev ?? undefined
                        : undefined;
                storageProvider.save(
                    path,
                    opts,
                    data,
                    (err, stat) => {
                        if (err && (err as StorageError).revConflict) {
                            logger.info('Save rev conflict, reloading from storage');
                            loadFromStorageAndMerge();
                        } else if (err) {
                            logger.info('Error saving data to storage');
                            complete(err);
                        } else {
                            if (stat && stat.rev) {
                                logger.info('Update rev in file info');
                                resolvedFileInfo.rev = stat.rev;
                            }
                            if (stat && stat.path) {
                                logger.info('Update path in file info', stat.path);
                                file.path = stat.path;
                                resolvedFileInfo.path = stat.path;
                                path = stat.path;
                            }
                            file.syncDate = new Date();
                            logger.info(
                                'Save to storage complete, update sync date'
                            );
                            this.scheduleBackupFile(file, data);
                            complete();
                        }
                    },
                    storageRev
                );
            };
            const saveToCacheAndStorage = (): void => {
                logger.info('Getting file data for saving');
                file.getData((data, err) => {
                    if (err || !data) {
                        return complete(err || 'No file data');
                    }
                    asyncVerifySavedData(data);
                    if (storageName === 'file') {
                        logger.info('Saving to file storage');
                        saveToStorage(data);
                    } else if (!file.dirty) {
                        logger.info(
                            'Saving to storage, skip cache because not dirty'
                        );
                        saveToStorage(data);
                    } else if (this.settings.disableOfflineStorage) {
                        logger.info(
                            'Saving to storage because cache is disabled'
                        );
                        saveToStorage(data);
                    } else {
                        logger.info('Saving to cache');
                        Storage.cache.save(
                            resolvedFileInfo.id,
                            null,
                            data,
                            (cacheErr) => {
                                if (cacheErr) {
                                    return complete(cacheErr);
                                }
                                file.dirty = false;
                                logger.info(
                                    'Saved to cache, saving to storage'
                                );
                                saveToStorage(data);
                            }
                        );
                    }
                });
            };
            logger.info('Stat file');
            if (!storageProvider.stat) {
                logger.info('Storage does not support stat, saving directly');
                saveToCacheAndStorage();
                return;
            }
            storageProvider.stat(path, opts, (err, stat) => {
                if (!file.active) {
                    return complete('File is closed');
                }
                if (err) {
                    if ((err as StorageError).notFound) {
                        logger.info('File does not exist in storage, creating');
                        saveToCacheAndStorage();
                    } else if (file.dirty) {
                        if (this.settings.disableOfflineStorage) {
                            logger.info(
                                'Stat error, dirty, cache is disabled',
                                err || 'no error'
                            );
                            return complete(err);
                        }
                        logger.info(
                            'Stat error, dirty, save to cache',
                            err || 'no error'
                        );
                        file.getData((data, e) => {
                            if (e || !data) {
                                logger.error('Error getting file data', e);
                                return complete(err);
                            }
                            Storage.cache.save(
                                resolvedFileInfo.id,
                                null,
                                data,
                                (cacheErr) => {
                                    if (cacheErr) {
                                        logger.error(
                                            'Error saving to cache',
                                            cacheErr
                                        );
                                    }
                                    if (!cacheErr) {
                                        file.dirty = false;
                                    }
                                    logger.info(
                                        'Saved to cache, exit with error',
                                        err || 'no error'
                                    );
                                    complete(err);
                                }
                            );
                        });
                    } else {
                        logger.info('Stat error, not dirty', err || 'no error');
                        complete(err);
                    }
                } else if (stat && stat.rev === resolvedFileInfo.rev) {
                    if (file.modified) {
                        logger.info('Stat found same version, modified, saving');
                        saveToCacheAndStorage();
                    } else {
                        logger.info('Stat found same version, not modified');
                        complete();
                    }
                } else {
                    logger.info('Found new version, loading from storage');
                    loadFromStorageAndMerge();
                }
            });
            }
        };
        if (existingFileInfo) {
            startSync(existingFileInfo);
        } else {
            logger.info('Create new file info');
            const dt = new Date();
            this.getStoreOpts(file).then((storeOpts) => {
                const newFileInfo = new FileInfoModel({
                    id: IdGenerator.uuid(),
                    name: file.name,
                    storage: file.storage,
                    path: file.path,
                    opts: storeOpts,
                    modified: file.modified,
                    editState: null,
                    rev: null,
                    syncDate: dt,
                    openDate: dt,
                    backup: file.backup
                });
                startSync(newFileInfo);
            });
        }
    }

    deleteAllCachedFiles(): void {
        for (const fileInfo of this.fileInfos) {
            if (fileInfo.storage && !fileInfo.modified) {
                Storage.cache.remove(fileInfo.id);
            }
        }
    }

    clearStoredKeyFiles(): void {
        for (const fileInfo of this.fileInfos) {
            fileInfo.set({
                keyFileName: null,
                keyFilePath: null,
                keyFileHash: null
            });
        }
        this.fileInfos.save();
    }

    unsetKeyFile(fileId: string): void {
        const fileInfo = this.fileInfos.get(fileId);
        if (!fileInfo) {
            return;
        }
        fileInfo.set({
            keyFileName: null,
            keyFilePath: null,
            keyFileHash: null
        });
        this.fileInfos.save();
    }

    setFileBackup(fileId: string, backup: Record<string, unknown>): void {
        const fileInfo = this.fileInfos.get(fileId);
        if (fileInfo) {
            fileInfo.backup = backup;
        }
        this.fileInfos.save();
    }

    backupFile(file: FileModel, data: ArrayBuffer, callback: (err?: unknown) => void): void {
        const opts = file.opts ?? undefined;
        const backup = asBackupSettings(file.backup);
        const logger = new Logger('backup', file.name);
        if (!backup || !backup.storage || !backup.path) {
            return callback('Invalid backup settings');
        }
        const backupStorageName = backup.storage;
        const backupStorage = getStorageProvider(backupStorageName);
        if (!backupStorage) {
            return callback('Backup storage not available: ' + backupStorageName);
        }
        let path = backup.path.replace('{date}', DateFormat.dtStrFs(new Date()));
        logger.info('Backup file to', backupStorageName, path);
        const saveToFolder = (): void => {
            if (backupStorage.getPathForName) {
                path = backupStorage.getPathForName(path);
            }
            backupStorage.save(path, opts, data, (err) => {
                if (err) {
                    logger.error('Backup error', err);
                } else {
                    logger.info('Backup complete');
                    const updated = asBackupSettings(file.backup) ?? { ...backup };
                    updated.lastTime = Date.now();
                    delete updated.pending;
                    file.backup = updated;
                    this.setFileBackup(file.id, updated);
                }
                callback(err);
            });
        };
        let folderPath = UrlFormat.fileToDir(path);
        if (backupStorage.getPathForName) {
            folderPath = backupStorage.getPathForName(folderPath).replace('.kdbx', '');
        }
        if (!backupStorage.stat) {
            // No stat support (e.g. some remote providers) — save directly.
            logger.info('Backup storage has no stat, saving without folder check');
            saveToFolder();
            return;
        }
        backupStorage.stat(folderPath, opts, (err) => {
            if (err) {
                if ((err as StorageError).notFound) {
                    logger.info('Backup folder does not exist');
                    if (!backupStorage.mkdir) {
                        return callback('Mkdir not supported by ' + backupStorageName);
                    }
                    backupStorage.mkdir(folderPath, (mkErr) => {
                        if (mkErr) {
                            logger.error('Error creating backup folder', mkErr);
                            callback('Error creating backup folder');
                        } else {
                            logger.info('Backup folder created');
                            saveToFolder();
                        }
                    });
                } else {
                    logger.error('Stat folder error', err);
                    callback('Cannot stat backup folder');
                }
            } else {
                logger.info('Backup folder exists, saving');
                saveToFolder();
            }
        });
    }

    scheduleBackupFile(file: FileModel, data: ArrayBuffer): void {
        const backup = asBackupSettings(file.backup);
        if (!backup || !backup.enabled) {
            return;
        }
        const logger = new Logger('backup', file.name);
        let needBackup = false;
        if (!backup.lastTime) {
            needBackup = true;
            logger.debug('No last backup time, backup now');
        } else {
            const dt = new Date(backup.lastTime);
            switch (backup.schedule) {
                case '0':
                    break;
                case '1d':
                    dt.setDate(dt.getDate() + 1);
                    break;
                case '1w':
                    dt.setDate(dt.getDate() + 7);
                    break;
                case '1m':
                    dt.setMonth(dt.getMonth() + 1);
                    break;
                default:
                    return;
            }
            if (dt.getTime() <= Date.now()) {
                needBackup = true;
            }
            logger.debug(
                'Last backup time: ' +
                    new Date(backup.lastTime) +
                    ', schedule: ' +
                    backup.schedule +
                    ', next time: ' +
                    dt +
                    ', ' +
                    (needBackup ? 'backup now' : 'skip backup')
            );
        }
        if (!backup.pending) {
            backup.pending = true;
            this.setFileBackup(file.id, backup);
        }
        if (needBackup) {
            this.backupFile(file, data, noop);
        }
    }

    usbDevicesChanged(): void {
        // No-op: YubiKey/USB device support removed in web-only fork
    }

    saveEncryptedPassword(file: FileModel, params?: OpenFileParams): void {
        // Hardware encryption is not available in web-only mode
    }

    getMemoryPassword(fileId: string): { value: string; date: Date } | undefined {
        return this.memoryPasswordStorage[fileId];
    }

    checkEncryptedPasswordsStorage(): void {
        if (this.settings.deviceOwnerAuth === 'file') {
            let changed = false;
            for (const fileInfo of this.fileInfos) {
                if (this.memoryPasswordStorage[fileInfo.id]) {
                    fileInfo.encryptedPassword = this.memoryPasswordStorage[fileInfo.id].value;
                    fileInfo.encryptedPasswordDate = this.memoryPasswordStorage[fileInfo.id].date;
                    changed = true;
                }
            }
            if (changed) {
                this.fileInfos.save();
            }
            for (const file of this.files) {
                if (this.memoryPasswordStorage[file.id]) {
                    file.encryptedPassword = this.memoryPasswordStorage[file.id].value;
                    file.encryptedPasswordDate = this.memoryPasswordStorage[file.id].date;
                }
            }
        } else if (this.settings.deviceOwnerAuth === 'memory') {
            let changed = false;
            for (const fileInfo of this.fileInfos) {
                if (fileInfo.encryptedPassword) {
                    this.memoryPasswordStorage[fileInfo.id] = {
                        value: fileInfo.encryptedPassword,
                        date: fileInfo.encryptedPasswordDate ?? new Date()
                    };
                    fileInfo.encryptedPassword = null;
                    fileInfo.encryptedPasswordDate = null;
                    changed = true;
                }
            }
            if (changed) {
                this.fileInfos.save();
            }
        } else {
            let changed = false;
            for (const fileInfo of this.fileInfos) {
                if (fileInfo.encryptedPassword) {
                    fileInfo.encryptedPassword = null;
                    fileInfo.encryptedPasswordDate = null;
                    changed = true;
                }
            }
            if (changed) {
                this.fileInfos.save();
            }
            for (const file of this.files) {
                if (file.encryptedPassword) {
                    file.encryptedPassword = null;
                    file.encryptedPasswordDate = null;
                }
            }
            this.memoryPasswordStorage = {};
        }
    }

    unlockAnyFile(unlockRes: unknown, timeout?: number): Promise<FileModel> {
        this.rejectPendingFileUnlockPromise('Replaced with a new operation');
        Events.emit('show-open-view');
        return new Promise((resolve, reject) => {
            this.fileUnlockPromise = { resolve, reject, unlockRes };
            if (timeout) {
                const timer = setTimeout(
                    () => this.rejectPendingFileUnlockPromise('Timeout'),
                    timeout
                );
                this.fileUnlockPromise.resolve = (res) => {
                    clearTimeout(timer);
                    resolve(res);
                };
                this.fileUnlockPromise.reject = (err) => {
                    clearTimeout(timer);
                    reject(err);
                };
            }
            this.appLogger.info('Pending file unlock operation is set');
            Events.emit('unlock-message-changed', unlockRes);
        });
    }

    get unlockMessageRes() {
        return this.fileUnlockPromise?.unlockRes;
    }

    rejectPendingFileUnlockPromise(reason: string): void {
        if (this.fileUnlockPromise) {
            this.appLogger.info('Cancel pending file unlock operation', reason);
            this.fileUnlockPromise.reject(new Error(reason));
            this.fileUnlockPromise = null;
            Events.emit('unlock-message-changed', null);
        }
    }

    mainWindowBlur(): void {
        if (!this.hardwareDecryptInProgress) {
            this.mainWindowBlurTimer = setTimeout(() => {
                // macOS emits focus-blur-focus event in a row when triggering auto-type from minimized state
                this.mainWindowBlurTimer = null;
                this.rejectPendingFileUnlockPromise('Main window blur');
            }, Timeouts.AutoTypeWindowFocusAfterBlur);
        }
    }

    mainWindowFocus(): void {
        if (this.mainWindowBlurTimer) {
            clearTimeout(this.mainWindowBlurTimer);
            this.mainWindowBlurTimer = null;
        }
    }

    mainWindowWillClose(): void {
        this.rejectPendingFileUnlockPromise('Main window will close');
    }

    hardwareDecryptStarted(): void {
        this.hardwareDecryptInProgress = true;
    }

    hardwareDecryptFinished(): void {
        this.hardwareDecryptInProgress = false;
    }
}

export { AppModel };
