import { Model } from 'framework/model';
import { SettingsStore } from 'comp/settings/settings-store';

class RuntimeDataModel extends Model {
    constructor() {
        super();
        this.on('change', () => this.save());
    }

    load(): Promise<void> {
        return SettingsStore.load('runtime-data').then((data) => {
            if (data && typeof data === 'object') {
                this.set(data as Record<string, unknown>, { silent: true });
            }
        });
    }

    save(): void {
        SettingsStore.save('runtime-data', this);
    }
}

RuntimeDataModel.defineModelProperties({}, { extensions: true });

const instance = new RuntimeDataModel();
(window as unknown as Record<string, unknown>).RuntimeDataModel = instance;

export { instance as RuntimeDataModel };
