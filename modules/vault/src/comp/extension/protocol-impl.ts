import * as kdbxweb from 'kdbxweb';
import { Events } from 'framework/events';
import { box as tweetnaclBox, sign as tweetnaclSign } from 'tweetnacl';
import { PasswordGenerator } from 'util/generators/password-generator';
import { GeneratorPresets } from 'comp/app/generator-presets';
import { Locale } from 'util/locale';
import { RuntimeInfo } from 'const/runtime-info';
import { KnownAppVersions } from 'const/known-app-versions';
import { RuntimeDataModel } from 'models/runtime-data-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { Timeouts } from 'const/timeouts';
import { SelectEntryFilter } from 'comp/app/select-entry-filter';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import type { GroupCollection } from 'collections/group-collection';
import type { ProtocolUi, SaveGroupChoice } from './protocol-ui';
import type { Logger } from 'util/logger';
import { entryFieldText, listEntries, summarizeEntry } from 'comp/extension/entry-list';

// === Public types shared with browser-extension-connector ===

export interface ConnectionInfo {
    connectionId: number;
    extensionName: string;
    appName?: string;
    supportsNotifications?: boolean;
}

export interface ProtocolRequest {
    action: string;
    clientID?: string;
    nonce?: string;
    message?: string;
    publicKey?: string;
    version?: string;
    triggerUnlock?: boolean;
    kwConnect?: string;
    [key: string]: unknown;
}

export interface ProtocolResponse {
    action?: string;
    kwConnect?: string;
    error?: string;
    errorCode?: number | string;
    [key: string]: unknown;
}

export interface SaveToConfig {
    fileId: string;
    groupId: string;
}

export interface ClientPermissions {
    allFiles?: boolean;
    files?: string[];
    askGet?: string;
    askSave?: string;
    saveTo?: SaveToConfig;
    /** May list and search entries (paired clients only). */
    canList?: boolean;
    [key: string]: unknown;
}

/** An extension that proved it holds a long-term identity key. */
interface Pairing {
    created: string;
    permissions?: ClientPermissions;
}

/** A short-lived reference to an entry, handed out in entry lists. */
interface EntryHandle {
    fileId: string;
    entryId: string;
    expires: number;
}

interface ClientStats {
    connectedDate: Date;
    passwordsRead: number;
    passwordsWritten: number;
}

interface ClientState {
    connection: ConnectionInfo;
    publicKey: Uint8Array;
    version?: string;
    keys: { publicKey: Uint8Array; secretKey: Uint8Array };
    stats: ClientStats;
    permissions?: ClientPermissions;
    permissionsDenied?: boolean;
    /** Identity key (base64) once the client has paired. */
    identity?: string;
    handles: Map<string, EntryHandle>;
}

interface ErrorDef {
    message: string;
    code: string;
}

// Error with optional protocol error code attached
interface CodedError extends Error {
    code?: string | number;
}

export interface ProtocolInitVars {
    appModel: AppModel;
    ui: ProtocolUi;
    logger: Logger;
    sendEvent: (data: ProtocolResponse) => void;
}

// Runtime settings allow extension-defined properties; describe only this protocol's keys.
const runtimeData = RuntimeDataModel as typeof RuntimeDataModel & {
    extensionPairings?: Record<string, Pairing>;
    extensionConnectConfig?: ClientPermissions;
    extensionSaveConfig?: { fileId: string; groupId: string; askSave?: string };
};

const KeeWebAssociationId = 'KeeWeb';
const KeeWebHash = '398d9c782ec76ae9e9877c2321cbda2b31fc6d18ccf0fed5ca4bd746bab4d64a'; // sha256('KeeWeb')
const ExtensionGroupIconId = 1;
const DefaultExtensionGroupName = 'Browser';
const ExtensionGroupNames = new Set(['KeePassXC-Browser Passwords', DefaultExtensionGroupName]);

const loc = Locale as unknown as Record<string, string>;

const Errors: Record<string, ErrorDef> = {
    noOpenFiles: {
        message: loc['extensionErrorNoOpenFiles'],
        code: '1'
    },
    userRejected: {
        message: loc['extensionErrorUserRejected'],
        code: '6'
    },
    noMatches: {
        message: loc['extensionErrorNoMatches'],
        code: '15'
    },
    notPaired: {
        message: 'The extension is not paired',
        code: 'kwx-not-paired'
    },
    expiredHandle: {
        message: 'The entry reference expired, list the entries again',
        code: 'kwx-expired-handle'
    }
};

