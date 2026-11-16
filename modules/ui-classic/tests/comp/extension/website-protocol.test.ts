import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { sign } from 'tweetnacl';
import type { AppModel } from 'models/app-model';
import type { ProtocolUi } from '../../../../vault/src/comp/extension/protocol-ui';
import type { ConnectionInfo, ProtocolRequest, ProtocolResponse } from '../../../../vault/src/comp/extension/protocol-impl';
import type { KeeWebConnectResponse } from '../../../../extension/src/background/protocol/types';

// The Classic runner starts each spec in its own process. Only App dependencies
// are replaced: matching, listing, handles, access policy and both NaCl protocol
// implementations below are production code. There is no client-side matcher.
const runtimeData: Record<string, unknown> = {};
mock.module('comp/app/generator-presets', () => ({ GeneratorPresets: { browserExtensionPreset: {} } }));
mock.module('util/generators/password-generator', () => ({ PasswordGenerator: { generate: () => 'unused' } }));
mock.module('models/runtime-data-model', () => ({ RuntimeDataModel: runtimeData }));
mock.module('models/app-settings-model', () => ({ AppSettingsModel: {} }));
mock.module('comp/settings/settings-store', () => ({ SettingsStore: { saveRequired: async () => {} } }));
mock.module('util/locale', () => ({ Locale: {
    extensionErrorNoOpenFiles: 'No files are open',
    extensionErrorUserRejected: 'Rejected by user',
    extensionErrorNoMatches: 'No matches found'
} }));

// Ranking's browser debug export and comparator detection need only a window
// during import; the protocol itself does not need a DOM.
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
if (!previousWindow) Object.defineProperty(globalThis, 'window', { value: {}, configurable: true });
const { ProtocolImpl: appProtocol } = await import('../../../app/scripts/comp/extension/protocol-impl');
const { createClassicProtocolAccess } = await import('../../../../vault/src/comp/extension/protocol-access');
const { Model } = await import('framework/model');
if (!previousWindow) Reflect.deleteProperty(globalThis, 'window');
const { ProtocolImpl: ClientProtocol } = await import('../../../../extension/src/background/protocol/protocol-impl');
const kdbx = await import('kdbxweb');

class FixtureEntry extends Model {}
FixtureEntry.defineModelProperties({}, { extensions: true });

const ORIGIN = 'https://login.example.org';
const OTHER_ORIGIN = 'https://wrong.example.com';
const clientRuntime = { getVersion: () => '1.0.0', getMessage: (key: string) => key, allowDebug: false };
const logger = { debug() {}, info() {}, warn() {}, error() {} };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function fixture() {
    const entries = new Map<string, ReturnType<typeof makeEntry>>();
    const file = { id: 'f1', name: 'Allowed vault', active: true, db: {},
        getEntry: (id: string) => entries.get(id) };
    const otherFile = { id: 'f2', name: 'Unapproved vault', active: true, db: {},
        getEntry: (id: string) => entries.get(id) };
    function makeEntry(id: string, title: string, url: string, extraUrls: string[] = [], owner = file) {
        return Object.assign(new FixtureEntry(), {
            id, title, url, extraUrls, file: owner, user: id + '-user',
            password: kdbx.ProtectedValue.fromString(id + '-secret'),
            entry: {}, updated: new Date(2026, 0, 1), iconId: 0, icon: 'key',
            customIcon: null, fields: {}, searchText: `${title} ${url}`.toLowerCase(),
            getAllUrls() { return [this.url, ...this.extraUrls]; },
            initOtpGenerator() {},
            otpGenerator: null as null | { next(callback: (error: Error | null, value?: string) => void): void }
        });
    }
    const direct = makeEntry('direct', 'Direct account', ORIGIN + '/login');
    const extra = makeEntry('extra', 'Extra URL account', OTHER_ORIGIN + '/primary', [ORIGIN + '/secondary']);
    const unrelated = makeEntry('unrelated', 'Unrelated account', OTHER_ORIGIN + '/login');
    const unapproved = makeEntry('unapproved', 'Unapproved account', ORIGIN + '/login', [], otherFile);
    for (const entry of [direct, extra, unrelated, unapproved]) entries.set(entry.id, entry);
    const files = Object.assign([file, otherFile], {
        hasOpenFiles: () => [file, otherFile].some(item => item.active),
        get: (id: string) => [file, otherFile].find(item => item.id === id)
    });
    const model = {
        files,
        getEntriesByFilter: ({ text = '' }: { text?: string }, allowed: typeof files) =>
            [...entries.values()].filter(entry => allowed.includes(entry.file) &&
                `${entry.title} ${entry.user} ${entry.getAllUrls().join(' ')}`.toLowerCase().includes(text.toLowerCase()))
    };
    const ui: ProtocolUi = {
        isBusy: () => false,
        connect: mock(async () => null),
        selectEntry: mock(async () => null),
        selectField: async () => null,
        saveEntry: async () => null,
        createGroup: async () => null,
        showTouch: (_input, cancel) => { cancel(); return { dispose() {} }; }
    };
    const appModel = model as unknown as AppModel;
    appProtocol.init({ appModel, access: createClassicProtocolAccess(appModel), ui,
        logger: logger as Parameters<typeof appProtocol.init>[0]['logger'], sendEvent() {} });
    return { direct, extra, unrelated, unapproved, file, otherFile, ui };
}

