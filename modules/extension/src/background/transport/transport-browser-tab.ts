import { TransportBase } from './transport-base';
import { activateTab, randomBase64 } from 'background/utils';
import {
    KeeWebConnectRequest,
    KeeWebConnectResponse,
    KeeWebConnectPingRequest,
    KeeWebConnectPingResponse
} from 'background/protocol/types';
import { noop } from 'common/utils';
import { matchesAppUrl } from 'common/app-url';
import { urlToMatchPattern } from 'common/match-pattern';

class TransportBrowserTab extends TransportBase {
    private readonly _keeWebUrl: string;
    private readonly _maxTabConnectionRetries = 10;
    private readonly _tabConnectionRetryMillis = 500;
    private readonly _tabConnectionTimeoutMillis = 500;
    private _tab: chrome.tabs.Tab | undefined;
    private _port: chrome.runtime.Port | undefined;

    constructor(keeWebUrl: string) {
        super();
        this._keeWebUrl = keeWebUrl;
    }

    async connect(): Promise<void> {
        const hasPermissions = this.isEmbeddedApp || (await this.checkPermissions());
        if (!hasPermissions) {
            const msg = chrome.i18n.getMessage('errorBrowserTabNoPermissions', this._keeWebUrl);
            throw new Error(msg);
        }

        this._tab = await this.findOrCreateTab();

        // The packaged app page includes the bridge script itself; extension
        // pages cannot be targeted by chrome.scripting.
        if (!this.isEmbeddedApp) {
            await this.injectContentScript();
        }

        this._port = await this.connectToTab(this._maxTabConnectionRetries);
        if (!this._port) {
            throw new Error(chrome.i18n.getMessage('errorConnectionErrorWeb'));
        }

        this._port.onDisconnect.addListener(() => this.portDisconnected());
        this._port.onMessage.addListener((msg) => this.portMessage(msg)); // eslint-disable-line @typescript-eslint/no-unsafe-argument
    }

    disconnect(): Promise<void> {
        return new Promise((resolve) => {
            this._tab = undefined;
            this._port?.disconnect();
            if (this._port) {
                this.portDisconnected();
            }
            resolve();
        });
    }

    request(message: KeeWebConnectRequest): void {
        if (this._port) {
            this._port.postMessage(message);
        }
    }

    focusKeeWeb(): void {
        if (this._tab?.id) {
            activateTab(this._tab.id).catch(noop);
        }
    }

    private get isEmbeddedApp(): boolean {
        return this._keeWebUrl.startsWith(chrome.runtime.getURL(''));
    }

    private checkPermissions(): Promise<boolean> {
        return new Promise((resolve) => {
            // `chrome.permissions.contains` expects a match pattern
            // (e.g. `https://example.com/*`), NOT a concrete URL.
            // Chrome is lenient, Firefox strict-rejects — user-reported
            // bug against v0.1.0 self-host bundle where Firefox
            // blocked the whole flow behind this gate.
            let origins: string[];
            try {
                origins = [urlToMatchPattern(this._keeWebUrl)];
            } catch {
                // Unparseable URL shouldn't reach here (options-page
                // validation catches it), but be defensive — if it
                // does, treat as "no permission".
                return resolve(false);
            }
            chrome.permissions.contains(
                {
                    permissions: ['tabs'],
                    origins
                },
                resolve
            );
        });
    }

    private findOrCreateTab(): Promise<chrome.tabs.Tab> {
        return new Promise((resolve, reject) => {
            chrome.tabs.query({}, (allTabs) => {
                const tab = allTabs.find((tab) => matchesAppUrl(tab.url, this._keeWebUrl));
                if (tab) {
                    return resolve(tab);
                }
                chrome.tabs.create({ url: this._keeWebUrl, active: true }, (tab) => {
                    if (tab) {
                        resolve(tab);
                    } else {
                        reject(
                            new Error(chrome.i18n.getMessage('errorBrowserCannotCreateTab'))
                        );
                    }
                });
            });
        });
    }

    private portDisconnected() {
        this._tab = undefined;
        if (this._port) {
            this._port = undefined;
            this.emit('disconnected');
        }
    }

    private injectContentScript(): Promise<void> {
        return new Promise((resolve, reject) => {
            chrome.scripting.executeScript(
                { files: ['js/content-keeweb.js'], target: { tabId: this._tab!.id! } },
                () => {
                    if (chrome.runtime.lastError) {
                        const msg = `Content script injection error: ${chrome.runtime.lastError.message}`;
                        reject(new Error(msg));
                    } else {
                        resolve();
                    }
                }
            );
        });
    }

    private connectToTab(retriesLeft: number): Promise<chrome.runtime.Port | undefined> {
        return new Promise((resolve) => {
            if (retriesLeft <= 0 || !this._tab?.id) {
                return resolve(undefined);
            }

            const name = TransportBrowserTab.getRandomPortName();
            const port = chrome.tabs.connect(this._tab.id, { name });

            const cleanup = () => {
                clearTimeout(responseTimeout);
                port.onDisconnect.removeListener(tabDisconnected);
                port.onMessage.removeListener(tabMessage);
            };

            const responseTimeout = setTimeout(() => {
                cleanup();
                port.disconnect();
                this.connectToTab(retriesLeft - 1)
                    .then(resolve)
                    .catch(noop);
            }, this._tabConnectionTimeoutMillis);

            const tabDisconnected = () => {
                if (chrome.runtime.lastError) {
                    // eslint-disable-next-line no-console
                    console.warn(
                        'KeeWeb tab disconnected with error',
                        chrome.runtime.lastError.message
                    );
                }
                cleanup();
                setTimeout(() => {
                    this.connectToTab(retriesLeft - 1)
                        .then(resolve)
                        .catch(noop);
                }, this._tabConnectionRetryMillis);
            };

            const tabMessage = (msg: KeeWebConnectPingResponse) => {
                cleanup();
                if (msg.data === name) {
                    resolve(port);
                } else {
                    port.disconnect();
                    resolve(undefined);
                }
            };

            port.onDisconnect.addListener(tabDisconnected);
            port.onMessage.addListener(tabMessage);

            const pingRequest: KeeWebConnectPingRequest = {
                action: 'ping',
                data: port.name
            };
            port.postMessage(pingRequest);
        });
    }

    private static getRandomPortName(): string {
        return `keeweb-connect-${randomBase64(32)}`;
    }

    private portMessage(msg: KeeWebConnectResponse) {
        this.emit('message', msg);
    }
}

export { TransportBrowserTab };