const HANDLE_TTL_MS = 5 * 60 * 1000;
const PAIRING_SIG_CONTEXT = 'kwx-pair-v1';

function getPairings(): Record<string, Pairing> {
    return runtimeData.extensionPairings ?? {};
}

function savePairing(identity: string, pairing: Pairing): void {
    runtimeData.extensionPairings = { ...getPairings(), [identity]: pairing };
}

const connectedClients = new Map<string, ClientState>();

let logger: Logger;
let appModel: AppModel;
let ui: ProtocolUi;
let sendEvent: (data: ProtocolResponse) => void;

function setupListeners(): void {
    Events.on('file-opened', () => {
        sendEvent({ action: 'database-unlocked' });
    });
    Events.on('one-file-closed', () => {
        if (!appModel.files.hasOpenFiles()) {
            sendEvent({ action: 'database-locked' });
        }
    });
    Events.on('all-files-closed', () => {
        for (const client of connectedClients.values()) {
            client.handles.clear();
        }
        sendEvent({ action: 'database-locked' });
    });
}

function incrementNonce(nonce: Uint8Array): void {
    // from libsodium/utils.c, like it is in KeePassXC
    let i = 0;
    let c = 1;
    for (; i < nonce.length; ++i) {
        c += nonce[i];
        nonce[i] = c;
        c >>= 8;
    }
}

function getClient(request: ProtocolRequest): ClientState {
    if (!request.clientID) {
        throw new Error('Empty clientID');
    }
    const client = connectedClients.get(request.clientID);
    if (!client) {
        throw new Error(`Client not connected: ${request.clientID}`);
    }
    return client;
}

function decryptRequest(request: ProtocolRequest): Record<string, unknown> {
    const client = getClient(request);

    if (!request.nonce) {
        throw new Error('Empty nonce');
    }
    if (!request.message) {
        throw new Error('Empty message');
    }

    const nonce = kdbxweb.ByteUtils.base64ToBytes(request.nonce);
    const message = kdbxweb.ByteUtils.base64ToBytes(request.message);

    const data = tweetnaclBox.open(
        new Uint8Array(message),
        new Uint8Array(nonce),
        client.publicKey,
        client.keys.secretKey
    );
    if (!data) {
        throw new Error('Failed to decrypt data');
    }

    const json = new TextDecoder().decode(data);
    const payload = JSON.parse(json) as Record<string, unknown>;

    logger.debug('Extension -> KeeWeb -> (decrypted)', payload);

    if (!payload) {
        throw new Error('Empty request payload');
    }
    if (payload.action !== request.action) {
        throw new Error(`Bad action in decrypted payload`);
    }

    return payload;
}

function encryptResponse(
    request: ProtocolRequest,
    payload: Record<string, unknown>
): ProtocolResponse {
    logger.debug('KeeWeb -> Extension (decrypted)', payload);

    if (!request.nonce) {
        throw new Error('Empty nonce');
    }
    // Nonce increment bug (2026-04-09 root cause of the entire
    // extension autofill failure):
    //
    // Upstream KeeWeb was written against kdbxweb <=1.x where
    // ByteUtils.base64ToBytes returned an ArrayBuffer. The original
    // code did:
    //     const nonceBytes = base64ToBytes(request.nonce);    // ArrayBuffer
    //     incrementNonce(new Uint8Array(nonceBytes));          // view → mutates buffer
    //     const nonce = bytesToBase64(nonceBytes);             // re-encode buffer
    // where `new Uint8Array(ArrayBuffer)` is a VIEW, so the increment
    // propagated back through the underlying buffer.
    //
    // Our fork of kdbxweb changed base64ToBytes to return Uint8Array.
    // `new Uint8Array(uint8array)` is a COPY, not a view, so the
    // increment happened on a throw-away copy and `nonceBytes` stayed
    // at the original value. The response payload.nonce ended up
    // equal to request.nonce (not incremented), and the extension
    // side's validateNonce rejected every response with "Bad nonce
    // in response" — visible only by running the full extension
    // protocol through a Selenium harness and capturing the
    // background console error.
    //
    // Fix: increment nonceBytes in place. incrementNonce takes a
    // Uint8Array and mutates it; we pass it directly now.
    const nonceBytes = kdbxweb.ByteUtils.base64ToBytes(request.nonce);
    incrementNonce(nonceBytes);
    const nonce = kdbxweb.ByteUtils.bytesToBase64(nonceBytes);

    const client = getClient(request);

    payload.nonce = nonce;

    const json = JSON.stringify(payload);
    const data = new TextEncoder().encode(json);

    const encrypted = tweetnaclBox(
        data,
        nonceBytes,
        client.publicKey,
        client.keys.secretKey
    );

    const message = kdbxweb.ByteUtils.bytesToBase64(encrypted);

    return {
        action: request.action,
        message,
        nonce
    };
}

