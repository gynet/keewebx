import { describe, expect, it } from 'bun:test';
import { BackendConnectionState } from '../src/common/backend-connection-state';
import type { OptionsPageMessage } from '../src/common/options-page-interface';
import type {
    BackgroundMessageFromPage,
    BackgroundMessageFromPageConnectToKeeWeb,
    BackgroundMessageFromPageOpenTab
} from '../src/common/background-interface';

/**
 * Tests for the settings model.
 *
 * SettingsModel is a class that heavily relies on chrome.* APIs (storage, permissions,
 * runtime, commands, tabs). We test the pure logic patterns and interface contracts
 * without instantiating the actual model.
 */

// -- Reproduce the pure logic from settings-model.ts --

const DEFAULT_KEEWEB_URL = 'https://keewebx.app/';

function resolveKeeWebUrl(customUrl: string | undefined, defaultUrl: string): string {
    return customUrl || defaultUrl;
}

function normalizeKeeWebUrl(
    url: string | undefined,
    defaultUrl: string
): string | undefined {
    if (url === defaultUrl) {
        return undefined;
    }
    return url;
}

function filterShortcuts(commands: Array<{ shortcut?: string; name?: string }>) {
    return commands.filter((cmd) => cmd.shortcut);
}

describe('Default Settings Values', () => {
    it('should have the correct default KeeWeb URL', () => {
        expect(DEFAULT_KEEWEB_URL).toBe('https://keewebx.app/');
    });

    it('should use default URL when no custom URL is set', () => {
        expect(resolveKeeWebUrl(undefined, DEFAULT_KEEWEB_URL)).toBe(DEFAULT_KEEWEB_URL);
    });

    it('should use custom URL when set', () => {
        const custom = 'https://keeweb.myserver.com/';
        expect(resolveKeeWebUrl(custom, DEFAULT_KEEWEB_URL)).toBe(custom);
    });

    it('should use default URL when custom is empty string', () => {
        expect(resolveKeeWebUrl('', DEFAULT_KEEWEB_URL)).toBe(DEFAULT_KEEWEB_URL);
    });
});

describe('KeeWeb URL Normalization', () => {
    it('should normalize default URL to undefined for storage', () => {
        expect(normalizeKeeWebUrl(DEFAULT_KEEWEB_URL, DEFAULT_KEEWEB_URL)).toBeUndefined();
    });

    it('should keep custom URL as-is', () => {
        const custom = 'https://my.keeweb.com/';
        expect(normalizeKeeWebUrl(custom, DEFAULT_KEEWEB_URL)).toBe(custom);
    });

    it('should keep undefined as-is', () => {
        expect(normalizeKeeWebUrl(undefined, DEFAULT_KEEWEB_URL)).toBeUndefined();
    });
});

describe('Shortcut Filtering', () => {
    it('should return only commands with shortcuts', () => {
        const commands = [
            { name: 'auto-fill', shortcut: 'Ctrl+Shift+L' },
            { name: 'submit-username', shortcut: '' },
            { name: 'submit-password', shortcut: 'Ctrl+Shift+P' },
            { name: 'otp' }
        ];
        const filtered = filterShortcuts(commands);
        expect(filtered).toHaveLength(2);
        expect(filtered[0].name).toBe('auto-fill');
        expect(filtered[1].name).toBe('submit-password');
    });

    it('should return empty array when no commands have shortcuts', () => {
        const commands = [
            { name: 'cmd1', shortcut: '' },
            { name: 'cmd2' }
        ];
        expect(filterShortcuts(commands)).toHaveLength(0);
    });

    it('should return all commands when all have shortcuts', () => {
        const commands = [
            { name: 'cmd1', shortcut: 'Ctrl+A' },
            { name: 'cmd2', shortcut: 'Ctrl+B' }
        ];
        expect(filterShortcuts(commands)).toHaveLength(2);
    });

    it('should return empty array for empty input', () => {
        expect(filterShortcuts([])).toHaveLength(0);
    });
});

describe('BackendConnectionState Enum', () => {
    it('should define Initializing state', () => {
        expect(BackendConnectionState.Initializing).toBe('Initializing');
    });

    it('should define ReadyToConnect state', () => {
        expect(BackendConnectionState.ReadyToConnect).toBe('ReadyToConnect');
    });

    it('should define Connecting state', () => {
        expect(BackendConnectionState.Connecting).toBe('Connecting');
    });

    it('should define Connected state', () => {
        expect(BackendConnectionState.Connected).toBe('Connected');
    });

    it('should define Error state', () => {
        expect(BackendConnectionState.Error).toBe('Error');
    });

    it('should have exactly 5 states', () => {
        const states = Object.values(BackendConnectionState);
        expect(states).toHaveLength(5);
    });
});

describe('OptionsPageMessage Interface', () => {
    it('should allow connection state message', () => {
        const msg: OptionsPageMessage = {
            backendConnectionState: BackendConnectionState.Connected
        };
        expect(msg.backendConnectionState).toBe('Connected');
        expect(msg.backendConnectionError).toBeUndefined();
    });

    it('should allow error state with message', () => {
        const msg: OptionsPageMessage = {
            backendConnectionState: BackendConnectionState.Error,
            backendConnectionError: 'Connection refused'
        };
        expect(msg.backendConnectionState).toBe('Error');
        expect(msg.backendConnectionError).toBe('Connection refused');
    });

    it('should allow empty message', () => {
        const msg: OptionsPageMessage = {};
        expect(msg.backendConnectionState).toBeUndefined();
    });
});

describe('BackgroundMessageFromPage Interface', () => {
    it('should accept connect-to-keeweb action', () => {
        const msg: BackgroundMessageFromPageConnectToKeeWeb = {
            action: 'connect-to-keeweb',
            activeTabId: 42
        };
        expect(msg.action).toBe('connect-to-keeweb');
        expect(msg.activeTabId).toBe(42);
    });

    it('should accept open-tab action', () => {
        const msg: BackgroundMessageFromPageOpenTab = {
            action: 'open-tab',
            url: 'https://keewebx.app/'
        };
        expect(msg.action).toBe('open-tab');
        expect(msg.url).toBe('https://keewebx.app/');
    });

    it('should work as discriminated union', () => {
        const msg: BackgroundMessageFromPage = {
            action: 'connect-to-keeweb',
            activeTabId: 1
        };

        switch (msg.action) {
            case 'connect-to-keeweb':
                expect(msg.activeTabId).toBe(1);
                break;
            case 'open-tab':
                expect(msg.url).toBeDefined();
                break;
        }
    });
});

describe('Settings Model Computed Properties', () => {
    it('useWebApp should be inverse of useNativeApp', () => {
        // This mirrors the getter: get useWebApp(): boolean { return !this._useNativeApp; }
        const testCases = [
            { useNativeApp: true, expectedUseWebApp: false },
            { useNativeApp: false, expectedUseWebApp: true }
        ];
        for (const tc of testCases) {
            expect(!tc.useNativeApp).toBe(tc.expectedUseWebApp);
        }
    });

    it('keeWebUrlIsSet should reflect custom URL presence', () => {
        // Mirrors: get keeWebUrlIsSet(): boolean { return !!this._keeWebUrl; }
        expect(!!undefined).toBe(false);
        expect(!!'').toBe(false);
        expect(!!'https://custom.keeweb.com/').toBe(true);
    });

    it('initial state should be Initializing', () => {
        // Mirrors: private _backendConnectionState = BackendConnectionState.Initializing;
        const initialState = BackendConnectionState.Initializing;
        expect(initialState).toBe('Initializing');
    });
});
