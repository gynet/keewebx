import { isLocalHtml } from 'comp/browser/local-html';

export interface StartupUpdateOptions {
    container: ServiceWorkerContainer;
    scriptURL: string;
    isCurrent(): boolean;
    onRegistration?(registration: ServiceWorkerRegistration): void;
    signal?: AbortSignal;
    timeoutMs?: number;
}

/** Check the web shell before constructing a vault. Offline startup stays bounded. */
export function checkStartupUpdate(options: StartupUpdateOptions): Promise<'continue'> {
    if (isLocalHtml()) return Promise.resolve('continue');
    const { container, signal } = options;
    const url = new URL(options.scriptURL);
    const scope = new URL('.', url).href;
    const hadController = !!container.controller;
    const budget = options.timeoutMs ?? 2500;
    const deadline = Date.now() + budget;
    return new Promise(resolve => {
        let settled = false;
        let registration: ServiceWorkerRegistration | undefined;
        const cleanups: (() => void)[] = [];
        const watched = new Set<ServiceWorker>();
        const live = () => !settled && !signal?.aborted && Date.now() < deadline;
        const finish = () => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            for (const cleanup of cleanups) cleanup();
            resolve('continue');
        };
        const timer = setTimeout(() => finish(), Math.max(0, budget));
        const abort = () => finish();
        signal?.addEventListener('abort', abort, { once: true });
        cleanups.push(() => signal?.removeEventListener('abort', abort));
        if (signal?.aborted) { finish(); return; }
        const inspect = () => {
            if (!live() || !registration) return;
            if (registration.waiting) {
                // The regular update notice handles explicit user consent.
                finish();
                return;
            }
            const worker = registration.installing;
            if (worker && worker.scriptURL !== url.href) { finish(); return; }
            if (worker && !watched.has(worker)) {
                watched.add(worker);
                const changed = () => {
                    if (!live()) return;
                    if (worker.state === 'redundant') { finish(); return; }
                    inspect();
                };
                worker.addEventListener('statechange', changed);
                cleanups.push(() => worker.removeEventListener('statechange', changed));
            }
        };
        void (async () => {
            if (!live() || !options.isCurrent()) { finish(); return; }
            const existing = await container.getRegistration(url.href);
            if (!live()) return;
            if (!options.isCurrent()) { finish(); return; }
            const matches = existing?.scope === scope && [existing.active, existing.waiting, existing.installing]
                .some(worker => worker?.scriptURL === url.href);
            registration = matches ? existing : await container.register(url.href, { scope, updateViaCache: 'none' });
            if (!live()) return;
            if (!options.isCurrent()) { finish(); return; }
            options.onRegistration?.(registration);
            const found = () => inspect();
            registration.addEventListener('updatefound', found);
            cleanups.push(() => registration?.removeEventListener('updatefound', found));
            inspect();
            if (!live()) return;
            // A first, uncontrolled visit already loaded its shell from the
            // network. Its initial offline precache need not delay unlocking.
            if (!hadController) { finish(); return; }
            if (registration.installing) return;
            await registration.update();
            if (!live()) return;
            inspect();
            if (!registration.installing) finish();
        })().catch(() => finish());
    });
}