function makeError(def: ErrorDef): CodedError {
    const e: CodedError = new Error(def.message);
    e.code = def.code;
    return e;
}

function ensureAtLeastOneFileIsOpen(): void {
    if (!appModel.files.hasOpenFiles()) {
        throw makeError(Errors.noOpenFiles);
    }
}

async function checkContentRequestPermissions(
    request: ProtocolRequest,
    options: { list?: boolean } = {}
): Promise<void> {
    if (!appModel.files.hasOpenFiles()) {
        if (AppSettingsModel.extensionFocusIfLocked) {
            try {
                focusKeeWeb();
                await appModel.unlockAnyFile(
                    'extensionUnlockMessage',
                    Timeouts.KeeWebConnectRequest
                );
            } catch {
                throw makeError(Errors.noOpenFiles);
            }
        } else {
            throw makeError(Errors.noOpenFiles);
        }
    }

    const client = getClient(request);
    if (client.permissions && (!options.list || client.permissions.canList)) {
        return;
    }

    // A paired extension keeps what the user approved for its identity key.
    // Other clients share one approval, as before pairing existed: MV3
    // service workers restart often and come back with a new clientId.
    const shared = runtimeData.extensionConnectConfig as ClientPermissions | undefined;
    const stored = client.identity ? getPairings()[client.identity]?.permissions : shared;
    // A paired client may fill with an approval given before pairing existed,
    // but listing always needs its own.
    const config = stored ?? (client.identity && !options.list ? shared : undefined);

    if (config && (!options.list || config.canList)) {
        client.permissions = config;
        Events.emit('browser-extension-sessions-changed');
        return;
    }

    if (ui.isBusy()) {
        throw new Error(loc['extensionErrorAlertDisplayed']);
    }

    focusKeeWeb();

    const files = appModel.files.map((f) => ({
        id: f.id,
        name: f.name,
        checked: true
    }));

    let approved: ClientPermissions;
    try {
        approved = { ...await promptWithTimeout((signal) => ui.connect({
            extensionName: getHumanReadableExtensionName(client),
            identityVerified: true,
            files,
            allFiles: (config ?? shared)?.allFiles ?? true,
            askGet: (config ?? shared)?.askGet ?? 'multiple',
            offerList: !!client.identity,
            canList: !!options.list || !!config?.canList
        }, signal)) };
    } catch (e) {
        client.permissionsDenied = true;
        Events.emit('browser-extension-sessions-changed');
        throw e;
    }

    if (client.identity) {
        savePairing(client.identity, {
            created: getPairings()[client.identity]?.created ?? new Date().toISOString(),
            permissions: approved
        });
    } else {
        runtimeData.extensionConnectConfig = approved;
    }
    client.permissions = approved;
    Events.emit('browser-extension-sessions-changed');
    if (options.list && !approved.canList) {
        throw makeError(Errors.userRejected);
    }
}

function requirePairing(request: ProtocolRequest): ClientState {
    const client = getClient(request);
    if (!client.identity) {
        throw makeError(Errors.notPaired);
    }
    return client;
}

function issueHandle(client: ClientState, entry: EntryModel): string {
    const handle = kdbxweb.ByteUtils.bytesToBase64(kdbxweb.CryptoEngine.random(12));
    client.handles.set(handle, {
        fileId: (entry.file as FileModel).id,
        entryId: entry.id,
        expires: Date.now() + HANDLE_TTL_MS
    });
    return handle;
}

function resolveHandle(client: ClientState, handle: unknown): EntryModel {
    const ref = client.handles.get(String(handle));
    if (!ref || ref.expires < Date.now()) {
        throw makeError(Errors.expiredHandle);
    }
    const file = appModel.files.get(ref.fileId);
    const entry = file?.getEntry(ref.entryId);
    if (!entry) {
        throw makeError(Errors.expiredHandle);
    }
    return entry;
}

async function promptWithTimeout<T>(show: (signal: AbortSignal) => Promise<T | null>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result = await Promise.race([
            show(controller.signal),
            new Promise<null>((resolve) => {
                timer = setTimeout(() => {
                    controller.abort();
                    resolve(null);
                }, Timeouts.KeeWebConnectRequest);
            })
        ]);
        if (result === null) throw makeError(Errors.userRejected);
        return result;
    } finally {
        clearTimeout(timer);
        controller.abort();
    }
}

