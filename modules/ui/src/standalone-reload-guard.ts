export interface ReloadSnapshot { standalone: boolean; openVaults: boolean; drafts: boolean; phase: string; epoch: number }
export function reloadAllowed(state: ReloadSnapshot): boolean {
    return state.standalone && !state.openVaults && !state.drafts && (state.phase === 'open' || state.phase === 'closed');
}
/** Confirmation can run application callbacks; recheck both access and mounted state afterward. */
export function requestStandaloneReload(read: () => ReloadSnapshot, current: () => boolean, confirm: () => boolean, reload: () => void): void {
    const before = read();
    if (!current() || !reloadAllowed(before) || !confirm()) return;
    const after = read();
    if (current() && reloadAllowed(after) && before.epoch === after.epoch) reload();
}
