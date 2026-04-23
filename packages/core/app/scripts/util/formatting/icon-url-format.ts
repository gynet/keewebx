import * as kdbxweb from 'kdbxweb';

const IconUrlFormat = {
    toDataUrl(iconData: ArrayBuffer | Uint8Array | null | undefined): string | null {
        if (!iconData) {
            return null;
        }
        // kdbxweb stores custom icons as ArrayBuffer (Kdbx.meta.customIcons).
        // bytesToBase64 wants a Uint8Array view over the underlying buffer.
        const bytes = iconData instanceof Uint8Array ? iconData : new Uint8Array(iconData);
        return 'data:image/png;base64,' + kdbxweb.ByteUtils.bytesToBase64(bytes);
    }
};

export { IconUrlFormat };
