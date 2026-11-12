import { describe, expect, it } from 'bun:test';
import type {
    ContentScriptMessage,
    ContentScriptMessageAutoFill,
    ContentScriptMessageGetNextAutoFillCommand,
    ContentScriptReturn
} from '../src/common/content-script-interface';

/**
 * The content-page.ts module defines all its functions inside a chrome.runtime.onMessage
 * listener closure, so they cannot be imported directly. These tests verify:
 * 1. The message interface types and their discriminated union structure
 * 2. The pure logic patterns used in input field detection (reproduced here)
 * 3. The command determination logic
 */

// -- Reproduce the pure logic from content-page.ts for testing --

function getNextAutoFillCommandLogic(
    activeTagName: string | undefined,
    activeInputType: string | undefined,
    hasNextPasswordInput: boolean
): string | undefined {
    if (activeTagName !== 'INPUT') {
        return undefined;
    }

    if (activeInputType === 'password') {
        return 'submit-password';
    }

    if (hasNextPasswordInput) {
        return 'submit-username-password';
    }

    return 'submit-username';
}

function shouldSkipInputType(type: string): boolean | 'skip' {
    switch (type) {
        case 'password':
            return true; // found a password input
        case 'checkbox':
        case 'hidden':
            return 'skip'; // skip these, keep searching
        default:
            return false; // non-password, non-skippable => stop
    }
}

function isMessageForCurrentUrl(messageUrl: string, currentUrl: string): boolean {
    return currentUrl === messageUrl;
}

describe('Content Script Interface Types', () => {
    it('should accept auto-fill message', () => {
        const msg: ContentScriptMessageAutoFill = {
            action: 'auto-fill',
            url: 'https://example.com',
            text: 'user@example.com',
            password: 'secret123',
            submit: true
        };
        expect(msg.action).toBe('auto-fill');
        expect(msg.url).toBe('https://example.com');
        expect(msg.text).toBe('user@example.com');
        expect(msg.password).toBe('secret123');
        expect(msg.submit).toBe(true);
    });

    it('should accept auto-fill message without optional fields', () => {
        const msg: ContentScriptMessageAutoFill = {
            action: 'auto-fill',
            url: 'https://example.com',
            submit: false
        };
        expect(msg.action).toBe('auto-fill');
        expect(msg.text).toBeUndefined();
        expect(msg.password).toBeUndefined();
        expect(msg.submit).toBe(false);
    });

    it('should accept get-next-auto-fill-command message', () => {
        const msg: ContentScriptMessageGetNextAutoFillCommand = {
            action: 'get-next-auto-fill-command',
            url: 'https://login.example.com'
        };
        expect(msg.action).toBe('get-next-auto-fill-command');
        expect(msg.url).toBe('https://login.example.com');
    });

    it('should work as discriminated union', () => {
        const msg: ContentScriptMessage = {
            action: 'auto-fill',
            url: 'https://example.com',
            submit: true
        };

        switch (msg.action) {
            case 'auto-fill':
                // TypeScript narrows to ContentScriptMessageAutoFill
                expect(msg.submit).toBe(true);
                break;
            case 'get-next-auto-fill-command':
                // TypeScript narrows to ContentScriptMessageGetNextAutoFillCommand
                expect(msg.url).toBeDefined();
                break;
        }
    });

    it('should represent return type with nextCommand', () => {
        const ret: ContentScriptReturn = { nextCommand: 'submit-password' };
        expect(ret.nextCommand).toBe('submit-password');
    });

    it('should allow empty return', () => {
        const ret: ContentScriptReturn = {};
        expect(ret.nextCommand).toBeUndefined();
    });
});

describe('Next Auto-Fill Command Logic', () => {
    it('should return undefined when active element is not an INPUT', () => {
        expect(getNextAutoFillCommandLogic('TEXTAREA', 'text', false)).toBeUndefined();
        expect(getNextAutoFillCommandLogic('DIV', undefined, false)).toBeUndefined();
        expect(getNextAutoFillCommandLogic('BUTTON', undefined, true)).toBeUndefined();
        expect(getNextAutoFillCommandLogic(undefined, undefined, false)).toBeUndefined();
    });

    it('should return submit-password when active input is a password field', () => {
        expect(getNextAutoFillCommandLogic('INPUT', 'password', false)).toBe('submit-password');
        expect(getNextAutoFillCommandLogic('INPUT', 'password', true)).toBe('submit-password');
    });

    it('should return submit-username-password when next password input exists', () => {
        expect(getNextAutoFillCommandLogic('INPUT', 'text', true)).toBe(
            'submit-username-password'
        );
        expect(getNextAutoFillCommandLogic('INPUT', 'email', true)).toBe(
            'submit-username-password'
        );
    });

    it('should return submit-username when no next password input', () => {
        expect(getNextAutoFillCommandLogic('INPUT', 'text', false)).toBe('submit-username');
        expect(getNextAutoFillCommandLogic('INPUT', 'email', false)).toBe('submit-username');
    });
});

describe('Input Type Skip Logic', () => {
    it('should identify password inputs', () => {
        expect(shouldSkipInputType('password')).toBe(true);
    });

    it('should skip checkbox inputs', () => {
        expect(shouldSkipInputType('checkbox')).toBe('skip');
    });

    it('should skip hidden inputs', () => {
        expect(shouldSkipInputType('hidden')).toBe('skip');
    });

    it('should stop on text inputs', () => {
        expect(shouldSkipInputType('text')).toBe(false);
    });

    it('should stop on email inputs', () => {
        expect(shouldSkipInputType('email')).toBe(false);
    });

    it('should stop on unknown input types', () => {
        expect(shouldSkipInputType('number')).toBe(false);
        expect(shouldSkipInputType('tel')).toBe(false);
        expect(shouldSkipInputType('url')).toBe(false);
    });
});

describe('URL Matching', () => {
    it('should match identical URLs', () => {
        expect(isMessageForCurrentUrl('https://example.com', 'https://example.com')).toBe(true);
    });

    it('should not match different URLs', () => {
        expect(isMessageForCurrentUrl('https://example.com', 'https://other.com')).toBe(false);
    });

    it('should be case-sensitive', () => {
        expect(isMessageForCurrentUrl('https://Example.com', 'https://example.com')).toBe(false);
    });

    it('should distinguish URLs with different paths', () => {
        expect(
            isMessageForCurrentUrl('https://example.com/login', 'https://example.com/signup')
        ).toBe(false);
    });

    it('should match URLs with same path', () => {
        expect(
            isMessageForCurrentUrl('https://example.com/login', 'https://example.com/login')
        ).toBe(true);
    });
});
