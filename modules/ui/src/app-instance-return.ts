import { APP_INSTANCE_MARK } from './app-instance';

/** This helper only focuses a browser-owned client; it never opens or navigates one. */
export function prepareInstanceReturn(base: string): Promise<ServiceWorkerRegistration | undefined> {
    if (!navigator.serviceWorker) return Promise.resolve(undefined);
    const url = new URL('connect-port/worker.js', base);
    const scope = new URL('.', url).href;
    return new Promise(resolve => {
        let settled = false;
        let unwatch = () => {};
        const finish = (registration?: ServiceWorkerRegistration) => {
            if (settled) return;
            settled = true; clearTimeout(timer); unwatch(); resolve(registration);
        };
        const timer = setTimeout(() => finish(), 2500);
        void navigator.serviceWorker.getRegistration(url.href).then(async found => {
            if (settled) return;
            // getRegistration also returns a broader root/offline worker. Only
            // the narrowly scoped Connect worker implements this message.
            const existing = found?.scope === scope && found.active?.scriptURL === url.href ? found : undefined;
            if (existing?.active) { void existing.update().catch(() => {}); finish(existing); return; }
            const registration = await navigator.serviceWorker.register(url.href, {
                scope, updateViaCache: 'none'
            });
            if (settled) return;
            const worker = registration.installing ?? registration.waiting;
            if (registration.active) { finish(registration); return; }
            if (!worker) { finish(); return; }
            const activated = () => {
                if (worker.state === 'activated' || worker.state === 'redundant') {
                    worker.removeEventListener('statechange', activated);
                    finish(worker.state === 'activated' ? registration : undefined);
                }
            };
            unwatch = () => worker.removeEventListener('statechange', activated);
            worker.addEventListener('statechange', activated); activated();
        }).catch(() => finish());
    });
}

async function instanceRequest<T>(registration: Promise<ServiceWorkerRegistration | undefined>, request: Record<string, string>,
    read: (data: Record<string, unknown>) => T | undefined, signal?: AbortSignal): Promise<T | undefined> {
    if (signal?.aborted) return;
    const worker = (await registration)?.active;
    if (!worker || signal?.aborted) return;
    return new Promise(resolve => {
        const channel = new MessageChannel();
        let settled = false;
        const finish = (value?: T) => {
            if (settled) return;
            settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
            channel.port1.close(); channel.port2.close(); resolve(value);
        };
        const abort = () => {
            try { channel.port1.postMessage({ marker: APP_INSTANCE_MARK, kind: 'cancel' }); } catch {}
            finish();
        };
        const timer = setTimeout(() => finish(), 1800);
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        channel.port1.onmessage = event => {
            if (event.data?.marker !== APP_INSTANCE_MARK) return;
            const value = read(event.data);
            if (value !== undefined) finish(value);
        };
        channel.port1.onmessageerror = () => finish();
        channel.port1.start();
        try { worker.postMessage({ marker: APP_INSTANCE_MARK, ...request }, [channel.port2]); }
        catch { finish(); }
    });
}

export async function identifyInstance(registration: Promise<ServiceWorkerRegistration | undefined>): Promise<string | undefined> {
    const read = (data: Record<string, unknown>) => data.kind === 'identified' && typeof data.clientId === 'string'
        && /^[a-zA-Z0-9{}-]{1,128}$/.test(data.clientId) ? data.clientId : undefined;
    // An already active worker may be updating from a version without this
    // operation. One bounded retry can use its newly activated replacement.
    return await instanceRequest(registration, { kind: 'identify' }, read)
        ?? await instanceRequest(registration, { kind: 'identify' }, read);
}

export async function returnToInstance(registration: Promise<ServiceWorkerRegistration | undefined>, lockName: string, signal?: AbortSignal): Promise<boolean> {
    return await instanceRequest(registration, { kind: 'focus', lockName }, data =>
        data.kind === 'focused' && typeof data.ok === 'boolean' ? data.ok : undefined, signal) === true;
}
