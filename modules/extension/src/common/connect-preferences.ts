/** Host-independent presentation preferences, shared by Connect clients. */
export interface ConnectPreferences {
    autoFillSingle: boolean;
}

export interface ConnectPreferenceStore {
    load(): Promise<ConnectPreferences>;
    save(preferences: ConnectPreferences): Promise<void>;
}

export const defaultConnectPreferences: Readonly<ConnectPreferences> = { autoFillSingle: false };

export function parseConnectPreferences(value: unknown): ConnectPreferences {
    const stored = value as Partial<ConnectPreferences> | null;
    return { autoFillSingle: stored?.autoFillSingle === true };
}
