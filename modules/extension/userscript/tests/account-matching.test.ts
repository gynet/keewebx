import { expect, test } from 'bun:test';
import { matchesOrigin } from '../src/form-targets';

test.each([
    ['uscardforum.com', 'https://www.uscardforum.com', true],
    ['https://uscardforum.com', 'https://www.uscardforum.com', true],
    ['https://www.uscardforum.com/login', 'https://uscardforum.com', true],
    ['https://USCARDFORUM.com:443/account', 'https://www.uscardforum.com', true],
    ['https://uscardforum.com:8443', 'https://www.uscardforum.com:8443', true],
    ['https://uscardforum.com:8443', 'https://www.uscardforum.com', false],
    ['https://uscardforum.com', 'https://www.uscardforum.com:8443', false],
    ['http://uscardforum.com', 'https://www.uscardforum.com', false],
    ['https://uscardforum.com', 'http://www.uscardforum.com', false],
    ['uscardforum.com', 'https://accounts.uscardforum.com', false],
    ['https://accounts.uscardforum.com', 'https://www.uscardforum.com', false],
    ['uscardforum.com', 'https://www.uscardforum.com.evil.test', false],
    ['https://uscardforum.com.evil.test', 'https://www.uscardforum.com', false],
    ['https://evil.test/?next=https://uscardforum.com', 'https://www.uscardforum.com', false],
    ['https://name:secret@uscardforum.com', 'https://www.uscardforum.com', false],
    ['https://uscardforum.com@evil.test', 'https://www.uscardforum.com', false],
    ['javascript:alert(1)', 'https://www.uscardforum.com', false],
    ['not a valid URL', 'https://www.uscardforum.com', false]
])('stored %s matches destination %s: %s', (entry, destination, expected) => {
    expect(matchesOrigin(entry as string, destination as string)).toBe(expected as boolean);
});
