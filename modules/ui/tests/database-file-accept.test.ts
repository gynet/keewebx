import { expect, test } from 'bun:test';
import { databaseFileAccept } from '../src/database-file-accept';

for (const device of ['iPhone', 'iPad', 'iPod']) {
    test(`${device} leaves unknown database types selectable`, () => {
        expect(databaseFileAccept({ userAgent: `Mozilla/5.0 (${device}; CPU OS 18_0 like Mac OS X)`, platform: device, maxTouchPoints: 5 })).toBeUndefined();
    });
}

test('iPadOS desktop user agent leaves unknown database types selectable', () => {
    expect(databaseFileAccept({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15', platform: 'MacIntel', maxTouchPoints: 5 })).toBeUndefined();
});

for (const platform of ['MacIntel', 'Win32', 'Linux x86_64', 'Linux aarch64']) {
    test(`${platform} retains the database filter`, () => {
        expect(databaseFileAccept({ userAgent: 'Mozilla/5.0', platform, maxTouchPoints: platform === 'MacIntel' ? 0 : 5 })).toBe('.kdbx,.kdb');
    });
}
