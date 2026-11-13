/**
 * Serves the browser extension's popup, side panel and settings page when
 * the app runs inside the extension, usually hidden in an offscreen
 * document. Requests are chrome.runtime messages shaped { vault: command }.
 * Messages only come from the extension's own pages, so they skip the
 * encrypted protocol that website tabs use.
 */
import { Events } from 'framework/events';
import { VaultApi } from 'comp/app/vault-api';
import { Logger } from 'util/logger';
import { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';

interface RuntimeSender {
    id?: string;
    url?: string;
}
interface ExtensionRuntime {
    id?: string;
    onMessage: {
        addListener(
            cb: (msg: unknown, sender: RuntimeSender, respond: (r: unknown) => void) => boolean
        ): void;
        removeListener(cb: (msg: unknown, sender: RuntimeSender, respond: (r: unknown) => void) => boolean): void;
    };
    sendMessage(msg: unknown): Promise<unknown>;
}
declare const chrome: { runtime?: ExtensionRuntime } | undefined;

type Request = Record<string, unknown> & { vault: string };

const logger = new Logger('embedded-vault');

function runtime(): ExtensionRuntime | undefined {
    return typeof chrome !== 'undefined' && chrome?.runtime?.id ? chrome.runtime : undefined;
}

function notifyChanged(): void {
    runtime()
        ?.sendMessage({ vaultEvent: 'changed' })
        .catch(() => {});
}

const EmbeddedVault = {
    init(): (() => void) | undefined {
        const rt = runtime();
        if (!rt || location.protocol !== 'chrome-extension:') {
            return;
        }
        const listener = (msg: unknown, sender: RuntimeSender, respond: (r: unknown) => void) => {
            const req = msg as Request | null;
            // Content scripts share the extension ID but run on untrusted sites.
            // Only extension-owned pages and its background may use this API.
            if (!req || typeof req.vault !== 'string' || sender.id !== rt.id ||
                !sender.url?.startsWith(`chrome-extension://${rt.id}/`)) {
                return false;
            }
            if (req.vaultContext === 'offscreen' &&
                new URLSearchParams(location.search).get('embedded') !== 'offscreen') return false;
            const handler = req.vault === 'ping' ? () => ({ ready: true })
                : req.vault === 'lock' ? lockAndWait : VaultApi[req.vault];
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
        };
        rt.onMessage.addListener(listener);
        Events.on('file-opened', notifyChanged);
        Events.on('app-ready', notifyChanged);
        Events.on('all-files-closed', notifyChanged);
        notifyChanged();
        return () => {
            rt.onMessage.removeListener(listener);
            Events.off('file-opened', notifyChanged);
            Events.off('app-ready', notifyChanged);
            Events.off('all-files-closed', notifyChanged);
        };
    }
};

/** Closing an offscreen document must wait for durable saving and actual lock. */
async function lockAndWait(): Promise<{ locked: true }> {
    const model = AppModel.instance;
    Events.emit('lock-workspace');
    const deadline = Date.now() + 20_000;
    while (model.files.hasOpenFiles()) {
        if (AppModel.instance !== model || getSessionAccess(model).state === 'recovery-required') {
            throw new Error('The vault could not lock safely. Keep it open and recover the session.');
        }
        if (Date.now() >= deadline) throw new Error('The vault is still saving. Keep it open and retry.');
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    return { locked: true };
}

export { EmbeddedVault };
