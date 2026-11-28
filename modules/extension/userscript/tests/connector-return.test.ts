import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the current helper and site listener directly, without a generated bundle.
const source = readFileSync(new URL('../src/native-connect.ts', import.meta.url), 'utf8');
const transpiler = new Bun.Transpiler({ loader: 'ts' });
const helperSource = transpiler.transformSync(source.slice(source.indexOf('export function startConnector(')).replace('export function', 'function'));
const siteSource = transpiler.transformSync(source.slice(source.indexOf('const connectorName ='), source.indexOf('/** Only a trusted user action opens/focuses')));
const MARK = 'keewebx-native-connect-v1';
const endpoint = new URL('https://keewebx.app/app');
const routingId = crypto.randomUUID();
const websiteOrigin = 'https://login.example.org';

function environment() {
    let now = 1000, nextTimer = 0;
    const timers = new Map<number, { at: number; callback: () => void }>();
    const listeners = new Map<string, Set<(event: any) => void>>();
    return {
        timers, listeners,
        Date: { now: () => now },
        setTimeout(callback: () => void, delay: number) { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
        clearTimeout(id: number) { timers.delete(id); },
        addEventListener(name: string, callback: (event: any) => void) {
            if (!listeners.has(name)) listeners.set(name, new Set());
            listeners.get(name)!.add(callback);
        },
        removeEventListener(name: string, callback: (event: any) => void) { listeners.get(name)?.delete(callback); },
        emit(name: string, event: any = {}) { for (const callback of [...(listeners.get(name) || [])]) callback(event); },
        advance(milliseconds: number) {
            now += milliseconds;
            for (const [id, timer] of [...timers]) if (timers.has(id) && timer.at <= now) { timers.delete(id); timer.callback(); }
        }
    };
}

function peer() {
    return {
        closed: false, focuses: 0, throws: false, posts: [] as Array<{ data: any; origin: string }>,
        focus() { this.focuses++; if (this.throws) throw new Error('Focus blocked'); },
        postMessage(data: any, origin: string) { this.posts.push({ data, origin }); }
    };
}

function helper() {
    const env = environment(), website = peer();
    let linked!: (peer: any, origin: string) => void, closed = 0;
    const elements: any[] = [];
    const document = {
        hidden: false, body: { append() {} },
        getElementById: () => undefined,
        createElement(tag: string) {
            const element = { tag, style: {}, textContent: '', hidden: false, disabled: false, attributes: {} as Record<string, string>,
                append() {}, setAttribute(name: string, value: string) { this.attributes[name] = value; } };
            elements.push(element); return element;
        }
    };
    runInNewContext(`${helperSource}; startConnector(endpoint);`, {
        ...env, URL, Map, endpoint, document,
        location: { href: `${endpoint.origin}/connect.html?kwx-client=${routingId}`, origin: endpoint.origin },
        window: { opener: website, close() { closed++; } },
        MARK, uuid: () => crypto.randomUUID(), isId: (value: any) => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value),
        connectorName: () => 'fixture', channelName: () => 'fixture', approvedRoute: async () => ({ host: 'selected' }),
        object: (value: any) => value !== null && typeof value === 'object', valid: () => false,
        SiteLink: class {
            constructor(_peer: any, callback: typeof linked) { linked = callback; }
            restart() {} pause() {}
        },
        BroadcastChannel: class { postMessage() {} }
    });
    linked(website, websiteOrigin); website.posts.length = 0;
    const back = elements.find(element => element.tag === 'button');
    const status = elements.find(element => element.attributes['data-role'] === 'website-return-status');
    const request = () => website.posts.at(-1)!.data;
    const ack = (data: any = {}, event: any = {}) => env.emit('message', {
        isTrusted: true, source: website, origin: websiteOrigin,
        data: { ...request(), kind: 'website-focused', visible: true, focused: true, ...data }, ...event
    });
    return { ...env, website, back, status, request, ack, linked, closed: () => closed };
}

