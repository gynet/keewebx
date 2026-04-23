// Web-only shortcuts helper. The desktop/Electron global-shortcut wiring
// (Launcher.setGlobalShortcuts, OS-level hotkeys) was stripped with
// Electron; everything here is the cosmetic "render a key symbol in a
// template" path that the UI still needs in web mode.
//
// History: this file was originally stubbed in commit a436c401 along
// with settings-store.ts / settings-manager.ts. The 2026-04-09 TL audit
// classified it OK-DESKTOP because most methods were genuinely desktop-
// only, but missed that `shiftShortcutSymbol` is called by
// select-entry-view.ts:156 on every browser-extension autofill (the
// entry picker template). The missing method made findEntry throw
// `TypeError: K.shiftShortcutSymbol is not a function`, killing every
// autofill request after permissions were cached. Fix: restore the
// full symbol + keyEvent helper set from upstream 2cafd5a9, drop only
// the `Launcher.setGlobalShortcuts(...)` line inside setGlobalShortcut
// (that was the Electron IPC call). Rule 7 stub audit should have
// caught this; it didn't because the stub had *some* methods, so a
// grep for "// Stub" alone doesn't reveal which methods are missing
// relative to their callers.
import { Features } from 'util/features';

interface KeyEventShortcut {
    value: string;
    valid: boolean;
}

const Shortcuts = {
    init(): void {},
    setGlobalShortcut(_key?: string): void {},
    screenCaptureParam: null as string | null,

    actionShortcutSymbol(_html?: boolean): string {
        return Features.isMac ? '⌘' : 'Ctrl';
    },
    altShortcutSymbol(_html?: boolean): string {
        return Features.isMac ? '⌥' : 'Alt';
    },
    shiftShortcutSymbol(_html?: boolean): string {
        return Features.isMac ? '⇧' : 'Shift';
    },
    ctrlShortcutSymbol(_html?: boolean): string {
        return Features.isMac ? '⌃' : 'Ctrl';
    },

    // Used by select-entry-view and the OTP QR reader alert body. Kept
    // minimal — web builds do not expose configurable global shortcuts,
    // so this always returns empty.
    globalShortcutText(_type?: string): string {
        return '';
    },

    // settings-shortcuts-view.ts:94-95 calls both of these when the
    // user opens the Settings → Shortcuts panel. The panel is legacy
    // desktop UI and should not be shown in web mode, but a stray
    // caller would crash the whole view if these were missing. Both
    // return a safe "no shortcut" value.
    keyEventToShortcut(_event: KeyboardEvent): KeyEventShortcut {
        return { value: '', valid: false };
    },
    presentShortcut(_shortcutValue: string): string {
        return '';
    },

    // Web builds cannot take screenshots programmatically; kept as
    // stub so legacy OTP QR reader alert body can safely query it.
    screenshotToClipboardShortcut(): string {
        return '';
    }
};
export { Shortcuts };
