import { UpdateModel } from 'models/update-model';
import { RuntimeInfo } from 'const/runtime-info';
import { Logger } from 'util/logger';
import { getStorageNamespace } from 'comp/settings/storage-namespace';

const logger = new Logger('service-worker');

const UPDATE_CHECK_INTERVAL = 60 * 60 * 1000;

function supported(): boolean {
    return (
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
        const prepared = this.registration;
        const registration = prepared && [prepared.active, prepared.waiting, prepared.installing].some(worker => worker?.scriptURL === scriptURL)
            ? Promise.resolve(prepared) : navigator.serviceWorker.register(scriptURL, { updateViaCache: 'none' });
        registration
            .then((registration) => {
                this.registration = registration;
                void navigator.serviceWorker.ready.then((ready) =>
                    ready.active?.postMessage({ type: 'cache-page', url: location.href })
                );
                if (registration.waiting && navigator.serviceWorker.controller) {
                    this.updateReady();
                }
                const watched = new Set<ServiceWorker>();
                const watchInstalling = () => {
                    const worker = registration.installing;
                    if (!worker || watched.has(worker)) return;
                    watched.add(worker);
                    worker?.addEventListener('statechange', () => {
                        // Only an update when a previous version controls the page.
                        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
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
        UpdateModel.set({
            updateStatus: 'ready'
        });
    },

    // Switches to the waiting version and reloads once it is in control.
    applyUpdate(): void {
        const waiting = this.registration?.waiting;
        if (!waiting) {
            location.reload();
            return;
        }
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), {
            once: true
        });
        waiting.postMessage({ type: 'skip-waiting' });
    }
};

export { ServiceWorkerClient };
