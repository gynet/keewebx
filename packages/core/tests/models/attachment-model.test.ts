import { describe, test, expect } from 'bun:test';

const { AttachmentModel } = await import('../../app/scripts/models/attachment-model');

describe('AttachmentModel', () => {
    test('creates from attachment with file extension mapping', () => {
        const model = AttachmentModel.fromAttachment({
            title: 'document.pdf',
            data: new Uint8Array([1, 2, 3])
        });
        expect(model.title).toBe('document.pdf');
        expect(model.ext).toBe('pdf');
        expect(model.icon).toBe('file-pdf');
        expect(model.mimeType).toBe('application/pdf');
    });

    test('maps image extensions to correct icon and mime type', () => {
        const model = AttachmentModel.fromAttachment({
            title: 'photo.png',
            data: new Uint8Array([])
        });
        expect(model.ext).toBe('png');
        expect(model.icon).toBe('file-image');
        expect(model.mimeType).toBe('image/png');
    });

    test('maps code file extensions to file-code icon', () => {
        const model = AttachmentModel.fromAttachment({
            title: 'script.js',
            data: new Uint8Array([])
        });
        expect(model.icon).toBe('file-code');
    });

    test('maps archive extensions to file-archive icon', () => {
        const model = AttachmentModel.fromAttachment({
            title: 'backup.zip',
            data: new Uint8Array([])
        });
        expect(model.icon).toBe('file-archive');
    });

    test('falls back to generic file icon for unknown extension', () => {
        const model = AttachmentModel.fromAttachment({
            title: 'data.xyz',
            data: new Uint8Array([])
        });
        expect(model.icon).toBe('file');
        expect(model.mimeType).toBeUndefined();
    });

    test('getBinary() returns Uint8Array from raw Uint8Array data', () => {
        const data = new Uint8Array([10, 20, 30]);
        const model = AttachmentModel.fromAttachment({
            title: 'test.bin',
            data
        });
        expect(model.getBinary()).toEqual(data);
    });

    test('getBinary() converts ArrayBuffer to Uint8Array', () => {
        const buffer = new Uint8Array([5, 10, 15]).buffer;
        const model = AttachmentModel.fromAttachment({
            title: 'test.bin',
            data: buffer
        });
        const result = model.getBinary();
        expect(result).toBeInstanceOf(Uint8Array);
        expect(result).toEqual(new Uint8Array([5, 10, 15]));
    });

    test('getBinary() returns undefined for null data', () => {
        const model = AttachmentModel.fromAttachment({
            title: 'empty.bin',
            data: null
        });
        expect(model.getBinary()).toBeUndefined();
    });

    test('handles filenames without extensions', () => {
        const model = AttachmentModel.fromAttachment({
            title: 'README',
            data: new Uint8Array([])
        });
        // 'README' -> extension is 'readme', which doesn't match any special case
        expect(model.icon).toBe('file');
    });
});