function getAvailableFiles(request: ProtocolRequest): FileModel[] | undefined {
    const client = getClient(request);
    if (!client.permissions) {
        return undefined;
    }
    const perms = client.permissions;

    const files = appModel.files.filter(
        (file) =>
            file.active &&
            (perms.allFiles || (perms.files?.includes(file.id) ?? false))
    );
    if (!files.length) {
        throw makeError(Errors.noOpenFiles);
    }

    return files;
}

function getVersion(request: ProtocolRequest): string {
    return isKeePassXcBrowser(request) ? KnownAppVersions.KeePassXC : RuntimeInfo.version;
}

function isKeeWebConnect(request: ProtocolRequest): boolean {
    return getClient(request).connection.extensionName === 'KeeWeb Connect';
}

function isKeePassXcBrowser(request: ProtocolRequest): boolean {
    return getClient(request).connection.extensionName === 'KeePassXC-Browser';
}

function getHumanReadableExtensionName(client: ClientState): string {
    return client.connection.appName
        ? `${client.connection.extensionName} (${client.connection.appName})`
        : client.connection.extensionName;
}

function focusKeeWeb(): void {
    logger.debug('Focus KeeWeb');
    sendEvent({ action: 'attention-required' });
}

async function findEntry(
    request: ProtocolRequest,
    returnIfOneMatch: boolean,
    filterOptions?: Record<string, unknown>
): Promise<EntryModel> {
    const payload = decryptRequest(request);
    await checkContentRequestPermissions(request);

    if (!payload.url) {
        throw new Error('Empty url');
    }

    const files = getAvailableFiles(request);
    const client = getClient(request);

    const filter = new SelectEntryFilter(
        { url: payload.url as string, title: payload.title as string },
        appModel as unknown as ConstructorParameters<typeof SelectEntryFilter>[1],
        files,
        filterOptions ?? {}
    );
    filter.subdomains = false;

    let entries = filter.getEntries();

    filter.subdomains = true;

    let entry: EntryModel | undefined;

    if (entries.length) {
        if (
            entries.length === 1 &&
            returnIfOneMatch &&
            client.permissions?.askGet === 'multiple'
        ) {
            entry = entries[0] as EntryModel;
        }
    } else {
        entries = filter.getEntries();

        if (!entries.length) {
            if (AppSettingsModel.extensionFocusIfEmpty) {
                filter.useUrl = false;
                if (filter.title && AppSettingsModel.autoTypeTitleFilterEnabled) {
                    filter.useTitle = true;
                    entries = filter.getEntries();
                    if (!entries.length) {
                        filter.useTitle = false;
                    }
                }
            } else {
                throw makeError(Errors.noMatches);
            }
        }
    }

    if (!entry) {
        const extName = getHumanReadableExtensionName(client);
        const topMessage = loc['extensionSelectPasswordFor'].replace('{}', extName);
        focusKeeWeb();
        entry = await promptWithTimeout((signal) => ui.selectEntry({ filter, topMessage }, signal));
    }

    client.stats.passwordsRead++;

    return entry;
}

type ProtocolHandler = (
    request: ProtocolRequest,
    connection: ConnectionInfo
) => ProtocolResponse | Promise<ProtocolResponse>;

