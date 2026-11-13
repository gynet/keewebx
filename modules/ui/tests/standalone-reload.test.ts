import { test, expect } from 'bun:test';
import { requestStandaloneReload, type ReloadSnapshot } from '../src/standalone-reload-guard';

test('standalone reload refuses open vaults, drafts, recovery, securing and a normal browser', () => {
    for (const blocked of [{ standalone: false }, { openVaults: true }, { drafts: true }, { phase: 'securing' }, { phase: 'recovery-required' }]) {
        let prompted = false, reloaded = false;
        requestStandaloneReload(() => ({ standalone: true, openVaults: false, drafts: false, phase: 'closed', epoch: 2, ...blocked }),
            () => true, () => { prompted = true; return true; }, () => { reloaded = true; });
        expect(prompted).toBe(false); expect(reloaded).toBe(false);
    }
});
test('cancel, detached controls and session changes during confirmation cannot reload', () => {
    for (const outcome of ['cancel', 'unmount', 'epoch', 'draft', 'open', 'reload']) {
        const state: ReloadSnapshot = { standalone: true, openVaults: false, drafts: false, phase: 'closed', epoch: 2 };
        let mounted = true, count = 0;
        requestStandaloneReload(() => ({ ...state }), () => mounted, () => {
            if (outcome === 'unmount') mounted = false;
            if (outcome === 'epoch') state.epoch++;
            if (outcome === 'draft') state.drafts = true;
            if (outcome === 'open') state.openVaults = true;
            return outcome !== 'cancel';
        }, () => { count++; });
        expect(count).toBe(outcome === 'reload' ? 1 : 0);
    }
});
