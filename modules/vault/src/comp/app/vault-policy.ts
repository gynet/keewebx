import { AppSettingsModel } from 'models/app-settings-model';
import { Storage } from 'storage';

/** Host policy is checked again by actions, including after asynchronous work. */
export function canOpenProvider(name: string): boolean {
    const provider = Storage[name] as { enabled?: boolean; system?: boolean } | undefined;
    return AppSettingsModel.canOpenStorage !== false && !!provider && !provider.system && provider.enabled === true &&
        (AppSettingsModel as unknown as Record<string, unknown>)[name] !== false;
}

export function assertVaultPolicy(action: 'open' | 'demo' | 'export' | 'provider', provider?: string): void {
    const allowed = action === 'provider' ? canOpenProvider(provider || '')
        : action === 'open' ? AppSettingsModel.canOpen !== false
            : action === 'demo' ? AppSettingsModel.canOpenDemo !== false : AppSettingsModel.canSaveTo !== false;
    if (!allowed) throw new Error('This action is disabled by the host.');
}
