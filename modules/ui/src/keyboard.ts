import type { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';

export function commandKey(event: KeyboardEvent): boolean {
    return /Mac|iPhone|iPad/.test(navigator.platform)
        ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

export function editingText(target: EventTarget | null): boolean {
    return target instanceof Element && !!target.closest('input, textarea, select, [contenteditable]:not([contenteditable=false])');
}

/** Check the live surface, not the state captured when the listener was installed. */
export function keyboardAvailable(model: AppModel, surface: HTMLElement | null, event: KeyboardEvent): boolean {
    return !event.defaultPrevented && !event.isComposing && event.keyCode !== 229 && !event.repeat
        && getSessionAccess(model).state === 'open' && model.files.hasOpenFiles()
        && !!surface?.isConnected && !surface.closest('[hidden], [inert]') && !!surface.getClientRects().length
        && !document.querySelector('dialog[open]')
        && !(event.target instanceof Element && event.target.closest('[hidden], [inert]'));
}
