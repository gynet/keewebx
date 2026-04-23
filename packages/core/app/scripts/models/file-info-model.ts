import { Model } from 'framework/model';
import { pick } from 'util/fn';
import { getRegisteredFileInfoFields } from 'hooks/data-registry';

interface FileInfoProperties {
    id: string;
    name: string;
    storage: string | null;
    path: string | null;
    modified: boolean;
    editState: unknown | null;
    rev: string | null;
    syncDate: Date | null;
    openDate: Date | null;
    keyFileName: string | null;
    keyFileHash: string | null;
    keyFilePath: string | null;
    opts: Record<string, unknown> | null;
    backup: Record<string, unknown> | null;
    fingerprint: string | null;
    chalResp: Record<string, unknown> | null;
    encryptedPassword: string | null;
    encryptedPasswordDate: Date | null;
    // Passkey quick unlock (#9, Phase 2). All four fields are persisted
    // together; presence of `passkeyCredentialId` is the gate for the
    // open-view passkey button. Wrap-mode design: `passkeyWrappedKey`
    // is an AES-256-GCM ciphertext of the master password string, keyed
    // by HKDF-SHA256(prfOutput, salt=fileId, info="neokeeweb-passkey-unlock-v1").
    // The KDBX file itself is unchanged — disabling passkey unlock is just
    // clearing these four fields, the database remains password-unlockable.
    passkeyCredentialId: string | null;
    passkeyPrfSalt: string | null;
    passkeyWrappedKey: string | null;
    // Note: field name MUST end in `Date` for constructor auto-hydration
    // below; renaming to `passkeyCreatedAt` would silently break reload.
    passkeyCreatedDate: Date | null;
}

const DefaultProperties: FileInfoProperties = {
    id: '',
    name: '',
    storage: null,
    path: null,
    modified: false,
    editState: null,
    rev: null,
    syncDate: null,
    openDate: null,
    keyFileName: null,
    keyFileHash: null,
    keyFilePath: null,
    opts: null,
    backup: null,
    fingerprint: null, // obsolete
    chalResp: null,
    encryptedPassword: null,
    encryptedPasswordDate: null,
    passkeyCredentialId: null,
    passkeyPrfSalt: null,
    passkeyWrappedKey: null,
    passkeyCreatedDate: null
};

class FileInfoModel extends Model {
    declare id: string;
    declare name: string;
    declare storage: string | null;
    declare path: string | null;
    declare modified: boolean;
    declare editState: unknown | null;
    declare rev: string | null;
    declare syncDate: Date | null;
    declare openDate: Date | null;
    declare keyFileName: string | null;
    declare keyFileHash: string | null;
    declare keyFilePath: string | null;
    declare opts: Record<string, unknown> | null;
    declare backup: Record<string, unknown> | null;
    declare fingerprint: string | null;
    declare chalResp: Record<string, unknown> | null;
    declare encryptedPassword: string | null;
    declare encryptedPasswordDate: Date | null;
    declare passkeyCredentialId: string | null;
    declare passkeyPrfSalt: string | null;
    declare passkeyWrappedKey: string | null;
    declare passkeyCreatedDate: Date | null;

    constructor(data?: Partial<FileInfoProperties>) {
        const raw: Record<string, unknown> = { ...(data ?? {}) };
        const cleaned = pick(raw, Object.keys(DefaultProperties)) ?? {};
        for (const [key, val] of Object.entries(cleaned)) {
            if (/Date$/.test(key)) {
                cleaned[key] = val ? new Date(val as string | number | Date) : null;
            }
        }
        super(cleaned as Record<string, unknown>);
    }
}

FileInfoModel.defineModelProperties(DefaultProperties as unknown as Record<string, unknown>);

function applyRegisteredFileInfoFields(): void {
    const extra: Record<string, unknown> = {};
    for (const [name, value] of getRegisteredFileInfoFields()) {
        (DefaultProperties as unknown as Record<string, unknown>)[name] = value;
        extra[name] = value;
    }
    if (Object.keys(extra).length) {
        FileInfoModel.defineModelProperties(extra);
    }
}

export { FileInfoModel, applyRegisteredFileInfoFields };
export type { FileInfoProperties };
