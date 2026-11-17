import { UpdateModel } from 'models/update-model';
import { RuntimeInfo } from 'const/runtime-info';
import { Logger } from 'util/logger';
import { getStorageNamespace } from 'comp/settings/storage-namespace';
import { isLocalHtml } from 'comp/browser/local-html';

const logger = new Logger('service-worker');

const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;
const UPDATE_ACTIVATION_TIMEOUT = 2500;
let cancelUpdate: (() => void) | undefined;

function supported(): boolean {
    return (
        !isLocalHtml() &&
        'serviceWorker' in navigator &&
        window.isSecureContext &&
        /^https?:$/.test(location.protocol) &&
        !RuntimeInfo.devMode &&
        !getStorageNamespace()
    );
}

const ServiceWorkerClient = {
    registration: null as ServiceWorkerRegistration | null,
    initialized: false,

    init(): void {
        if (!supported() || this.initialized) {
            return;
        }
        this.initialized = true;
        const scriptURL = new URL('service-worker.js', document.baseURI).href;
        const scope = new URL('.', scriptURL).href;
        const prepared = this.registration;
        const registration = prepared?.scope === scope && [prepared.active, prepared.waiting, prepared.installing].some(worker => worker?.scriptURL === scriptURL)
            ? Promise.resolve(prepared) : navigator.serviceWorker.register(scriptURL, { scope, updateViaCache: 'none' });
        registration
            .then((registration) => {
                this.registration = registration;
                void navigator.serviceWorker.ready.then((ready) => {
                    if (ready.scope === scope) ready.active?.postMessage({ type: 'cache-page', url: location.href });
                }).catch(() => {});
                const changed = () => this.updateReady();
                navigator.serviceWorker.addEventListener('controllerchange', changed);
                this.updateReady();
                const watched = new Set<ServiceWorker>();
                const watchInstalling = () => {
                    const worker = registration.installing;
                    if (!worker || watched.has(worker)) return;
                    watched.add(worker);
                    worker?.addEventListener('statechange', () => {
                        if (worker.state === 'installed' || worker.state === 'activated' || worker.state === 'redundant') {
                            this.updateReady();
                        }
                    });
                };
                registration.addEventListener('updatefound', watchInstalling);
                watchInstalling();
                setInterval(() => {
                    registration.update().catch(() => {});
                }, UPDATE_CHECK_INTERVAL);
            })
            .catch((err: unknown) => { this.initialized = false; logger.warn('Registration failed', err); });
    },

    updateReady(): void {
        if (isLocalHtml()) { UpdateModel.set({ updateStatus: null }); return; }
        const waiting = this.registration?.waiting;
        const scriptURL = new URL('service-worker.js', document.baseURI).href;
        const ready = this.registration?.scope === new URL('.', scriptURL).href && waiting?.scriptURL === scriptURL &&
            !!navigator.serviceWorker.controller && navigator.serviceWorker.controller !== waiting;
        UpdateModel.set({
            updateStatus: ready ? 'ready' : null
        });
    },

    // Consent is valid only while the caller remains safe and mounted.
    applyUpdate(canReload: () => boolean = () => true): () => void {
        if (isLocalHtml()) { cancelUpdate?.(); return () => {}; }
        if (cancelUpdate) return cancelUpdate;
        if (!canReload()) return () => {};
        const waiting = this.registration?.waiting;
        const scriptURL = new URL('service-worker.js', document.baseURI).href;
        if (!waiting || waiting.scriptURL !== scriptURL || this.registration?.scope !== new URL('.', scriptURL).href) {
            this.updateReady();
            return () => {};
        }
        const container = navigator.serviceWorker;
        const deadline = Date.now() + UPDATE_ACTIVATION_TIMEOUT;
        const cancel = () => {
            clearTimeout(timer);
            container.removeEventListener('controllerchange', controlled);
            waiting.removeEventListener('statechange', changed);
            window.removeEventListener('pagehide', cancel);
            if (cancelUpdate === cancel) cancelUpdate = undefined;
        };
        const controlled = () => {
            if (isLocalHtml() || !canReload() || Date.now() >= deadline) { cancel(); return; }
            if (container.controller !== waiting) return;
            cancel();
            location.reload();
        };
        const changed = () => { if (waiting.state === 'redundant') cancel(); };
        const timer = setTimeout(cancel, UPDATE_ACTIVATION_TIMEOUT);
        cancelUpdate = cancel;
        container.addEventListener('controllerchange', controlled);
        waiting.addEventListener('statechange', changed);
        window.addEventListener('pagehide', cancel);
        try { waiting.postMessage({ type: 'skip-waiting' }); } catch { cancel(); }
        return cancel;
    }
};

export { ServiceWorkerClient };
