import { useRef, useState } from 'preact/hooks';
import { ProtectedValue } from 'kdbxweb';
import { BuiltInFields } from 'const/entry-fields';
import type { AppModel } from 'models/app-model';
import { getSessionAccess } from 'comp/app/session-access';
import { OtpFieldNames, otpSnapshot, readEntryOtp, prepareOtpDraft, applyEntryOtp, type OtpDraft } from 'comp/app/entry-otp';
import { EntryOtpFields } from './entry-otp-fields';
import type { EntryModel } from 'models/entry-model';
import type { FileModel } from 'models/file-model';
import type { GroupModel } from 'models/group-model';
import { PasswordGeneratorPanel } from './password-generator';
import { t } from './i18n';
import './entry-editor.css';
import { usePendingDraft } from './pending-drafts';
import { EntryHistory } from './entry-history';
import { writableCreationGroup } from './creation-target';

const FIELDS = [
    { name: 'Title', label: 'Title' },
    { name: 'UserName', label: 'Username' },
    { name: 'Password', label: 'Password' },
    { name: 'URL', label: 'Website' },
    { name: 'Notes', label: 'Notes' }
] as const;
const reservedNames = new Set([...BuiltInFields, ...OtpFieldNames].map((name) => name.toLowerCase()));

interface CustomField {
    id: number;
    originalName?: string;
    name: string;
    value: string;
    protected: boolean;
    multiline?: boolean;
}

export interface EntryDraft {
    fields: Record<string, string>;
    tags: string;
    custom: CustomField[];
    otp?: OtpDraft;
    otpBaseline?: string;
    expires?: string;
    protection?: Record<string, boolean>;
}

function localDate(date?: Date): string {
    if (!date || !Number.isFinite(date.getTime())) return '';
    return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 19);
}

function fieldText(value: unknown): string {
    return value instanceof ProtectedValue ? value.getText() : String(value ?? '');
}

function customName(field: CustomField): string {
    return field.name === field.originalName ? field.name : field.name.trim();
}

export function makeDraft(entry: EntryModel | null, tags: string[], group?: GroupModel): EntryDraft {
    const fields = entry?.getAllFields() ?? {};
    return {
        fields: Object.fromEntries(FIELDS.map(({ name }) => [name, fieldText(fields[name] ??
            (!entry && name === 'UserName' ? (group?.file as FileModel | undefined)?.defaultUser : ''))])),
        protection: Object.fromEntries(FIELDS.map(({ name }) => [name,
            fields[name] instanceof ProtectedValue || (!entry && name === 'Password')])),
        expires: localDate(entry?.expires),
        tags: (entry?.tags ?? tags).join(', '),
        otp: { action: 'keep', value: readEntryOtp(entry).value },
        otpBaseline: otpSnapshot(entry),
        custom: Object.entries(fields)
            .filter(([name]) => !reservedNames.has(name.toLowerCase()))
            .map(([name, value], id) => ({
                id, originalName: name, name, value: fieldText(value), protected: value instanceof ProtectedValue,
                multiline: /[\r\n]/.test(fieldText(value))
            }))
    };
}