const ProtocolHandlers: Record<string, ProtocolHandler> = {
    'ping'(request: ProtocolRequest): ProtocolResponse {
        const data = (request as Record<string, unknown>).data;
        return { data };
    },

    'change-public-keys'(request: ProtocolRequest, connection: ConnectionInfo): ProtocolResponse {
        const clientId = request.clientID;
        const version = request.version;
        let publicKeyStr = request.publicKey;

        if (!clientId || !publicKeyStr) {
            throw new Error('Missing clientID or publicKey');
        }

        if (connectedClients.has(clientId)) {
            throw new Error('Changing keys is not allowed');
        }

        // on web there can be only one connected client
        connectedClients.clear();

        const keys = tweetnaclBox.keyPair();
        const publicKey = new Uint8Array(kdbxweb.ByteUtils.base64ToBytes(publicKeyStr));

        const stats: ClientStats = {
            connectedDate: new Date(),
            passwordsRead: 0,
            passwordsWritten: 0
        };

        connectedClients.set(clientId, {
            connection,
            publicKey,
            version,
            keys,
            stats,
            handles: new Map()
        });

        Events.emit('browser-extension-sessions-changed');

        logger.info('New client key created', clientId, version);

        if (!request.nonce) {
            throw new Error('Empty nonce');
        }
        const nonceBytes = new Uint8Array(kdbxweb.ByteUtils.base64ToBytes(request.nonce));
        incrementNonce(nonceBytes);
        const nonce = kdbxweb.ByteUtils.bytesToBase64(nonceBytes);

        return {
            action: 'change-public-keys',
            version: getVersion(request),
            publicKey: kdbxweb.ByteUtils.bytesToBase64(keys.publicKey),
            nonce,
            success: 'true',
            ...(isKeeWebConnect(request) ? { appName: 'KeeWeb' } : undefined)
        };
    },

    async 'get-databasehash'(request: ProtocolRequest): Promise<ProtocolResponse> {
        decryptRequest(request);

        if (request.triggerUnlock) {
            await checkContentRequestPermissions(request);
        } else {
            ensureAtLeastOneFileIsOpen();
        }

        return encryptResponse(request, {
            hash: KeeWebHash,
            success: 'true',
            version: getVersion(request)
        });
    },

    'generate-password'(request: ProtocolRequest): ProtocolResponse {
        const password = PasswordGenerator.generate(
            { ...GeneratorPresets.browserExtensionPreset }
        );

        return encryptResponse(request, {
            version: getVersion(request),
            success: 'true',
            entries: [{ password }]
        });
    },

    'lock-database'(request: ProtocolRequest): ProtocolResponse {
        decryptRequest(request);
        ensureAtLeastOneFileIsOpen();

        Events.emit('lock-workspace');

        if (ui.isBusy()) {
            focusKeeWeb();
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request)
        });
    },

    'associate'(request: ProtocolRequest): ProtocolResponse {
        decryptRequest(request);
        ensureAtLeastOneFileIsOpen();

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            hash: KeeWebHash,
            id: KeeWebAssociationId
        });
    },

    'test-associate'(request: ProtocolRequest): ProtocolResponse {
        const payload = decryptRequest(request);
        // ensureAtLeastOneFileIsOpen();

        if (payload.id !== KeeWebAssociationId) {
            throw makeError(Errors.noOpenFiles);
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            hash: KeeWebHash,
            id: payload.id as string
        });
    },

    // ---- KeeWebX extension: pairing and entry lists ----
    // The extension proves it holds a long-term ed25519 identity key by
    // signing this session's two box public keys. Approvals are then stored
    // for that key rather than shared by every client.

    'kwx-pair'(request: ProtocolRequest): ProtocolResponse {
        const payload = decryptRequest(request);
        const client = getClient(request);
        const identity = String(payload.identityKey || '');
        const identityKey = kdbxweb.ByteUtils.base64ToBytes(identity);
        const signature = kdbxweb.ByteUtils.base64ToBytes(String(payload.signature || ''));
        const signed = new Uint8Array([
            ...new TextEncoder().encode(PAIRING_SIG_CONTEXT),
            ...client.publicKey,
            ...client.keys.publicKey
        ]);
        if (
            identityKey.length !== tweetnaclSign.publicKeyLength ||
            signature.length !== tweetnaclSign.signatureLength ||
            !tweetnaclSign.detached.verify(signed, signature, identityKey)
        ) {
            throw new Error('Bad pairing signature');
        }
        client.identity = identity;
        client.permissions = undefined;
        return encryptResponse(request, { success: 'true', known: !!getPairings()[identity] });
    },

    'kwx-features'(request: ProtocolRequest): ProtocolResponse {
        decryptRequest(request);
        const client = getClient(request);
        const permissions = client.identity ? getPairings()[client.identity]?.permissions : undefined;
        return encryptResponse(request, {
            features: ['entries-v1'],
            locked: !appModel.files.hasOpenFiles(),
            paired: !!client.identity,
            canList: !!permissions?.canList
        });
    },

    async 'kwx-get-entries'(request: ProtocolRequest): Promise<ProtocolResponse> {
        const payload = decryptRequest(request);
        const client = requirePairing(request);
        if (!appModel.files.hasOpenFiles()) {
            return encryptResponse(request, { locked: true, suggested: [], items: [] });
        }
        await checkContentRequestPermissions(request, { list: true });
        const files = getAvailableFiles(request);
        const { suggested, items } = listEntries(appModel, files, {
            url: payload.url ? String(payload.url) : undefined,
            query: payload.query ? String(payload.query) : undefined
        });
        const toWire = (entry: EntryModel) => ({ handle: issueHandle(client, entry), ...summarizeEntry(entry) });
        return encryptResponse(request, {
            locked: false,
            suggested: suggested.map(toWire),
            items: items.map(toWire)
        });
    },

    async 'kwx-get-entry-fields'(request: ProtocolRequest): Promise<ProtocolResponse> {
        const payload = decryptRequest(request);
        const client = requirePairing(request);
        ensureAtLeastOneFileIsOpen();
        if (!client.permissions?.canList) {
            throw makeError(Errors.userRejected);
        }
        const entry = resolveHandle(client, payload.handle);
        const wanted = Array.isArray(payload.fields) ? payload.fields.map(String) : [];
        const values: Record<string, string> = {};
        for (const field of wanted) {
            values[field] = await entryFieldText(entry, field);
        }
        if (wanted.includes('password')) {
            client.stats.passwordsRead++;
            Events.emit('browser-extension-sessions-changed');
        }
        return encryptResponse(request, { values });
    },

    async 'get-logins'(request: ProtocolRequest): Promise<ProtocolResponse> {
        const entry = await findEntry(request, true);

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            hash: KeeWebHash,
            count: 1,
            entries: [
                {
                    group: (entry.group as GroupModel).title,
                    login: entry.user || '',
                    name: entry.title || '',
                    password: entry.password?.getText() || '',
                    skipAutoSubmit: 'false',
                    stringFields: [],
                    uuid: kdbxweb.ByteUtils.bytesToHex(entry.entry.uuid.bytes)
                }
            ],
            id: ''
        });
    },

    async 'get-totp-by-url'(request: ProtocolRequest): Promise<ProtocolResponse> {
        const entry = await findEntry(request, true, { otp: true });

        entry.initOtpGenerator();

        if (!entry.otpGenerator) {
            throw makeError(Errors.noMatches);
        }

        // Device-backed entries are optional extensions of the shared EntryModel.
        const touchEntry = entry as EntryModel & { needsTouch?: boolean; device?: { shortName: string } };
        const controller = new AbortController();
        let touch: ReturnType<ProtocolUi['showTouch']> | undefined;
        let totp: string;
        try {
            totp = await new Promise<string>((resolve, reject) => {
                if (touchEntry.needsTouch) {
                    touch = ui.showTouch({ deviceShortName: touchEntry.device!.shortName },
                        () => reject(makeError(Errors.userRejected)), controller.signal);
                }
                entry.otpGenerator!.next((err, otp) => {
                    if (otp) resolve(otp);
                    else reject(err || makeError(Errors.userRejected));
                });
            });
        } finally {
            touch?.dispose();
            controller.abort();
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            totp
        });
    },

    async 'get-any-field'(request: ProtocolRequest): Promise<ProtocolResponse> {
        const entry = await findEntry(request, false);

        const field = await promptWithTimeout((signal) => ui.selectField({ entry }, signal));
        if (!field) throw makeError(Errors.userRejected);

        let value = entry.getAllFields()[field];
        if (value instanceof kdbxweb.ProtectedValue) {
            value = value.getText();
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            field,
            value
        });
    },

    async 'get-totp'(request: ProtocolRequest): Promise<ProtocolResponse> {
        decryptRequest(request);
        await checkContentRequestPermissions(request);

        throw new Error('Not implemented');
    },

    async 'set-login'(request: ProtocolRequest): Promise<ProtocolResponse> {
        const payload = decryptRequest(request);
        await checkContentRequestPermissions(request);

        focusKeeWeb();

        if (!payload.url) {
            throw new Error('Empty url');
        }
        const url = new URL(payload.url as string);

        const files = getAvailableFiles(request);
        if (!files) {
            throw makeError(Errors.noOpenFiles);
        }
        const client = getClient(request);

        let selectedGroup: GroupModel | undefined;

        let entryToUpdate: EntryModel | undefined;
        if (payload.uuid) {
            for (const file of files) {
                const entryId = kdbxweb.ByteUtils.bytesToBase64(
                    kdbxweb.ByteUtils.hexToBytes(payload.uuid as string)
                );
                const foundEntry = file.getEntry(file.subId(entryId));
                if (foundEntry) {
                    if (entryToUpdate) {
                        throw new Error('Two entries with the same ID found');
                    } else {
                        entryToUpdate = foundEntry;
                        selectedGroup = foundEntry.group as GroupModel;
                    }
                }
            }
            if (!entryToUpdate) {
                throw new Error('Updated entry not found');
            }
        }

        const perms = client.permissions;
        if (perms?.askSave === 'auto' && perms.saveTo && !selectedGroup) {
            const saveTo = perms.saveTo;
            const file = files.find((f) => f.id === saveTo.fileId);
            selectedGroup = file?.getGroup(saveTo.groupId);
        }

        if (perms?.askSave !== 'auto' || !selectedGroup) {
            const saveConfig = runtimeData.extensionSaveConfig;
            if (!selectedGroup && saveConfig) {
                const file = files.find(
                    (f) => f.id === saveConfig.fileId
                );
                selectedGroup = file?.getGroup(saveConfig.groupId);
            }

            const allGroups: SaveGroupChoice[] = [];
            for (const file of files) {
                file.forEachGroup((group: GroupModel) => {
                    const spaces: string[] = [];
                    for (let parent = group; parent.parentGroup; parent = parent.parentGroup) {
                        spaces.push(' ', ' ');
                    }

                    if (
                        !selectedGroup &&
                        group.iconId === ExtensionGroupIconId &&
                        ExtensionGroupNames.has(group.title)
                    ) {
                        selectedGroup = group;
                    }

                    allGroups.push({
                        id: group.id,
                        fileId: file.id,
                        spaces,
                        title: group.title,
                        selected: group.id === selectedGroup?.id
                    });
                });
            }
            if (!selectedGroup) {
                allGroups.splice(1, 0, {
                    id: '',
                    fileId: files[0].id,
                    spaces: [' ', ' '],
                    title: `${DefaultExtensionGroupName} (${loc['extensionSaveEntryNewGroup']})`,
                    selected: true
                });
            }

            const config = { ...await promptWithTimeout((signal) => ui.saveEntry({
                extensionName: getHumanReadableExtensionName(client),
                url: payload.url as string,
                user: payload.login as string | undefined,
                askSave: saveConfig?.askSave || 'always',
                update: !!entryToUpdate,
                allGroups
            }, signal)) };
            if (!entryToUpdate) {
                if (config.groupId) {
                    const file = files.find((f) => f.id === config.fileId);
                    selectedGroup = file?.getGroup(config.groupId);
                } else {
                    selectedGroup = appModel.createNewGroupWithName(
                        files[0].groups[0],
                        files[0],
                        DefaultExtensionGroupName
                    );
                    selectedGroup.setIcon(ExtensionGroupIconId);
                    config.groupId = selectedGroup.id;
                }

                runtimeData.extensionSaveConfig = config;
                if (client.permissions) {
                    client.permissions.saveTo = {
                        fileId: config.fileId,
                        groupId: config.groupId
                    };
                }
            }

            if (client.permissions) {
                client.permissions.askSave = config.askSave;
            }
        }

        const entryFields: Record<string, string | kdbxweb.ProtectedValue> = {
            Title: url.hostname,
            UserName: (payload.login as string) || '',
            Password: kdbxweb.ProtectedValue.fromString((payload.password as string) || ''),
            URL: payload.url as string
        };

        if (entryToUpdate) {
            for (const [field, value] of Object.entries(entryFields)) {
                if (value) {
                    entryToUpdate.setField(field, value);
                }
            }
        } else {
            if (!selectedGroup) throw new Error('Selected group not found');
            appModel.createNewEntryWithFields(selectedGroup, entryFields);
        }

        client.stats.passwordsWritten++;

        Events.emit('browser-extension-sessions-changed');
        Events.emit('refresh');

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            count: null,
            entries: null,
            hash: KeeWebHash
        });
    },

    async 'get-database-groups'(request: ProtocolRequest): Promise<ProtocolResponse> {
        decryptRequest(request);
        await checkContentRequestPermissions(request);

        interface GroupTreeNode {
            name: string;
            uuid: string;
            children: GroupTreeNode[];
        }

        const makeGroups = (group: GroupModel): GroupTreeNode => {
            const res: GroupTreeNode = {
                name: group.title,
                uuid: kdbxweb.ByteUtils.bytesToHex(group.group.uuid.bytes),
                children: []
            };
            for (const subGroup of group.items as unknown as GroupCollection) {
                if (subGroup.matches()) {
                    res.children.push(makeGroups(subGroup));
                }
            }
            return res;
        };

        const groups: GroupTreeNode[] = [];
        const availableFiles = getAvailableFiles(request);
        if (availableFiles) {
            for (const file of availableFiles) {
                for (const group of file.groups) {
                    groups.push(makeGroups(group));
                }
            }
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            groups: { groups }
        });
    },

    async 'create-new-group'(request: ProtocolRequest): Promise<ProtocolResponse> {
        const payload = decryptRequest(request);
        await checkContentRequestPermissions(request);

        if (!payload.groupName) {
            throw new Error('No groupName');
        }

        const groupNames = (payload.groupName as string)
            .split('/')
            .map((g: string) => g.trim())
            .filter((g: string) => g);

        if (!groupNames.length) {
            throw new Error('Empty group path');
        }

        const files = getAvailableFiles(request);
        if (!files) {
            throw makeError(Errors.noOpenFiles);
        }

        for (const file of files) {
            for (const rootGroup of file.groups) {
                let foundGroup: GroupModel | undefined = rootGroup;
                const pendingGroups = [...groupNames];
                while (pendingGroups.length && foundGroup) {
                    const title = pendingGroups.shift()!;
                    foundGroup = (foundGroup.items as unknown as GroupCollection).find((g) => g.title === title);
                }
                if (foundGroup) {
                    return encryptResponse(request, {
                        success: 'true',
                        version: getVersion(request),
                        name: foundGroup.title,
                        uuid: kdbxweb.ByteUtils.bytesToHex(foundGroup.group.uuid.bytes)
                    });
                }
            }
        }

        const client = getClient(request);
        const selectedFileId = await promptWithTimeout((signal) => ui.createGroup({
            extensionName: getHumanReadableExtensionName(client),
            groupPath: groupNames.join(' / '),
            files: files.map((f, ix) => ({
                id: f.id,
                name: f.name,
                selected: ix === 0
            }))
        }, signal));

        const selectedFile = files.find((f) => f.id === selectedFileId);
        if (!selectedFile) {
            throw new Error('Selected file not found');
        }

        let newGroup: GroupModel = selectedFile.groups[0];
        const pendingGroups = [...groupNames];

        while (pendingGroups.length) {
            const title = pendingGroups.shift()!;
            const item = (newGroup.items as unknown as GroupCollection).find((g) => g.title === title);
            if (item) {
                newGroup = item;
            } else {
                newGroup = appModel.createNewGroupWithName(newGroup, selectedFile, title);
            }
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            name: newGroup.title,
            uuid: kdbxweb.ByteUtils.bytesToHex(newGroup.group.uuid.bytes)
        });
    }
};

