import { AppSettingsModel } from 'models/app-settings-model';
import { RuntimeDataModel } from 'models/runtime-data-model';

// AppSettingsModel and RuntimeDataModel are class instances exposing
// dynamic properties via Object.defineProperty in framework/model.ts.
// TS sees them as their nominal class type and rejects direct
// `Record<string, unknown>` casts because the class shapes don't
// overlap structurally. We cast through `unknown` (the TS-recommended
// escape hatch for cross-shape conversions) so the dynamic property
// access works without further per-key annotation.
const settingsBag = AppSettingsModel as unknown as Record<string, unknown>;
const runtimeBag = RuntimeDataModel as unknown as Record<string, unknown>;

const ExportApi = {
    settings: {
        get(key?: string): unknown {
            return key ? settingsBag[key] : { ...settingsBag };
        },
        set(key: string, value: unknown): void {
            settingsBag[key] = value;
        },
        del(key: string): void {
            delete settingsBag[key];
        }
    },
    runtimeData: {
        get(key?: string): unknown {
            return key ? runtimeBag[key] : { ...runtimeBag };
        },
        set(key: string, value: unknown): void {
            runtimeBag[key] = value;
        },
        del(key: string): void {
            delete runtimeBag[key];
        }
    }
};

export { ExportApi };
