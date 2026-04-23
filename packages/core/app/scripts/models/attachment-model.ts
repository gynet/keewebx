import { Model } from 'framework/model';

interface AttachmentData {
    title: string;
    data: unknown;
}

interface AttachmentProperties {
    title: string | undefined;
    data: unknown;
    ext: string | undefined;
    icon: string | undefined;
    mimeType: string | undefined;
}

class AttachmentModel extends Model {
    declare title: string | undefined;
    declare data: unknown;
    declare ext: string | undefined;
    declare icon: string | undefined;
    declare mimeType: string | undefined;

    getBinary(): Uint8Array | undefined {
        let data = this.data as
            | Uint8Array
            | ArrayBuffer
            | { value?: unknown; getBinary?: () => unknown }
            | null;

        if (data && typeof data === 'object' && 'value' in data) {
            data = data.value as typeof data;
        }
        if (data && typeof data === 'object' && 'getBinary' in data && typeof data.getBinary === 'function') {
            data = data.getBinary() as typeof data;
        }
        if (data instanceof ArrayBuffer && data.byteLength) {
            data = new Uint8Array(data);
        }
        if (data instanceof Uint8Array) {
            return data;
        }
        return undefined;
    }

    static fromAttachment(att: AttachmentData): AttachmentModel {
        const ext = getExtension(att.title);
        return new AttachmentModel({
            title: att.title,
            data: att.data,
            ext,
            icon: getIcon(ext),
            mimeType: getMimeType(ext)
        });
    }
}

AttachmentModel.defineModelProperties({
    title: undefined,
    data: undefined,
    ext: undefined,
    icon: undefined,
    mimeType: undefined
});

function getExtension(fileName: string | undefined): string | undefined {
    const ext = fileName ? fileName.split('.').pop() : undefined;
    return ext ? ext.toLowerCase() : undefined;
}

function getIcon(ext: string | undefined): string {
    switch (ext) {
        case 'txt':
        case 'log':
        case 'rtf':
        case 'pem':
            return 'file-alt';
        case 'html':
        case 'htm':
        case 'js':
        case 'css':
        case 'xml':
        case 'config':
        case 'json':
        case 'yaml':
        case 'cpp':
        case 'c':
        case 'h':
        case 'cc':
        case 'hpp':
        case 'mm':
        case 'cs':
        case 'php':
        case 'sh':
        case 'py':
        case 'java':
        case 'rb':
        case 'cfg':
        case 'properties':
        case 'yml':
        case 'asm':
        case 'bat':
            return 'file-code';
        case 'pdf':
            return 'file-pdf';
        case 'zip':
        case 'rar':
        case 'bz':
        case 'bz2':
        case '7z':
        case 'gzip':
        case 'gz':
        case 'tar':
        case 'cab':
        case 'ace':
        case 'dmg':
        case 'jar':
            return 'file-archive';
        case 'doc':
        case 'docx':
            return 'file-word';
        case 'xls':
        case 'xlsx':
            return 'file-excel';
        case 'ppt':
        case 'pptx':
            return 'file-powerpoint';
        case 'jpeg':
        case 'jpg':
        case 'png':
        case 'gif':
        case 'bmp':
        case 'tiff':
        case 'svg':
        case 'ico':
        case 'psd':
            return 'file-image';
        case 'avi':
        case 'mp4':
        case '3gp':
        case 'm4v':
        case 'mov':
        case 'mpeg':
        case 'mpg':
        case 'mpe':
            return 'file-video';
        case 'mp3':
        case 'wav':
        case 'flac':
            return 'file-audio';
        default:
            return 'file';
    }
}

function getMimeType(ext: string | undefined): string | undefined {
    switch (ext) {
        case 'txt':
        case 'log':
        case 'html':
        case 'htm':
        case 'js':
        case 'css':
        case 'xml':
        case 'config':
        case 'json':
        case 'yaml':
        case 'cpp':
        case 'c':
        case 'h':
        case 'cc':
        case 'hpp':
        case 'mm':
        case 'cs':
        case 'php':
        case 'sh':
        case 'py':
        case 'java':
        case 'rb':
        case 'cfg':
        case 'properties':
        case 'yml':
        case 'asm':
        case 'pem':
            return 'text/plain';
        case 'pdf':
            return 'application/pdf';
        case 'jpeg':
        case 'jpg':
        case 'png':
        case 'gif':
        case 'bmp':
        case 'tiff':
        case 'svg':
            return 'image/' + ext;
        default:
            return undefined;
    }
}

export { AttachmentModel };
export type { AttachmentProperties };
