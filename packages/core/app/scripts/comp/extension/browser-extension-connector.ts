import { Logger } from 'util/logger';
import {
    ProtocolImpl,
    type ConnectionInfo,
    type ProtocolRequest,
    type ProtocolResponse,
    type ClientPermissions
} from './protocol-impl';
import { Features } from 'util/features';

const WebConnectionInfo: ConnectionInfo = {
    connectionId: 1,
    extensionName: 'KeeWeb Connect',
    supportsNotifications: true
};

interface SupportedExtension {
    alias: string;
    name: string;
}

const SupportedExtensions: SupportedExtension[] = [
    { alias: 'KWC', name: 'KeeWeb Connect' },
    { alias: 'KPXC', name: 'KeePassXC-Browser' }
];
const SupportedBrowsers: string[] = ['Chrome', 'Firefox', 'Edge', 'Other'];
if (Features.isMac) {
    SupportedBrowsers.unshift('Safari');
}

const logger = new Logger('browser-extension-connector');
if (!localStorage.debugBrowserExtension) {
    logger.level = Logger.Level.Info;
}

const connections = new Map<number, ConnectionInfo>();
const pendingBrowserMessages: ProtocolRequest[] = [];
let processingBrowserMessage = false;

interface BrowserWindowMessageEventData {
    kwConnect?: string;
    [key: string]: unknown;
}

const BrowserExtensionConnector = {
    started: false,
    logger,

    init(appModel: unknown): void {
        const sendEvent = this.sendEvent.bind(this);
        ProtocolImpl.init({ appModel, logger, sendEvent });

        this.browserWindowMessage = this.browserWindowMessage.bind(this);

        if (this.isEnabled()) {
            this.start();
        }
    },

    start(): void {
        this.startWebMessageListener();

        this.started = true;
    },

    stop(): void {
        this.stopWebMessageListener();

        ProtocolImpl.cleanup();
        connections.clear();

        this.started = false;
    },

    appSettingsChanged(): void {
        if (this.isEnabled()) {
            if (!this.started) {
                this.start();
            }
        } else if (this.started) {
            this.stop();
        }
    },

    isEnabled(): boolean {
        return true;
    },

    startWebMessageListener(): void {
        window.addEventListener('message', this.browserWindowMessage);
        logger.info('Started');
    },

    stopWebMessageListener(): void {
        window.removeEventListener('message', this.browserWindowMessage);
    },

    browserWindowMessage(e: MessageEvent<BrowserWindowMessageEventData>): void {
        // On file:// in Firefox, location.origin is the string "null"
        // (opaque origin). We still require same-window (`e.source ===
        // window`), which is a strong enough guarantee: a message from
        // the extension's content script injected into this document
        // will always match.
        if (e.source !== window) {
            return;
        }
        if (location.origin !== 'null' && e.origin !== location.origin) {
            return;
        }
        if (e?.data?.kwConnect !== 'request') {
            return;
        }
        logger.debug('Extension -> KeeWeb', e.data);
        pendingBrowserMessages.push(e.data as unknown as ProtocolRequest);
        this.processBrowserMessages();
    },

    async processBrowserMessages(): Promise<void> {
        if (!pendingBrowserMessages.length || processingBrowserMessage) {
            return;
        }

        if (!connections.has(WebConnectionInfo.connectionId)) {
            connections.set(WebConnectionInfo.connectionId, WebConnectionInfo);
        }

        processingBrowserMessage = true;

        const request = pendingBrowserMessages.shift();
        if (!request) {
            processingBrowserMessage = false;
            return;
        }

        const response = await ProtocolImpl.handleRequest(request, WebConnectionInfo);

        processingBrowserMessage = false;

        if (response) {
            this.sendWebResponse(response);
        }

        this.processBrowserMessages();
    },

    sendWebResponse(response: ProtocolResponse): void {
        logger.debug('KeeWeb -> Extension', response);
        response.kwConnect = 'response';
        // On file:// in Firefox, location.origin is "null" which
        // postMessage rejects as targetOrigin. Fall back to "*" —
        // the content script's window-message listener additionally
        // validates `e.source === window` to prevent cross-document
        // leaks.
        const targetOrigin = location.origin === 'null' ? '*' : window.location.origin;
        postMessage(response, targetOrigin);
    },

    sendEvent(data: ProtocolResponse): void {
        if (!this.isEnabled() || !connections.size) {
            return;
        }
        this.sendWebResponse(data);
    },

    get sessions() {
        return ProtocolImpl.sessions;
    },

    terminateConnection(connectionId: number | string): void {
        const id = +connectionId;
        ProtocolImpl.deleteConnection(id);
    },

    getClientPermissions(clientId: string): ClientPermissions | undefined {
        return ProtocolImpl.getClientPermissions(clientId);
    },

    setClientPermissions(clientId: string, permissions: Partial<ClientPermissions>): void {
        ProtocolImpl.setClientPermissions(clientId, permissions);
    }
};

export { BrowserExtensionConnector, SupportedExtensions, SupportedBrowsers };
export type { SupportedExtension };
