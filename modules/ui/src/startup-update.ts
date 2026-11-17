import { isLocalHtml } from 'comp/browser/local-html';

export interface StartupUpdateOptions {
    container: ServiceWorkerContainer;
    scriptURL: string;
    reload(): void;
    canReload(): boolean;
    onRegistration?(registration: ServiceWorkerRegistration): void;
    signal?: AbortSignal;
    timeoutMs?: number;
}

/** Check the web shell before constructing a vault. Offline startup stays bounded. */
export function checkStartupUpdate(options: StartupUpdateOptions): Promise<'continue' | 'reloading'> {
    if (isLocalHtml()) return Promise.resolve('continue');
    const { container, signal } = options;
    const url = new URL(options.scriptURL);
    const scope = new URL('.', url).href;
    const hadController = !!container.controller;
    const budget = options.timeoutMs ?? 2500;
    const deadline = Date.now() + budget;
    return new Promise(resolve => {
        let settled = false;
        let activating: ServiceWorker | undefined;
        let registration: ServiceWorkerRegistration | undefined;
        const cleanups: (() => void)[] = [];
        const watched = new Set<ServiceWorker>();
        const live = () => !settled && !signal?.aborted && Date.now() < deadline;
        const finish = (result: 'continue' | 'reloading' = 'continue') => {
            if (settled) return;
            settled = true; clearTimeout(timer);
            for (const cleanup of cleanups) cleanup();
            resolve(result);
        };
        const timer = setTimeout(() => finish(), Math.max(0, budget));
        const abort = () => finish();
        signal?.addEventListener('abort', abort, { once: true });
        cleanups.push(() => signal?.removeEventListener('abort', abort));
        if (signal?.aborted) { finish(); return; }
        const controlled = () => {
            if (!live() || !activating) return;
            if (container.controller !== activating) return;
            if (!hadController || !options.canReload()) { finish(); return; }
            try { options.reload(); finish('reloading'); } catch { finish(); }
        };
        container.addEventListener('controllerchange', controlled);
        cleanups.push(() => container.removeEventListener('controllerchange', controlled));
        const inspect = () => {
            if (!live() || !registration) return;
            const waiting = registration.waiting;
            if (waiting && !activating) {
                if (waiting.scriptURL !== url.href) { finish(); return; }
                if (!options.canReload()) { finish(); return; }
                activating = waiting;
                try { waiting.postMessage({ type: 'skip-waiting' }); } catch { finish(); }
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
            if (!live() || !options.canReload()) { finish(); return; }
            const existing = await container.getRegistration(url.href);
            if (!live()) return;
            if (!options.canReload()) { finish(); return; }
            const matches = existing?.scope === scope && [existing.active, existing.waiting, existing.installing]
                .some(worker => worker?.scriptURL === url.href);
            registration = matches ? existing : await container.register(url.href, { scope, updateViaCache: 'none' });
            if (!live()) return;
            if (!options.canReload()) { finish(); return; }
            options.onRegistration?.(registration);
            const found = () => inspect();
            registration.addEventListener('updatefound', found);
            cleanups.push(() => registration?.removeEventListener('updatefound', found));
            inspect();
            if (activating) return;
            // A first, uncontrolled visit already loaded its shell from the
            // network. Its initial offline precache need not delay unlocking.
            if (!hadController) { finish(); return; }
            if (registration.installing) return;
            await registration.update();
            if (!live()) return;
            inspect();
            if (!activating && !registration.installing && !registration.waiting) finish();
        })().catch(() => finish());
    });
}