test('only a trusted tap requests focus and success needs the matching acknowledgement', () => {
    const fixture = helper();
    fixture.back.onclick({ isTrusted: false });
    expect(fixture.website.focuses).toBe(0); expect(fixture.timers.size).toBe(0);
    fixture.back.onclick({ isTrusted: true });
    expect(fixture.website.focuses).toBe(1);
    expect(fixture.request()).toMatchObject({ kind: 'return-to-website', routingId, endpoint: endpoint.href, websiteOrigin });
    expect(fixture.website.posts[0].origin).toBe(websiteOrigin);
    expect(fixture.back.textContent).toBe('Checking website…');
    fixture.ack();
    expect(fixture.status.textContent).toContain('visible and focused');
    expect(fixture.back.disabled).toBe(false); expect(fixture.timers.size).toBe(0); expect(fixture.closed()).toBe(0);
});

test('ignored focus shows Safari tab instructions after a bounded wait and leaves the relay open', () => {
    const fixture = helper(); fixture.back.onclick({ isTrusted: true });
    fixture.advance(2000);
    expect(fixture.status.textContent).toContain('Safari’s tabs button');
    expect(fixture.status.textContent).toContain('existing website');
    expect(fixture.status.textContent).toContain('Keep this connection page open');
    expect(fixture.timers.size).toBe(0); expect(fixture.closed()).toBe(0);
    fixture.ack(); expect(fixture.status.textContent).not.toContain('visible and focused');
});

test('a thrown focus request gives immediate fallback without closing the relay', () => {
    const fixture = helper(); fixture.website.throws = true;
    fixture.back.onclick({ isTrusted: true });
    expect(fixture.status.textContent).toContain('Safari’s tabs button');
    expect(fixture.timers.size).toBe(0); expect(fixture.closed()).toBe(0);
});

test('spoofed, incomplete and stale acknowledgements cannot report success', () => {
    const fixture = helper(); fixture.back.onclick({ isTrusted: true });
    for (const data of [{ nonce: crypto.randomUUID() }, { routingId: crypto.randomUUID() }, { endpoint: 'https://evil.test/app' },
        { websiteOrigin: 'https://evil.test' }, { visible: false }, { focused: false }, { marker: 'wrong' }]) fixture.ack(data);
    for (const event of [{ isTrusted: false }, { source: peer() }, { origin: 'https://evil.test' }]) fixture.ack({}, event);
    expect(fixture.back.textContent).toBe('Checking website…'); expect(fixture.timers.size).toBe(1);
    const previous = fixture.request(); fixture.back.onclick({ isTrusted: true });
    fixture.ack({ nonce: previous.nonce }); expect(fixture.back.textContent).toBe('Checking website…');
    fixture.ack(); expect(fixture.status.textContent).toContain('visible and focused');
    expect(fixture.timers.size).toBe(0);
});

test('origin changes and pagehide cancel return checks and their timers', () => {
    const fixture = helper(); fixture.back.onclick({ isTrusted: true });
    const previous = fixture.request(); fixture.linked(fixture.website, 'https://second.example');
    expect(fixture.timers.size).toBe(0); fixture.ack({ nonce: previous.nonce });
    expect(fixture.status.textContent).not.toContain('visible and focused');
    fixture.back.onclick({ isTrusted: true }); expect(fixture.timers.size).toBe(1);
    fixture.emit('pagehide'); expect(fixture.timers.size).toBe(0);
    fixture.back.onclick({ isTrusted: true }); expect(fixture.timers.size).toBe(0); expect(fixture.closed()).toBe(0);
});

function site() {
    const env = environment(), connector = peer(), binding = { origin: endpoint.origin, routingId };
    const document = { visibilityState: 'hidden', focused: false, hasFocus() { return this.focused; } };
    const location = { origin: websiteOrigin };
    const peers = new Map([[connector, binding]]);
    runInNewContext(siteSource, {
        ...env, MARK, SETUP_MARK: 'fixture-setup', peers, document, location, window: {},
        client: { endpoint, id: routingId }, isId: (value: any) => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value)
    });
    const request = (data: any = {}, event: any = {}) => env.emit('message', {
        isTrusted: true, source: connector, origin: endpoint.origin,
        data: { marker: MARK, kind: 'return-to-website', endpoint: endpoint.href, routingId, websiteOrigin, nonce: crypto.randomUUID(), ...data }, ...event
    });
    return { ...env, connector, document, location, peers, request };
}

