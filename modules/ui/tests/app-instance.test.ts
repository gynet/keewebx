import { expect, test } from 'bun:test';
import type { AppInstanceState } from '../src/app-instance';

// Run the same behavioral regressions against a saved source for negative controls.
const { AppInstance, appInstanceLock }: typeof import('../src/app-instance') =
    await import(process.env.KWX_APP_INSTANCE_SOURCE ?? '../src/app-instance');

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

/** The browser can release a held lock before delivering its rejected promise. */
function suspendingManager() {
    type Request = {
        name: string; options: LockOptions; callback: LockGrantedCallback;
        resolve(): void; reject(error: unknown): void;
    };
    const resources = new Map<string, { held?: Request; queue: Request[] }>();
    const calls: Request[] = [];
    const resource = (name: string) => {
        if (!resources.has(name)) resources.set(name, { queue: [] });
        return resources.get(name)!;
    };
    const drain = (name: string) => {
        const state = resource(name);
        if (state.held) return;
        const request = state.queue.shift();
        if (!request) return;
        if (request.options.signal?.aborted) { drain(name); return; }
        state.held = request;
        void Promise.resolve(request.callback({ name, mode: 'exclusive' } as Lock)).then(() => {
            // A suspended callback may settle after another context owns the lock.
            if (state.held === request) { state.held = undefined; drain(name); }
            request.resolve();
        }, request.reject);
    };
    const locks = { request: (name: string, options: LockOptions, callback: LockGrantedCallback) =>
        new Promise<void>((resolve, reject) => {
            const request = { name, options, callback, resolve, reject };
            calls.push(request);
            expect(options.steal).not.toBe(true);
            const state = resource(name);
            options.signal?.addEventListener('abort', () => reject(new DOMException('Canceled', 'AbortError')), { once: true });
            if (options.ifAvailable && (state.held || state.queue.length)) {
                void Promise.resolve(callback(null)).then(resolve, reject); return;
            }
            state.queue.push(request); drain(name);
        }) } as Pick<LockManager, 'request'>;
    return {
        locks, calls,
        held: (name = 'test') => !!resource(name).held,
        lose(name = 'test') {
            const state = resource(name), request = state.held!;
            expect(request).toBeDefined();
            state.held = undefined; drain(name);
            return (error: unknown = new DOMException('Browsing context suspended', 'AbortError')) => request.reject(error);
        }
    };
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

test('suspension rejection after foreground reacquires once without another lifecycle event', async () => {
    const browser = suspendingManager(), p = page(browser.locks);
    await settle();
    p.instance.attachClient('original-client'); await settle();
    const reject = browser.lose();
    p.instance.pageHide(true);
    p.instance.start(); p.instance.visibility(true);
    reject(); await settle();
    expect(p.instance.primary).toBe(true);
    expect(p.states).toEqual(['checking', 'primary', 'checking', 'primary']);
    expect(browser.calls.filter(call => call.name === 'test')).toHaveLength(2);
    expect(browser.held('test:client:original-client')).toBe(false);
    p.instance.stop(); await settle();
    expect(browser.held()).toBe(false);
});

test('hidden suspension loss waits for return and reacquires through the browser', async () => {
    const browser = suspendingManager(), p = page(browser.locks);
    await settle(); p.instance.visibility(false);
    browser.lose()(); await settle();
    expect(p.instance.primary).toBe(false);
    expect(browser.calls).toHaveLength(1);
    p.instance.visibility(true); await settle();
    expect(p.instance.primary).toBe(true);
    expect(browser.calls).toHaveLength(2);
    p.instance.stop(); await settle();
});

test('visible suspension recovery is bounded even when the replacement lock is also lost', async () => {
    const browser = suspendingManager(), p = page(browser.locks);
    await settle(); browser.lose()(); await settle();
    expect(p.instance.primary).toBe(true);
    p.instance.start(); p.instance.visibility(true); p.instance.visibility(true);
    browser.lose()(); await settle();
    expect(p.instance.state).toBe('error');
    expect(p.instance.primary).toBe(false);
    expect(browser.calls).toHaveLength(2);
    await settle(); expect(browser.calls).toHaveLength(2);
    p.instance.visibility(false); p.instance.visibility(true); await settle();
    expect(p.instance.primary).toBe(true);
    browser.lose()(); await settle();
    expect(p.instance.primary).toBe(true);
    expect(browser.calls).toHaveLength(4);
    p.instance.stop(); await settle();
});

test('an AbortError before any lock is held does not automatically retry', async () => {
    let requests = 0;
    const locks = { request: () => {
        requests++;
        return Promise.reject(new DOMException('Browsing context suspended', 'AbortError'));
    } } as Pick<LockManager, 'request'>;
    const p = page(locks); await settle();
    expect(p.instance.state).toBe('error');
    expect(p.instance.primary).toBe(false);
    expect(requests).toBe(1);
    p.instance.stop();
});

test('generic held-lock failure does not automatically retry', async () => {
    const browser = suspendingManager(), p = page(browser.locks);
    await settle(); browser.lose()(new Error('Lock service unavailable')); await settle();
    expect(p.instance.state).toBe('error');
    expect(p.instance.primary).toBe(false);
    expect(browser.calls).toHaveLength(1);
    p.instance.start(); await settle(); expect(p.instance.primary).toBe(true);
    p.instance.stop(); await settle();
});

test('suspension recovery queues behind another owner without stealing its lock', async () => {
    const browser = suspendingManager(), first = page(browser.locks), next = page(browser.locks);
    await settle(); const reject = browser.lose(); await settle();
    expect(next.instance.primary).toBe(true);
    reject(); await settle();
    expect(first.instance.primary).toBe(false);
    expect(first.instance.state).toBe('secondary');
    expect(next.instance.primary).toBe(true);
    next.instance.stop(); await settle();
    expect(first.instance.primary).toBe(true);
    first.instance.stop(); await settle();
});

test('a stopped attempt cannot reacquire on a late suspension rejection', async () => {
    const browser = suspendingManager(), p = page(browser.locks);
    await settle(); const reject = browser.lose();
    p.instance.stop(); p.instance.start(); await settle();
    const states = [...p.states];
    reject(); await settle();
    expect(p.states).toEqual(states);
    expect(p.instance.primary).toBe(true);
    expect(browser.calls).toHaveLength(2);
    p.instance.stop(); await settle();
});

test('canonical aliases share a lock while self-hosted bases and storage namespaces remain distinct', () => {
    expect(appInstanceLock('https://example.test/app', '')).toBe(appInstanceLock('https://example.test/next.html', ''));
    expect(appInstanceLock('https://example.test/one/index.html', '')).not.toBe(appInstanceLock('https://example.test/two/index.html', ''));
    expect(appInstanceLock('https://example.test/app', 'one')).not.toBe(appInstanceLock('https://example.test/app', 'two'));
});
