import { describe, test, expect, mock } from 'bun:test';
import type { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';
import { createNewProtocolUi } from '../src/extension-ui';
import type { ConnectPrompt } from 'comp/extension/protocol-ui';

const input: ConnectPrompt = {
    extensionName: 'Test extension', identityVerified: true,
    files: [{ id: 'one', name: 'Database', checked: true }],
    allFiles: true, askGet: 'multiple', offerList: true, canList: true
};
const approval = { allFiles: true, files: ['one'], askGet: 'always', canList: true };
function setup(blocked = () => false) {
    const model = { files: { hasOpenFiles: () => true, filter: () => [] } } as unknown as AppModel;
    const ui = createNewProtocolUi(model, blocked);
    return { ui, access: getSessionAccess(model), signal: new AbortController() };
}

describe('New protocol UI lifetime', () => {
    test('no host, another dialog or a suspended session cannot approve', async () => {
        const { ui, signal, access } = setup();
        expect(await ui.connect(input, signal.signal)).toBeNull();
        const unmount = ui.mount();
        access.beginSecuring();
        expect(await ui.connect(input, signal.signal)).toBeNull();
        unmount();
        const blocked = setup(() => true);
        blocked.ui.mount();
        expect(await blocked.ui.connect(input, blocked.signal.signal)).toBeNull();
    });
    test('explicit choice resolves once and releases the prompt', async () => {
        const { ui, signal } = setup(); ui.mount();
        const result = ui.connect(input, signal.signal);
        const pending = ui.prompt;
        if (pending?.kind !== 'connect') throw new Error('Missing prompt');
        pending.complete(approval);
        pending.complete(null);
        expect(await result).toEqual(approval);
        expect(ui.prompt).toBeNull();
    });
    test('aborting clears the host synchronously and rejects late approval', async () => {
        const { ui, signal } = setup(); ui.mount();
        const result = ui.connect(input, signal.signal);
        const pending = ui.prompt;
        const observed = mock(() => { expect(ui.prompt).toBeNull(); });
        ui.subscribe(observed);
        signal.abort();
        expect(observed).toHaveBeenCalledTimes(1);
        if (pending?.kind === 'connect') pending.complete(approval);
        expect(await result).toBeNull();
    });
    test('host unmount cancels and pre-aborted input never appears', async () => {
        const { ui, signal } = setup(); const unmount = ui.mount();
        const result = ui.connect(input, signal.signal);
        unmount();
        expect(await result).toBeNull();
        ui.mount(); signal.abort();
        expect(await ui.connect(input, signal.signal)).toBeNull();
        expect(ui.prompt).toBeNull();
    });
    test('concurrent requests do not replace a pending decision', async () => {
        const { ui, signal } = setup(); ui.mount();
        const first = ui.connect(input, signal.signal);
        const pending = ui.prompt;
        expect(await ui.connect(input, signal.signal)).toBeNull();
        expect(ui.prompt).toBe(pending);
        ui.cancel(); expect(await first).toBeNull();
    });
    test('stale UI callbacks cannot settle a subsequent request', async () => {
        const { ui, signal } = setup(); ui.mount();
        const first = ui.connect(input, signal.signal);
        const old = ui.prompt;
        ui.cancel(); expect(await first).toBeNull();
        const second = ui.connect(input, signal.signal);
        const current = ui.prompt;
        expect(old?.id).not.toBe(current?.id);
        if (old?.kind === 'connect') old.complete(approval);
        expect(ui.prompt).toBe(current);
        ui.cancel(); expect(await second).toBeNull();
    });
    test('a captured gate epoch is checked when the user responds', async () => {
        const { ui, signal, access } = setup(); ui.mount();
        const result = ui.connect(input, signal.signal);
        const pending = ui.prompt;
        access.beginSecuring();
        expect(ui.prompt).toBeNull();
        if (pending?.kind === 'connect') pending.complete(approval);
        expect(await result).toBeNull();
    });
    test('touch cancel and disposal are distinct, idempotent lifetimes', () => {
        const { ui, signal } = setup(); ui.mount();
        const canceled = mock(() => {});
        const touch = ui.showTouch({ deviceShortName: 'Key' }, canceled, signal.signal);
        touch.dispose(); touch.dispose(); signal.abort();
        expect(canceled).not.toHaveBeenCalled();
        const nextSignal = new AbortController();
        const next = ui.showTouch({ deviceShortName: 'Key' }, canceled, nextSignal.signal);
        nextSignal.abort(); next.dispose();
        expect(canceled).toHaveBeenCalledTimes(1);
        expect(ui.prompt).toBeNull();
    });
});
