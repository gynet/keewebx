import { afterEach, beforeEach, expect, test } from 'bun:test';
import { ClipboardExpiry } from '../src/comp/browser/clipboard-expiry';

const nativeSet = globalThis.setTimeout, nativeClear = globalThis.clearTimeout;
let timers: Map<number, () => Promise<void>>, next: number;
beforeEach(() => {
    timers = new Map(); next = 0;
    globalThis.setTimeout = ((fn: () => Promise<void>) => { timers.set(++next, fn); return next; }) as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => { timers.delete(Number(id)); }) as typeof clearTimeout;
});
afterEach(() => { globalThis.setTimeout = nativeSet; globalThis.clearTimeout = nativeClear; });
function clipboard(initial = 'copied secret') {
    let text = initial;
    const writes: string[] = [];
    return { writes, get text() { return text; }, replace(value: string) { text = value; },
        readText: async () => text, writeText: async (value: string) => { writes.push(value); text = value; } };
}
async function expire() { const fn = [...timers.values()][0]; expect(fn).toBeDefined(); await fn(); }
test('expiry clears the copied text', async () => {
    const clip = clipboard(); new ClipboardExpiry().schedule(clip.text, 10, clip);
    await expire(); expect(clip.text).toBe(''); expect(clip.writes).toEqual(['']);
});
test('expiry preserves text subsequently copied outside the app', async () => {
    const clip = clipboard(); new ClipboardExpiry().schedule(clip.text, 10, clip);
    clip.replace('other content'); await expire(); expect(clip.text).toBe('other content'); expect(clip.writes).toEqual([]);
});
test('a newer copy invalidates an already pending old read', async () => {
    const clip = clipboard(), owner = new ClipboardExpiry();
    let finish!: (value: string) => void;
    owner.schedule('copied secret', 10, { ...clip, readText: () => new Promise(resolve => { finish = resolve; }) });
    const pending = expire();
    clip.replace('new secret'); owner.schedule('new secret', 10, clip);
    finish('copied secret'); await pending; expect(clip.writes).toEqual([]);
    await expire(); expect(clip.text).toBe('');
});
test('Off cancels the preceding timer without clearing anything', async () => {
    const clip = clipboard(), owner = new ClipboardExpiry(); owner.schedule(clip.text, 10, clip);
    owner.schedule('next copy', 0, clip); expect(timers.size).toBe(0); expect(clip.writes).toEqual([]);
});
test('denied clipboard read never falls back to a blind clear', async () => {
    const clip = clipboard(); new ClipboardExpiry().schedule(clip.text, 10, {
        ...clip, readText: async () => { throw new Error('denied'); }
    });
    await expire(); expect(clip.writes).toEqual([]);
});
test('denied clipboard clearing is handled without an unhandled rejection', async () => {
    const clip = clipboard(); new ClipboardExpiry().schedule(clip.text, 10, {
        ...clip, writeText: async () => { throw new Error('denied'); }
    });
    await expire(); expect(clip.text).toBe('copied secret');
});
