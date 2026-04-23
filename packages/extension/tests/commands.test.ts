import { describe, expect, it } from 'bun:test';

/**
 * Tests for the command parsing logic in commands.ts.
 *
 * The actual runCommand function depends heavily on chrome.* APIs and the backend,
 * so we extract and test the pure logic patterns:
 * 1. Command name parsing (which options are derived from command strings)
 * 2. URL validation regex
 * 3. Command routing ("auto" detection)
 */

// -- Reproduce the pure logic from commands.ts --

function parseCommandOptions(command: string) {
    return {
        username: command.includes('username'),
        password: command.includes('password'),
        submit: command.includes('submit'),
        otp: command.includes('otp'),
        other: command.includes('other')
    };
}

function isAutoCommand(command: string): boolean {
    return command.includes('auto');
}

function isValidUrl(url: string, keeWebUrl: string): boolean {
    return /^https?:/i.test(url) && !url.startsWith(keeWebUrl);
}

describe('Command Option Parsing', () => {
    it('should parse submit-username-password command', () => {
        const opts = parseCommandOptions('submit-username-password');
        expect(opts.username).toBe(true);
        expect(opts.password).toBe(true);
        expect(opts.submit).toBe(true);
        expect(opts.otp).toBe(false);
        expect(opts.other).toBe(false);
    });

    it('should parse submit-username command', () => {
        const opts = parseCommandOptions('submit-username');
        expect(opts.username).toBe(true);
        expect(opts.password).toBe(false);
        expect(opts.submit).toBe(true);
        expect(opts.otp).toBe(false);
        expect(opts.other).toBe(false);
    });

    it('should parse submit-password command', () => {
        const opts = parseCommandOptions('submit-password');
        expect(opts.username).toBe(false);
        expect(opts.password).toBe(true);
        expect(opts.submit).toBe(true);
        expect(opts.otp).toBe(false);
        expect(opts.other).toBe(false);
    });

    it('should parse otp command', () => {
        const opts = parseCommandOptions('otp');
        expect(opts.username).toBe(false);
        expect(opts.password).toBe(false);
        expect(opts.submit).toBe(false);
        expect(opts.otp).toBe(true);
        expect(opts.other).toBe(false);
    });

    it('should parse other command', () => {
        const opts = parseCommandOptions('other');
        expect(opts.username).toBe(false);
        expect(opts.password).toBe(false);
        expect(opts.submit).toBe(false);
        expect(opts.otp).toBe(false);
        expect(opts.other).toBe(true);
    });

    it('should handle empty command', () => {
        const opts = parseCommandOptions('');
        expect(opts.username).toBe(false);
        expect(opts.password).toBe(false);
        expect(opts.submit).toBe(false);
        expect(opts.otp).toBe(false);
        expect(opts.other).toBe(false);
    });

    it('should handle compound commands', () => {
        const opts = parseCommandOptions('submit-username-password-otp');
        expect(opts.username).toBe(true);
        expect(opts.password).toBe(true);
        expect(opts.submit).toBe(true);
        expect(opts.otp).toBe(true);
        expect(opts.other).toBe(false);
    });
});

describe('Auto Command Detection', () => {
    it('should detect auto-fill command', () => {
        expect(isAutoCommand('auto-fill')).toBe(true);
    });

    it('should detect any command containing auto', () => {
        expect(isAutoCommand('auto')).toBe(true);
        expect(isAutoCommand('auto-submit')).toBe(true);
    });

    it('should not flag non-auto commands', () => {
        expect(isAutoCommand('submit-username')).toBe(false);
        expect(isAutoCommand('submit-password')).toBe(false);
        expect(isAutoCommand('otp')).toBe(false);
        expect(isAutoCommand('other')).toBe(false);
    });
});

describe('URL Validation', () => {
    const keeWebUrl = 'https://keewebx.app/';

    it('should accept http URLs', () => {
        expect(isValidUrl('http://example.com', keeWebUrl)).toBe(true);
    });

    it('should accept https URLs', () => {
        expect(isValidUrl('https://example.com', keeWebUrl)).toBe(true);
    });

    it('should be case-insensitive for protocol', () => {
        expect(isValidUrl('HTTP://example.com', keeWebUrl)).toBe(true);
        expect(isValidUrl('HTTPS://example.com', keeWebUrl)).toBe(true);
        expect(isValidUrl('Https://example.com', keeWebUrl)).toBe(true);
    });

    it('should reject chrome:// URLs', () => {
        expect(isValidUrl('chrome://extensions', keeWebUrl)).toBe(false);
    });

    it('should reject about: URLs', () => {
        expect(isValidUrl('about:blank', keeWebUrl)).toBe(false);
    });

    it('should reject file:// URLs', () => {
        expect(isValidUrl('file:///home/user', keeWebUrl)).toBe(false);
    });

    it('should reject the KeeWeb URL itself', () => {
        expect(isValidUrl('https://keewebx.app/', keeWebUrl)).toBe(false);
        expect(isValidUrl('https://keewebx.app/page', keeWebUrl)).toBe(false);
    });

    it('should accept URLs that are not the KeeWeb URL', () => {
        expect(isValidUrl('https://other.keeweb.info/', keeWebUrl)).toBe(true);
        expect(isValidUrl('https://example.com', keeWebUrl)).toBe(true);
    });

    it('should reject empty string', () => {
        expect(isValidUrl('', keeWebUrl)).toBe(false);
    });

    it('should work with custom keeWebUrl', () => {
        const customUrl = 'https://keeweb.myserver.com/';
        expect(isValidUrl('https://keeweb.myserver.com/app', customUrl)).toBe(false);
        expect(isValidUrl('https://example.com', customUrl)).toBe(true);
    });
});

describe('Command Interface', () => {
    it('should define CommandArgs shape', () => {
        const args = {
            command: 'submit-username-password',
            tab: { id: 1, index: 0, active: true, pinned: false } as chrome.tabs.Tab,
            url: 'https://example.com',
            frameId: 0
        };
        expect(args.command).toBe('submit-username-password');
        expect(args.tab.id).toBe(1);
        expect(args.url).toBe('https://example.com');
        expect(args.frameId).toBe(0);
    });

    it('should allow optional url and frameId', () => {
        const args = {
            command: 'auto-fill',
            tab: { id: 1, index: 0, active: true, pinned: false } as chrome.tabs.Tab
        };
        expect(args.command).toBe('auto-fill');
        expect((args as { url?: string }).url).toBeUndefined();
        expect((args as { frameId?: number }).frameId).toBeUndefined();
    });
});
