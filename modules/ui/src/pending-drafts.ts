import { useEffect, useRef } from 'preact/hooks';
import { Events } from 'framework/events';
import { t } from './i18n';

interface PendingDraft {
    scope?: string;
    fileId?: string;
    dirty: boolean;
    save: (retain?: boolean) => boolean | void;
    discard: () => void;
}

const pending = new Set<{ current: PendingDraft }>();

export function usePendingDraft(dirty: boolean, save: PendingDraft['save'], discard: () => void, scope?: string, fileId?: string): void {
    const reference = useRef<PendingDraft>({ dirty, save, discard });
    reference.current = { dirty, save, discard, scope, fileId };
    useEffect(() => {
        pending.add(reference);
        return () => { pending.delete(reference); Events.emit('draft-changed'); };
    }, []);
    useEffect(() => { Events.emit('draft-changed'); }, [dirty, fileId]);
}

export function hasPendingDrafts(fileId?: string): boolean {
    return [...pending].some(({ current }) => current.dirty && (!fileId || current.fileId === fileId));
}

export function savePendingDrafts(fileId?: string, retain = false): void {
    for (const reference of pending) {
        if (reference.current.dirty && (!fileId || reference.current.fileId === fileId)) {
            if (reference.current.save(retain) === false) {
                throw new Error('Resolve the invalid fields before saving or closing the vault.');
            }
            reference.current.dirty = false;
        }
    }
}

export function discardPendingDrafts(scope?: string, fileId?: string): void {
    for (const reference of pending) {
        if ((!scope || reference.current.scope === scope) && (!fileId || reference.current.fileId === fileId) && reference.current.dirty) {
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
