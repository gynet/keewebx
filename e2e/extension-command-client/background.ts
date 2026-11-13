import { box, sign } from 'tweetnacl';
import { TransportBrowserTab } from '../../modules/extension/src/background/transport/transport-browser-tab';

// A compatible installed client, using the real tab bridge and authenticated wire
// format. It has no reference to app models, prompts, decrypted vaults or test hooks.
const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const decode = (value: string) => Uint8Array.from(atob(value), c => c.charCodeAt(0));
const random = () => crypto.getRandomValues(new Uint8Array(24));
let transport: TransportBrowserTab | undefined;
let keys = box.keyPair();
let serverKey: Uint8Array;
let clientID = encode(random());
const identity = sign.keyPair();
let pending: { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> } | undefined;
let attention = 0;
const events: string[] = [];

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
    const response = check(await request({ action, clientID, nonce: encode(nonce), message: encode(message) }));
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
    const signature = sign.detached(new Uint8Array([...new TextEncoder().encode('kwx-pair-v1'), ...keys.publicKey, ...serverKey]), identity.secretKey);
    await call('kwx-pair', { identityKey: encode(identity.publicKey), signature: encode(signature) });
    return { connected: true };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id || !sender.url?.startsWith(chrome.runtime.getURL('client.html')) || message.type !== 'command') return;
    const task = message.action === 'connect' ? connect(message.url) : call(message.action, message.fields);
    void task.then(value => respond({ ok: true, value, attention, events: [...events] }),
        error => respond({ ok: false, error: String(error.message), attention, events: [...events] }));
    return true;
});
