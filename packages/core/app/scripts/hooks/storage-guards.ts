import type { FileInfoModel } from 'models/file-info-model';

export interface StorageGuardError {
    name?: string;
    message?: string;
    code?: string;
    notEnrolled?: boolean;
    notFound?: boolean;
    revConflict?: boolean;
    toString(): string;
}

export type BeforeOpenGuard = (
    storage: string | undefined,
    fileInfo: FileInfoModel | null
) => StorageGuardError | null;

export type BeforeSyncGuard = (
    storage: string | null,
    fileInfo: FileInfoModel | null | undefined
) => void;

const openGuards: BeforeOpenGuard[] = [];
const syncGuards: BeforeSyncGuard[] = [];

export function registerBeforeOpen(guard: BeforeOpenGuard): void {
    openGuards.push(guard);
}

export function registerBeforeSync(guard: BeforeSyncGuard): void {
    syncGuards.push(guard);
}

export function runBeforeOpen(
    storage: string | undefined,
    fileInfo: FileInfoModel | null
): StorageGuardError | null {
    for (const guard of openGuards) {
        const err = guard(storage, fileInfo);
        if (err) {
            return err;
        }
    }
    return null;
}

export function runBeforeSync(
    storage: string | null,
    fileInfo: FileInfoModel | null | undefined
): void {
    for (const guard of syncGuards) {
        guard(storage, fileInfo);
    }
}
