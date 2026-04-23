import * as kdbxweb from 'kdbxweb';
import { Model } from 'framework/model';
import { AppSettingsModel } from 'models/app-settings-model';
import { KdbxToHtml } from 'comp/format/kdbx-to-html';
import { IconMap } from 'const/icon-map';
import { BuiltInFields } from 'const/entry-fields';
import { AttachmentModel } from 'models/attachment-model';
import { Color } from 'util/data/color';
import { Otp } from 'util/data/otp';
import { Ranking } from 'util/data/ranking';
import { IconUrlFormat } from 'util/formatting/icon-url-format';
import { omit } from 'util/fn';
import { EntrySearch } from 'util/entry-search';
import type { EntryModel as SearchableEntryModel, SearchFilter } from 'util/entry-search';
import type { ColorName } from 'const/colors';

const UrlRegex = /^https?:\/\//i;
const FieldRefRegex = /^\{REF:([TNPAU])@I:(\w{32})}$/;
const FieldRefFields = ['title', 'password', 'user', 'url', 'notes'];
const FieldRefIds: Record<string, string> = {
    T: 'Title',
    U: 'UserName',
    P: 'Password',
    A: 'URL',
    N: 'Notes'
};
const ExtraUrlFieldName = 'KP2A_URL';

/**
 * Parse a legacy OTP query-string / TrayTOTP-settings numeric argument
 * (period, digits, step, size) into a number. Returns `undefined` if
 * the value is missing or not finite, which matches the ignored-default
 * behaviour in `Otp.makeUrl`.
 */
