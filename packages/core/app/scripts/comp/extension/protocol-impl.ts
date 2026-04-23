import * as kdbxweb from 'kdbxweb';
import { Events } from 'framework/events';
import { box as tweetnaclBox } from 'tweetnacl';
import { PasswordGenerator } from 'util/generators/password-generator';
import { GeneratorPresets } from 'comp/app/generator-presets';
import { Alerts } from 'comp/ui/alerts';
import { Locale } from 'util/locale';
import { RuntimeInfo } from 'const/runtime-info';
import { KnownAppVersions } from 'const/known-app-versions';
import { ExtensionConnectView } from 'views/extension/extension-connect-view';
import { ExtensionCreateGroupView } from 'views/extension/extension-create-group-view';
import { ExtensionSaveEntryView } from 'views/extension/extension-save-entry-view';
import { RuntimeDataModel } from 'models/runtime-data-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { Timeouts } from 'const/timeouts';
import { SelectEntryView } from 'views/select/select-entry-view';
import { SelectEntryFieldView } from 'views/select/select-entry-field-view';
import { SelectEntryFilter } from 'comp/app/select-entry-filter';
import type { Logger } from 'util/logger';

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
    [key: string]: unknown;
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
}

interface ErrorDef {
    message: string;
    code: string;
}

// Error with optional protocol error code attached
interface CodedError extends Error {
    code?: string | number;
}

interface ProtocolInitVars {
    appModel: unknown;
    logger: Logger;
    sendEvent: (data: ProtocolResponse) => void;
}

// Loose alias for the appModel / view shapes consumed by this module.
// Using an `any` escape hatch here keeps the file out of strict-mode
// failures without deeply coupling to AppModel internals.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAppModel = any;

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
    }
};

const connectedClients = new Map<string, ClientState>();

let logger: Logger;
let appModel: AnyAppModel;
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
    // Nonce increment bug (2026-04-09 warroom root cause of the entire
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

