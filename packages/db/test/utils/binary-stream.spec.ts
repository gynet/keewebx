import { describe, test, expect } from 'bun:test';
import { BinaryStream } from '../../lib';

describe('BinaryStream', () => {
    const arr = new Uint8Array(100);
    for (let i = 0; i < arr.length; i++) {
        arr[i] = i;
    }
    const view = new DataView(arr.buffer);

    test('provides basic int and float getters available in DataView', () => {
        const stm = new BinaryStream(arr.buffer);
        expect(stm.getUint8()).toBe(view.getUint8(0));
        expect(stm.getUint8()).toBe(view.getUint8(1));
        expect(stm.getInt8()).toBe(view.getInt8(2));
        expect(stm.getInt8()).toBe(view.getInt8(3));
        expect(stm.getUint16(false)).toBe(view.getUint16(4, false));
        expect(stm.getUint16(true)).toBe(view.getUint16(6, true));
        expect(stm.getInt16(false)).toBe(view.getUint16(8, false));
        expect(stm.getInt16(true)).toBe(view.getUint16(10, true));
        expect(stm.getUint32(false)).toBe(view.getUint32(12, false));
        expect(stm.getUint32(true)).toBe(view.getUint32(16, true));
        expect(stm.getInt32(false)).toBe(view.getUint32(20, false));
        expect(stm.getInt32(true)).toBe(view.getUint32(24, true));
        expect(stm.getFloat32(false)).toBe(view.getFloat32(28, false));
        expect(stm.getFloat32(true)).toBe(view.getFloat32(32, true));
        expect(stm.getFloat64(false)).toBe(view.getFloat64(36, false));
        expect(stm.getFloat64(true)).toBe(view.getFloat64(44, true));
    });

    test('gets uint64', () => {
        let stm = new BinaryStream(arr.buffer);
        expect(stm.getUint64(false)).toBe(0x0001020304050607);
        expect(stm.getUint8()).toBe(8);
        stm = new BinaryStream(arr.buffer);
        expect(stm.getUint64(true)).toBe(0x0706050403020100);
        expect(stm.getUint8()).toBe(8);
    });

    test('provides basic int and float setters available in DataView', () => {
        const tmpArr = new Uint8Array(100);
        const stm = new BinaryStream(tmpArr.buffer);
        stm.setUint8(view.getUint8(0));
        stm.setUint8(view.getUint8(1));
        stm.setInt8(view.getInt8(2));
        stm.setInt8(view.getInt8(3));
        stm.setUint16(view.getUint16(4, false), false);
        stm.setUint16(view.getUint16(6, true), true);
        stm.setInt16(view.getUint16(8, false), false);
        stm.setInt16(view.getUint16(10, true), true);
        stm.setUint32(view.getUint32(12, false), false);
        stm.setUint32(view.getUint32(16, true), true);
        stm.setInt32(view.getUint32(20, false), false);
        stm.setInt32(view.getUint32(24, true), true);
        stm.setFloat32(view.getFloat32(28, false), false);
        stm.setFloat32(view.getFloat32(32, true), true);
        stm.setFloat64(view.getFloat64(36, false), false);
        stm.setFloat64(view.getFloat64(44, true), true);
        expect(new Uint8Array(tmpArr.buffer.slice(0, 52))).toEqual(
            new Uint8Array(arr.buffer.slice(0, 52))
        );
    });

    test('sets uint64', () => {
        let tmpArr = new Uint8Array(9);
        let stm = new BinaryStream(tmpArr.buffer);
        stm.setUint64(0x0001020304050607, false);
        stm.setUint8(8);
        expect(new Uint8Array(tmpArr.buffer)).toEqual(new Uint8Array(arr.buffer.slice(0, 9)));
        tmpArr = new Uint8Array(9);
        stm = new BinaryStream(tmpArr.buffer);
        stm.setUint64(0x0706050403020100, true);
        stm.setUint8(8);
        expect(new Uint8Array(tmpArr.buffer)).toEqual(new Uint8Array(arr.buffer.slice(0, 9)));
    });

    test('reads bytes after pos', () => {
        let stm = new BinaryStream(arr.buffer);
        let bytes = stm.readBytesToEnd();
        expect(new Uint8Array(bytes)).toEqual(new Uint8Array(arr.buffer));
        bytes = stm.readBytesToEnd();
        expect(bytes.byteLength).toBe(0);

        stm = new BinaryStream(arr.buffer);
        stm.getUint8();
        stm.getFloat64(false);
        bytes = stm.readBytesToEnd();
        expect(new Uint8Array(bytes)).toEqual(new Uint8Array(arr.buffer.slice(9)));
        bytes = stm.readBytesToEnd();
        expect(bytes.byteLength).toBe(0);

        stm = new BinaryStream(arr.buffer);
        for (let i = 0; i < 100; i++) {
            stm.getUint8();
        }
        bytes = stm.readBytesToEnd();
        expect(bytes.byteLength).toBe(0);
    });

    test('reads number of bytes after pos', () => {
        let stm = new BinaryStream(arr.buffer);
        let bytes = stm.readBytes(100);
        expect(new Uint8Array(bytes)).toEqual(new Uint8Array(arr.buffer));
        bytes = stm.readBytesToEnd();
        expect(bytes.byteLength).toBe(0);

        stm = new BinaryStream(arr.buffer);
        stm.getUint8();
        stm.getFloat64(false);
        bytes = stm.readBytes(50);
        expect(new Uint8Array(bytes)).toEqual(new Uint8Array(arr.buffer.slice(9, 59)));
        bytes = stm.readBytesToEnd();
        expect(bytes.byteLength).toBe(41);

        stm = new BinaryStream(arr.buffer);
        for (let i = 0; i < 100; i++) {
            stm.getUint8();
        }
        bytes = stm.readBytes(5);
        expect(bytes.byteLength).toBe(0);
    });

    test('returns position', () => {
        const stm = new BinaryStream(arr.buffer);
        expect(stm.pos).toBe(0);
        stm.getInt8();
        expect(stm.pos).toBe(1);
        stm.readBytesToEnd();
        expect(stm.pos).toBe(100);
    });

    test('returns byteLength', () => {
        const stm = new BinaryStream(arr.buffer);
        expect(stm.byteLength).toBe(arr.buffer.byteLength);
    });

    test('can read bytes without changing position', () => {
        const stm = new BinaryStream(arr.buffer);
        expect(stm.pos).toBe(0);
        const bytes = stm.readBytesNoAdvance(10, 12);
        expect(stm.pos).toBe(0);
        expect(new Uint8Array(bytes)).toEqual(new Uint8Array([10, 11]));
    });

    test('can expand length on write', () => {
        const stm = new BinaryStream(new Uint8Array(2).buffer);
        // @ts-ignore
        stm._canExpand = true;
        stm.writeBytes(new Uint8Array([0, 1, 2]));
        stm.setUint8(3);
        stm.writeBytes(new Uint8Array([4]).buffer);
        expect(new Uint8Array(stm.getWrittenBytes())).toEqual(new Uint8Array([0, 1, 2, 3, 4]));
    });

    test('creates buffer itself and expands it', () => {
        const stm = new BinaryStream();
        stm.writeBytes(new Uint8Array(1021));
        stm.writeBytes(new Uint8Array([0, 1, 2]));
        stm.setUint8(3);
        stm.writeBytes(new Uint8Array([4]).buffer);
        expect(stm.getWrittenBytes().byteLength).toBe(1026);
    });
});
