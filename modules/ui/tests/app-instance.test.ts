import { expect, test } from 'bun:test';
import { AppInstance, appInstanceLock, type AppInstanceState } from '../src/app-instance';

async function settle() { for (let n = 0; n < 30; n++) await Promise.resolve(); }

/** Minimal FIFO lock manager; held callbacks retain ownership until settlement. */
function manager() {
    let held = false;
    const queue: (() => void)[] = [];
    const request = (_name: string, options: LockOptions, callback: LockGrantedCallback) => new Promise<void>((resolve, reject) => {
        if (options.ifAvailable && options.signal) { reject(new TypeError('ifAvailable cannot use signal')); return; }
        const aborted = () => reject(new DOMException('Canceled', 'AbortError'));
        const grant = () => {
            if (options.signal?.aborted) { aborted(); drain(); return; }
            held = true;
            void Promise.resolve(callback({ name: 'test', mode: 'exclusive' } as Lock)).then(() => {
                held = false; resolve(); drain();
            }, error => { held = false; reject(error); drain(); });
        };
        const drain = () => { if (!held) queue.shift()?.(); };
        options.signal?.addEventListener('abort', aborted, { once: true });
        if (options.signal?.aborted) { aborted(); return; }
        if (options.ifAvailable && (held || queue.length)) {
            void Promise.resolve(callback(null)).then(() => resolve(), reject); return;
        }
        queue.push(grant); drain();
    });
    return { request } as Pick<LockManager, 'request'>;
}

function page(locks: Pick<LockManager, 'request'>) {
    const states: AppInstanceState[] = [];
    const instance = new AppInstance('test', locks, value => states.push(value));
    instance.start();
    return { instance, states };
}

test('simultaneous pages have one primary; closing it promotes only the first waiting page', async () => {
    const locks = manager(), pages = [page(locks), page(locks), page(locks)];
    await settle();
    expect(pages.map(p => p.instance.state)).toEqual(['primary', 'secondary', 'secondary']);
    pages[0].instance.pageHide(false); await settle();
    expect(pages[0].instance.primary).toBe(false);
    expect(pages[1].instance.state).toBe('primary');
    expect(pages[1].instance.primary).toBe(true);
    expect(pages[2].instance.state).toBe('secondary');
    pages.forEach(p => p.instance.stop()); await settle();
});

test('a hidden or back-forward cached primary is never replaced by elapsed time or a waiting page', async () => {
    const locks = manager(), first = page(locks), second = page(locks);
    await settle(); first.instance.pageHide(true); second.instance.start(); await settle();
    expect(first.states.filter(s => s === 'primary')).toHaveLength(1);
    expect(second.instance.state).toBe('secondary');
    first.instance.start(); await settle();
    expect(first.states.filter(s => s === 'primary')).toHaveLength(1);
    first.instance.stop(); second.instance.stop(); await settle();
});

test('a departed secondary cannot later acquire and start a vault', async () => {
    const locks = manager(), first = page(locks), departed = page(locks), next = page(locks);
    await settle(); departed.instance.pageHide(true); first.instance.stop(); await settle();
    expect(departed.states).not.toContain('primary');
    expect(next.instance.state).toBe('primary');
    departed.instance.start(); await settle();
    expect(departed.instance.state).toBe('secondary');
    next.instance.stop(); await settle(); expect(departed.instance.state).toBe('primary');
    departed.instance.stop(); await settle();
});

test('stopping before acquisition invalidates the late callback and permits a fresh start', async () => {
    let grant!: LockGrantedCallback;
    const locks = { request: (_name: string, _options: LockOptions, callback: LockGrantedCallback) => {
        grant = callback; return Promise.resolve();
    } } as Pick<LockManager, 'request'>;
    const p = page(locks), old = grant;
    p.instance.stop(); p.instance.start();
    await old({ name: 'test', mode: 'exclusive' } as Lock); await settle();
    expect(p.states).toEqual(['checking', 'checking']);
    p.instance.stop();
});

test('hidden duplicates release their queue position; a hidden primary retains ownership', async () => {
    const locks = manager(), first = page(locks), second = page(locks), third = page(locks);
    await settle(); first.instance.visibility(false); second.instance.visibility(false); await settle();
    expect(first.instance.state).toBe('primary'); expect(third.instance.state).toBe('secondary');
    first.instance.stop(); await settle(); expect(third.instance.state).toBe('primary');
    expect(second.states).not.toContain('primary');
    second.instance.visibility(true); await settle(); expect(second.instance.state).toBe('secondary');
    second.instance.stop(); third.instance.stop(); await settle();
});

test('lock service errors fail closed and allow an explicit retry', async () => {
    let count = 0;
    const good = manager();
    const locks = { request: (...args: Parameters<LockManager['request']>) => {
        if (!count++) return Promise.reject(new Error('Unavailable'));
        return (good.request as Function)(...args);
    } } as Pick<LockManager, 'request'>;
    const p = page(locks); await settle(); expect(p.instance.state).toBe('error');
    p.instance.start(); await settle(); expect(p.instance.state).toBe('primary');
    p.instance.stop(); await settle();
});

test('canonical aliases share a lock while self-hosted bases and storage namespaces remain distinct', () => {
    expect(appInstanceLock('https://example.test/app', '')).toBe(appInstanceLock('https://example.test/next.html', ''));
    expect(appInstanceLock('https://example.test/one/index.html', '')).not.toBe(appInstanceLock('https://example.test/two/index.html', ''));
    expect(appInstanceLock('https://example.test/app', 'one')).not.toBe(appInstanceLock('https://example.test/app', 'two'));
});