async function connect(websiteOrigin: string | undefined = ORIGIN, scoped = true) {
    const connection: ConnectionInfo = { connectionId: 1, extensionName: 'KeeWeb Connect',
        ...(scoped ? { websiteOrigin } : {}) };
    let requestConnection = connection;
    const requests: ProtocolRequest[] = [];
    const responses: ProtocolResponse[] = [];
    // A test may pause after the handler but before the connector's final check.
    let beforeDelivery: (() => void) | undefined;
    const client = new ClientProtocol({ request: async request => {
        requests.push(request);
        const result = await appProtocol.handleRequest(request, requestConnection);
        beforeDelivery?.(); beforeDelivery = undefined;
        const response = appProtocol.prepareResponse(result);
        responses.push(response);
        return response as unknown as KeeWebConnectResponse;
    } }, clientRuntime);
    await client.ping();
    await client.changePublicKeys();
    const identity = sign.keyPair();
    runtimeData.extensionPairings = {
        [kdbx.ByteUtils.bytesToBase64(identity.publicKey)]: { created: '2026-11-16',
            permissions: { allFiles: false, files: ['f1'], canList: true } }
    };
    expect(await client.pair(identity)).toBe(true);
    return { client, connection, requests, responses,
        setConnection(value: ConnectionInfo) { requestConnection = value; },
        beforeDelivery(callback: () => void) { beforeDelivery = callback; }
    };
}

async function expectDenied(operation: Promise<unknown>, session: Awaited<ReturnType<typeof connect>>, code?: string) {
    await expect(operation).rejects.toThrow();
    const response = session.responses.at(-1)!;
    expect(response.error).toBeTruthy();
    if (code) expect(String(response.errorCode)).toBe(code);
    expect(response.message).toBeUndefined();
    expect(response.values).toBeUndefined();
    expect(JSON.stringify(response)).not.toMatch(/direct-secret|extra-secret|unrelated-secret/);
}

