import { KdbxBinaries, ProtectedValue, type Kdbx, type KdbxEntry } from 'kdbxweb';
import { sha256 } from '@noble/hashes/sha2.js';
import type { AppModel } from 'models/app-model';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { getSessionAccess } from './session-access';
import { waitForCredentialChanges, credentialChangeVersion } from '../../util/kdbxweb/credential-changes';
import { createExportSnapshot } from '../../util/kdbxweb/export-snapshot';

export interface TransferDestination { file: FileModel; group: GroupModel; label: string; }
export interface TransferResult {
    state: 'moved' | 'source-save-pending' | 'source-retained';
    message: string;
    entryId?: string;
    groupId?: string;
}

function writable(model: AppModel, file: FileModel): boolean {
    return file.active && !file.demo && model.files.get(file.id) === file
        && !(file as FileModel & { readOnly?: boolean }).readOnly;
}

/** Include membership and sibling order: a reused id is not the confirmed destination. */
function path(file: FileModel, group: GroupModel) {
    const result: { group: GroupModel; raw: GroupModel['group']; name: string; position: number }[] = [];
    for (let current: GroupModel | null = group; current; current = current.parentGroup) {
        if (result.some(item => item.group === current) || current.file !== file || file.getGroup(current.id) !== current
            || current.group.parentGroup !== current.parentGroup?.group
            || file.db.meta.recycleBinUuid?.equals(current.group.uuid)
            || file.db.meta.entryTemplatesGroup?.equals(current.group.uuid)) return null;
        const siblings = current.parentGroup ? current.parentGroup.group.groups : file.db.groups;
        const position = siblings.indexOf(current.group);
        if (position < 0) return null;
        const same = siblings.filter(other => file.getGroup(file.subId(other.uuid.id))?.title === current!.title);
        const name = JSON.stringify(current.title) + (same.length > 1 ? ` (${same.indexOf(current.group) + 1})` : '');
        result.unshift({ group: current, raw: current.group, name, position });
    }
    return result;
}

function stamp(file: FileModel) {
    const db = file.db, seq = file.editSeq, syncDate = file.syncDate?.getTime();
    const credentials = db.credentials, version = credentialChangeVersion(credentials);
    return () => file.db === db && file.editSeq === seq && file.syncDate?.getTime() === syncDate
        && db.credentials === credentials && credentialChangeVersion(credentials) === version;
}

