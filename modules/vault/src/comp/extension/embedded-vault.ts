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

function runtime(): ExtensionRuntime | undefined {
    return typeof chrome !== 'undefined' && chrome?.runtime?.id ? chrome.runtime : undefined;
}

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
            const handler = req.vault === 'ping' ? () => ({ ready: true }) : VaultApi[req.vault];
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
