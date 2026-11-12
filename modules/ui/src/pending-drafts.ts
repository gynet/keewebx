import { useEffect, useRef } from 'preact/hooks';
import { t } from './i18n';

interface PendingDraft {
    scope?: string;
    dirty: boolean;
    save: () => boolean | void;
    discard: () => void;
}

const pending = new Set<{ current: PendingDraft }>();

export function usePendingDraft(dirty: boolean, save: PendingDraft['save'], discard: () => void, scope?: string): void {
    const reference = useRef<PendingDraft>({ dirty, save, discard });
    reference.current = { dirty, save, discard, scope };
    useEffect(() => {
        pending.add(reference);
        return () => { pending.delete(reference); };
    }, []);
}

export function hasPendingDrafts(): boolean {
    return [...pending].some((reference) => reference.current.dirty);
}

export function savePendingDrafts(): void {
    for (const reference of pending) {
        if (reference.current.dirty) {
            if (reference.current.save() === false) {
                throw new Error('Resolve the invalid fields before locking the vault.');
            }
            reference.current.dirty = false;
        }
    }
}

export function discardPendingDrafts(scope?: string): void {
    for (const reference of pending) {
        if ((!scope || reference.current.scope === scope) && reference.current.dirty) {
            reference.current.discard();
            reference.current.dirty = false;
        }
    }
}

export function confirmDiscardDrafts(scope?: string): boolean {
    const selected = [...pending].filter((reference) => !scope || reference.current.scope === scope);
    if (!selected.some((reference) => reference.current.dirty)) return true;
    if (!window.confirm(t('Discard unsaved changes?'))) return false;
    discardPendingDrafts(scope);
    return true;
}
