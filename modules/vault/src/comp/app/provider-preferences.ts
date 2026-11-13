import { AppSettingsModel } from 'models/app-settings-model';
import { Storage } from 'storage';
interface SessionProvider { deleteStoredToken(): unknown; }
/** Clear every provider, including disabled ones; one failure must not skip the rest. */
export async function setShortLivedProviderSessions(enabled: boolean, providers: Record<string, SessionProvider> = Storage as unknown as Record<string, SessionProvider>): Promise<void> {
    AppSettingsModel.shortLivedStorageToken = enabled;
    if (!enabled) return;
    const results = await Promise.allSettled(Object.values(providers).map(provider => Promise.resolve().then(() => provider.deleteStoredToken())));
    if (results.some(result => result.status === 'rejected')) throw new Error('Provider session cleanup failed.');
}