function parseOtpNumericArg(value: string | undefined): number | undefined {
    if (value === undefined || value === '') {
        return undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

// EntryFilter extends SearchFilter so `EntryModel.matches()` can forward
// it to `EntrySearch.matches()` without loss. SearchFilter uses the
// structural `AdvancedFilter` flags (regex, cs, user, url, ...); callers
// in views that still use the legacy `exact/protect/user` sub-flags are
// treated as a subset of the advanced filter.
interface EntryFilter extends SearchFilter {
    trash?: boolean;
    group?: string;
    subGroups?: boolean;
    includeDisabled?: boolean;
}

interface AutoTypeItem {
    window: string;
    sequence: string;
}

/**
 * What `EntryModel.otpGenerator` actually holds.
 *
 * Historically this was typed as a loose `{ url: string; [k: string]: unknown }`
 * bag but at runtime it's always an `Otp` instance produced by
 * `Otp.parseUrl(url)`. Typing it as `Otp` lets `setOtp(otp)` compile
 * without casts.
 */
type OtpGenerator = Otp;

class EntryModel extends Model {
    _search!: EntrySearch;
    entry!: kdbxweb.KdbxEntry;
    group!: unknown;
    file!: unknown;
    hasFieldRefs!: boolean;

    declare uuid: string;
    declare id: string;
    declare fileName: string;
    declare groupName: string;
    declare title: string;
    declare password: kdbxweb.ProtectedValue;
    declare notes: string;
    declare url: string;
    declare displayUrl: string;
    declare user: string;
    declare iconId: number;
    declare icon: string;
    declare tags: string[];
    declare color: string | null;
    declare fields: Record<string, unknown>;
    declare attachments: AttachmentModel[];
    declare created: Date;
    declare updated: Date;
    declare expires: Date | undefined;
    declare expired: boolean;
    declare historyLength: number;
    declare titleUserLower: string;
    declare customIcon: string | null;
    declare customIconId: string | null;
    declare searchText: string;
    declare searchTags: string[];
    declare searchColor: string | null;
    declare autoTypeEnabled: boolean;
    declare autoTypeObfuscation: boolean;
    declare autoTypeSequence: string | undefined;
    declare autoTypeWindows: AutoTypeItem[];
    declare unsaved: boolean;
    declare isJustCreated: boolean;
    declare canBeDeleted: boolean;
    declare otpGenerator: OtpGenerator | null;

    constructor(props?: Record<string, unknown>) {
        super(props);
        // EntrySearch's structural model type is defined in util/entry-search
        // to avoid a circular import; the runtime class always satisfies it
        // via the fields/searchText/searchTags/getAllFields members below.
        this._search = new EntrySearch(this as unknown as SearchableEntryModel);
    }

    setEntry(entry: kdbxweb.KdbxEntry, group: unknown, file: unknown): void {
        this.entry = entry;
        this.group = group;
        this.file = file;
        if (this.uuid === (entry.uuid as unknown as { id: string }).id) {
            this._checkUpdatedEntry();
        }
        // we cannot calculate field references now because database index has not yet been built
        this.hasFieldRefs = false;
        this._fillByEntry();
        this.hasFieldRefs = true;
    }

    _fillByEntry(): void {
        const entry = this.entry;
        const file = this.file as { subId(id: string): string; name: string; db: { meta: { customIcons: Map<string, { data: ArrayBuffer }> } } };
        const group = this.group as { title: string };
        this.set(
            { id: file.subId((entry.uuid as unknown as { id: string }).id), uuid: (entry.uuid as unknown as { id: string }).id },
            { silent: true }
        );
        this.fileName = file.name;
        this.groupName = group.title;
        this.title = this._getFieldString('Title');
        this.password = this._getPassword();
        this.notes = this._getFieldString('Notes');
        this.url = this._getFieldString('URL');
        this.displayUrl = this._getDisplayUrl(this._getFieldString('URL'));
        this.user = this._getFieldString('UserName');
        this.iconId = entry.icon as number;
        this.icon = this._iconFromId(entry.icon as number);
        this.tags = entry.tags;
        this.color =
            this._colorToModel(entry.bgColor as string | undefined) ||
            this._colorToModel(entry.fgColor as string | undefined);
        this.fields = this._fieldsToModel();
        this.attachments = this._attachmentsToModel(entry.binaries);
        this.created = entry.times.creationTime as Date;
        this.updated = entry.times.lastModTime as Date;
        this.expires = entry.times.expires ? (entry.times.expiryTime as Date) : undefined;
        this.expired = !!(entry.times.expires && (entry.times.expiryTime as Date) <= new Date());
        this.historyLength = entry.history.length;
        this.titleUserLower = `${this.title}:${this.user}`.toLowerCase();
        this._buildCustomIcon();
        this._buildSearchText();
        this._buildSearchTags();
        this._buildSearchColor();
        this._buildAutoType();
        if (this.hasFieldRefs) {
            this.resolveFieldReferences();
        }
    }

    _getPassword(): kdbxweb.ProtectedValue {
        const password = this.entry.fields.get('Password') || kdbxweb.ProtectedValue.fromString('');
        if (!(password as kdbxweb.ProtectedValue).isProtected) {
            return kdbxweb.ProtectedValue.fromString(password as string);
        }
        return password as kdbxweb.ProtectedValue;
    }

    _getFieldString(field: string): string {
        const val = this.entry.fields.get(field);
        if (!val) {
            return '';
        }
        if ((val as kdbxweb.ProtectedValue).isProtected) {
            return (val as kdbxweb.ProtectedValue).getText();
        }
        return val.toString();
    }

    _checkUpdatedEntry(): void {
        if (this.isJustCreated) {
            this.isJustCreated = false;
        }
        if (this.canBeDeleted) {
            this.canBeDeleted = false;
        }
        if (this.unsaved && +this.updated !== +(this.entry.times.lastModTime as Date)) {
            this.unsaved = false;
        }
    }

    _buildSearchText(): void {
        let text = '';
        for (const value of this.entry.fields.values()) {
            if (typeof value === 'string') {
                text += value.toLowerCase() + '\n';
            }
        }
        this.entry.tags.forEach((tag) => {
            text += tag.toLowerCase() + '\n';
        });
        this.attachments.forEach((att) => {
            text += (att.title ?? '').toLowerCase() + '\n';
        });
        this.searchText = text;
    }

    _buildCustomIcon(): void {
        this.customIcon = null;
        this.customIconId = null;
        if (this.entry.customIcon) {
            const file = this.file as { db: { meta: { customIcons: Map<string, { data: ArrayBuffer }> } } };
            this.customIcon = IconUrlFormat.toDataUrl(
                file.db.meta.customIcons.get((this.entry.customIcon as unknown as { id: string }).id)?.data
            );
            this.customIconId = this.entry.customIcon.toString();
        }
    }

    _buildSearchTags(): void {
        this.searchTags = this.entry.tags.map((tag) => tag.toLowerCase());
    }

    _buildSearchColor(): void {
        this.searchColor = this.color;
    }

    _buildAutoType(): void {
        this.autoTypeEnabled = this.entry.autoType.enabled as boolean;
        this.autoTypeObfuscation =
            this.entry.autoType.obfuscation ===
            kdbxweb.Consts.AutoTypeObfuscationOptions.UseClipboard;
        this.autoTypeSequence = this.entry.autoType.defaultSequence;
        this.autoTypeWindows = this.entry.autoType.items.map(this._convertAutoTypeItem);
    }

    _convertAutoTypeItem(item: { window: string; keystrokeSequence: string }): AutoTypeItem {
        return { window: item.window, sequence: item.keystrokeSequence };
    }

    _iconFromId(id: number): string {
        return (IconMap as Record<number, string>)[id];
    }

    _getDisplayUrl(url: string): string {
        if (!url) {
            return '';
        }
        return url.replace(UrlRegex, '');
    }

    _colorToModel(color: string | undefined): string | null {
        return color ? Color.getNearest(color) : null;
    }

    _fieldsToModel(): Record<string, unknown> {
        // `getAllFields()` always returns a concrete object, never null,
        // so `omit` returns a `Partial<Record<string, unknown>>` we can
        // safely widen back to the indexed type.
        return (omit(this.getAllFields(), BuiltInFields as unknown as string[]) ?? {}) as Record<
            string,
            unknown
        >;
    }

    _attachmentsToModel(binaries: Map<string, unknown>): AttachmentModel[] {
        const att: AttachmentModel[] = [];
        for (let [title, data] of binaries) {
            if (data && (data as { ref?: unknown }).ref) {
                data = (data as { value: unknown }).value;
            }
            if (data) {
                att.push(AttachmentModel.fromAttachment({ data, title }));
            }
        }
        return att;
    }

    _entryModified(): void {
        if (!this.unsaved) {
            this.unsaved = true;
            const file = this.file as { historyMaxItems: number; setModified(): void; reload(): void };
            if (file.historyMaxItems !== 0) {
                this.entry.pushHistory();
            }
            file.setModified();
        }
        if (this.isJustCreated) {
            this.isJustCreated = false;
            (this.file as { reload(): void }).reload();
        }
        this.entry.times.update();
    }

    setSaved(): void {
        if (this.unsaved) {
            this.unsaved = false;
        }
        if (this.canBeDeleted) {
            this.canBeDeleted = false;
        }
    }

    matches(filter: EntryFilter): boolean {
        return this._search.matches(filter);
    }

    getAllFields(): Record<string, unknown> {
        const fields: Record<string, unknown> = {};
        for (const [key, value] of this.entry.fields) {
            fields[key] = value;
        }
        return fields;
    }

    getHistoryEntriesForSearch(): kdbxweb.KdbxEntry[] {
        return this.entry.history;
    }

    resolveFieldReferences(): void {
        this.hasFieldRefs = false;
        FieldRefFields.forEach((field) => {
            const fieldValue = (this as unknown as Record<string, unknown>)[field];
            const refValue = this._resolveFieldReference(fieldValue);
            if (refValue !== undefined) {
                (this as unknown as Record<string, unknown>)[field] = refValue;
                this.hasFieldRefs = true;
            }
        });
    }

    getFieldValue(field: string): unknown {
        field = field.toLowerCase();
        let resolvedField: string | undefined;
        [...this.entry.fields.keys()].some((entryField) => {
            if (entryField.toLowerCase() === field) {
                resolvedField = entryField;
                return true;
            }
            return false;
        });
        if (resolvedField) {
            let fieldValue: unknown = this.entry.fields.get(resolvedField);
            const refValue = this._resolveFieldReference(fieldValue);
            if (refValue !== undefined) {
                fieldValue = refValue;
            }
            return fieldValue;
        }
        return undefined;
    }

    _resolveFieldReference(fieldValue: unknown): unknown | undefined {
        if (!fieldValue) {
            return undefined;
        }
        if (
            (fieldValue as kdbxweb.ProtectedValue).isProtected &&
            typeof (fieldValue as { isFieldReference?: () => boolean }).isFieldReference === 'function' &&
            (fieldValue as { isFieldReference: () => boolean }).isFieldReference()
        ) {
            fieldValue = (fieldValue as kdbxweb.ProtectedValue).getText();
        }
        if (typeof fieldValue !== 'string') {
            return undefined;
        }
        const match = fieldValue.match(FieldRefRegex);
        if (!match) {
            return undefined;
        }
        return this._getReferenceValue(match[1], match[2]);
    }

    _getReferenceValue(fieldRefId: string, idStr: string): unknown | undefined {
        const id = new Uint8Array(16);
        for (let i = 0; i < 16; i++) {
            id[i] = parseInt(idStr.substr(i * 2, 2), 16);
        }
        const uuid = new kdbxweb.KdbxUuid(id);
        const file = this.file as { subId(id: string): string; getEntry(id: string): EntryModel | undefined };
        const entry = file.getEntry(file.subId((uuid as unknown as { id: string }).id));
        if (!entry) {
            return undefined;
        }
        return entry.entry.fields.get(FieldRefIds[fieldRefId]);
    }

    setColor(color: ColorName | null): void {
        this._entryModified();
        this.entry.bgColor = color ? Color.getKnownBgColor(color) : undefined;
        this._fillByEntry();
    }

    setIcon(iconId: number): void {
        this._entryModified();
        this.entry.icon = iconId;
        this.entry.customIcon = undefined;
        this._fillByEntry();
    }

    setCustomIcon(customIconId: string): void {
        this._entryModified();
        this.entry.customIcon = new kdbxweb.KdbxUuid(customIconId);
        this._fillByEntry();
    }

    setExpires(dt: Date | null): void {
        this._entryModified();
        this.entry.times.expiryTime = dt instanceof Date ? dt : undefined;
        this.entry.times.expires = !!dt;
        this._fillByEntry();
    }

    setTags(tags: string[]): void {
        this._entryModified();
        this.entry.tags = tags;
        this._fillByEntry();
    }

    renameTag(from: string, to: string): void {
        const ix = this.entry.tags.findIndex(
            (tag) => tag.toLowerCase() === from.toLowerCase()
        );
        if (ix < 0) {
            return;
        }
        this._entryModified();
        this.entry.tags.splice(ix, 1);
        if (to) {
            this.entry.tags.push(to);
        }
        this._fillByEntry();
    }

    setField(field: string, val: unknown, allowEmpty?: boolean): void {
        const hasValue =
            val &&
            (typeof val === 'string' ||
                ((val as kdbxweb.ProtectedValue).isProtected &&
                    (val as kdbxweb.ProtectedValue).byteLength));
        if (hasValue || allowEmpty || (BuiltInFields as unknown as string[]).indexOf(field) >= 0) {
            this._entryModified();
            val = this.sanitizeFieldValue(val);
            this.entry.fields.set(field, val as string | kdbxweb.ProtectedValue);
        } else if (this.entry.fields.has(field)) {
            this._entryModified();
            this.entry.fields.delete(field);
        }
        this._fillByEntry();
    }

    sanitizeFieldValue(val: unknown): unknown {
        if (val && !(val as kdbxweb.ProtectedValue).isProtected) {
            // https://github.com/keeweb/keeweb/issues/910
            // eslint-disable-next-line no-control-regex
            val = (val as string).replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\uFFF0-\uFFFF]/g, '');
        }
        return val;
    }

    hasField(field: string): boolean {
        return this.entry.fields.has(field);
    }

    addAttachment(name: string, data: ArrayBuffer): Promise<void> {
        this._entryModified();
        const file = this.file as { db: { createBinary(data: ArrayBuffer): Promise<unknown> } };
        return file.db.createBinary(data).then((binaryRef: unknown) => {
            this.entry.binaries.set(name, binaryRef as kdbxweb.KdbxBinaryWithHash);
            this._fillByEntry();
        });
    }

    removeAttachment(name: string): void {
        this._entryModified();
        this.entry.binaries.delete(name);
        this._fillByEntry();
    }

    getHistory(): EntryModel[] {
        const history = this.entry.history.map(function (this: EntryModel, rec) {
            return EntryModel.fromEntry(rec, this.group, this.file);
        }, this);
        history.push(this);
        history.sort((x, y) => +x.updated - +y.updated);
        return history;
    }

    deleteHistory(historyEntry: kdbxweb.KdbxEntry): void {
        const ix = this.entry.history.indexOf(historyEntry);
        if (ix >= 0) {
            this.entry.removeHistory(ix);
            (this.file as { setModified(): void }).setModified();
        }
        this._fillByEntry();
    }

    revertToHistoryState(historyEntry: kdbxweb.KdbxEntry): void {
        const ix = this.entry.history.indexOf(historyEntry);
        if (ix < 0) {
            return;
        }
        this.entry.pushHistory();
        this.unsaved = true;
        (this.file as { setModified(): void }).setModified();
        this.entry.fields = new Map();
        this.entry.binaries = new Map();
        this.entry.copyFrom(historyEntry);
        this._entryModified();
        this._fillByEntry();
    }

    discardUnsaved(): void {
        if (this.unsaved && this.entry.history.length) {
            this.unsaved = false;
            const historyEntry = this.entry.history[this.entry.history.length - 1];
            this.entry.removeHistory(this.entry.history.length - 1);
            this.entry.fields = new Map();
            this.entry.binaries = new Map();
            this.entry.copyFrom(historyEntry);
            this._fillByEntry();
        }
    }

    moveToTrash(): void {
        const file = this.file as { setModified(): void; db: { remove(entry: kdbxweb.KdbxEntry): void }; reload(): void };
        file.setModified();
        if (this.isJustCreated) {
            this.isJustCreated = false;
        }
        file.db.remove(this.entry);
        file.reload();
    }

    deleteFromTrash(): void {
        const file = this.file as { setModified(): void; db: { move(entry: kdbxweb.KdbxEntry, target: unknown): void }; reload(): void };
        file.setModified();
        file.db.move(this.entry, null);
        file.reload();
    }

    removeWithoutHistory(): void {
        if (this.canBeDeleted) {
            const group = this.group as { group: { entries: kdbxweb.KdbxEntry[] } };
            const ix = group.group.entries.indexOf(this.entry);
            if (ix >= 0) {
                group.group.entries.splice(ix, 1);
            }
            (this.file as { reload(): void }).reload();
        }
    }

    detach(): kdbxweb.KdbxEntry {
        const file = this.file as { setModified(): void; db: { move(entry: kdbxweb.KdbxEntry, target: null): void }; reload(): void };
        file.setModified();
        file.db.move(this.entry, null);
        file.reload();
        return this.entry;
    }

    moveToFile(file: unknown): void {
        if (this.canBeDeleted) {
            this.removeWithoutHistory();
            const f = file as { groups: Array<{ group: { entries: kdbxweb.KdbxEntry[] }; addEntry(entry: EntryModel): void }>; setModified(): void };
            this.group = f.groups[0];
            this.file = file;
            this._fillByEntry();
            this.entry.times.update();
            (this.group as { group: { entries: kdbxweb.KdbxEntry[] }; addEntry(entry: EntryModel): void }).group.entries.push(this.entry);
            (this.group as { addEntry(entry: EntryModel): void }).addEntry(this);
            this.isJustCreated = true;
            this.unsaved = true;
            (this.file as { setModified(): void }).setModified();
        }
    }

    initOtpGenerator(): void {
        let otpUrl: string | undefined;
        if ((this.fields as Record<string, unknown>).otp) {
            otpUrl = (this.fields as Record<string, unknown>).otp as string;
            if ((otpUrl as unknown as kdbxweb.ProtectedValue).isProtected) {
                otpUrl = (otpUrl as unknown as kdbxweb.ProtectedValue).getText();
            }
            // called only if secret provided, no formatted url
            if (Otp.isSecret(otpUrl.replace(/\s/g, ''))) {
                otpUrl = Otp.makeUrl(otpUrl.replace(/\s/g, '').toUpperCase());
            } else if (otpUrl.toLowerCase().lastIndexOf('otpauth:', 0) !== 0) {
                // KeeOTP plugin format
                const args: Record<string, string> = {};
                otpUrl.split('&').forEach((part) => {
                    const parts = part.split('=', 2);
                    args[parts[0]] = decodeURIComponent(parts[1]).replace(/=/g, '');
                });
                if (args.key) {
                    otpUrl = Otp.makeUrl(
                        args.key,
                        parseOtpNumericArg(args.step),
                        parseOtpNumericArg(args.size)
                    );
                }
            }
        } else if (this.entry.fields.get('TOTP Seed')) {
            // TrayTOTP plugin format
            let secret: unknown = this.entry.fields.get('TOTP Seed');
            if ((secret as kdbxweb.ProtectedValue).isProtected) {
                secret = (secret as kdbxweb.ProtectedValue).getText();
            }
            if (secret) {
                let settings: unknown = this.entry.fields.get('TOTP Settings');
                if (settings && (settings as kdbxweb.ProtectedValue).isProtected) {
                    settings = (settings as kdbxweb.ProtectedValue).getText();
                }
                let period: number | undefined;
                let digits: number | undefined;
                if (settings) {
                    const settingsParts = (settings as string).split(';');
                    if (settingsParts.length > 0 && settingsParts[0] > '0') {
                        period = parseOtpNumericArg(settingsParts[0]);
                    }
                    if (settingsParts.length > 1 && settingsParts[1] > '0') {
                        digits = parseOtpNumericArg(settingsParts[1]);
                    }
                }
                otpUrl = Otp.makeUrl(secret as string, period, digits);
                (this.fields as Record<string, unknown>).otp =
                    kdbxweb.ProtectedValue.fromString(otpUrl);
            }
        }
        if (otpUrl) {
            if (this.otpGenerator && this.otpGenerator.url === otpUrl) {
                return;
            }
            try {
                this.otpGenerator = Otp.parseUrl(otpUrl);
            } catch {
                this.otpGenerator = null;
            }
        } else {
            this.otpGenerator = null;
        }
    }

    setOtp(otp: OtpGenerator): void {
        this.otpGenerator = otp;
        this.setOtpUrl(otp.url);
    }

    setOtpUrl(url: string | undefined): void {
        this.setField(
            'otp',
            url ? kdbxweb.ProtectedValue.fromString(url) : undefined
        );
        this.entry.fields.delete('TOTP Seed');
        this.entry.fields.delete('TOTP Settings');
    }

    getEffectiveEnableAutoType(): boolean {
        if (typeof this.entry.autoType.enabled === 'boolean') {
            return this.entry.autoType.enabled;
        }
        return (this.group as { getEffectiveEnableAutoType(): boolean }).getEffectiveEnableAutoType();
    }

    getEffectiveAutoTypeSeq(): string {
        return (
            this.entry.autoType.defaultSequence ||
            (this.group as { getEffectiveAutoTypeSeq(): string }).getEffectiveAutoTypeSeq()
        );
    }

    setEnableAutoType(enabled: boolean | null): void {
        this._entryModified();
        // kdbxweb's KdbxEntryAutoType types `enabled` as `boolean`, but
        // the runtime and the KDBX XML spec both permit an "inherit"
        // state encoded as null/undefined — `getEffectiveEnableAutoType`
        // below explicitly falls back to the parent group when
        // `typeof enabled !== 'boolean'`. Widen at assignment only.
        (this.entry.autoType as { enabled: boolean | null }).enabled = enabled;
        this._buildAutoType();
    }

    setAutoTypeObfuscation(enabled: boolean): void {
        this._entryModified();
        this.entry.autoType.obfuscation = enabled
            ? kdbxweb.Consts.AutoTypeObfuscationOptions.UseClipboard
            : kdbxweb.Consts.AutoTypeObfuscationOptions.None;
        this._buildAutoType();
    }

    setAutoTypeSeq(seq: string | undefined): void {
        this._entryModified();
        this.entry.autoType.defaultSequence = seq || undefined;
        this._buildAutoType();
    }

    getGroupPath(): string[] {
        let group = this.group as { title: string; parentGroup?: unknown } | undefined;
        const groupPath: string[] = [];
        while (group) {
            groupPath.unshift(group.title);
            group = group.parentGroup as typeof group;
        }
        return groupPath;
    }

    cloneEntry(nameSuffix: string): EntryModel {
        const newEntry = EntryModel.newEntry(
            this.group as { group: kdbxweb.KdbxGroup; addEntry(entry: EntryModel): void; file: unknown; icon: string; iconId: number },
            this.file as { db: kdbxweb.Kdbx; setModified(): void; reload(): void; subId(id: string): string; name: string }
        );
        const uuid = newEntry.entry.uuid;
        newEntry.entry.copyFrom(this.entry);
        newEntry.entry.uuid = uuid;
        newEntry.entry.times.update();
        newEntry.entry.times.creationTime = newEntry.entry.times.lastModTime;
        newEntry.entry.fields.set('Title', this.title + nameSuffix);
        newEntry._fillByEntry();
        (this.file as { reload(): void }).reload();
        return newEntry;
    }

    copyFromTemplate(templateEntry: EntryModel): void {
        const uuid = this.entry.uuid;
        this.entry.copyFrom(templateEntry.entry);
        this.entry.uuid = uuid;
        this.entry.times.update();
        this.entry.times.creationTime = this.entry.times.lastModTime;
        this.entry.fields.set('Title', '');
        this._fillByEntry();
    }

    getRank(filter: EntryFilter): number {
        const searchString = filter.textLower;

        if (!searchString) {
            // no search string given, so rank all items the same
            return 0;
        }

        const checkProtectedFields = filter.advanced && filter.advanced.protect;

        const fieldWeights: Record<string, number> = {
            Title: 10,
            URL: 8,
            UserName: 5,
            Notes: 2
        };

        const defaultFieldWeight = 2;

        const allFields = Object.keys(fieldWeights).concat(Object.keys(this.fields));

        return allFields.reduce((rank, fieldName) => {
            const val = this.entry.fields.get(fieldName);
            if (!val) {
                return rank;
            }
            if (
                (val as kdbxweb.ProtectedValue).isProtected &&
                (!checkProtectedFields || !(val as kdbxweb.ProtectedValue).byteLength)
            ) {
                return rank;
            }
            const stringRank = Ranking.getStringRank(searchString, val);
            const fieldWeight = fieldWeights[fieldName] || defaultFieldWeight;
            return rank + stringRank * fieldWeight;
        }, 0);
    }

    getHtml(): string {
        const file = this.file as { db: kdbxweb.Kdbx };
        return KdbxToHtml.entryToHtml(file.db, this.entry);
    }

    canCheckPasswordIssues(): boolean {
        return !this.entry.customData?.has('IgnorePwIssues');
    }

    setIgnorePasswordIssues(): void {
        if (!this.entry.customData) {
            this.entry.customData = new Map();
        }
        // KdbxCustomDataItem = { value: string | undefined; lastModified?: Date }
        this.entry.customData.set('IgnorePwIssues', { value: '1' });
        this._entryModified();
    }

    getNextUrlFieldName(): string {
        const takenFields = new Set(
            [...this.entry.fields.keys()].filter((f) => f.startsWith(ExtraUrlFieldName))
        );
        for (let i = 0; ; i++) {
            const fieldName = i ? `${ExtraUrlFieldName}_${i}` : ExtraUrlFieldName;
            if (!takenFields.has(fieldName)) {
                return fieldName;
            }
        }
    }

    getAllUrls(): string[] {
        const urls = this.url ? [this.url] : [];
        const extraUrls = Object.entries(this.fields)
            .filter(([field]) => field.startsWith(ExtraUrlFieldName))
            .map(([, value]) =>
                (value as kdbxweb.ProtectedValue).isProtected
                    ? (value as kdbxweb.ProtectedValue).getText()
                    : (value as string)
            )
            .filter((value) => value);
        return urls.concat(extraUrls);
    }

    static fromEntry(entry: kdbxweb.KdbxEntry, group: unknown, file: unknown): EntryModel {
        const model = new EntryModel();
        model.setEntry(entry, group, file);
        return model;
    }

    static newEntry(
        group: { group: kdbxweb.KdbxGroup; addEntry(entry: EntryModel): void; icon?: string; iconId?: number },
        file: { db: kdbxweb.Kdbx; setModified(): void; reload?(): void; subId?(id: string): string; name?: string },
        opts?: { tag?: string }
    ): EntryModel {
        const model = new EntryModel();
        const entry = file.db.createEntry(group.group);
        if (
            AppSettingsModel.useGroupIconForEntries &&
            group.icon &&
            group.iconId
        ) {
            entry.icon = group.iconId;
        }
        if (opts && opts.tag) {
            entry.tags = [opts.tag];
        }
        model.setEntry(entry, group, file);
        model.entry.times.update();
        model.unsaved = true;
        model.isJustCreated = true;
        model.canBeDeleted = true;
        group.addEntry(model);
        file.setModified();
        return model;
    }

    static newEntryWithFields(
        group: { group: kdbxweb.KdbxGroup; addEntry(entry: EntryModel): void; file: unknown },
        fields: Record<string, unknown>
    ): EntryModel {
        const entry = EntryModel.newEntry(group, (group as { file: unknown }).file as { db: kdbxweb.Kdbx; setModified(): void });
        for (const [field, value] of Object.entries(fields)) {
            entry.setField(field, value);
        }
        return entry;
    }
}

EntryModel.defineModelProperties({}, { extensions: true });

export { EntryModel, ExtraUrlFieldName };
export type { EntryFilter, AutoTypeItem };