// Compare semantic content without retaining plaintext protected fields in a string.
// Parent pointers and local merge bookkeeping are not persisted entry content.
function digest(value: unknown): string {
    const hash = (bytes: Uint8Array) => Array.from(sha256(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    const normalize = (item: unknown): unknown => {
        if (item instanceof ProtectedValue) {
            const bytes = item.getBinary();
            try { return { protected: hash(bytes) }; } finally { bytes.fill(0); }
        }
        if (item instanceof ArrayBuffer) return { bytes: hash(new Uint8Array(item)) };
        if (item instanceof Uint8Array) return { bytes: hash(item) };
        if (item instanceof Date) return item.getTime();
        if (item instanceof Map) return [...item].sort(([a], [b]) => String(a).localeCompare(String(b)))
            .map(([key, value]) => [key, normalize(value)]);
        if (Array.isArray(item)) return item.map(normalize);
        if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort()
            .filter(key => key !== 'parentGroup' && key !== '_editState')
            .map(key => [key, normalize((item as Record<string, unknown>)[key])]));
        return item;
    };
    return hash(new TextEncoder().encode(JSON.stringify(normalize(value))));
}

function records(entry: KdbxEntry): KdbxEntry[] { return [entry, ...entry.history.flatMap(records)]; }
function content(db: Kdbx, entry: KdbxEntry): string {
    return digest([entry, records(entry).map(item => item.customIcon ? db.meta.customIcons.get(item.customIcon.id) : undefined),
        records(entry).flatMap(item => [...item.binaries.values()].map(binary =>
            KdbxBinaries.isKdbxBinaryWithHash(binary) ? db.binaries.getValueByHash(binary.hash) : binary))]);
}

/** A one-shot, destination-first transfer. The source is never removed on a copy-only result. */
export function prepareEntryTransfer(model: AppModel, entry: EntryModel) {
    const source = entry.file as FileModel, original = entry.entry, sourceGroup = entry.group as GroupModel;
    const access = getSessionAccess(model), epoch = access.epoch, files = [...model.files];
    const sourceStamp = stamp(source), originalPath = path(source, sourceGroup);
    const sourceContent = content(source.db, original);
    let started = false;
    const samePath = (file: FileModel, group: GroupModel, previous: ReturnType<typeof path>) => {
        const current = path(file, group);
        return !!previous && !!current && current.length === previous.length && current.every((item, i) =>
            item.group === previous[i].group && item.raw === previous[i].raw
            && item.name === previous[i].name && item.position === previous[i].position);
    };
    const session = () => access.state === 'open' && access.isCurrent(epoch)
        && files.length === model.files.length && files.every((file, i) => model.files[i] === file);
    const sourceCurrent = () => session() && writable(model, source) && sourceStamp() && !source.syncing
        && source.getEntry(entry.id) === entry && entry.entry === original && entry.group === sourceGroup
        && original.parentGroup === sourceGroup.group && sourceGroup.group.entries.includes(original)
        && samePath(source, sourceGroup, originalPath) && content(source.db, original) === sourceContent;
    if (!sourceCurrent()) throw new Error('This entry is unavailable, read-only, or changing. Reopen Move after saving.');
    const choices = files.filter(file => file !== source && writable(model, file) && !file.syncing).flatMap(file => {
        const current = stamp(file);
        return file.db.groups.flatMap(root => [...root.allGroups()]).flatMap(raw => {
            const group = file.getGroup(file.subId(raw.uuid.id));
            const chain = group && path(file, group);
            return group && chain ? [{ file, group, label: `${file.name} (${files.indexOf(file) + 1}) / ${chain.map(item => item.name).join(' / ')}`,
                current, chain }] : [];
        });
    });
    const check = (destination?: TransferDestination): string => {
        if (!sourceCurrent()) return 'The source or session changed. Cancel and open Move again.';
        if (destination) {
            const choice = choices.find(item => item === destination);
            if (!choice || !writable(model, choice.file) || choice.file.syncing || !choice.current()
                || !samePath(choice.file, choice.group, choice.chain)) return 'The destination changed. Cancel and choose it again.';
        }
        return '';
    };
    return {
        destinations: choices as TransferDestination[], check,
        async move(destination: TransferDestination, signal: AbortSignal): Promise<TransferResult> {
            if (started) throw new Error('This move has already been submitted.');
            started = true;
            const ensure = () => {
                const reason = check(destination);
                if (signal.aborted || reason) throw new Error(reason || 'Move canceled.');
            };
            ensure();
            const target = destination.file, targetDb = target.db, group = destination.group;
            await Promise.all([waitForCredentialChanges(source.db.credentials), waitForCredentialChanges(targetDb.credentials)]);
            ensure();
            const uuid = original.uuid.id;
            if (targetDb.header.versionMajor < source.db.header.versionMajor
                || (targetDb.header.versionMajor === source.db.header.versionMajor && targetDb.header.versionMinor < source.db.header.versionMinor)) {
                throw new Error('The destination uses an older database format that may discard entry metadata. Nothing moved. Choose a compatible vault.');
            }
            if (targetDb.deletedObjects.some(item => item.uuid?.id === uuid)
                || targetDb.groups.some(root => [...root.allGroups()].some(item => item.uuid?.id === uuid)
                    || [...root.allEntries()].some(item => item.uuid?.id === uuid))) {
                throw new Error('This entry UUID already exists or was deleted in the destination. Nothing moved. Choose another vault.');
            }
            const historyLimit = targetDb.meta.historyMaxItems;
            if (typeof historyLimit === 'number' && historyLimit >= 0 && original.history.length > historyLimit) {
                throw new Error('The destination history limit would discard revisions. Increase its history limit before moving.');
            }
            // Full graph copy preserves protected values, history, custom data and binary ownership.
            // importEntry deliberately assigns another UUID, so it is not a move primitive.
            const snapshot = createExportSnapshot(source.db);
            const copy = snapshot.groups.flatMap(root => [...root.allEntries()]).find(item => item.uuid?.id === uuid)!;
            const binaries = new Map<string, ReturnType<Kdbx['binaries']['getValueByHash']>>();
            const icons = new Map<string, NonNullable<ReturnType<Kdbx['meta']['customIcons']['get']>>>();
            for (const revision of records(copy)) {
                for (const binary of revision.binaries.values()) if (KdbxBinaries.isKdbxBinaryWithHash(binary)) {
                    const bytes = snapshot.binaries.getValueByHash(binary.hash), existing = targetDb.binaries.getValueByHash(binary.hash);
                    if (!bytes || digest(bytes) !== digest(binary.value) || (existing && digest(existing) !== digest(bytes))) {
                        throw new Error('An attachment is missing or conflicts with the destination. Nothing moved.');
                    }
                    binaries.set(binary.hash, bytes);
                }
                if (revision.customIcon) {
                    const id = revision.customIcon.id, icon = snapshot.meta.customIcons.get(id), existing = targetDb.meta.customIcons.get(id);
                    if (!icon || (existing && digest(existing) !== digest(icon)) || targetDb.deletedObjects.some(item => item.uuid?.id === id)) {
                        throw new Error('A custom icon is missing or conflicts with the destination. Nothing moved.');
                    }
                    icons.set(id, icon);
                }
                revision.parentGroup = undefined;
            }
            ensure();
            for (const [hash, value] of binaries) targetDb.binaries.addWithHash({ hash, value: value! });
            for (const [id, icon] of icons) targetDb.meta.customIcons.set(id, icon);
            copy.parentGroup = group.group;
            group.group.entries.push(copy);
            target.setModified(); target.reload();
            const targetSeq = target.editSeq, targetCredentials = targetDb.credentials, targetVersion = credentialChangeVersion(targetCredentials), choice = choices.find(item => item === destination)!;
            const targetCurrent = () => session() && !signal.aborted && writable(model, target) && target.db === targetDb
                && targetDb.credentials === targetCredentials && credentialChangeVersion(targetCredentials) === targetVersion
                && target.editSeq === targetSeq && samePath(target, group, choice.chain)
                && group.group.entries.includes(copy) && content(targetDb, copy) === sourceContent;
            const save = (file: FileModel, canContinue: () => boolean) => new Promise<void>((resolve, reject) =>
                model.syncFile(file, { canContinue }, error => error ? reject(error) : resolve()));
            try {
                await save(target, () => targetCurrent() && sourceCurrent());
                if (!targetCurrent() || !sourceCurrent() || target.modified || target.dirty || target.syncing) throw new Error('Save changed or interrupted');
            } catch {
                // A remote write can have succeeded even if its acknowledgement failed.
                // Retain both records; never turn an ambiguous copy into a source deletion.
                return { state: 'source-retained', message: 'Move not completed. The source entry is intact. The destination may contain a copy, including an unsaved copy. Review both vaults and their save status; no source deletion was performed.' };
            }
            source.db.move(original, null);
            source.setModified(); source.reload();
            const moved = { entryId: target.subId(uuid), groupId: group.id };
            try {
                const db = source.db, seq = source.editSeq;
                await save(source, () => session() && !signal.aborted && writable(model, source) && source.db === db && source.editSeq === seq);
                if (source.modified || source.dirty || source.syncing) throw new Error('Source save incomplete');
                return { ...moved, state: 'moved', message: 'Entry moved. Both vaults saved.' };
            } catch {
                return { ...moved, state: 'source-save-pending', message: 'The destination is saved. Source removal is not yet saved; an older source copy may remain. Retry saving the source vault before closing it.' };
            }
        }
    };
}