async function checkContentRequestPermissions(request: ProtocolRequest): Promise<void> {
    if (!appModel.files.hasOpenFiles()) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((AppSettingsModel as any).extensionFocusIfLocked) {
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
    if (client.permissions) {
        return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const config = (RuntimeDataModel as any).extensionConnectConfig as
        | { allFiles?: boolean; files?: string[]; askGet?: string }
        | undefined;

    // MV3 service workers restart frequently, generating a new clientId each
    // time.  If the user already approved a prior session, reuse that config
    // instead of prompting again on every reconnect.
    if (config) {
        client.permissions = config;
        Events.emit('browser-extension-sessions-changed');
        return;
    }

    if (Alerts.alertDisplayed) {
        throw new Error(loc['extensionErrorAlertDisplayed']);
    }

    focusKeeWeb();

    const files = appModel.files.map((f: AnyAppModel) => ({
        id: f.id,
        name: f.name,
        checked: true
    }));

    const extensionConnectView = new ExtensionConnectView({
        extensionName: getHumanReadableExtensionName(client),
        identityVerified: true,
        files,
        allFiles: true,
        askGet: 'multiple'
    } as unknown as Record<string, unknown>) as AnyAppModel;

    try {
        await alertWithTimeout({
            header: loc['extensionConnectHeader'],
            icon: 'exchange-alt',
            buttons: [Alerts.buttons.allow, Alerts.buttons.deny],
            view: extensionConnectView,
            wide: true,
            opaque: true
        });
    } catch (e) {
        client.permissionsDenied = true;
        Events.emit('browser-extension-sessions-changed');
        throw e;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (RuntimeDataModel as any).extensionConnectConfig = extensionConnectView.config;
    client.permissions = extensionConnectView.config;
    Events.emit('browser-extension-sessions-changed');
}

interface AlertWithTimeoutConfig {
    header?: string;
    icon?: string;
    buttons?: Array<{ result: string; title: string }>;
    view?: unknown;
    wide?: boolean;
    opaque?: boolean;
}

function alertWithTimeout(config: AlertWithTimeoutConfig): Promise<string> {
    return new Promise<string>((resolve, reject) => {
        let inactivityTimer: ReturnType<typeof setTimeout> | 0 = 0;

        const alert = Alerts.alert({
            ...config,
            enter: 'yes',
            esc: '',
            success: (res: string) => {
                if (inactivityTimer) clearTimeout(inactivityTimer);
                resolve(res);
            },
            cancel: () => {
                if (inactivityTimer) clearTimeout(inactivityTimer);
                reject(makeError(Errors.userRejected));
            }
        }) as AnyAppModel;

        inactivityTimer = setTimeout(() => {
            alert?.closeWithResult?.('');
        }, Timeouts.KeeWebConnectRequest);
    });
}

function getAvailableFiles(request: ProtocolRequest): AnyAppModel[] | undefined {
    const client = getClient(request);
    if (!client.permissions) {
        return undefined;
    }
    const perms = client.permissions;

    const files = appModel.files.filter(
        (file: AnyAppModel) =>
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
): Promise<AnyAppModel> {
    const payload = decryptRequest(request);
    await checkContentRequestPermissions(request);

    if (!payload.url) {
        throw new Error('Empty url');
    }

    const files = getAvailableFiles(request);
    const client = getClient(request);

    const filter = new SelectEntryFilter(
        { url: payload.url as string, title: payload.title as string },
        appModel,
        files,
        filterOptions ?? {}
    ) as AnyAppModel;
    filter.subdomains = false;

    let entries = filter.getEntries() as AnyAppModel[];

    filter.subdomains = true;

    let entry: AnyAppModel;

    if (entries.length) {
        if (
            entries.length === 1 &&
            returnIfOneMatch &&
            client.permissions?.askGet === 'multiple'
        ) {
            entry = entries[0];
        }
    } else {
        entries = filter.getEntries() as AnyAppModel[];

        if (!entries.length) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            if ((AppSettingsModel as any).extensionFocusIfEmpty) {
                filter.useUrl = false;
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                if (filter.title && (AppSettingsModel as any).autoTypeTitleFilterEnabled) {
                    filter.useTitle = true;
                    entries = filter.getEntries() as AnyAppModel[];
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
        const selectEntryView = new SelectEntryView({
            filter,
            topMessage
        } as unknown as Record<string, unknown>) as AnyAppModel;

        focusKeeWeb();

        const inactivityTimer = setTimeout(() => {
            selectEntryView.emit('result', undefined);
        }, Timeouts.KeeWebConnectRequest);

        const result = await selectEntryView.showAndGetResult();

        clearTimeout(inactivityTimer);

        entry = result?.entry;
        if (!entry) {
            throw makeError(Errors.userRejected);
        }
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

        connectedClients.set(clientId, { connection, publicKey, version, keys, stats });

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
            (GeneratorPresets as AnyAppModel).browserExtensionPreset
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

        if (Alerts.alertDisplayed) {
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

    async 'get-logins'(request: ProtocolRequest): Promise<ProtocolResponse> {
        const entry = await findEntry(request, true);

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            hash: KeeWebHash,
            count: 1,
            entries: [
                {
                    group: entry.group.title,
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

        let selectEntryFieldView: AnyAppModel;
        if (entry.needsTouch) {
            selectEntryFieldView = new SelectEntryFieldView({
                needsTouch: true,
                deviceShortName: entry.device.shortName
            } as unknown as Record<string, unknown>);
            selectEntryFieldView.render();
        }

        const otpPromise = new Promise<string>((resolve, reject) => {
            selectEntryFieldView?.on('result', () => reject(makeError(Errors.userRejected)));
            entry.otpGenerator.next((err: unknown, otp: string) => {
                if (otp) {
                    resolve(otp);
                } else {
                    reject(err || makeError(Errors.userRejected));
                }
            });
        });

        let totp: string;
        try {
            totp = await otpPromise;
        } finally {
            selectEntryFieldView?.remove();
        }

        return encryptResponse(request, {
            success: 'true',
            version: getVersion(request),
            totp
        });
    },

    async 'get-any-field'(request: ProtocolRequest): Promise<ProtocolResponse> {
        const entry = await findEntry(request, false);

        const selectEntryFieldView = new SelectEntryFieldView({
            entry
        } as unknown as Record<string, unknown>) as AnyAppModel;
        const inactivityTimer = setTimeout(() => {
            selectEntryFieldView.emit('result', undefined);
        }, Timeouts.KeeWebConnectRequest);

        const field = await selectEntryFieldView.showAndGetResult();

        clearTimeout(inactivityTimer);

        if (!field) {
            throw makeError(Errors.userRejected);
        }

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

        let selectedGroup: AnyAppModel | undefined;

        let entryToUpdate: AnyAppModel | undefined;
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
                        selectedGroup = foundEntry.group;
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
            const file = files.find((f: AnyAppModel) => f.id === saveTo.fileId);
            selectedGroup = file?.getGroup(saveTo.groupId);
        }

        if (perms?.askSave !== 'auto' || !selectedGroup) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const saveConfig = (RuntimeDataModel as any).extensionSaveConfig as
                | { fileId: string; groupId: string; askSave?: string }
                | undefined;
            if (!selectedGroup && saveConfig) {
                const file = files.find(
                    (f: AnyAppModel) => f.id === saveConfig.fileId
                );
                selectedGroup = file?.getGroup(saveConfig.groupId);
            }

            interface GroupListItem {
                id: string;
                fileId: string;
                spaces: string[];
                title: string;
                selected: boolean;
            }
            const allGroups: GroupListItem[] = [];
            for (const file of files) {
                file.forEachGroup((group: AnyAppModel) => {
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

            const saveEntryView = new ExtensionSaveEntryView({
                extensionName: getHumanReadableExtensionName(client),
                url: payload.url,
                user: payload.login,
                askSave: saveConfig?.askSave || 'always',
                update: !!entryToUpdate,
                allGroups
            }) as unknown as AnyAppModel;

            await alertWithTimeout({
                header: loc['extensionSaveEntryHeader'],
                icon: 'plus',
                buttons: [Alerts.buttons.allow, Alerts.buttons.deny],
                view: saveEntryView
            });

            const config = { ...saveEntryView.config };
            if (!entryToUpdate) {
                if (config.groupId) {
                    const file = files.find((f: AnyAppModel) => f.id === config.fileId);
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

                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                (RuntimeDataModel as any).extensionSaveConfig = config;
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

        const makeGroups = (group: AnyAppModel): GroupTreeNode => {
            const res: GroupTreeNode = {
                name: group.title,
                uuid: kdbxweb.ByteUtils.bytesToHex(group.group.uuid.bytes),
                children: []
            };
            for (const subGroup of group.items) {
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
                let foundGroup: AnyAppModel | undefined = rootGroup;
                const pendingGroups = [...groupNames];
                while (pendingGroups.length && foundGroup) {
                    const title = pendingGroups.shift();
                    foundGroup = foundGroup.items.find((g: AnyAppModel) => g.title === title);
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
        const createGroupView = new ExtensionCreateGroupView({
            extensionName: getHumanReadableExtensionName(client),
            groupPath: groupNames.join(' / '),
            files: files.map((f: AnyAppModel, ix: number) => ({
                id: f.id,
                name: f.name,
                selected: ix === 0
            }))
        }) as unknown as AnyAppModel;

        await alertWithTimeout({
            header: loc['extensionNewGroupHeader'],
            icon: 'folder-plus',
            buttons: [Alerts.buttons.allow, Alerts.buttons.deny],
            view: createGroupView
        });

        const selectedFile = files.find(
            (f: AnyAppModel) => f.id === createGroupView.selectedFile
        );
        if (!selectedFile) {
            throw new Error('Selected file not found');
        }

        let newGroup: AnyAppModel = selectedFile.groups[0];
        const pendingGroups = [...groupNames];

        while (pendingGroups.length) {
            const title = pendingGroups.shift();
            const item = newGroup.items.find((g: AnyAppModel) => g.title === title);
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
        appModel = vars.appModel;
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
