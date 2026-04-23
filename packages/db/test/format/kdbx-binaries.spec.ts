import { describe, test, expect } from 'bun:test';
import { ByteUtils, KdbxBinaries, ProtectedValue } from '../../lib';

describe('KdbxBinaries', () => {
    const protectedBinary = ProtectedValue.fromBinary(new TextEncoder().encode('bin'));
    const protectedBinary2 = ProtectedValue.fromBinary(new TextEncoder().encode('another'));
    const hash = '51a1f05af85e342e3c849b47d387086476282d5f50dc240c19216d6edfb1eb5a';
    const hash2 = 'ae448ac86c4e8e4dec645729708ef41873ae79c6dff84eff73360989487f08e5';

    describe('add', () => {
        test('adds a ProtectedValue', async () => {
            const binaries = new KdbxBinaries();
            const bin = await binaries.add(protectedBinary);
            expect(bin).toBeTruthy();
            expect(bin.hash).toBe(hash);
            expect(binaries.getAllWithHashes()).toEqual([{ hash, value: protectedBinary }]);
        });

        test('adds an ArrayBuffer', async () => {
            const binaries = new KdbxBinaries();
            const ab = ByteUtils.arrayToBuffer(protectedBinary.getBinary());
            const bin = await binaries.add(ab);
            expect(bin).toBeTruthy();
            expect(bin.hash).toBe(hash);
            expect(binaries.getAllWithHashes()).toEqual([{ hash, value: ab }]);
        });

        test('adds an Uint8Array', async () => {
            const binaries = new KdbxBinaries();
            const arr = protectedBinary.getBinary();
            const bin = await binaries.add(arr);
            expect(bin).toBeTruthy();
            expect(bin.hash).toBe(hash);
            expect(binaries.getAllWithHashes()).toEqual([{ hash, value: arr.buffer }]);
        });
    });

    describe('addWithNextId', () => {
        test('adds a binary and generates id', async () => {
            const binaries = new KdbxBinaries();
            binaries.addWithNextId(protectedBinary);
            binaries.addWithNextId(protectedBinary2);

            await binaries.computeHashes();

            const found1 = binaries.getByRef({ ref: '0' });
            expect(found1).toBeTruthy();
            expect(found1!.hash).toBe(hash);

            const found2 = binaries.getByRef({ ref: '1' });
            expect(found2).toBeTruthy();
            expect(found2!.hash).toBe(hash2);

            const notFound = binaries.getByRef({ ref: '2' });
            expect(notFound).toBe(undefined);
        });
    });

    describe('addWithId', () => {
        test('adds a binary with the specified id', async () => {
            const binaries = new KdbxBinaries();
            binaries.addWithId('0', protectedBinary);
            binaries.addWithId('0', protectedBinary2);

            await binaries.computeHashes();

            const found2 = binaries.getByRef({ ref: '0' });
            expect(found2).toBeTruthy();
            expect(found2!.hash).toBe(hash2);

            const notFound = binaries.getByRef({ ref: '1' });
            expect(notFound).toBe(undefined);
        });
    });

    describe('addWithHash', () => {
        test('adds a binary with the specified hash', () => {
            const binaries = new KdbxBinaries();
            binaries.addWithHash({ hash, value: protectedBinary });

            expect(binaries.getAllWithHashes()).toEqual([{ hash, value: protectedBinary }]);
        });
    });

    describe('deleteWithHash', () => {
        test('deletes a binary with the specified hash', () => {
            const binaries = new KdbxBinaries();
            binaries.addWithHash({ hash, value: protectedBinary });
            binaries.addWithHash({ hash: hash2, value: protectedBinary2 });
            binaries.deleteWithHash(hash2);

            expect(binaries.getAllWithHashes()).toEqual([{ hash, value: protectedBinary }]);
        });
    });

    describe('getByRef', () => {
        test('returns a binary by reference', async () => {
            const binaries = new KdbxBinaries();
            binaries.addWithNextId(protectedBinary);
            binaries.addWithNextId(protectedBinary2);

            await binaries.computeHashes();

            binaries.deleteWithHash(hash2);

            const found1 = binaries.getByRef({ ref: '0' });
            expect(found1).toBeTruthy();
            expect(found1!.hash).toBe(hash);

            expect(binaries.getByRef({ ref: '1' })).toBe(undefined);
            expect(binaries.getByRef({ ref: '2' })).toBe(undefined);
        });
    });

    describe('get...', () => {
        test('gets a reference by hash', async () => {
            const binaries = new KdbxBinaries();
            binaries.addWithNextId(protectedBinary);
            binaries.addWithNextId(protectedBinary2);

            await binaries.computeHashes();

            const ref1 = binaries.getRefByHash(hash);
            expect(ref1).toBeTruthy();
            expect(ref1?.ref).toBe('0');

            const ref2 = binaries.getRefByHash(hash2);
            expect(ref2).toBeTruthy();
            expect(ref2?.ref).toBe('1');

            const refNotExisting = binaries.getRefByHash('boo');
            expect(refNotExisting).toBe(undefined);

            const all = binaries.getAll();
            expect(all).toEqual([
                { ref: '0', value: protectedBinary },
                { ref: '1', value: protectedBinary2 }
            ]);

            const allWithHashes = binaries.getAllWithHashes();
            expect(allWithHashes).toEqual([
                { hash, value: protectedBinary },
                { hash: hash2, value: protectedBinary2 }
            ]);

            expect(binaries.getValueByHash(hash)).toBe(protectedBinary);
            expect(binaries.getValueByHash(hash2)).toBe(protectedBinary2);
            expect(binaries.getValueByHash('boo')).toBe(undefined);
        });
    });

    describe('isKdbxBinaryRef', () => {
        test('returns true for KdbxBinaryRef', () => {
            const isRef = KdbxBinaries.isKdbxBinaryRef({ ref: '1' });
            expect(isRef).toBe(true);
        });

        test('returns false for a ProtectedValue', () => {
            const isRef = KdbxBinaries.isKdbxBinaryRef(protectedBinary);
            expect(isRef).toBe(false);
        });

        test('returns false for undefined', () => {
            const isRef = KdbxBinaries.isKdbxBinaryRef(undefined);
            expect(isRef).toBe(false);
        });
    });

    describe('isKdbxBinaryWithHash', () => {
        test('returns true for KdbxBinaryWithHash', () => {
            const isRef = KdbxBinaries.isKdbxBinaryWithHash({ ref: '1', hash });
            expect(isRef).toBe(true);
        });

        test('returns false for KdbxBinaryRef', () => {
            const isRef = KdbxBinaries.isKdbxBinaryWithHash({ ref: '1' });
            expect(isRef).toBe(false);
        });

        test('returns false for a ProtectedValue', () => {
            const isRef = KdbxBinaries.isKdbxBinaryWithHash(protectedBinary);
            expect(isRef).toBe(false);
        });

        test('returns false for undefined', () => {
            const isRef = KdbxBinaries.isKdbxBinaryWithHash(undefined);
            expect(isRef).toBe(false);
        });
    });
});
