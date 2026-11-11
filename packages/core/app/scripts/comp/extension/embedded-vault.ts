/**
 * Serves the browser extension's popup, side panel and settings page when
 * the app runs inside the extension, usually hidden in an offscreen
 * document. Requests are chrome.runtime messages shaped { vault: command }.
 * Messages only come from the extension's own pages, so they skip the
 * encrypted protocol that website tabs use.
 */
import * as kdbxweb from 'kdbxweb';
import { Events } from 'framework/events';
import { AppModel } from 'models/app-model';
import { AppSettingsModel } from 'models/app-settings-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import { SelectEntryFilter } from 'comp/app/select-entry-filter';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { UrlFormat } from 'util/formatting/url-format';
import { Logger } from 'util/logger';

interface RuntimeSender {
    id?: string;
}
interface ExtensionRuntime {
    id?: string;
    onMessage: {
        addListener(
            cb: (msg: unknown, sender: RuntimeSender, respond: (r: unknown) => void) => boolean
        ): void;
    };
    sendMessage(msg: unknown): Promise<unknown>;
}
declare const chrome: { runtime?: ExtensionRuntime } | undefined;

type Request = Record<string, unknown> & { vault: string };

const logger = new Logger('embedded-vault');
const RECENT_LIMIT = 30;
const SETTINGS = ['idleMinutes', 'clipboardSeconds', 'lockOnOsLock'] as const;

let clipboardTimer: ReturnType<typeof setTimeout> | undefined;

function app(): AppModel {
    return AppModel.instance;
}

function runtime(): ExtensionRuntime | undefined {
    return typeof chrome !== 'undefined' && chrome?.runtime?.id ? chrome.runtime : undefined;
}

function entrySummary(entry: EntryModel) {
    return {
        id: entry.id,
        title: entry.title || '',
        user: entry.user || '',
        url: entry.displayUrl || entry.url || '',
        // The picture the app shows for the entry; none for the default key.
        icon: entry.customIcon ? null : entry.iconId ? entry.icon : null,
        customIcon: entry.customIcon || null,
        hasOtp: !!entry.otpGenerator || !!entry.fields?.otp || !!entry.fields?.['TOTP Seed']
    };
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

function otpCode(entry: EntryModel): Promise<string> {
    entry.initOtpGenerator();
    const generator = entry.otpGenerator;
    if (!generator) {
        return Promise.resolve('');
    }
    return new Promise((resolve, reject) =>
        generator.next((err, pass) => (err ? reject(err) : resolve(pass || '')))
    );
}

function fieldText(entry: EntryModel, field: unknown): Promise<string> {
    switch (field) {
        case 'user':
            return Promise.resolve(entry.user || '');
        case 'password':
            return Promise.resolve(entry.password?.getText?.() ?? String(entry.password ?? ''));
        case 'url':
            return Promise.resolve(entry.url || '');
        case 'otp':
            return otpCode(entry);
        default:
            throw new Error('Unknown field');
    }
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

function list(req: Request) {
    const model = app();
    const query = String(req.query || '').trim();
    let suggested: ReturnType<typeof entrySummary>[] = [];
    if (req.url && !query) {
        const filter = new SelectEntryFilter(
            { url: String(req.url), title: '' },
            model as unknown as ConstructorParameters<typeof SelectEntryFilter>[1],
            model.files,
            {}
        );
        suggested = (filter.getEntries() as unknown as EntryModel[]).map(entrySummary);
    }
    const all = (model.getEntriesByFilter({ text: query }, model.files) as unknown as EntryModel[])
        .slice()
        .sort((a, b) =>
            query
                ? (a.title || '').localeCompare(b.title || '')
                : (b.updated?.getTime() ?? 0) - (a.updated?.getTime() ?? 0)
        );
    const shown = new Set(suggested.map((e) => e.id));
    const items = all
        .filter((e) => !shown.has(e.id))
        .slice(0, query ? 200 : RECENT_LIMIT)
        .map(entrySummary);
    return { suggested, items };
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

const handlers: Record<string, (req: Request) => unknown> = {
    ping: () => ({ ready: true }),
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
        return { text: await fieldText(findEntry(req.id), req.field) };
    },

    async credentials(req) {
        const entry = findEntry(req.id);
        return { user: await fieldText(entry, 'user'), password: await fieldText(entry, 'password') };
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

function notifyChanged(): void {
    runtime()
        ?.sendMessage({ vaultEvent: 'changed' })
        .catch(() => {});
}

const EmbeddedVault = {
    init(): void {
        const rt = runtime();
        if (!rt || location.protocol !== 'chrome-extension:') {
            return;
        }
        rt.onMessage.addListener((msg, sender, respond) => {
            const req = msg as Request | null;
            if (!req || typeof req.vault !== 'string' || sender.id !== rt.id) {
                return false;
            }
            const handler = handlers[req.vault];
            if (!handler) {
                return false;
            }
            Promise.resolve()
                .then(() => handler(req))
                .then(
                    (result) => respond({ ok: true, result }),
                    (e: unknown) => {
                        logger.info('Request failed', req.vault, e);
                        respond({ ok: false, error: e instanceof Error ? e.message : String(e) });
                    }
                );
            return true;
        });
        Events.on('file-opened', notifyChanged);
        Events.on('app-ready', notifyChanged);
        Events.on('all-files-closed', notifyChanged);
        notifyChanged();
    }
};

export { EmbeddedVault };
