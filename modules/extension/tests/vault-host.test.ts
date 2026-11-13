import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { appUrl, openFullApp } from '../src/background/vault-host';

let previousChrome: PropertyDescriptor | undefined;
let hidden: boolean;
let tabs: any[];
let reply: unknown;
const sendMessage = mock(async (_request: unknown) => reply);
const closeDocument = mock(async () => { hidden = false; });
const create = mock(async (_options: unknown) => ({}));
const update = mock(async (_id: number, _options: unknown) => ({}));
beforeEach(() => {
    previousChrome = Object.getOwnPropertyDescriptor(globalThis, 'chrome');
    hidden = true; tabs = []; reply = { ok: true, result: { locked: true } };
    for (const fn of [sendMessage, closeDocument, create, update]) fn.mockClear();
    Object.defineProperty(globalThis, 'chrome', { configurable: true, value: {
        runtime: { id: 'test-extension', getURL: (path: string) => `chrome-extension://test-extension/${path}`, sendMessage },
        tabs: { query: async () => tabs, create, update },
        offscreen: { hasDocument: async () => hidden, closeDocument },
        windows: { update: async () => ({}) }
    } });
});
afterEach(() => {
    if (previousChrome) Object.defineProperty(globalThis, 'chrome', previousChrome);
    else Reflect.deleteProperty(globalThis, 'chrome');
});

test('opens New only after the hidden vault confirms it has safely locked', async () => {
    expect(appUrl()).toBe('chrome-extension://test-extension/app/next.html');
    await openFullApp();
    expect(sendMessage).toHaveBeenCalledWith({ vault: 'lock', vaultContext: 'offscreen' });
    expect(closeDocument).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ url: appUrl() });
});

test('failed or incomplete lock retains the hidden vault without opening another copy', async () => {
    for (reply of [undefined, { ok: true }, { ok: true, result: {} }, { ok: false, error: 'Save failed' }]) {
        await expect(openFullApp()).rejects.toThrow();
        expect(hidden).toBe(true);
        expect(closeDocument).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    }
});

test('reuses either existing interface with query strings and does not match a foreign origin', async () => {
    hidden = false;
    for (const entry of ['index.html?ui=classic', 'next.html?tab=security']) {
        tabs = [{ id: 1, url: 'chrome-extension://foreign/app/next.html' },
            { id: 2, windowId: 10, url: `chrome-extension://test-extension/app/${entry}` }];
        await openFullApp();
        expect(update).toHaveBeenLastCalledWith(2, { active: true });
        expect(create).not.toHaveBeenCalled();
    }
});

test('a newly created app tab is recognized before its first navigation commits', async () => {
    hidden = false;
    tabs = [{ id: 3, pendingUrl: appUrl() }];
    await openFullApp();
    expect(update).toHaveBeenLastCalledWith(3, { active: true });
    expect(create).not.toHaveBeenCalled();
});