/** Apply only changed fields, letting the model own history and file modification. */
export function applyEntryDraft(entry: EntryModel, draft: EntryDraft): void {
    const expires = draft.expires ? new Date(draft.expires) : null;
    if (expires && !Number.isFinite(expires.getTime())) throw new Error('Invalid expiry date');
    if (draft.otp) applyEntryOtp(entry, draft.otp, draft.otpBaseline!);
    const original = entry.getAllFields();
    for (const { name } of FIELDS) {
        const value = draft.fields[name];
        const protect = draft.protection?.[name] ?? (name === 'Password' || original[name] instanceof ProtectedValue);
        if (fieldText(original[name]) !== value || (original[name] instanceof ProtectedValue) !== protect) {
            entry.setField(name, protect
                ? ProtectedValue.fromString(value) : value);
        }
    }

    const names = new Set(draft.custom.map(customName));
    for (const name of Object.keys(original)) {
        if (!reservedNames.has(name.toLowerCase()) && !names.has(name)) {
            entry.setField(name, undefined);
        }
    }
    for (const field of draft.custom) {
        const name = customName(field);
        const previous = original[field.originalName ?? name];
        const unchanged = field.originalName === name && fieldText(previous) === field.value
            && (previous instanceof ProtectedValue) === field.protected;
        if (!unchanged) {
            const value = field.protected ? ProtectedValue.fromString(field.value) : field.value;
            entry.setField(name, value, true);
        }
    }
    if (entry.tags.join(', ') !== draft.tags) {
        const tags = draft.tags.split(/[,;\n]/).map((tag) => tag.trim()).filter(Boolean);
        entry.setTags([...new Set(tags)]);
    }
    if (draft.expires !== undefined && draft.expires !== localDate(entry.expires)) entry.setExpires(expires);
}

