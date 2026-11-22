import { Gunzip } from 'fflate';
import { ErrorCodes } from '../defs/consts';
import { KdbxError } from '../errors/kdbx-error';

const MaxExpandedBytes = 256 * 1024 * 1024;
const InputChunkBytes = 16 * 1024;

/** Feed small input chunks so each decoded chunk can be checked as it arrives. */
export function gunzipBounded(input: Uint8Array): Uint8Array {
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
        const decoder = new Gunzip(chunk => {
            length += chunk.byteLength;
            if (length > MaxExpandedBytes) {
                throw new KdbxError(ErrorCodes.Unsupported, 'expanded database exceeds size limit');
            }
            chunks.push(chunk);
        });
        if (input.byteLength < 18) {
            throw new KdbxError(ErrorCodes.FileCorrupt, 'incomplete gzip data');
        }
        // Leave the complete trailer for the final push.
        const chunkEnd = input.byteLength - 8;
        for (let offset = 0; offset < chunkEnd; offset += InputChunkBytes) {
            const end = Math.min(offset + InputChunkBytes, chunkEnd);
            decoder.push(input.subarray(offset, end === chunkEnd ? input.length : end), end === chunkEnd);
        }
    } catch (error) {
        if (error instanceof KdbxError) throw error;
        throw new KdbxError(ErrorCodes.FileCorrupt, 'bad gzip data');
    }

    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}
