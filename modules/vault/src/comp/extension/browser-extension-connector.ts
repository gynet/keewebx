import type { AppModel } from 'models/app-model';
import type { ProtocolAccess } from './protocol-access';
import type { ProtocolUi } from './protocol-ui';
import { Logger } from 'util/logger';
import { storageKey } from 'comp/settings/storage-namespace';
import {
    ProtocolImpl,
    type ConnectionInfo,
    type ProtocolRequest,
    type ProtocolResponse,
    type ProtocolInitVars,
    type ClientPermissions
} from './protocol-impl';
import { Features } from 'util/features';
import { validWebsiteOrigin } from './website-matching';

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
if (!localStorage[storageKey('debugBrowserExtension')]) {
    logger.level = Logger.Level.Info;
}

const connections = new Map<number, ConnectionInfo>();
type BrowserRequest = ProtocolRequest & { kwConnection?: string; kwRequest?: string; kwAttempt?: string; kwDeadline?: number };
const validReceiptId = (value: unknown): value is string => typeof value === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
interface RequestReceipt {
    id: string;
    attempt: string;
    deadline: number;
    fingerprint: string;
    origin: string;
    epoch: number;
}
const pendingBrowserMessages: Array<{ request: BrowserRequest; receipt?: RequestReceipt }> = [];
const seenRequests = new Map<string, number>();
let latestReceipt: (RequestReceipt & { response: ProtocolResponse; port: string; generation: number }) | undefined;
let receiptTimer: ReturnType<typeof setTimeout> | undefined;
let receiptEpoch = 0;
let receiptNeedsHandshake = false;
function clearReceipts(needsHandshake = false): void {
    ++receiptEpoch;
    seenRequests.clear();
    latestReceipt = undefined;
    clearTimeout(receiptTimer); receiptTimer = undefined;
    receiptNeedsHandshake = needsHandshake;
}
let processingBrowserMessage = false;
let transportGeneration = 0;
let webPort: string | undefined;
let webWebsiteOrigin: string | undefined;
let initVars: ProtocolInitVars | undefined;
let unsubscribeInvalidation: (() => void) | undefined;
let boundMessage: ((event: MessageEvent<BrowserWindowMessageEventData>) => void) | undefined;
let accessOpen = false;

interface BrowserWindowMessageEventData {
    kwConnect?: string;
    [key: string]: unknown;
}

