import { afterEach, beforeEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Fragment, h } from 'preact';
import { sanitizeData } from '../../../diagnostics/src/schema';
import { localLogPreference } from '../src/local-log-preference';
import { transportEvent, watchTransport } from '../src/transport-events';
import { appLogRecording, readMainReceiverLog } from '../src/app-receiver-log';

const KEY = 'keewebx-userscript-local-log-enabled-v1';
const AUTOFILL_KEY = 'keewebx-userscript-connect-preferences-v1';
const originals = new Map<string, PropertyDescriptor | undefined>();
const cleanups: Array<() => void> = [];
let storage: Map<string, unknown>, writes: Array<[string, unknown]>, copied: string;
let gm: { getValue(key: string): Promise<unknown>; setValue(key: string, value: unknown): Promise<void> };

function replace(key: string, value: unknown) {
    if (!originals.has(key)) originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}
async function settle() { for (let turn = 0; turn < 30; turn++) await Promise.resolve(); }

beforeEach(() => {
    storage = new Map([[AUTOFILL_KEY, { autoFillSingle: true }]]); writes = []; copied = '';
    gm = {
        async getValue(key) { return storage.get(key); },
        async setValue(key, value) { writes.push([key, value]); storage.set(key, value); }
    };
    replace('GM', gm);
    replace('document', Object.assign(new EventTarget(), { hidden: false }));
    replace('window', new EventTarget());
    replace('navigator', { clipboard: { async writeText(value: string) { copied = value; } } });
});
afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
    }
    originals.clear();
});

// Run the actual component with a small hook scheduler, without global module mocks
// or a browser dependency. Storage, sanitization and transport observers are real.
const source = readFileSync(new URL('../src/local-connect-log.tsx', import.meta.url), 'utf8');
const compiled = new Bun.Transpiler({ loader: 'tsx', tsconfig: {
    compilerOptions: { jsx: 'react', jsxFactory: 'h', jsxFragmentFactory: 'Fragment' }
} }).transformSync(source.slice(source.indexOf('const MAX_LINES')).replace('export function', 'function'));

function mount(mode: 'app' | 'website' = 'website') {
    const slots: any[] = [], effects: Array<() => void> = [];
    let cursor = 0, dirty = true, mounted = true, tree: any;
    const hooks = {
        useState(initial: unknown) {
            const slot = slots[cursor++] ??= { value: initial };
            return [slot.value, (value: unknown) => { slot.value = value; dirty = true; }];
        },
        useRef(initial: unknown) { return slots[cursor++] ??= { current: initial }; },
        useEffect(setup: () => void | (() => void), deps: unknown[]) {
            const slot = slots[cursor++] ??= {};
            if (!slot.deps || deps.some((value, index) => value !== slot.deps[index])) {
                slot.deps = deps;
                effects.push(() => { slot.cleanup?.(); slot.cleanup = setup(); });
            }
        }
    };
    const dependencies = { ...hooks, h, Fragment, sanitizeData, watchTransport, localLogPreference,
        appLogRecording, readMainReceiverLog, CONNECT_VERSION: 'test' };
    const Component = new Function(...Object.keys(dependencies), compiled + '\nreturn LocalConnectLog;')(...Object.values(dependencies));
    const snapshot = () => ({ state: 'Connected' });
    const render = () => {
        if (!mounted || !dirty) return;
        cursor = 0; dirty = false;
        tree = Component({ mode, snapshot });
        for (const effect of effects.splice(0)) effect();
    };
    const find = (type: string, node: any = tree): any => {
        if (!node || typeof node !== 'object') return;
        if (node.type === type) return node;
        for (const child of [node.props?.children].flat(Infinity)) {
            if (child == null) continue;
            const found = find(type, child);
            if (found) return found;
        }
    };
    const unmount = () => {
        if (!mounted) return;
        mounted = false;
        for (const slot of slots) slot.cleanup?.();
    };
    cleanups.push(unmount);
    render();
    return {
        unmount,
        async settle() { await settle(); render(); },
        enabled: () => find('input').props.checked,
        toggle(checked: boolean, isTrusted = true) {
            find('input').props.onChange({ isTrusted, currentTarget: { checked } }); render();
        },
        async copy() { await find('button').props.onClick({ isTrusted: true }); render(); }
    };
}

test.each(['app', 'website'] as const)('%s restores explicit on and off choices in future documents', async mode => {
    const first = mount(mode); await first.settle();
    expect(first.enabled()).toBe(false); expect(writes).toEqual([]);
    first.toggle(true); await first.settle(); first.unmount();
    const reopened = mount(mode); await reopened.settle();
    expect(reopened.enabled()).toBe(true);
    reopened.toggle(false); await reopened.settle(); reopened.unmount();
    const disabled = mount(mode); await disabled.settle();
    expect(disabled.enabled()).toBe(false);
    expect(writes).toEqual([[KEY, true], [KEY, false]]);
    expect(storage.get(AUTOFILL_KEY)).toEqual({ autoFillSingle: true });
    expect([...storage.keys()]).toEqual([AUTOFILL_KEY, KEY]);
});

test('an App choice is restored in a new website document', async () => {
    const app = mount('app'); await app.settle(); app.toggle(true); await app.settle(); app.unmount();
    const website = mount('website'); await website.settle();
    expect(website.enabled()).toBe(true);
});