test('the website acknowledges only after it stays visible and focused for 200 ms', () => {
    const fixture = site(); fixture.request(); expect(fixture.connector.posts).toHaveLength(0);
    fixture.document.visibilityState = 'visible'; fixture.emit('visibilitychange');
    expect(fixture.connector.posts).toHaveLength(0);
    fixture.document.focused = true; fixture.emit('focus');
    expect(fixture.connector.posts).toHaveLength(0);
    fixture.advance(199); expect(fixture.connector.posts).toHaveLength(0);
    fixture.advance(1);
    expect(fixture.connector.posts).toHaveLength(1);
    expect(fixture.connector.posts[0]).toMatchObject({ origin: endpoint.origin, data: { kind: 'website-focused', websiteOrigin, visible: true, focused: true } });
    expect(fixture.timers.size).toBe(0); expect(fixture.listeners.get('focus')!.size).toBe(0);
    expect(fixture.listeners.get('blur')!.size).toBe(0);
});

test('transient focus followed by blur never acknowledges and resets the settling period', () => {
    const fixture = site(); fixture.document.visibilityState = 'visible'; fixture.document.focused = true;
    fixture.request(); fixture.advance(100);
    fixture.document.focused = false; fixture.emit('blur'); fixture.advance(100);
    expect(fixture.connector.posts).toHaveLength(0); expect(fixture.timers.size).toBe(1);
    fixture.document.focused = true; fixture.emit('focus'); fixture.advance(199);
    expect(fixture.connector.posts).toHaveLength(0);
    fixture.advance(1); expect(fixture.connector.posts).toHaveLength(1); expect(fixture.timers.size).toBe(0);
});

test('visibility loss cancels the stable timer and an unfocused website times out cleanly', () => {
    const fixture = site(); fixture.document.visibilityState = 'visible'; fixture.document.focused = true;
    fixture.request(); fixture.advance(100);
    fixture.document.visibilityState = 'hidden'; fixture.emit('visibilitychange');
    expect(fixture.timers.size).toBe(1);
    fixture.advance(1700); expect(fixture.connector.posts).toHaveLength(0); expect(fixture.timers.size).toBe(0);
    expect(fixture.listeners.get('focus')!.size).toBe(0); expect(fixture.listeners.get('blur')!.size).toBe(0);
});

test('route replacement and pagehide cancel a pending stability proof', () => {
    const fixture = site(); fixture.document.visibilityState = 'visible'; fixture.document.focused = true;
    fixture.request(); expect(fixture.timers.size).toBe(2);
    fixture.peers.set(fixture.connector, { origin: endpoint.origin, routingId: crypto.randomUUID() });
    fixture.advance(200); expect(fixture.connector.posts).toHaveLength(0); expect(fixture.timers.size).toBe(0);
    const hidden = site(); hidden.document.visibilityState = 'visible'; hidden.document.focused = true;
    hidden.request(); hidden.emit('pagehide');
    expect(hidden.timers.size).toBe(0); hidden.advance(200); expect(hidden.connector.posts).toHaveLength(0);
});

test('website checks reject spoofed requests and release listeners on timeout, navigation and replacement', () => {
    const fixture = site();
    for (const data of [{ nonce: 'invalid' }, { routingId: crypto.randomUUID() }, { endpoint: 'https://evil.test/app' }, { websiteOrigin: 'https://evil.test' }]) fixture.request(data);
    for (const event of [{ isTrusted: false }, { source: peer() }, { origin: 'https://evil.test' }]) fixture.request({}, event);
    expect(fixture.timers.size).toBe(0);
    fixture.request(); fixture.request(); expect(fixture.timers.size).toBe(1); expect(fixture.listeners.get('focus')!.size).toBe(1);
    fixture.advance(1800); expect(fixture.timers.size).toBe(0); expect(fixture.listeners.get('focus')!.size).toBe(0);
    fixture.request(); fixture.emit('pagehide'); expect(fixture.timers.size).toBe(0);
    fixture.request(); fixture.location.origin = 'https://second.example';
    fixture.document.visibilityState = 'visible'; fixture.document.focused = true; fixture.emit('focus');
    expect(fixture.connector.posts).toHaveLength(0); expect(fixture.timers.size).toBe(0);
});
