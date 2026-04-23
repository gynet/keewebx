import { describe, expect, it } from 'bun:test';
import { urlToMatchPattern } from '../src/common/match-pattern';

/**
 * Tests for the URL -> browser extension match pattern helper.
 *
 * Regression guard for the v0.1.0 self-host bundle bug, secondary
 * symptom: `chrome.permissions.contains({ origins: [concreteUrl] })`
 * was called with a raw URL instead of a match pattern. Chrome is
 * lenient, Firefox strict-rejects, leaving Firefox users stuck at the
 * "grant permission" gate even after URL validation passed.
 */

describe('urlToMatchPattern', () => {
    it('converts https URL with path to scheme://host/*', () => {
        expect(urlToMatchPattern('https://foo.example/path/to/app')).toBe(
            'https://foo.example/*'
        );
    });

    it('strips port from https URL', () => {
        expect(urlToMatchPattern('https://foo.example:8443/app')).toBe(
            'https://foo.example/*'
        );
    });

    it('converts http://localhost:PORT to http://localhost/*', () => {
        expect(urlToMatchPattern('http://localhost:8080')).toBe('http://localhost/*');
    });

    it('converts http://127.0.0.1:PORT to http://127.0.0.1/*', () => {
        expect(urlToMatchPattern('http://127.0.0.1:8080')).toBe('http://127.0.0.1/*');
    });

    it('keeps IPv6 literals bracketed', () => {
        expect(urlToMatchPattern('http://[::1]:8080')).toBe('http://[::1]/*');
    });

    it('normalizes file:// URLs to file:///*', () => {
        expect(urlToMatchPattern('file:///Users/gynet/Desktop/app/index.html')).toBe(
            'file:///*'
        );
    });

    it('normalizes file:// URL with query+fragment to file:///*', () => {
        expect(urlToMatchPattern('file:///tmp/app/index.html#app/open')).toBe(
            'file:///*'
        );
    });

    it('ignores query string and fragment for http(s)', () => {
        expect(urlToMatchPattern('https://foo.example/app?x=1#frag')).toBe(
            'https://foo.example/*'
        );
    });

    it('throws on malformed URL', () => {
        expect(() => urlToMatchPattern('not a url')).toThrow();
    });
});
