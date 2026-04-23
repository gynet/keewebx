import { Model } from 'framework/model';
import { SettingsStore } from 'comp/settings/settings-store';

interface UpdateModelProperties {
    lastSuccessCheckDate: Date | null;
    lastCheckDate: Date | null;
    lastVersion: string | null;
    lastVersionReleaseDate: Date | null;
    lastCheckError: string | null;
    lastCheckUpdMin: number | null;
    status: string | null;
    updateStatus: string | null;
    updateError: string | null;
    updateManual: boolean;
}

class UpdateModel extends Model {
    declare lastSuccessCheckDate: Date | null;
    declare lastCheckDate: Date | null;
    declare lastVersion: string | null;
    declare lastVersionReleaseDate: Date | null;
    declare lastCheckError: string | null;
    declare lastCheckUpdMin: number | null;
    declare status: string | null;
    declare updateStatus: string | null;
    declare updateError: string | null;
    declare updateManual: boolean;

    load(): Promise<void> {
        return SettingsStore.load('update-info').then((data) => {
            if (data && typeof data === 'object') {
                const record = data as Record<string, unknown>;
                try {
                    for (const [key, val] of Object.entries(record)) {
                        if (/Date$/.test(key)) {
                            record[key] = val ? new Date(val as string | number) : null;
                        }
                    }
                    this.set(record, { silent: true });
                } catch {
                    /* failed to load model */
                }
            }
        });
    }

    save(): void {
        const attr: Record<string, unknown> = { ...(this as unknown as Record<string, unknown>) };
        for (const key of Object.keys(attr)) {
            if (key.lastIndexOf('update', 0) === 0) {
                delete attr[key];
            }
        }
        SettingsStore.save('update-info', attr);
    }
}

UpdateModel.defineModelProperties({
    lastSuccessCheckDate: null,
    lastCheckDate: null,
    lastVersion: null,
    lastVersionReleaseDate: null,
    lastCheckError: null,
    lastCheckUpdMin: null,
    status: null,
    updateStatus: null,
    updateError: null,
    updateManual: false
});

const instance = new UpdateModel();

export { instance as UpdateModel };
export type { UpdateModelProperties };