const ProtocolImpl = {
    init(vars: ProtocolInitVars): void {
        if (!vars.ui) throw new Error('Protocol UI is required');
        appModel = vars.appModel;
        ui = vars.ui;
        logger = vars.logger;
        sendEvent = vars.sendEvent;

        setupListeners();
    },

    cleanup(): void {
        const wasNotEmpty = connectedClients.size;

        connectedClients.clear();

        if (wasNotEmpty) {
            Events.emit('browser-extension-sessions-changed');
        }
    },

    deleteConnection(connectionId: number): void {
        for (const [clientId, client] of connectedClients.entries()) {
            if (client.connection.connectionId === connectionId) {
                connectedClients.delete(clientId);
            }
        }
        Events.emit('browser-extension-sessions-changed');
    },

    getClientPermissions(clientId: string): ClientPermissions | undefined {
        return connectedClients.get(clientId)?.permissions;
    },

    setClientPermissions(clientId: string, permissions: Partial<ClientPermissions>): void {
        const client = connectedClients.get(clientId);
        if (client?.permissions) {
            client.permissions = { ...client.permissions, ...permissions };
        }
    },

    errorToResponse(e: CodedError, request: ProtocolRequest | undefined): ProtocolResponse {
        return {
            action: request?.action,
            error: e.message || 'Unknown error',
            errorCode: e.code || 0
        };
    },

    async handleRequest(
        request: ProtocolRequest,
        connectionInfo: ConnectionInfo
    ): Promise<ProtocolResponse> {
        let result: ProtocolResponse;
        try {
            const handler = ProtocolHandlers[request.action];
            if (!handler) {
                throw new Error(`Handler not found: ${request.action}`);
            }
            result = await handler(request, connectionInfo);
            if (!result) {
                throw new Error(`Handler returned an empty result: ${request.action}`);
            }
        } catch (e) {
            const err = e as CodedError;
            if (!err.code) {
                logger.error(`Error in handler ${request.action}`, e);
            }
            result = this.errorToResponse(err, request);
        }

        return result;
    },

    get sessions() {
        return [...connectedClients.entries()]
            .map(([clientId, client]) => ({
                clientId,
                connectionId: client.connection.connectionId,
                appName: client.connection.appName,
                extensionName: client.connection.extensionName,
                connectedDate: client.stats.connectedDate,
                passwordsRead: client.stats.passwordsRead,
                passwordsWritten: client.stats.passwordsWritten,
                permissions: client.permissions,
                permissionsDenied: client.permissionsDenied
            }))
            .sort((x, y) => y.connectedDate.getTime() - x.connectedDate.getTime());
    }
};

export { ProtocolImpl };
