/**
 * What an interface asks of the vault: open and unlock vaults, list and
 * search entries, read fields, lock, and the security settings. Used by
 * the browser extension (through EmbeddedVault) and by the new web app.
 * Results are plain objects without secrets, except field reads.
 */
import * as kdbxweb from 'kdbxweb';
import { Events } from 'framework/events';
import { AppModel } from 'models/app-model';
import { AppSettingsModel } from 'models/app-settings-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import { entryFieldText, listEntries, summarizeEntry } from 'comp/extension/entry-list';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { UrlFormat } from 'util/formatting/url-format';
import { getSessionAccess } from './session-access';
import { Timeouts } from 'const/timeouts';
import { clipboardExpiry } from 'comp/browser/clipboard-expiry';

export type VaultRequest = Record<string, unknown>;

const SETTINGS = ['idleMinutes', 'clipboardSeconds', 'lockOnOsLock'] as const;

let copyLockTimer: ReturnType<typeof setTimeout> | undefined;

function app(): AppModel {
    return AppModel.instance;
}

function entrySummary(entry: EntryModel) {
    return { id: entry.id, ...summarizeEntry(entry) };
}

function findEntry(id: unknown): EntryModel {
    for (const file of app().files) {
        const entry = (file as FileModel).getEntry(String(id));
        if (entry) {
            return entry;
        }
    }
    throw new Error('Entry not found');
}

function openFile(params: Record<string, unknown>): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
        app().openFile(params as unknown as Parameters<AppModel['openFile']>[0], (err, file) => {
            if (!err) {
                return resolve(file?.id);
            }
            const code = (err as { code?: string }).code;
            reject(new Error(code === 'InvalidKey' ? 'invalid-password' : String(err)));
        });
    });
}

function keyFileParams(req: VaultRequest): Record<string, unknown> {
    if (typeof req.keyFileData !== 'string') return {};
    return {
        keyFileData: kdbxweb.ByteUtils.arrayToBuffer(kdbxweb.ByteUtils.base64ToBytes(req.keyFileData)),
        keyFileName: String(req.keyFileName || 'key file')
    };
}

function status() {
    const model = app();
    const access = getSessionAccess(model);
    if (access.state !== 'open') {
        return { open: false, accessState: access.state, files: [], recent: [], settings: {} };
    }
    return {
        open: model.files.hasOpenFiles(),
        files: model.files.map((f) => ({ id: f.id, name: f.name, storage: f.storage })),
        recent: model.fileInfos.map((fi) => ({ id: fi.id, name: fi.name, storage: fi.storage })),
        sync: model.syncScheduler.summary(),
        settings: Object.fromEntries(SETTINGS.map((k) => [k, AppSettingsModel[k]]))
    };
}

function list(req: VaultRequest) {
    const model = app();
    const { suggested, items } = listEntries(model, model.files, {
        url: req.url ? String(req.url) : undefined,
        query: String(req.query || '')
    });
    return { suggested: suggested.map(entrySummary), items: items.map(entrySummary) };
}

function schedulePasswordCopyLock(request: VaultRequest): void {
    const model = app();
    const access = getSessionAccess(model);
    const epoch = access.epoch;
    // A clipboard write may finish after suspension or reauthentication. Its
    // cleanup still runs, but it must not lock a different authenticated session.
    if (request.password !== true || request.sessionEpoch !== epoch ||
        !AppSettingsModel.lockOnCopy || access.state !== 'open') return;
    clearTimeout(copyLockTimer);
    copyLockTimer = setTimeout(() => {
        if (app() === model && access.state === 'open' && access.isCurrent(epoch) &&
            AppSettingsModel.lockOnCopy && model.files.hasOpenFiles()) {
            Events.emit('lock-workspace');
        }
    }, Timeouts.CopyTip + Timeouts.BeforeAutoLock);
}

const handlers: Record<string, (req: VaultRequest) => unknown> = {
    status,
    list,

    async unlock(req) {
        const fileInfo = app().fileInfos.get(String(req.id));
        if (!fileInfo) {
            throw new Error('Unknown vault');
        }
        const openedFileId = await openFile({
            id: fileInfo.id,
            name: fileInfo.name,
            storage: fileInfo.storage,
            path: fileInfo.path,
            opts: fileInfo.opts,
            keyFileName: fileInfo.keyFileName,
            ...keyFileParams(req),
            password: kdbxweb.ProtectedValue.fromString(String(req.password ?? ''))
        });
        return { ...status(), openedFileId };
    },

    async openWebDav(req) {
        const url = String(req.url);
        const openedFileId = await openFile({
            name: UrlFormat.getDataFileName(url),
            storage: 'webdav',
            path: url,
            opts: { user: req.user || '', password: req.pass || '' },
            ...keyFileParams(req),
            password: kdbxweb.ProtectedValue.fromString(String(req.password ?? ''))
        });
        return { ...status(), openedFileId };
    },

    async openData(req) {
        const bytes = kdbxweb.ByteUtils.base64ToBytes(String(req.data));
        const openedFileId = await openFile({
            name: String(req.name || 'vault').replace(/\.kdbx$/i, ''),
            storage: null,
            path: null,
            fileData: kdbxweb.ByteUtils.arrayToBuffer(bytes),
            ...keyFileParams(req),
            password: kdbxweb.ProtectedValue.fromString(String(req.password ?? ''))
        });
        return { ...status(), openedFileId };
    },

    openDemo() {
        app().createDemoFile();
        return status();
    },

    lock() {
        Events.emit('lock-workspace');
        return { locked: !app().files.hasOpenFiles(), accessState: getSessionAccess(app()).state };
    },

    entry(req) {
        const entry = findEntry(req.id);
        return { ...entrySummary(entry), hasOtp: (entry.initOtpGenerator(), !!entry.otpGenerator) };
    },

    async field(req) {
        IdleTracker.regUserAction();
        return { text: await entryFieldText(findEntry(req.id), req.field) };
    },

    async credentials(req) {
        const entry = findEntry(req.id);
        return { user: await entryFieldText(entry, 'user'), password: await entryFieldText(entry, 'password') };
    },

    copied(request) {
        if (typeof request.text === 'string') clipboardExpiry.schedule(request.text, AppSettingsModel.clipboardSeconds);
        schedulePasswordCopyLock(request);
        return {};
    },

    settings(req) {
        const values = (req.values || {}) as Record<string, unknown>;
        for (const key of SETTINGS) {
            if (key in values) {
                (AppSettingsModel as unknown as Record<string, unknown>)[key] = values[key];
            }
        }
        return status();
    },

    activity() {
        IdleTracker.regUserAction();
        return {};
    }
};

const VaultApi: Record<string, (req: VaultRequest) => unknown> = Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [name, (request: VaultRequest) => {
        // Cleanup of a previously authorized clipboard write must still run after suspension.
        if (name === 'status' || name === 'lock' || name === 'copied') return handler(request);
        const access = getSessionAccess(app());
        const epoch = access.epoch;
        access.assertOpen(epoch);
        const result = handler(request);
        if (result instanceof Promise) return result.then((value) => {
            access.assertOpen(epoch);
            return value;
        });
        access.assertOpen(epoch);
        return result;
    }])
);

export { VaultApi };
