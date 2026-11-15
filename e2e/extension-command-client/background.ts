import { box, sign } from 'tweetnacl';
import { TransportBrowserTab } from '../../modules/extension/src/background/transport/transport-browser-tab';
import { getIdentity } from '../../modules/extension/src/background/identity';
import { backend } from '../../modules/extension/src/background/backend';

// A compatible installed client, using the real tab bridge and authenticated wire
// format. It has no reference to app models, prompts, decrypted vaults or test hooks.
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const random = () => crypto.getRandomValues(new Uint8Array(24));
let transport: TransportBrowserTab | undefined;
let keys = box.keyPair();
let serverKey: Uint8Array;
let clientID = encode(random());
let pending: { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
let attention = 0;
const events: string[] = [];
const bootID = crypto.randomUUID();
const ready = backend.init();

function request(data: any): Promise<any> {
    if (pending) throw new Error('A command is already pending');
    return new Promise((resolve, reject) => {
        pending = { resolve, reject, timer: setTimeout(() => {
            pending = undefined; reject(new Error('Command timed out'));
        }, 25_000) };
        transport!.request(data);
    });
}
function check(response: any) {
    if (response.error) throw new Error(`${response.errorCode ?? 'error'}: ${response.error}`);
    return response;
}
async function call(action: string, fields: Record<string, unknown> = {}) {
    const nonce = random();
    const message = box(new TextEncoder().encode(JSON.stringify({ action, ...fields })), nonce, serverKey, keys.secretKey);
    const envelope = { action, clientID, nonce: encode(nonce), message: encode(message) };
    if (action === 'kwx-get-entry-fields') await chrome.storage.session.set({ previousFieldsRequest: envelope });
    const response = check(await request(envelope));
    const expected = nonce.slice();
    for (let index = 0, carry = 1; index < expected.length && carry; index++) {
        const value = expected[index] + carry; expected[index] = value; carry = value >> 8;
    }
    if (response.nonce !== encode(expected)) throw new Error('Invalid response nonce');
    const plain = box.open(decode(response.message), decode(response.nonce), serverKey, keys.secretKey);
    if (!plain) throw new Error('Invalid authenticated response');
    const payload = JSON.parse(new TextDecoder().decode(plain));
    if (payload.nonce !== response.nonce) throw new Error('Mismatched payload nonce');
    return check(payload);
}
async function connect(url: string) {
    await transport?.disconnect();
    keys = box.keyPair(); clientID = encode(random());
    transport = new TransportBrowserTab(url);
    transport.on('message', response => {
        if (response.action === 'attention-required') { attention++; transport!.focusKeeWeb(); return; }
        if (['database-locked', 'database-unlocked'].includes(response.action)) { events.push(response.action); return; }
        if (pending) { const current = pending; pending = undefined; clearTimeout(current.timer); current.resolve(response); }
    });
    transport.on('disconnected', () => {
        if (pending) { clearTimeout(pending.timer); pending.reject(new Error('Disconnected')); pending = undefined; }
    });
    await transport.connect();
    const response = check(await request({ action: 'change-public-keys', extensionName: 'KeeWeb Connect',
        version: '1.0.0', clientID, publicKey: encode(keys.publicKey), nonce: encode(random()) }));
    serverKey = decode(response.publicKey);
    const identity = await getIdentity();
    const signature = sign.detached(new Uint8Array([...new TextEncoder().encode('kwx-pair-v1'), ...keys.publicKey, ...serverKey]), identity.secretKey);
    await call('kwx-pair', { identityKey: encode(identity.publicKey), signature: encode(signature) });
    return { connected: true, bootID, clientID, publicKey: encode(keys.publicKey), serverKey: encode(serverKey), identity: encode(identity.publicKey) };
}
async function backendCommand(message: any) {
    await ready;
    switch (message.action) {
        case 'backend-configure': await chrome.storage.local.set({ keeWebUrl: message.url }); return { configured: true };
        case 'backend-connect':
            await backend.connect();
            if (backend.state !== 'Connected') throw new Error(backend.connectionError || backend.state);
            return { connected: true, bootID, identity: encode((await getIdentity()).publicKey) };
        case 'backend-status': return backend.features();
        case 'backend-list': return backend.getEntries(message.fields.url, undefined);
        case 'backend-fields': return backend.getEntryFields(message.fields.handle, ['password']);
        case 'backend-other': return backend.getAnyField(message.fields.url, 'Interruption fixture');
        default: throw new Error('Unknown backend command');
    }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('client.html')) || message.type !== 'command') return;
    const task = message.action.startsWith('backend-') ? backendCommand(message)
        : message.action === 'connect' ? connect(message.url)
        : message.action === 'reset-identity' ? chrome.storage.local.remove('kwxIdentity').then(() => ({ resetOnRestart: true }))
        : message.action === 'replay-fields' ? chrome.storage.session.get('previousFieldsRequest').then(async stored => {
            if (!stored.previousFieldsRequest) throw new Error('No previous field request');
            return check(await request(stored.previousFieldsRequest));
        }) : call(message.action, message.fields);
    void task.then(value => respond({ ok: true, value, attention, events: [...events] }),
        error => respond({ ok: false, error: String(error.message), attention, events: [...events] }));
    return true;
});
