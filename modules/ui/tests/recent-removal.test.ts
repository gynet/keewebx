import { expect, mock, test } from 'bun:test';
import type { AppModel } from '../../vault/src/models/app-model';
let complete: (error?: unknown) => void;
let canRemove: () => boolean;
mock.module('storage', () => ({ Storage: { cache: { remove: (_id: string, _opts: unknown, callback: typeof complete, check: typeof canRemove) => { complete = callback; canRemove = check; } } } }));
const { removeRecent } = await import('../src/recent-removal');
function fixture() {
    const selected = { id: 'selected' }, other = { id: 'other' };
    const infos = new Map([['selected', selected], ['other', other]]);
    const save = mock(() => {}), removed: string[] = [];
    const model = { fileInfos: { get: (id: string) => infos.get(id), remove: (id: string) => { infos.delete(id); removed.push(id); }, save },
        files: new Map(), settings: { canRemoveLatest: true } } as unknown as AppModel;
    return { model, infos, selected, other, save, removed };
}
test('aborted durable deletion preserves both recents; retry publishes removal only after completion', async () => {
    const f = fixture(), first = removeRecent(f.model, 'selected');
    expect(f.infos.size).toBe(2); expect(f.save).not.toHaveBeenCalled();
    complete(new Error('transaction aborted')); await expect(first).rejects.toThrow('transaction aborted');
    expect(f.infos.get('selected')).toBe(f.selected); expect(f.save).not.toHaveBeenCalled();
    const retry = removeRecent(f.model, 'selected'); expect(canRemove()).toBe(true); complete(); await retry;
    expect(f.removed).toEqual(['selected']); expect(f.infos.get('other')).toBe(f.other); expect(f.save).toHaveBeenCalledTimes(1);
});
test('policy revocation or record replacement before cache transaction denies deletion and recent publication', async () => {
    for (const reason of ['policy', 'replacement', 'open'] as const) {
        const f = fixture(), pending = removeRecent(f.model, 'selected');
        if (reason === 'policy') f.model.settings.canRemoveLatest = false;
        else if (reason === 'replacement') f.infos.set('selected', { id: 'replacement' });
        else (f.model.files as unknown as Map<string, object>).set('selected', { active: true });
        expect(canRemove()).toBe(false); complete(); await expect(pending).rejects.toThrow('vault changed');
        expect(f.save).not.toHaveBeenCalled(); expect(f.removed).toEqual([]);
    }
});
