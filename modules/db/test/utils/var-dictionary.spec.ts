/*
    @note           Disable typescript checking for this file since we are explicity trying to check for
                    invalid types. this became a requirement in typescript v5x

    @ref            'throws error for bad value type on set'
*/

// @ts-nocheck

import { describe, test, expect } from 'bun:test';
import { BinaryStream, ByteUtils, Consts, Int64, VarDictionary } from '../../lib';
import { ValueType } from '../../lib/utils/var-dictionary';

describe('VarDictionary', () => {
    const data =
        '00010808000000426f6f6c5472756501000000010809000000426f6f6c46616c' +
        '73650100000000040600000055496e743332040000002a000000050600000055' +
        '496e74363408000000ccccddddeeeeffff0c05000000496e74333204000000d6' +
        'ffffff0d05000000496e74363408000000444433332222111118060000005374' +
        '72696e670b000000537472696e6756616c756542090000004279746541727261' +
        '7907000000000102030405ff00';

    test('reads and writes dictionary', () => {
        const dataBytes = ByteUtils.hexToBytes(data);
        let stm = new BinaryStream(ByteUtils.arrayToBuffer(dataBytes));
        const dict = VarDictionary.read(stm);
        expect(dict).toBeInstanceOf(VarDictionary);
        expect(dict.length).toBe(8);
        expect(dict.get('BoolTrue')).toBe(true);
        expect(dict.get('BoolFalse')).toBe(false);
        expect(dict.get('UInt32')).toBe(42);
        expect((dict.get('UInt64') as Int64).hi).toBe(0xffffeeee);
        expect((dict.get('UInt64') as Int64).lo).toBe(0xddddcccc);
        expect(dict.get('Int32')).toBe(-42);
        expect((dict.get('Int64') as Int64).hi).toBe(0x11112222);
        expect((dict.get('Int64') as Int64).lo).toBe(0x33334444);
        expect(dict.get('String')).toBe('StringValue');
        expect(dict.keys()).toEqual([
            'BoolTrue',
            'BoolFalse',
            'UInt32',
            'UInt64',
            'Int32',
            'Int64',
            'String',
            'ByteArray'
        ]);
        expect(ByteUtils.bytesToHex(dict.get('ByteArray') as ArrayBuffer)).toBe('000102030405ff');

        stm = new BinaryStream();
        dict.write(stm);
        expect(ByteUtils.bytesToHex(stm.getWrittenBytes())).toBe(data);
    });

    test('writes dictionary', () => {
        const dict = new VarDictionary();
        dict.set('BoolTrue', ValueType.Bool, true);
        dict.set('BoolFalse', ValueType.Bool, false);
        dict.set('UInt32', ValueType.UInt32, 42);
        dict.set('UInt64', ValueType.UInt64, new Int64(0xddddcccc, 0xffffeeee));
        dict.set('Int32', ValueType.Int32, -42);
        dict.set('Int64', ValueType.Int64, new Int64(0x33334444, 0x11112222));
        dict.set('String', ValueType.String, 'StringValue');
        dict.set('ByteArray', ValueType.Bytes, ByteUtils.hexToBytes('000102030405ff'));
        const stm = new BinaryStream();
        dict.write(stm);
        expect(ByteUtils.bytesToHex(stm.getWrittenBytes())).toBe(data);
    });

    test('returns undefined for not found value', () => {
        const dict = new VarDictionary();
        expect(dict.length).toBe(0);
        expect(dict.get('val')).toBe(undefined);
    });

    test('removes item from dictionary', () => {
        const dict = new VarDictionary();
        expect(dict.length).toBe(0);
        expect(dict.get('val')).toBe(undefined);
        dict.set('val', ValueType.Bool, true);
        expect(dict.length).toBe(1);
        expect(dict.get('val')).toBe(true);
        dict.remove('val');
        expect(dict.length).toBe(0);
        expect(dict.get('val')).toBe(undefined);
    });

    test('allows to add key twice', () => {
        const dict = new VarDictionary();
        dict.set('UInt32', ValueType.UInt32, 42);
        expect(dict.length).toBe(1);
        dict.set('UInt32', ValueType.UInt32, 42);
        expect(dict.length).toBe(1);
    });

    test('throws error for empty version', () => {
        expect(() => {
            VarDictionary.read(
                new BinaryStream(ByteUtils.arrayToBuffer(ByteUtils.hexToBytes('0000')))
            );
        }).toThrow();
    });

    test('throws error for larger version', () => {
        expect(() => {
            VarDictionary.read(
                new BinaryStream(ByteUtils.arrayToBuffer(ByteUtils.hexToBytes('0002')))
            );
        }).toThrow();
    });

    test('throws error for bad value type', () => {
        expect(() => {
            VarDictionary.read(
                new BinaryStream(
                    ByteUtils.arrayToBuffer(ByteUtils.hexToBytes('0001ff01000000dd10000000'))
                )
            );
        }).toThrow();
    });

    test('reads empty dictionary', () => {
        const dict = VarDictionary.read(
            new BinaryStream(ByteUtils.arrayToBuffer(ByteUtils.hexToBytes('000100')))
        );
        expect(dict.length).toBe(0);
    });

    test('throws error for bad key length', () => {
        expect(() => {
            VarDictionary.read(
                new BinaryStream(
                    ByteUtils.arrayToBuffer(ByteUtils.hexToBytes('0001ff00000000dd10000000'))
                )
            );
        }).toThrow();
    });

    test('throws error for bad value length', () => {
        expect(() => {
            VarDictionary.read(
                new BinaryStream(
                    ByteUtils.arrayToBuffer(ByteUtils.hexToBytes('0001ff01000000ddffffffff'))
                )
            );
        }).toThrow();
    });

    test('throws error for bad uint32 value', () => {
        expect(() => {
            VarDictionary.read(
                new BinaryStream(
                    ByteUtils.arrayToBuffer(ByteUtils.hexToBytes('00010401000000dd0500000000'))
                )
            );
        }).toThrow();
    });

    test('throws error for bad uint64 value', () => {
        expect(() => {
            VarDictionary.read(
                new BinaryStream(
                    ByteUtils.arrayToBuffer(ByteUtils.hexToBytes('00010501000000dd0500000000'))
                )
            );
        }).toThrow();
    });

    test('throws error for bad bool value', () => {
        expect(() => {
            VarDictionary.read(
                new BinaryStream(
                    ByteUtils.arrayToBuffer(ByteUtils.hexToBytes('00010801000000dd0500000000'))
                )
            );
        }).toThrow();
    });

    test('throws error for bad int32 value', () => {
        expect(() => {
            VarDictionary.read(
                new BinaryStream(
                    ByteUtils.arrayToBuffer(ByteUtils.hexToBytes('00010c01000000dd0500000000'))
                )
            );
        }).toThrow();
    });

    test('throws error for bad int64 value', () => {
        expect(() => {
            VarDictionary.read(
                new BinaryStream(
                    ByteUtils.arrayToBuffer(ByteUtils.hexToBytes('00010d01000000dd0500000000'))
                )
            );
        }).toThrow();
    });

    test('throws error for bad value type on write', () => {
        expect(() => {
            const dict = new VarDictionary();
            dict.set('BoolTrue', ValueType.Bool, true);
            // @ts-ignore
            dict._items[0].type = 0xff;
            dict.write(new BinaryStream());
        }).toThrow();
    });

    test('throws error for bad value type on set', () => {
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', 0xff, true);
        }).toThrow();
    });

    test('throws error for bad int32 on set', () => {
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.Int32, 'str');
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            // @ts-ignore
            dict.set('val', ValueType.Int32, null);
        }).toThrow();
    });

    test('throws error for bad int64 on set', () => {
        expect(() => {
            const dict = new VarDictionary();
            // @ts-ignore
            dict.set('val', ValueType.Int64, null);
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.Int64, 'str');
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.Int64, 123);
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            // @ts-ignore
            dict.set('val', ValueType.Int64, { hi: 1 });
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            // @ts-ignore
            dict.set('val', ValueType.Int64, { lo: 1 });
        }).toThrow();
    });

    test('throws error for bad bool on set', () => {
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.Bool, 'true');
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.Bool, 1);
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            // @ts-ignore
            dict.set('val', ValueType.Bool, null);
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.Bool, undefined);
        }).toThrow();
    });

    test('throws error for bad uint32 on set', () => {
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.UInt32, 'str');
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.UInt32, -1);
        }).toThrow();
    });

    test('throws error for bad uint64 on set', () => {
        expect(() => {
            const dict = new VarDictionary();
            // @ts-ignore
            dict.set('val', ValueType.UInt64, null);
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.UInt64, 'str');
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.UInt64, 123);
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            // @ts-ignore
            dict.set('val', ValueType.UInt64, { hi: 1 });
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            // @ts-ignore
            dict.set('val', ValueType.UInt64, { lo: 1 });
        }).toThrow();
    });

    test('throws error for bad string on set', () => {
        expect(() => {
            const dict = new VarDictionary();
            // @ts-ignore
            dict.set('val', ValueType.String, null);
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.String, 123);
        }).toThrow();
    });

    test('throws error for bad bytes', () => {
        expect(() => {
            const dict = new VarDictionary();
            // @ts-ignore
            dict.set('val', ValueType.Bytes, null);
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.Bytes, 123);
        }).toThrow();
        expect(() => {
            const dict = new VarDictionary();
            dict.set('val', ValueType.Bytes, '0000');
        }).toThrow();
    });
});
