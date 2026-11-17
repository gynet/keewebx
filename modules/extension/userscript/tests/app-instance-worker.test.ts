import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../../ui/connect-port/worker.js', import.meta.url), 'utf8');
const marker = 'keewebx-app-instance-v1', lockName = marker + ':/:', scriptURL = 'https://keewebx.app/connect-port/worker.js';

async function fixture(options: { sourceURL?: string; targetURL?: string; mode?: string; lock?: string; reject?: boolean;
    locator?: boolean; foreignLocator?: boolean; identify?: boolean } = {}) {
    let listener!: (event: any) => void;
    let focused = 0, queried = 0;
    class Client {
        frameType = 'top-level';
        constructor(readonly id: string, readonly url: string) {}
        async focus() { focused++; if (options.reject) throw new Error('Refused'); return { focused: true }; }
    }
    const target = new Client('actual-owner', options.targetURL ?? 'https://keewebx.app/app');
    const messages: unknown[] = [];
    const port = { postMessage: (value: unknown) => messages.push(value), start() {}, close() {} };
    runInNewContext(source, { URL, TextEncoder, WindowClient: Client, setTimeout, clearTimeout,
        self: { location: new URL(scriptURL), addEventListener: (name: string, cb: typeof listener) => { if (name === 'message') listener = cb; },
            navigator: { locks: { query: async () => { queried++; return { held: [
                { name: options.lock ?? lockName, mode: options.mode ?? 'exclusive', clientId: 'lock-context' },
                ...(options.locator === false ? [] : [{ name: lockName + ':client:' + encodeURIComponent(target.id),
                    mode: 'exclusive', clientId: options.foreignLocator ? 'another-context' : 'lock-context' }])
            ] }; } } },
            clients: { get: async (id: string) => id === target.id ? target : undefined } }
    });
    let work: Promise<void> | undefined;
    listener({ data: options.identify ? { marker, kind: 'identify' } : { marker, kind: 'focus', lockName }, ports: [port],
        source: new Client('secondary', options.sourceURL ?? 'https://keewebx.app/next.html'),
        waitUntil: (promise: Promise<void>) => { work = promise; } });
    await work;
    return { focused, queried, messages };
}

test('the worker focuses only the browser-reported exclusive owner without registration metadata', async () => {
    const r = await fixture();
    expect(r.focused).toBe(1); expect(r.queried).toBe(1);
    expect(r.messages).toEqual([{ marker, kind: 'focused', ok: true }]);
});

test('an App learns only its own browser-owned WindowClient ID', async () => {
    const r = await fixture({ identify: true });
    expect(r.messages).toEqual([{ marker, kind: 'identified', clientId: 'secondary' }]);
    expect(r.queried).toBe(0); expect(r.focused).toBe(0);
});

test.each(['https://login.example.org/app', 'https://keewebx.app/connect-port/relay.html', 'https://keewebx.app/classic'])
('a focus request from %s cannot address an App', async sourceURL => {
    const r = await fixture({ sourceURL }); expect(r.focused).toBe(0); expect(r.queried).toBe(0); expect(r.messages).toEqual([]);
});

test.each([
    { targetURL: 'https://login.example.org/app' },
    { targetURL: 'https://keewebx.app/connect-port/relay.html' },
    { mode: 'shared' }, { lock: marker + ':/other/:' }, { reject: true }, { locator: false }, { foreignLocator: true }
])('missing, foreign or refused owners return a manual fallback', async options => {
    const r = await fixture(options); expect(r.messages).toEqual([{ marker, kind: 'focused', ok: false }]);
});

test('a lock query that resumes after the fallback deadline cannot unexpectedly focus a tab', async () => {
    let listener!: (event: any) => void, deadline!: () => void, resolveQuery!: (value: unknown) => void;
    let focused = 0;
    class Client {
        frameType = 'top-level'; url = 'https://keewebx.app/app';
        async focus() { focused++; return { focused: true }; }
    }
    const messages: unknown[] = [];
    runInNewContext(source, { URL, TextEncoder, WindowClient: Client,
        setTimeout: (callback: () => void) => { deadline = callback; return 1; }, clearTimeout() {},
        self: { location: new URL(scriptURL), addEventListener: (name: string, cb: typeof listener) => { if (name === 'message') listener = cb; },
            navigator: { locks: { query: () => new Promise(resolve => { resolveQuery = resolve; }) } },
            clients: { get: async () => new Client() } }
    });
    let work!: Promise<void>;
    listener({ data: { marker, kind: 'focus', lockName }, source: new Client(),
        ports: [{ postMessage: (value: unknown) => messages.push(value), start() {}, close() {} }],
        waitUntil: (value: Promise<void>) => { work = value; } });
    deadline(); await work;
    expect(messages).toEqual([{ marker, kind: 'focused', ok: false }]);
    resolveQuery({ held: [{ name: lockName, mode: 'exclusive', clientId: 'owner' }] });
    for (let n = 0; n < 10; n++) await Promise.resolve();
    expect(focused).toBe(0);
});
