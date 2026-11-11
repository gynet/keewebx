import { AppSettingsModel } from 'models/app-settings-model';
import { RuntimeDataModel } from 'models/runtime-data-model';
import { Logger } from 'util/logger';

class StorageBase {
    name: string | null = null;
    icon: string | null = null;
    enabled: boolean = false;
    system: boolean = false;
    uipos: number | null = null;

    logger: Logger | null = null;
    appSettings: typeof AppSettingsModel = AppSettingsModel;
    runtimeData: typeof RuntimeDataModel = RuntimeDataModel;

    init(): this {
        if (!this.name) {
            throw 'Failed to init provider: no name';
        }
        if (!this.system) {
            const enabled = (this.appSettings as unknown as Record<string, unknown>)[this.name];
            if (typeof enabled === 'boolean') {
                this.enabled = enabled;
            }
        }
        this.logger = new Logger('storage-' + this.name);
        return this;
    }

    get loggedIn(): boolean {
        return false;
    }

    setEnabled(enabled: boolean): void {
        this.enabled = enabled;
    }

    logout(): void {}

    deleteStoredToken(): void {}
}

export { StorageBase };
