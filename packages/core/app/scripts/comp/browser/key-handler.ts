import { Events } from 'framework/events';
import { IdleTracker } from 'comp/browser/idle-tracker';
import { Keys } from 'const/keys';
import { FocusManager } from 'comp/app/focus-manager';

const shortcutKeyProp: 'metaKey' | 'ctrlKey' =
    navigator.platform.indexOf('Mac') >= 0 ? 'metaKey' : 'ctrlKey';

// jQuery-wrapped keyboard event. We bind via `$(document).bind('keypress',
// ...)` so handlers receive the jQuery event object, not a native one.
// `@types/jquery` is intentionally not in devDependencies (no project
// uses jQuery types directly), so we declare a minimal local shim of
// the jQuery event surface we actually use. Migrating away from jQuery
// is a Phase 2 view-layer task, not in scope here.
interface JQueryKeyEvent {
    keyCode?: number;
    which?: number;
    metaKey?: boolean;
    ctrlKey?: boolean;
    shiftKey?: boolean;
    altKey?: boolean;
    target?: EventTarget | null;
    preventDefault(): void;
    stopPropagation(): void;
    stopImmediatePropagation(): void;
    isImmediatePropagationStopped(): boolean;
}

interface KeyShortcut {
    handler: (e: JQueryKeyEvent, code?: number) => void;
    thisArg: unknown;
    shortcut: number;
    modal: unknown;
    noPrevent?: boolean;
}

class KeyHandler {
    SHORTCUT_ACTION = 1;
    SHORTCUT_OPT = 2;
    SHORTCUT_SHIFT = 4;

    shortcuts: Record<number, KeyShortcut[]> = {};

    init(): void {
        $(document).bind('keypress', this.keypress.bind(this));
        $(document).bind('keydown', this.keydown.bind(this));

        this.shortcuts[Keys.DOM_VK_A] = [
            {
                handler: this.handleAKey,
                thisArg: this,
                shortcut: this.SHORTCUT_ACTION,
                modal: true,
                noPrevent: true
            }
        ];
    }

    onKey(
        key: number,
        handler: (e: JQueryKeyEvent, code?: number) => void,
        thisArg: unknown,
        shortcut: number,
        modal?: unknown,
        noPrevent?: boolean
    ): void {
        let keyShortcuts = this.shortcuts[key];
        if (!keyShortcuts) {
            this.shortcuts[key] = keyShortcuts = [];
        }
        keyShortcuts.push({
            handler,
            thisArg,
            shortcut,
            modal,
            noPrevent
        });
    }

    offKey(
        key: number,
        handler: (e: JQueryKeyEvent, code?: number) => void,
        thisArg: unknown
    ): void {
        if (this.shortcuts[key]) {
            this.shortcuts[key] = this.shortcuts[key].filter(
                (sh) => sh.handler !== handler || sh.thisArg !== thisArg
            );
        }
    }

    isActionKey(e: JQueryKeyEvent): boolean {
        return !!(e as unknown as Record<string, boolean>)[shortcutKeyProp];
    }

    keydown(e: JQueryKeyEvent): void {
        IdleTracker.regUserAction();
        const code = e.keyCode || e.which;
        if (code === undefined) {
            return;
        }
        const keyShortcuts = this.shortcuts[code];
        if (keyShortcuts && keyShortcuts.length) {
            for (const sh of keyShortcuts) {
                if (FocusManager.modal && sh.modal !== FocusManager.modal && sh.modal !== '*') {
                    e.stopPropagation();
                    continue;
                }
                const isActionKey = this.isActionKey(e);
                switch (sh.shortcut) {
                    case this.SHORTCUT_ACTION:
                        if (!isActionKey) {
                            continue;
                        }
                        break;
                    case this.SHORTCUT_OPT:
                        if (!e.altKey) {
                            continue;
                        }
                        break;
                    case this.SHORTCUT_SHIFT:
                        if (!e.shiftKey) {
                            continue;
                        }
                        break;
                    case this.SHORTCUT_ACTION + this.SHORTCUT_OPT:
                        if (!e.altKey || !isActionKey) {
                            continue;
                        }
                        break;
                    default:
                        if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) {
                            continue;
                        }
                        break;
                }
                sh.handler.call(sh.thisArg, e, code);
                if (isActionKey && !sh.noPrevent) {
                    e.preventDefault();
                }
                if (e.isImmediatePropagationStopped()) {
                    break;
                }
            }
        }
    }

    keypress(e: JQueryKeyEvent): void {
        if (
            !FocusManager.modal &&
            e.which !== Keys.DOM_VK_RETURN &&
            e.which !== Keys.DOM_VK_ESCAPE &&
            e.which !== Keys.DOM_VK_TAB &&
            !e.altKey &&
            !e.ctrlKey &&
            !e.metaKey
        ) {
            Events.emit('keypress', e);
        } else if (FocusManager.modal) {
            Events.emit('keypress:' + FocusManager.modal, e);
        }
    }

    reg(): void {
        IdleTracker.regUserAction();
    }

    handleAKey(e: JQueryKeyEvent): void {
        const target = e.target as HTMLInputElement;
        if (
            target.tagName.toLowerCase() === 'input' &&
            ['password', 'text'].indexOf(target.type) >= 0
        ) {
            e.stopImmediatePropagation();
        } else {
            e.preventDefault();
        }
    }
}

const instance = new KeyHandler();

export { instance as KeyHandler };