export function EntryEditor({ model, entry, group, tags = [], draftSource, onSave, onCancel }: {
    model: AppModel;
    entry: EntryModel | null;
    group?: GroupModel;
    tags?: string[];
    draftSource?: EntryModel;
    onSave: (draft: EntryDraft, retain?: boolean) => EntryModel;
    onCancel: () => void;
}) {
    const file = (entry?.file ?? group?.file) as FileModel | undefined;
    const [draft, setDraft] = useState(() => {
        const initial = makeDraft(entry ?? draftSource ?? null, tags, group);
        if (!entry && draftSource) initial.fields.Title = '';
        return initial;
    });
    const initialDraft = useRef(JSON.stringify(draft));
    const cleanDraft = useRef(JSON.stringify(draft));
    const target = useRef(entry ? { file: entry.file as FileModel, db: (entry.file as FileModel).db, raw: entry.entry } : null);
    const access = getSessionAccess(model);
    const openEpoch = useRef(access.epoch);
    if (access.state === 'open') openEpoch.current = access.epoch;
    const nextId = useRef(draft.custom.length);
    const [reveal, setReveal] = useState(false);
    const [revealedFields, setRevealedFields] = useState<Set<string>>(new Set());
    const toggleReveal = (name: string) => setRevealedFields(current => {
        const next = new Set(current); if (next.has(name)) next.delete(name); else next.add(name); return next;
    });
    const [generatorOpen, setGeneratorOpen] = useState(false);
    const [error, setError] = useState('');
    const updateCustom = (id: number, changes: Partial<CustomField>) => setDraft((current) => ({
        ...current, custom: current.custom.map((field) => field.id === id ? { ...field, ...changes } : field)
    }));
    const save = (forLock = false, retain = false) => {
        const allowed = access.state === 'open' || (forLock && access.state === 'securing' && access.epoch === openEpoch.current + 1);
        const original = target.current;
        if (!allowed || !file || !file.active || model.files.get(file.id) !== file || (!entry && !writableCreationGroup(model, group)) || (entry && (!original || !original.file.active || model.files.get(original.file.id) !== original.file ||
            entry.file !== original.file || original.file.db !== original.db || entry.entry !== original.raw || (original.file as FileModel & { readOnly?: boolean }).readOnly))) {
            setError(t('This entry is no longer available for editing.')); return false;
        }
        if (entry && ((entry.file as FileModel).getEntry(entry.id) !== entry || JSON.stringify(makeDraft(entry, tags)) !== initialDraft.current)) {
            setError(t('This entry changed while you were editing. Copy your changes, then cancel and reopen the editor.'));
            return false;
        }
        const names = new Set<string>();
        for (const field of draft.custom) {
            const name = field.name.trim().toLowerCase();
            if (!name || reservedNames.has(name) || names.has(name)) {
                setError(t('Custom fields need unique names that are not built-in field names.'));
                return false;
            }
            names.add(name);
        }
        try {
            prepareOtpDraft(draft.otp);
            const saved = onSave(draft, retain);
            if (retain) {
                initialDraft.current = JSON.stringify(makeDraft(saved, tags));
                target.current = { file, db: file.db, raw: saved.entry };
                const next = { ...draft, otpBaseline: otpSnapshot(saved), custom: draft.custom.map(field => ({ ...field, originalName: customName(field) })) };
                cleanDraft.current = JSON.stringify(next);
                setDraft(next);
            }
            return true;
        }
        catch { setError(t('Could not save. Check the OTP configuration and reopen the editor if this entry changed.')); return false; }
    };
    usePendingDraft(JSON.stringify(draft) !== cleanDraft.current, retain => save(true, retain), onCancel, undefined, file?.id);

    return (
        <main class="detail entry-editor" aria-label={entry ? t('Edit entry') : t('New entry')}>
            <form class="entry-editor__form" onSubmit={(event) => { event.preventDefault(); save(); }}>
                <div class="entry-editor__head">
                    <h1 class="detail__title">{entry ? t('Edit entry') : t('New entry')}</h1>
                    <div class="entry-editor__actions">
                        {entry && <EntryHistory entry={entry} hasDraft={JSON.stringify(draft) !== cleanDraft.current}
                            onRestore={() => {
                                const restored = makeDraft(entry, tags);
                                initialDraft.current = JSON.stringify(restored);
                                cleanDraft.current = JSON.stringify(restored);
                                nextId.current = restored.custom.length;
                                setDraft(restored); setError('');
                            }} />}
                        <button class="pill" type="button" onClick={onCancel}>{t('Cancel')}</button>
                        <button class="pill pill--primary" type="submit">{t('Save')}</button>
                    </div>
                </div>
                {FIELDS.map(({ name, label }) => (
                    <div class="entry-editor__field" key={name}>
                        <label class="field-label">
                            <span>{t(label)}</span>
                            {name === 'Notes' && (!draft.protection?.[name] || revealedFields.has(name)) ? (
                                <textarea class="input entry-editor__notes" value={draft.fields[name]}
                                    onInput={(event) => setDraft({ ...draft, fields: { ...draft.fields, [name]: event.currentTarget.value } })} />
                            ) : (
                                <input class="input" type={(name === 'Password' ? !reveal : draft.protection?.[name] && !revealedFields.has(name)) ? 'password' : 'text'}
                                    autoFocus={name === 'Title'} autoComplete="off" spellcheck={false}
                                    list={name === 'UserName' ? 'entry-usernames' : undefined}
                                    value={draft.fields[name]}
                                    onInput={(event) => setDraft({ ...draft, fields: { ...draft.fields, [name]: event.currentTarget.value } })} />
                            )}
                        </label>
                        <label class="entry-editor__protect">
                            <input type="checkbox" checked={draft.protection?.[name]}
                                onChange={event => setDraft({ ...draft, protection: { ...draft.protection, [name]: event.currentTarget.checked } })} />
                            {t('Protect {}', t(label))}
                        </label>
                        {name !== 'Password' && draft.protection?.[name] && <button class="link" type="button"
                            onClick={() => toggleReveal(name)}>{t(revealedFields.has(name) ? 'Hide {}' : 'Show {}', t(label))}</button>}
                        {name === 'Password' && (
                            <>
                                <div class="entry-editor__password-actions">
                                    <button class="link" type="button" onClick={() => setReveal(!reveal)}>
                                        {reveal ? t('Hide password') : t('Show password')}
                                    </button>
                                    <button hidden={!model.settings.canOpenGenerator} class="link" type="button" aria-expanded={generatorOpen}
                                        onClick={() => { if (model.settings.canOpenGenerator) setGeneratorOpen(!generatorOpen); }}>{t('Generate password')}</button>
                                </div>
                                {generatorOpen && model.settings.canOpenGenerator && <PasswordGeneratorPanel sourcePassword={draft.fields.Password} onClose={() => setGeneratorOpen(false)}
                                    onUse={(password) => {
                                        if (!model.settings.canOpenGenerator) return;
                                        setDraft((current) => ({ ...current, fields: { ...current.fields, Password: password } }));
                                        setGeneratorOpen(false);
                                    }} />}
                            </>
                        )}
                    </div>
                ))}
                <datalist id="entry-usernames">
                    {[...new Set(model.files.flatMap(file => {
                        const names: string[] = [];
                        file.forEachEntry({}, entry => { if (entry.user) names.push(entry.user); });
                        return names;
                    }))].map(name => <option value={name} />)}
                </datalist>
                <label class="field-label entry-editor__field">
                    <span>{t('Expires')}</span>
                    <input class="input" type="datetime-local" aria-label={t('Expires')} step="1" value={draft.expires}
                        onInput={event => setDraft({ ...draft, expires: event.currentTarget.value })} />
                    <span class="muted">{t('Leave empty for no expiry.')}</span>
                </label>
                <label class="field-label entry-editor__field">
                    <span>{t('Tags')}</span>
                    <input class="input" value={draft.tags} placeholder={t('Separate tags with commas')}
                        onInput={(event) => setDraft({ ...draft, tags: event.currentTarget.value })} />
                </label>
                <EntryOtpFields model={model} value={draft.otp!} original={readEntryOtp(entry ?? draftSource ?? null)}
                    onChange={(otp) => setDraft((current) => ({ ...current, otp }))} />
                <fieldset class="entry-editor__custom">
                    <legend class="section-title">{t('Custom fields')}</legend>
                    {draft.custom.map((field) => (
                        <div class="entry-editor__custom-row" key={field.id}>
                            <label class="field-label">
                                <span>{t('Field name')}</span>
                                <input class="input" value={field.name} autoComplete="off"
                                    onInput={(event) => updateCustom(field.id, { name: event.currentTarget.value })} />
                            </label>
                            <label class="field-label">
                                <span>{t('Field value')}</span>
                                {field.multiline && (!field.protected || revealedFields.has(`custom:${field.id}`)) ?
                                <textarea class="input" value={field.value} autoComplete="off" spellcheck={false}
                                    onInput={event => updateCustom(field.id, { value: event.currentTarget.value })} /> :
                                <input class="input" type={field.protected && !revealedFields.has(`custom:${field.id}`) ? 'password' : 'text'}
                                    value={field.value} autoComplete="off" spellcheck={false}
                                    onInput={(event) => updateCustom(field.id, { value: event.currentTarget.value })} />}
                            </label>
                            <label class="entry-editor__protect">
                                <input type="checkbox" checked={field.multiline}
                                    onChange={event => updateCustom(field.id, { multiline: event.currentTarget.checked })} />
                                {t('Multiline')}
                            </label>
                            {field.protected && <button class="link" type="button" onClick={() => toggleReveal(`custom:${field.id}`)}>
                                {t(revealedFields.has(`custom:${field.id}`) ? 'Hide field' : 'Show field')}
                            </button>}
                            <label class="entry-editor__protect">
                                <input type="checkbox" checked={field.protected}
                                    onChange={(event) => updateCustom(field.id, { protected: event.currentTarget.checked })} />
                                {t('Protected')}
                            </label>
                            <button class="link" type="button" onClick={() => setDraft({
                                ...draft, custom: draft.custom.filter((item) => item.id !== field.id)
                            })}>{t('Remove field')}</button>
                        </div>
                    ))}
                    <button class="link" type="button" onClick={() => setDraft({
                        ...draft, custom: [...draft.custom, { id: nextId.current++, name: '', value: '', protected: false }]
                    })}>{t('Add field')}</button>
                </fieldset>
                {error && <p class="error" role="alert">{error}</p>}
            </form>
        </main>
    );
}