const BrowserExtensionConnector = {
    started: false,
    logger,

    init(appModel: AppModel, ui: ProtocolUi, access: ProtocolAccess): void {
        if (this.started) this.stop();
        const sendEvent = this.sendEvent.bind(this);
        initVars = { appModel, ui, access, logger, sendEvent };

        if (this.isEnabled()) {
            this.start();
        }
    },

    start(): void {
        if (this.started) return;
        if (!initVars) throw new Error('Connector must be initialized');
        ProtocolImpl.init(initVars);
        this.startWebMessageListener();

        this.started = true;
        accessOpen = initVars.access.snapshot().open;
        this.sendLockState();
        unsubscribeInvalidation = initVars.access.subscribeInvalidation(() => {
            clearReceipts(true);
            const open = initVars!.access.snapshot().open;
            if (open !== accessOpen) { accessOpen = open; this.sendLockState(); }
            for (const { request, receipt } of pendingBrowserMessages.splice(0)) {
                this.sendWebResponse({ action: request.action, error: 'Access suspended', errorCode: '1' }, request.kwConnection ?? null, receipt?.id, receipt?.attempt);
            }
        });
    },

    stop(): void {
        ++transportGeneration;
        clearReceipts();
        webPort = undefined;
        webWebsiteOrigin = undefined;
        unsubscribeInvalidation?.(); unsubscribeInvalidation = undefined;
        pendingBrowserMessages.length = 0;
        processingBrowserMessage = false;
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
        boundMessage ??= this.browserWindowMessage.bind(this);
        window.addEventListener('message', boundMessage);
        logger.info('Started');
    },

    stopWebMessageListener(): void {
        if (boundMessage) window.removeEventListener('message', boundMessage);
    },

    browserWindowMessage(e: MessageEvent<BrowserWindowMessageEventData>): void {
        // On file:// in Firefox, location.origin is the string "null"
        // (opaque origin). We still require same-window (`e.source ===
        // window`), which is a strong enough guarantee: a message from
        // the extension's content script injected into this document
        // will always match.
        if (!this.started || e.source !== window) {
            return;
        }
        if (location.origin !== 'null' && e.origin !== location.origin) {
            return;
        }
        if (e.data?.kwConnect === 'get-state') { this.sendLockState(); return; }
        const port = typeof e.data?.kwConnection === 'string' && e.data.kwConnection ? e.data.kwConnection : undefined;
        if (e.data?.kwConnect === 'disconnected') {
            if (port && port === webPort) {
                this.invalidateWebConnection();
                webPort = undefined;
                webWebsiteOrigin = undefined;
            }
            return;
        }
        if (e?.data?.kwConnect !== 'request') {
            return;
        }
        const websiteOrigin = validWebsiteOrigin(e.data.kwWebsiteOrigin);
        if (e.data.kwWebsiteOrigin !== undefined && (!websiteOrigin || !port)) return;
        let receipt: RequestReceipt | undefined;
        if (e.data.kwRequest !== undefined) {
            const id = e.data.kwRequest, attempt = e.data.kwAttempt, deadline = e.data.kwDeadline, now = Date.now();
            if (!port || !validReceiptId(id) || !validReceiptId(attempt) ||
                typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline <= now || deadline > now + 66000) return;
            let fingerprint: string;
            try {
                // A fresh policy check changes its attempt token, never the execution identity.
                const { kwAttempt, ...execution } = e.data;
                fingerprint = JSON.stringify(execution);
            } catch { return; }
            receipt = { id, attempt, deadline, fingerprint, origin: e.origin, epoch: receiptEpoch };
            for (const [seen, until] of seenRequests) if (until <= now) seenRequests.delete(seen);
            if (latestReceipt && latestReceipt.deadline <= now) latestReceipt = undefined;
            if (seenRequests.has(id)) {
                const cached = latestReceipt;
                if (cached && cached.id === id && cached.deadline === deadline && cached.fingerprint === fingerprint &&
                    cached.port === port && cached.origin === e.origin && cached.generation === transportGeneration && cached.epoch === receiptEpoch) {
                    this.sendWebResponse(cached.response, port, id, attempt);
                }
                return;
            }
        }
        const handshake = e.data.action === 'ping' || e.data.action === 'change-public-keys';
        // A bridge port is a transport lifetime, not an authentication identity.
        // A new handshake must bypass abandoned work; old port notifications
        // must not invalidate its replacement. Untagged legacy bridges still work.
        if (port !== webPort || websiteOrigin !== webWebsiteOrigin || (receipt && receiptNeedsHandshake)) {
            if (!handshake) {
                // Fail the displaced bridge without accessing or replacing the active connection.
                if (port) this.sendWebResponse({
                    action: typeof e.data.action === 'string' ? e.data.action : undefined,
                    error: 'KeeWebX connection changed. Find accounts again.',
                    errorCode: 'kwx-connection-changed'
                }, port ?? null, receipt?.id, receipt?.attempt);
                return;
            }
            this.invalidateWebConnection();
            webPort = port;
            webWebsiteOrigin = websiteOrigin;
        }
        if (receipt) {
            if (seenRequests.size >= 256) {
                this.sendWebResponse({ action: typeof e.data.action === 'string' ? e.data.action : undefined,
                    error: 'Too many Connect requests. Find accounts again.', errorCode: 'kwx-request-limit' }, port ?? null, receipt.id, receipt.attempt);
                return;
            }
            receipt.epoch = receiptEpoch;
            // Reserve before queueing so retries cannot execute pending work twice.
            seenRequests.set(receipt.id, receipt.deadline);
        }
        logger.debug('Extension -> KeeWeb', e.data);
        pendingBrowserMessages.push({ request: e.data as unknown as BrowserRequest, receipt });
        void this.processBrowserMessages().catch(error => logger.error('Error draining browser extension queue', error));
    },

    invalidateWebConnection(): void {
        ++transportGeneration;
        clearReceipts();
        pendingBrowserMessages.length = 0;
        processingBrowserMessage = false;
        connections.delete(WebConnectionInfo.connectionId);
        ProtocolImpl.deleteConnection(WebConnectionInfo.connectionId);
    },

    async processBrowserMessages(): Promise<void> {
        if (!this.started || !pendingBrowserMessages.length || processingBrowserMessage) {
            return;
        }

        if (!connections.has(WebConnectionInfo.connectionId)) {
            connections.set(WebConnectionInfo.connectionId, { ...WebConnectionInfo, websiteOrigin: webWebsiteOrigin });
        }

        processingBrowserMessage = true;

        const pending = pendingBrowserMessages.shift();
        if (!pending) {
            processingBrowserMessage = false;
            return;
        }

        const { request, receipt } = pending;
        const generation = transportGeneration;
        const respond = (response: ProtocolResponse) => {
            if (!this.started || generation !== transportGeneration) return;
            if (receipt) {
                if (Date.now() >= receipt.deadline) return;
                if (receipt.epoch !== receiptEpoch) {
                    this.sendWebResponse({ action: request.action, error: 'Access suspended', errorCode: '1' }, request.kwConnection ?? null, receipt.id, receipt.attempt);
                    return;
                }
                // Retain the original encrypted response object for its final policy guard.
                const cached = latestReceipt = { ...receipt, response, port: request.kwConnection!, generation };
                clearTimeout(receiptTimer);
                const ownTimer = setTimeout(() => {
                    if (latestReceipt === cached) latestReceipt = undefined;
                    if (receiptTimer === ownTimer) receiptTimer = undefined;
                }, Math.max(1, receipt.deadline - Date.now()));
                receiptTimer = ownTimer;
            }
            this.sendWebResponse(response, request.kwConnection ?? null, receipt?.id, receipt?.attempt);
        };
        try {
            if (receipt && (receipt.epoch !== receiptEpoch || Date.now() >= receipt.deadline)) return;
            const response = await ProtocolImpl.handleRequest(request, connections.get(WebConnectionInfo.connectionId)!);
            if (response) respond(response);
        } catch (error) {
            if (!this.started || generation !== transportGeneration) return;
            const failure = error instanceof Error ? error : new Error(String(error));
            logger.error('Error processing browser extension request', failure);
            respond(ProtocolImpl.errorToResponse(failure, request));
        } finally {
            // Old work must never release or drain a replacement transport's queue.
            if (this.started && generation === transportGeneration) {
                processingBrowserMessage = false;
                void this.processBrowserMessages().catch(error => logger.error('Error draining browser extension queue', error));
            }
        }
    },

    sendWebResponse(response: ProtocolResponse, port: string | null = webPort ?? null, requestId?: string, attempt?: string): void {
        if (!this.started) return;
        response = { ...ProtocolImpl.prepareResponse(response) };
        logger.debug('KeeWeb -> Extension', response);
        response.kwConnect = 'response';
        if (port) response.kwConnection = port;
        else delete response.kwConnection;
        if (requestId && attempt) { response.kwRequest = requestId; response.kwAttempt = attempt; response.kwReceipt = 1; }
        else { delete response.kwRequest; delete response.kwAttempt; delete response.kwReceipt; }
        // On file:// in Firefox, location.origin is "null" which
        // postMessage rejects as targetOrigin. Fall back to "*" —
        // the content script's window-message listener additionally
        // validates `e.source === window` to prevent cross-document
        // leaks.
        const targetOrigin = location.origin === 'null' ? '*' : window.location.origin;
        try { postMessage(response, targetOrigin); }
        catch (error) { logger.error('Error posting browser extension response', error); }
    },

    sendEvent(data: ProtocolResponse): void {
        if (!this.started || !this.isEnabled() || !connections.size) {
            return;
        }
        this.sendWebResponse(data);
    },

    sendLockState(): void {
        if (!this.started || !initVars) return;
        // Lifecycle state is independent of webPort: locking resets that bridge
        // before file-opened (or recovery) can announce the next unlock.
        const action = initVars.access.snapshot().open ? 'database-unlocked' : 'database-locked';
        try { postMessage({ kwConnect: 'state', action }, location.origin === 'null' ? '*' : location.origin); }
        catch (error) { logger.error('Error posting browser extension state', error); }
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