test('App export reserves the clipboard write synchronously with a promised text blob', async () => {
    let writes = 0, item: any;
    const finished = deferred<void>();
    replace('ClipboardItem', class { constructor(public values: Record<string, Promise<Blob>>) {} });
    replace('navigator', { clipboard: { write(items: any[]) { writes++; item = items[0]; return finished.promise; } } });
    const log = mount('app'); await log.settle(); log.toggle(true); await log.settle();
    const copying = log.copy();
    expect(writes).toBe(1);
    expect(item.values['text/plain']).toBeInstanceOf(Promise);
    const text = await (await item.values['text/plain']).text();
    expect(text).toContain('App page receiver (local only)');
    finished.resolve(); await copying;
});

test.each([undefined, null, 'true', 1, { enabled: true }])('only an explicit stored boolean enables logging (%j)', async stored => {
    storage.set(KEY, stored);
    const log = mount(); await log.settle();
    expect(log.enabled()).toBe(false); expect(writes).toEqual([]);
});

test.each([false, true])('late restoration cannot override a newer user choice (saved %j)', async saved => {
    const read = deferred<unknown>(); gm.getValue = () => read.promise;
    const log = mount(); await log.settle();
    expect(log.enabled()).toBe(false);
    log.toggle(true);
    transportEvent({ event: 'hello-replied' }); await log.copy();
    expect(copied).toContain('hello-replied');
    if (saved) log.toggle(false);
    expect(log.enabled()).toBe(!saved);
    read.resolve(saved); await log.settle();
    expect(log.enabled()).toBe(!saved); expect(storage.get(KEY)).toBe(!saved);
});

test('rapid toggles persist in order even when the first write is slow', async () => {
    const held = deferred<void>(), started = deferred<void>();
    const save = gm.setValue;
    gm.setValue = async (key, value) => {
        if (value === true) { started.resolve(); await held.promise; }
        await save(key, value);
    };
    const log = mount(); await log.settle();
    log.toggle(true); await started.promise;
    transportEvent({ event: 'hello-replied' }); await log.copy();
    expect(copied).toContain('hello-replied');
    log.toggle(false); await log.settle();
    expect(log.enabled()).toBe(false); expect(writes).toEqual([]);
    held.resolve(); await log.settle();
    expect(writes).toEqual([[KEY, true], [KEY, false]]);
    log.unmount(); const reopened = mount(); await reopened.settle();
    expect(reopened.enabled()).toBe(false);
});

test.each(['throw', 'reject'] as const)('manager %s failures leave local logging usable and later saves recover', async failure => {
    const fail = (): Promise<never> => {
        if (failure === 'throw') throw new Error('Manager unavailable');
        return Promise.reject(new Error('Manager unavailable'));
    };
    gm.getValue = fail; gm.setValue = fail;
    const log = mount(); await log.settle(); expect(log.enabled()).toBe(false);
    log.toggle(true); await log.settle();
    transportEvent({ event: 'hello-replied' }); await log.copy();
    expect(log.enabled()).toBe(true); expect(copied).toContain('hello-replied');
    gm.setValue = async (key, value) => { storage.set(key, value); };
    log.toggle(false); await log.settle();
    expect(storage.get(KEY)).toBe(false);
});

test('missing manager APIs do not prevent a local toggle or capture', async () => {
    Reflect.deleteProperty(globalThis, 'GM');
    const log = mount(); await log.settle(); log.toggle(true); await log.settle();
    transportEvent({ event: 'hello-replied' }); await log.copy();
    expect(copied).toContain('hello-replied'); expect(log.enabled()).toBe(true);
});

test('untrusted events neither change nor persist the preference', async () => {
    const log = mount(); await log.settle(); log.toggle(true, false); await log.settle();
    expect(log.enabled()).toBe(false); expect(writes).toEqual([]);
});

test('a late read after unmount does not reactivate recording', async () => {
    const read = deferred<unknown>(); gm.getValue = () => read.promise;
    const log = mount(); await log.settle(); log.unmount(); read.resolve(true); await log.settle();
    expect(log.enabled()).toBe(false); expect(writes).toEqual([]);
});

test('restored logging keeps only 300 sanitized events in memory and starts fresh after reload', async () => {
    storage.set(KEY, true);
    const log = mount(); await log.settle();
    for (let pending = 0; pending < 305; pending++) {
        transportEvent({ event: 'hello-replied', pending, password: 'never persist this' } as any);
    }
    await log.copy();
    const events = copied.split('\n').slice(2).map(line => JSON.parse(line.slice(line.indexOf('{'))));
    expect(events).toHaveLength(300);
    expect(events[0].pending).toBe(5); expect(events.at(-1).pending).toBe(304);
    expect(copied).not.toContain('password'); expect(copied).not.toContain('never persist this');
    expect(writes).toEqual([]);
    log.unmount(); const reopened = mount(); await reopened.settle(); await reopened.copy();
    expect(copied).not.toContain('hello-replied');
    reopened.toggle(false); transportEvent({ event: 'hello-replied' }); reopened.toggle(true);
    await reopened.settle(); await reopened.copy();
    expect(copied).not.toContain('hello-replied');
    expect(writes).toEqual([[KEY, false], [KEY, true]]);
});
