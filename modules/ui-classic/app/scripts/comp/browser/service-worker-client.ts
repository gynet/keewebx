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

    init(): void {
        if (!supported()) {
            return;
        }
        navigator.serviceWorker
            .register('service-worker.js', { updateViaCache: 'none' })
            .then((registration) => {
                this.registration = registration;
                void navigator.serviceWorker.ready.then((ready) =>
                    ready.active?.postMessage({ type: 'cache-page', url: location.href })
                );
                if (registration.waiting && navigator.serviceWorker.controller) {
                    this.updateReady();
                }
                registration.addEventListener('updatefound', () => {
                    const worker = registration.installing;
                    worker?.addEventListener('statechange', () => {
                        // Only an update when a previous version controls the page.
                        if (worker.state === 'installed' && navigator.serviceWorker.controller) {
                            this.updateReady();
                        }
                    });
                });
                setInterval(() => {
                    registration.update().catch(() => {});
                }, UPDATE_CHECK_INTERVAL);
            })
            .catch((err: unknown) => logger.warn('Registration failed', err));
    },

    updateReady(): void {
        (UpdateModel as unknown as { set(p: Record<string, unknown>): void }).set({
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
