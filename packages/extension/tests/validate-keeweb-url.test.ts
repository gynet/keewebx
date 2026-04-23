import { describe, expect, it } from 'bun:test';
import {
    validateKeeWebUrl,
    type KeeWebUrlValidationResult
} from '../src/options/components/connect/validate-keeweb-url';

/**
 * Tests for the pure URL-validation helper backing the options-page
 * "KeeWeb URL" input.
 *
 * Regression guard for the v0.1.0 self-host bundle bug: Firefox user
 * tried to point the extension at `file:///.../index.html` from the
 * `keewebx-web-v0.1.0.zip` release bundle and was rejected by the
 * UI with "The URL must start with https://". The validation is now
 * scheme-aware:
 *   - `https:` any host
 *   - `http:`  only loopback (localhost / 127.0.0.1 / ::1)
 *   - `file:`  always
 *   - everything else rejected
 */

function assertOk(
    res: KeeWebUrlValidationResult,
    expectedProtocol: string
): asserts res is { ok: true; url: URL } {
    if (!res.ok) {
        throw new Error(
            `expected ok, got rejection (reason=${res.reason}, message=${res.message})`
        );
    }
    expect(res.url.protocol).toBe(expectedProtocol);
}

describe('validateKeeWebUrl — allowed schemes', () => {
    it('accepts https on any host', () => {
        const res = validateKeeWebUrl('https://foo.example');
        assertOk(res, 'https:');
    });

    it('accepts https with path and port', () => {
        const res = validateKeeWebUrl('https://foo.example:8443/path/to/app/');
        assertOk(res, 'https:');
        expect(res.url.hostname).toBe('foo.example');
        expect(res.url.port).toBe('8443');
    });

    it('accepts http on localhost', () => {
        const res = validateKeeWebUrl('http://localhost:8080');
        assertOk(res, 'http:');
        expect(res.url.hostname).toBe('localhost');
    });

    it('accepts http on 127.0.0.1', () => {
        const res = validateKeeWebUrl('http://127.0.0.1:8080');
        assertOk(res, 'http:');
        expect(res.url.hostname).toBe('127.0.0.1');
    });

    it('accepts http on [::1] IPv6 loopback', () => {
        const res = validateKeeWebUrl('http://[::1]:8080');
        assertOk(res, 'http:');
        // URL parsing of IPv6 literal — accept either bracketed or bare
        // depending on platform (both are normalized to `[::1]`)
        expect(['[::1]', '::1']).toContain(res.url.hostname);
    });

    it('accepts file:// on arbitrary path', () => {
        const res = validateKeeWebUrl('file:///Users/gynet/Desktop/app/index.html');
        assertOk(res, 'file:');
    });

    it('accepts file:// with relative-style path', () => {
        const res = validateKeeWebUrl('file:///tmp/keewebx/index.html');
        assertOk(res, 'file:');
    });
});

describe('validateKeeWebUrl — rejected schemes', () => {
    it('rejects http on LAN IP', () => {
        const res = validateKeeWebUrl('http://192.168.1.5:8080');
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('scheme');
    });

    it('rejects http on 10.x private network', () => {
        const res = validateKeeWebUrl('http://10.0.0.5:8080');
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('scheme');
    });

    it('rejects http on evil.com', () => {
        const res = validateKeeWebUrl('http://evil.com');
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('scheme');
    });

    it('rejects ftp:', () => {
        const res = validateKeeWebUrl('ftp://ftp.example.com/x');
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('scheme');
    });

    it('rejects javascript: (XSS defense)', () => {
        // eslint-disable-next-line no-script-url
        const res = validateKeeWebUrl('javascript:alert(1)');
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('scheme');
    });

    it('rejects data: URLs', () => {
        const res = validateKeeWebUrl('data:text/html,<h1>pwnd</h1>');
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('scheme');
    });
});

describe('validateKeeWebUrl — malformed input', () => {
    it('rejects empty string with parse error', () => {
        const res = validateKeeWebUrl('');
        expect(res.ok).toBe(false);
        if (!res.ok) {
            expect(res.reason).toBe('parse');
            expect(res.message.length).toBeGreaterThan(0);
        }
    });

    it('rejects bare hostname with parse error', () => {
        const res = validateKeeWebUrl('not a url');
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('parse');
    });

    it('rejects protocol-relative URL with parse error', () => {
        const res = validateKeeWebUrl('//foo.example');
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.reason).toBe('parse');
    });
});
