import { describe, test, expect } from 'bun:test';
import {
    BinaryStream,
    ByteUtils,
    Consts,
    Int64,
    Kdbx,
    KdbxBinaries,
    KdbxContext,
    KdbxHeader,
    KdbxUuid,
    ProtectedValue,
    VarDictionary
} from '../../lib';
import { ValueType } from '../../lib/utils/var-dictionary';

describe('KdbxHeader', () => {
    const kdbx = new Kdbx();

    test('writes and reads header v4', async () => {
        const kdbx = new Kdbx();
        kdbx.binaries = new KdbxBinaries();
        kdbx.binaries.addWithNextId(new Uint8Array([1, 2]));
        kdbx.binaries.addWithNextId(ProtectedValue.fromBinary(new Uint8Array([1, 2, 3]).buffer));
        await kdbx.binaries.computeHashes();

        const header = KdbxHeader.create();
        expect(header.versionMajor).toBe(4);
        header.masterSeed = new Uint32Array([1, 1, 1, 1]).buffer;
        header.transformSeed = new Uint32Array([2, 2, 2, 2]).buffer;
        header.streamStartBytes = new Uint32Array([3, 3, 3, 3]).buffer;
        header.protectedStreamKey = new Uint32Array([4, 4, 4, 4]).buffer;
        header.encryptionIV = new Uint32Array([5, 5]).buffer;
        header.kdfParameters!.set('S', ValueType.Bytes, new Uint32Array([6, 6, 6, 6]).buffer);
        header.publicCustomData = new VarDictionary();
        header.publicCustomData.set('custom', ValueType.String, 'val');

        const headerStm = new BinaryStream();
        const innerHeaderStm = new BinaryStream();
        header.write(headerStm);
        header.writeInnerHeader(innerHeaderStm, new KdbxContext({ kdbx }));

        const newKdbx = new Kdbx();
        newKdbx.binaries = new KdbxBinaries();
        const newHeader = KdbxHeader.read(
            new BinaryStream(headerStm.getWrittenBytes()),
            new KdbxContext({ kdbx: newKdbx })
        );

        expect(newHeader.versionMajor).toBe(header.versionMajor);
        expect(newHeader.versionMinor).toBe(header.versionMinor);
        expect(newHeader.dataCipherUuid!.toString()).toBe(Consts.CipherId.Aes);
        expect(newHeader.crsAlgorithm).toBe(undefined);
        expect(newHeader.compression).toBe(Consts.CompressionAlgorithm.GZip);
        expect(newHeader.endPos).toBe(headerStm.getWrittenBytes().byteLength);
        expect(ByteUtils.bytesToHex(newHeader.masterSeed!)).toBe(
            '01000000010000000100000001000000'
        );
        expect(newHeader.transformSeed).toBe(undefined);
        expect(newHeader.streamStartBytes).toBe(undefined);
        expect(newHeader.protectedStreamKey).toBe(undefined);
        expect(ByteUtils.bytesToHex(newHeader.encryptionIV!)).toBe('0500000005000000');
        expect(newHeader.kdfParameters!.length).toBe(6);
        expect(ByteUtils.bytesToBase64(newHeader.kdfParameters!.get('$UUID') as ArrayBuffer)).toBe(
            Consts.KdfId.Argon2
        );
        expect(ByteUtils.bytesToHex(newHeader.kdfParameters!.get('S') as ArrayBuffer)).toBe(
            '06000000060000000600000006000000'
        );
        expect(newHeader.kdfParameters!.get('P')).toBe(1);
        expect(newHeader.kdfParameters!.get('V')).toBe(0x13);
        expect((newHeader.kdfParameters!.get('I') as Int64).value).toBe(2);
        expect((newHeader.kdfParameters!.get('M') as Int64).value).toBe(1024 * 1024);
        expect(newHeader.publicCustomData!.length).toBe(1);
        expect(newHeader.publicCustomData!.get('custom')).toBe('val');
        expect(newKdbx.binaries.getAll()).toEqual([]);

        newHeader.readInnerHeader(
            new BinaryStream(innerHeaderStm.getWrittenBytes()),
            new KdbxContext({ kdbx: newKdbx })
        );

        await newKdbx.binaries.computeHashes();

        expect(newHeader.crsAlgorithm).toBe(Consts.CrsAlgorithm.ChaCha20);
        expect(ByteUtils.bytesToHex(newHeader.protectedStreamKey!)).toBe(
            '04000000040000000400000004000000'
        );

        const oldBinaries = kdbx.binaries.getAll();
        const newBinaries = newKdbx.binaries.getAll();
        expect(newBinaries.length).toBe(2);
        expect(newBinaries[0].ref).toBe('0');
        expect(newBinaries[0].value).toBeInstanceOf(ArrayBuffer);
        expect(ByteUtils.bytesToHex(newBinaries[0].value as ArrayBuffer)).toBe(
            ByteUtils.bytesToHex(oldBinaries[0].value as ArrayBuffer)
        );
        expect(newBinaries[1].ref).toBe('1');
        expect(newBinaries[1].value).toBeInstanceOf(ProtectedValue);
        expect(ByteUtils.bytesToHex((newBinaries[1].value as ProtectedValue).getBinary())).toBe(
            ByteUtils.bytesToHex((oldBinaries[1].value as ProtectedValue).getBinary())
        );
    });

    test('generates salts v4', () => {
        const header = new KdbxHeader();
        header.versionMajor = 4;
        header.dataCipherUuid = new KdbxUuid(Consts.CipherId.ChaCha20);
        header.kdfParameters = new VarDictionary();
        header.generateSalts();

        expect(header.protectedStreamKey).toBeTruthy();
        expect(header.protectedStreamKey!.byteLength).toBe(64);
        expect(header.kdfParameters.get('S')).toBeTruthy();
        expect((header.kdfParameters.get('S') as ArrayBuffer).byteLength).toBe(32);
        expect(header.encryptionIV).toBeTruthy();
        expect(header.encryptionIV!.byteLength).toBe(12);

        header.dataCipherUuid = new KdbxUuid(Consts.CipherId.Aes);
        header.generateSalts();
        expect(header.encryptionIV!.byteLength).toBe(16);
    });

    test('writes header without public custom data', async () => {
        const kdbx = new Kdbx();
        await kdbx.binaries.add(new Uint8Array([1]));
        await kdbx.binaries.computeHashes();
        const ctx = new KdbxContext({ kdbx });
        const header = KdbxHeader.create();
        header.setVersion(KdbxHeader.MaxFileVersion);
        header.generateSalts();
        let stm = new BinaryStream();
        header.write(stm);
        header.writeInnerHeader(stm, ctx);

        stm = new BinaryStream(stm.getWrittenBytes());
        const newHeader = KdbxHeader.read(stm, ctx);
        newHeader.readInnerHeader(stm, ctx);
        expect(newHeader.publicCustomData).toBe(undefined);
    });

    test('validates header cipher', () => {
        const header = KdbxHeader.create();
        header.setVersion(KdbxHeader.MaxFileVersion);
        header.generateSalts();
        header.dataCipherUuid = undefined;
        expect(() => {
            header.write(new BinaryStream());
        }).toThrow();
    });

    test('validates header compression', () => {
        const header = KdbxHeader.create();
        header.setVersion(KdbxHeader.MaxFileVersion);
        header.generateSalts();
        header.compression = undefined;
        expect(() => {
            header.write(new BinaryStream());
        }).toThrow();
    });

    test('validates master seed', () => {
        const header = KdbxHeader.create();
        header.setVersion(KdbxHeader.MaxFileVersion);
        header.generateSalts();
        header.masterSeed = undefined;
        expect(() => {
            header.write(new BinaryStream());
        }).toThrow();
    });

    test('validates header encryption iv', () => {
        const header = KdbxHeader.create();
        header.setVersion(KdbxHeader.MaxFileVersion);
        header.generateSalts();
        header.encryptionIV = undefined;
        expect(() => {
            header.write(new BinaryStream());
        }).toThrow();
    });

    test('validates header kdf parameters', () => {
        const header = KdbxHeader.create();
        header.setVersion(KdbxHeader.MaxFileVersion);
        header.generateSalts();
        header.kdfParameters = undefined;
        expect(() => {
            header.write(new BinaryStream());
        }).toThrow();
    });

    test('validates inner header protected stream key', () => {
        const header = KdbxHeader.create();
        header.setVersion(KdbxHeader.MaxFileVersion);
        header.generateSalts();
        header.protectedStreamKey = undefined;
        expect(() => {
            header.writeInnerHeader(new BinaryStream(), new KdbxContext({ kdbx }));
        }).toThrow();
    });

    test('validates inner header crs algorithm', () => {
        const header = KdbxHeader.create();
        header.setVersion(KdbxHeader.MaxFileVersion);
        header.generateSalts();
        header.crsAlgorithm = undefined;
        expect(() => {
            header.writeInnerHeader(new BinaryStream(), new KdbxContext({ kdbx }));
        }).toThrow();
    });

    test('throws error for bad signature', () => {
        expect(() => {
            KdbxHeader.read(
                new BinaryStream(ByteUtils.hexToBytes('0000000000000000').buffer),
                new KdbxContext({ kdbx })
            );
        }).toThrow();
    });

    test('throws error for bad version', () => {
        expect(() => {
            KdbxHeader.read(
                new BinaryStream(ByteUtils.hexToBytes('03d9a29a67fb4bb501000500').buffer),
                new KdbxContext({ kdbx })
            );
        }).toThrow();
    });

    test('throws error for bad cipher', () => {
        expect(() => {
            KdbxHeader.read(
                new BinaryStream(
                    ByteUtils.hexToBytes('03d9a29a67fb4bb501000400020100000031c1f2e6bf').buffer
                ),
                new KdbxContext({ kdbx })
            );
        }).toThrow();
    });

    test('throws error for bad compression flags', () => {
        expect(() => {
            KdbxHeader.read(
                new BinaryStream(
                    ByteUtils.hexToBytes('03d9a29a67fb4bb5010004000320000000011111111').buffer
                ),
                new KdbxContext({ kdbx })
            );
        }).toThrow();
    });

    test('throws error for empty files', () => {
        expect(() => {
            KdbxHeader.read(new BinaryStream(new ArrayBuffer(0)), new KdbxContext({ kdbx }));
        }).toThrow();
    });

    test('throws error for bad version in setVersion', () => {
        const header = KdbxHeader.create();
        expect(() => {
            header.setVersion(2);
        }).toThrow();
    });

    test('throws error for version 3 in setVersion', () => {
        const header = KdbxHeader.create();
        expect(() => {
            header.setVersion(3);
        }).toThrow();
    });

    test('throws error for bad KDF in setKdf', () => {
        const header = KdbxHeader.create();
        expect(() => {
            header.setKdf('unknown');
        }).toThrow();
    });
});
