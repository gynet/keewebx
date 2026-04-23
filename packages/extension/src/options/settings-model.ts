import { TypedEmitter } from 'tiny-typed-emitter';
import { OptionsPageMessage } from 'common/options-page-interface';
import { BackendConnectionState } from 'common/backend-connection-state';
import {
    BackgroundMessageFromPageConnectToKeeWeb,
    BackgroundMessageFromPageOpenTab
} from 'common/background-interface';
import { noop } from 'common/utils';
import { urlToMatchPattern } from 'common/match-pattern';

interface SettingsModelEvents {
    change: () => void;
}

class SettingsModel extends TypedEmitter<SettingsModelEvents> {
    readonly defaultKeeWebUrl = 'https://keewebx.app/';

    private _loaded = false;
    private _canAccessKeeWebTab: boolean | undefined;
    private _keeWebUrl: string | undefined;
    private _backgroundPagePort: chrome.runtime.Port | undefined;
    private _chromeCommands: chrome.commands.Command[] | undefined;
    private _backendConnectionState = BackendConnectionState.Initializing;
    private _backendConnectionError: string | undefined;

    async init() {
        await this.loadStorageConfig();
        await this.checkPermissions();
        await this.connectToBackgroundPage();
        await this.getShortcuts();
        this.initComplete();
    }

    private loadStorageConfig(): Promise<void> {
        return new Promise((resolve) => {
            chrome.storage.local.get(['keeWebUrl'], (result) => {
                this._keeWebUrl = <string>result.keeWebUrl;
                resolve();
            });
        });
    }

    private checkPermissions(): Promise<void> {
        return new Promise((resolve) => {
            // `chrome.permissions.contains` `origins` expects match
            // patterns (e.g. `https://example.com/*`), not concrete
            // URLs. Firefox strict-rejects bad patterns.
            let origins: string[];
            try {
                origins = [urlToMatchPattern(this.keeWebUrl)];
            } catch {
                this._canAccessKeeWebTab = false;
                return resolve();
            }
            chrome.permissions.contains(
                {
                    permissions: ['tabs'],
                    origins
                },
                (canAccessKeeWebTab) => {
                    this._canAccessKeeWebTab = canAccessKeeWebTab;
                    resolve();
                }
            );
        });
    }

    private connectToBackgroundPage(): Promise<void> {
        return new Promise((resolve) => {
            this.establishBackgroundPort();
            resolve();
        });
    }

    private establishBackgroundPort(): chrome.runtime.Port {
        this._backgroundPagePort = chrome.runtime.connect({ name: 'options' });
        this._backgroundPagePort.onMessage.addListener((message) =>
            this.handleMessageFromBackgroundPage(message as OptionsPageMessage)
        );
        this._backgroundPagePort.onDisconnect.addListener(() => {
            this._backgroundPagePort = undefined;
        });
        return this._backgroundPagePort;
    }

    private ensureBackgroundPort(): chrome.runtime.Port {
        if (!this._backgroundPagePort) {
            return this.establishBackgroundPort();
        }
        return this._backgroundPagePort;
    }

    private getShortcuts(): Promise<void> {
        return new Promise((resolve) => {
            chrome.commands.getAll((commands) => {
                if (Array.isArray(commands)) {
                    this._chromeCommands = commands;
                }
                resolve();
            });
        });
    }

    private initComplete() {
        this._loaded = true;
        this.emit('change');
    }

    get loaded(): boolean {
        return this._loaded;
    }

    get keeWebUrl(): string {
        return this._keeWebUrl || this.defaultKeeWebUrl;
    }

    setKeeWebUrl(keeWebUrl: string | undefined) {
        if (keeWebUrl === this.defaultKeeWebUrl) {
            keeWebUrl = undefined;
        }
        this._keeWebUrl = keeWebUrl;
        this._canAccessKeeWebTab = undefined;
        (async () => {
            await new Promise<void>((resolve) => {
                if (keeWebUrl) {
                    chrome.storage.local.set({ keeWebUrl }, () => resolve());
                } else {
                    chrome.storage.local.remove(['keeWebUrl'], () => resolve());
                }
            });
            this.emit('change');
            await this.checkPermissions();
            this.emit('change');
        })().catch(noop);
    }

    get keeWebUrlIsSet(): boolean {
        return !!this._keeWebUrl;
    }

    get canAccessKeeWebTab(): boolean | undefined {
        return this._canAccessKeeWebTab;
    }
    askKeeWebTabPermission(): Promise<boolean> {
        return new Promise((resolve) => {
            let origins: string[];
            try {
                origins = [urlToMatchPattern(this.keeWebUrl)];
            } catch {
                return resolve(false);
            }
            chrome.permissions.request(
                {
                    permissions: ['tabs'],
                    origins
                },
                (granted) => {
                    if (granted) {
                        this._canAccessKeeWebTab = true;
                        this.emit('change');
                    }
                    resolve(granted);
                }
            );
        });
    }

    get shortcuts(): chrome.commands.Command[] {
        return (this._chromeCommands || []).filter((cmd) => cmd.shortcut);
    }

    private handleMessageFromBackgroundPage(message: OptionsPageMessage) {
        if (message.backendConnectionState) {
            this._backendConnectionState = message.backendConnectionState;
            this._backendConnectionError = message.backendConnectionError;
            this.emit('change');
        }
    }

    get backendConnectionState(): BackendConnectionState {
        return this._backendConnectionState;
    }

    get backendConnectionError(): string | undefined {
        return this._backendConnectionError;
    }

    connectToKeeWeb() {
        chrome.tabs.getCurrent((tab) => {
            if (tab?.id) {
                const message: BackgroundMessageFromPageConnectToKeeWeb = {
                    action: 'connect-to-keeweb',
                    activeTabId: tab.id
                };
                this.ensureBackgroundPort().postMessage(message);
            }
        });
    }

    openKeeWebTab() {
        const message: BackgroundMessageFromPageOpenTab = {
            action: 'open-tab',
            url: this.keeWebUrl
        };
        this.ensureBackgroundPort().postMessage(message);
    }
}

const model = new SettingsModel();

export { model };
