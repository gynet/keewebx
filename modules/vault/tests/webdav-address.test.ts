import { expect, test } from 'bun:test';
import { webDavAddress } from '../src/comp/app/webdav-address';

test('remote WebDAV addresses require HTTPS before credentials can be transmitted', () => {
    for (const address of ['http://dav.example/vault.kdbx', 'http://localhost.example/vault.kdbx', 'ftp://localhost/vault.kdbx',
        'https://user:pass@dav.example/vault.kdbx', 'https://dav.example/vault.kdbx#secret', 'https://dav.example/va\nult.kdbx', 'https://dav.example\\vault.kdbx']) {
        expect(() => webDavAddress(address)).toThrow();
    }
    expect(webDavAddress(' https://dav.example/vault.kdbx?token=opaque ')).toBe('https://dav.example/vault.kdbx?token=opaque');
});
test('local HTTP servers are an explicit loopback exception', () => {
    for (const host of ['localhost', '127.0.0.1', '127.1.2.3', '[::1]']) {
        const address = `http://${host}:8111/vault.kdbx`;
        expect(webDavAddress(address)).toBe(address);
    }
});
