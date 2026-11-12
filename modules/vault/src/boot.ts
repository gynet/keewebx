/**
 * Starts the vault without any interface: loads settings and the list of
 * recent vaults, sets up key derivation and storages, and creates the app
 * model. Used by the new web app; the Classic app runs the same steps in
 * its own start-up.
 */
import 'hooks/init';
import { Events } from 'framework/events';
import { FileInfoCollection } from 'collections/file-info-collection';
import { applyRegisteredSettings } from 'const/default-app-settings';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { getRegisteredSettings } from 'hooks/data-registry';
import { AppModel } from 'models/app-model';
import { AppSettingsModel } from 'models/app-settings-model';
import { applyRegisteredFileInfoFields } from 'models/file-info-model';
import { RuntimeDataModel } from 'models/runtime-data-model';
import { applyRegisteredStorages, Storage } from 'storage';
import { KdbxwebInit } from 'util/kdbxweb/kdbxweb-init';
import { startPeriodicSync } from 'comp/app/periodic-sync';

export { saveAndLock } from 'comp/app/vault-lifecycle';

export async function startVault(): Promise<AppModel> {
    applyRegisteredSettings();
    const registered = Object.fromEntries(getRegisteredSettings());
    if (Object.keys(registered).length) {
        (AppSettingsModel as unknown as { set(p: Record<string, unknown>, o: { silent: boolean }): void }).set(
            registered,
            { silent: true }
        );
    }
    applyRegisteredFileInfoFields();
    applyRegisteredStorages();

    const appModel = new AppModel();
    await Promise.all([AppSettingsModel.load(), RuntimeDataModel.load(), FileInfoCollection.load()]);
    if (window.top !== window && !AppSettingsModel.allowIframes) {
        throw new Error('Opening the vault in a frame is disabled.');
    }
    KdbxwebInit.init();
    for (const provider of Object.values(Storage as unknown as Record<string, { init(): void }>)) {
        provider.init();
    }
    IdleTracker.init();
    startPeriodicSync(appModel);
    Events.emit('app-ready');
    return appModel;
}