describe('App-authoritative website protocol over the real encrypted client', () => {
    beforeEach(() => {
        appProtocol.cleanup();
        for (const key of Object.keys(runtimeData)) delete runtimeData[key];
    });
    afterEach(() => appProtocol.cleanup());

    test('scoped listing ignores crafted URL and query, exposes no general items, and supports extra URLs', async () => {
        const f = fixture();
        const session = await connect();
        const features = await session.client.features();
        expect(features.features).toContain('website-matching-v1');
        expect(features.websiteOrigin).toBe(ORIGIN);
        for (const [url, query] of [[OTHER_ORIGIN, 'Unrelated'], [undefined, undefined],
            [ORIGIN, 'no entry has this text']] as const) {
            const list = await session.client.getEntries(url, query);
            expect(list.locked).toBe(false);
            expect(list.suggested.map(entry => entry.title).sort()).toEqual(['Direct account', 'Extra URL account']);
            expect(list.items).toEqual([]);
            expect(JSON.stringify(list)).not.toMatch(/Unrelated account|Unapproved account|direct-secret|extra-secret/);
            const extra = list.suggested.find(entry => entry.title === f.extra.title)!;
            // The client receives the primary URL, which intentionally differs
            // from the website. Only the App can know the matching extra URL.
            expect(extra.url).toBe(f.extra.url);
            expect(await session.client.getEntryFields(extra.handle, ['user', 'password']))
                .toEqual({ user: 'extra-user', password: 'extra-secret' });
        }
        expect(f.ui.connect).not.toHaveBeenCalled();
        expect(f.ui.selectEntry).not.toHaveBeenCalled();
    });

    test('a website with no matching entries cannot query the generic vault list', async () => {
        fixture();
        const session = await connect('https://no-match.example.test');
        const list = await session.client.getEntries(OTHER_ORIGIN, 'Unrelated');
        expect(list).toMatchObject({ locked: false, suggested: [], items: [] });
    });

    test('raw entry IDs and unrelated entry IDs cannot be used as handles', async () => {
        const f = fixture();
        const session = await connect();
        await session.client.getEntries(ORIGIN, undefined);
        for (const handle of [f.unrelated.id, f.direct.id, 'crafted-handle']) {
            await expectDenied(session.client.getEntryFields(handle, ['password']), session, 'kwx-expired-handle');
        }
        expect(appProtocol.sessions[0].passwordsRead).toBe(0);
    });

    test('a formerly valid handle fails after an in-place primary URL edit', async () => {
        const f = fixture();
        const session = await connect();
        const list = await session.client.getEntries(ORIGIN, undefined);
        const handle = list.suggested.find(entry => entry.title === f.direct.title)!.handle;
        expect(await session.client.getEntryFields(handle, ['password'])).toEqual({ password: 'direct-secret' });
        const object = f.direct.entry;
        f.direct.url = OTHER_ORIGIN;
        expect(f.direct.entry).toBe(object);
        await expectDenied(session.client.getEntryFields(handle, ['password']), session, 'kwx-website-mismatch');
        expect(appProtocol.sessions[0].passwordsRead).toBe(1);
        expect((await session.client.getEntries(ORIGIN, undefined)).suggested.map(entry => entry.title))
            .toEqual(['Extra URL account']);
    });

    test('removing the matching extra URL invalidates an existing handle', async () => {
        const f = fixture();
        const session = await connect();
        const list = await session.client.getEntries(ORIGIN, undefined);
        const handle = list.suggested.find(entry => entry.title === f.extra.title)!.handle;
        f.extra.extraUrls.length = 0;
        await expectDenied(session.client.getEntryFields(handle, ['user', 'password']), session, 'kwx-website-mismatch');
    });

    test('URL changes during an asynchronous field read suppress the entire response', async () => {
        const f = fixture();
        const session = await connect();
        const list = await session.client.getEntries(ORIGIN, undefined);
        const handle = list.suggested.find(entry => entry.title === f.direct.title)!.handle;
        const started = deferred<void>();
        let finish!: (error: Error | null, value?: string) => void;
        f.direct.otpGenerator = { next(callback) { finish = callback; started.resolve(); } };
        const pending = session.client.getEntryFields(handle, ['password', 'otp']);
        // Consume rejection while arranging the fault. Bun's rejects matcher
        // waits synchronously, so invoke it only after releasing the callback.
        const settled = pending.then(() => {}, () => {});
        await started.promise;
        f.direct.url = OTHER_ORIGIN;
        finish(null, '123456');
        await settled;
        await expectDenied(pending, session, 'kwx-website-mismatch');
        expect(appProtocol.sessions[0].passwordsRead).toBe(0);
    });

    test('the final prepareResponse check catches a URL edit after encryption', async () => {
        const f = fixture();
        const session = await connect();
        const list = await session.client.getEntries(ORIGIN, undefined);
        const handle = list.suggested.find(entry => entry.title === f.direct.title)!.handle;
        session.beforeDelivery(() => { f.direct.url = OTHER_ORIGIN; });
        await expectDenied(session.client.getEntryFields(handle, ['password']), session, 'kwx-website-mismatch');
    });

    for (const permissions of [{ canList: false }, { files: ['f2'] }]) {
        test(`permission reduction ${JSON.stringify(permissions)} denies an issued handle`, async () => {
            fixture();
            const session = await connect();
            const handle = (await session.client.getEntries(ORIGIN, undefined)).suggested[0].handle;
            appProtocol.setClientPermissions(appProtocol.sessions[0].clientId, permissions);
            await expectDenied(session.client.getEntryFields(handle, ['password']), session);
            expect(appProtocol.sessions[0].passwordsRead).toBe(0);
        });
    }

    test('changing or omitting connection origin cannot downgrade an established website session', async () => {
        fixture();
        const session = await connect();
        const handle = (await session.client.getEntries(ORIGIN, undefined)).suggested[0].handle;
        for (const connection of [{ ...session.connection, websiteOrigin: OTHER_ORIGIN },
            { connectionId: 1, extensionName: 'KeeWeb Connect' },
            { ...session.connection, connectionId: 2 }]) {
            session.setConnection(connection);
            await expectDenied(session.client.getEntryFields(handle, ['password']), session, '6');
        }
        session.setConnection(session.connection);
        expect((await session.client.features()).websiteOrigin).toBe(ORIGIN);
    });

    test('the handshake snapshots connection metadata instead of retaining a mutable origin reference', async () => {
        fixture();
        const session = await connect();
        session.connection.websiteOrigin = OTHER_ORIGIN;
        session.setConnection({ ...session.connection, websiteOrigin: ORIGIN });
        expect((await session.client.features()).websiteOrigin).toBe(ORIGIN);
        const list = await session.client.getEntries(OTHER_ORIGIN, 'Unrelated');
        expect(list.suggested.map(entry => entry.title).sort()).toEqual(['Direct account', 'Extra URL account']);
        expect(list.items).toEqual([]);
    });

    test('a real unrelated handle from an unscoped session is rejected after a website handshake', async () => {
        fixture();
        const generic = await connect(undefined, false);
        const list = await generic.client.getEntries(undefined, 'Unrelated');
        const handle = list.items[0].handle;
        const website = await connect();
        await website.client.getEntries(ORIGIN, undefined);
        await expectDenied(website.client.getEntryFields(handle, ['password']), website, 'kwx-expired-handle');
    });

    test('website sessions cannot bypass handles through legacy field commands', async () => {
        fixture();
        const session = await connect();
        await session.client.getEntries(ORIGIN, undefined);
        await expectDenied(session.client.getAnyField(OTHER_ORIGIN, 'Unrelated account'), session, '6');
    });

    test('unscoped desktop listing retains generic lists, query search, suggestions and field reads', async () => {
        fixture();
        const session = await connect(undefined, false);
        const features = await session.client.features();
        expect(features.features).toEqual(['entries-v1']);
        expect(features.websiteOrigin).toBeUndefined();
        const recent = await session.client.getEntries(undefined, undefined);
        expect(recent.suggested).toEqual([]);
        expect(recent.items.map(entry => entry.title).sort())
            .toEqual(['Direct account', 'Extra URL account', 'Unrelated account']);
        const searched = await session.client.getEntries(ORIGIN, 'Unrelated');
        expect(searched.suggested).toEqual([]);
        expect(searched.items.map(entry => entry.title)).toEqual(['Unrelated account']);
        expect(await session.client.getEntryFields(searched.items[0].handle, ['password']))
            .toEqual({ password: 'unrelated-secret' });
        const suggested = await session.client.getEntries(ORIGIN, undefined);
        expect(suggested.suggested.map(entry => entry.title).sort()).toEqual(['Direct account', 'Extra URL account']);
        expect(suggested.items.map(entry => entry.title)).toEqual(['Unrelated account']);
    });
});
