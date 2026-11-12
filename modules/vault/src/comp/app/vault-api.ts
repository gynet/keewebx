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

export type VaultRequest = Record<string, unknown>;

const SETTINGS = ['idleMinutes', 'clipboardSeconds', 'lockOnOsLock'] as const;

let clipboardTimer: ReturnType<typeof setTimeout> | undefined;

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

function openFile(params: Record<string, unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
        app().openFile(params as unknown as Parameters<AppModel['openFile']>[0], (err) => {
            if (!err) {
                return resolve();
            }
            const code = (err as { code?: string }).code;
            reject(new Error(code === 'InvalidKey' ? 'invalid-password' : String(err)));
        });
    });
}

function status() {
    const model = app();
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

/** Clears the clipboard later if it still holds what was copied. */
function scheduleClipboardClear(): void {
    clearTimeout(clipboardTimer);
    const seconds = AppSettingsModel.clipboardSeconds;
    if (!(seconds > 0)) {
        return;
    }
    clipboardTimer = setTimeout(() => {
        const blank = (e: ClipboardEvent) => {
            e.clipboardData?.setData('text/plain', '');
            e.preventDefault();
        };
        document.addEventListener('copy', blank);
        try {
            document.execCommand('copy');
        } finally {
            document.removeEventListener('copy', blank);
        }
    }, seconds * 1000);
}

const VaultApi: Record<string, (req: VaultRequest) => unknown> = {
    status,
    list,

    async unlock(req) {
        const fileInfo = app().fileInfos.get(String(req.id));
        if (!fileInfo) {
            throw new Error('Unknown vault');
        }
        await openFile({
            id: fileInfo.id,
            name: fileInfo.name,
            storage: fileInfo.storage,
            path: fileInfo.path,
            opts: fileInfo.opts,
            keyFileName: fileInfo.keyFileName,
            password: kdbxweb.ProtectedValue.fromString(String(req.password ?? ''))
        });
        return status();
    },

    async openWebDav(req) {
        const url = String(req.url);
        await openFile({
            name: UrlFormat.getDataFileName(url),
            storage: 'webdav',
            path: url,
            opts: { user: req.user || '', password: req.pass || '' },
            password: kdbxweb.ProtectedValue.fromString(String(req.password ?? ''))
        });
        return status();
    },

    async openData(req) {
        const bytes = kdbxweb.ByteUtils.base64ToBytes(String(req.data));
        await openFile({
            name: String(req.name || 'vault').replace(/\.kdbx$/i, ''),
            storage: null,
            path: null,
            fileData: kdbxweb.ByteUtils.arrayToBuffer(bytes),
            password: kdbxweb.ProtectedValue.fromString(String(req.password ?? ''))
        });
        return status();
    },

    openDemo() {
        app().createDemoFile();
        return status();
    },

    lock() {
        Events.emit('lock-workspace');
        return { locked: true };
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

    copied() {
        scheduleClipboardClear();
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

export { VaultApi };
